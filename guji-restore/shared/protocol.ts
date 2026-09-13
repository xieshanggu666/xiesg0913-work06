import type { DashboardReport } from './dashboard.js';
import type { ExportPreview } from './export-preview.js';
import type {
  Comment,
  CommentTarget,
  ExportRecord,
  ExportResult,
  Folio,
  ID,
  Layer,
  Material,
  MaterialBatch,
  PlanSnapshot,
  PlanVersion,
  Project,
  Recommendation,
  RestorationStep,
  Sample,
  SampleKind,
  Shape,
  StockMovement
} from './types.js';
import type { DamageKind, LayerKind, MaterialCategory } from './types.js';
import type { Geometry } from './types.js';

/**
 * 渲染进程可调用的全部后端能力。
 * Electron 环境由 preload 桥接 IPC；浏览器/测试环境由内存 Mock 实现同构接口。
 */
export interface GujiApi {
  app: {
    getDataDir(): Promise<string>;
    openDataDir(): Promise<void>;
    /** 导入内置样例项目，返回项目 ID；已存在则返回已有项目 */
    importSamples(operator: string): Promise<{ projectId: ID; folioCount: number }>;
  };

  projects: {
    list(): Promise<Project[]>;
    create(input: {
      name: string;
      author: string;
      shelf_no: string;
      era: string;
      description: string;
    }): Promise<Project>;
    update(id: ID, patch: Partial<Project>): Promise<Project>;
    remove(id: ID): Promise<void>;
    stats(id: ID): Promise<{
      folios: number;
      shapes: number;
      damagedAreaPx: number;
      steps: number;
      comments: number;
    }>;
  };

  folios: {
    list(projectId: ID): Promise<Folio[]>;
    /** srcPath 为用户通过对话框选择的绝对路径；原图会被复制为只读副本 */
    import(projectId: ID, files: { name: string; srcPath: string }[]): Promise<Folio[]>;
    update(id: ID, patch: Partial<Pick<Folio, 'name' | 'note'>>): Promise<Folio>;
    remove(id: ID): Promise<void>;
    /** 上传修复后对照图（不覆盖原图） */
    setAfterImage(folioId: ID, srcPath: string): Promise<Folio>;
    /** 计算图像平均色（Lab），供快速建样本 */
    averageColor(folioId: ID, geo: Geometry | null): Promise<{ hex: string }>;
  };

  layers: {
    list(folioId: ID): Promise<Layer[]>;
    create(folioId: ID, input: { name: string; kind: LayerKind; color: string }): Promise<Layer>;
    update(
      id: ID,
      patch: Partial<Pick<Layer, 'name' | 'color' | 'visible' | 'locked' | 'opacity' | 'order_index'>>
    ): Promise<Layer>;
    remove(id: ID): Promise<void>;
  };

  shapes: {
    list(folioId: ID): Promise<Shape[]>;
    create(
      folioId: ID,
      input: { layer_id: ID; damage: DamageKind; geometry: Geometry; label?: string; note?: string }
    ): Promise<Shape>;
    update(
      id: ID,
      patch: Partial<Pick<Shape, 'layer_id' | 'damage' | 'geometry' | 'label' | 'note' | 'order_index'>>
    ): Promise<Shape>;
    remove(id: ID): Promise<void>;
  };

  samples: {
    list(kind?: SampleKind): Promise<Sample[]>;
    create(input: Omit<Sample, 'id' | 'created_at' | 'updated_at'>): Promise<Sample>;
    update(id: ID, patch: Partial<Sample>): Promise<Sample>;
    remove(id: ID): Promise<void>;
  };

  materials: {
    list(category?: MaterialCategory): Promise<Material[]>;
    create(input: Omit<Material, 'id' | 'created_at' | 'updated_at'>): Promise<Material>;
    update(id: ID, patch: Partial<Material>): Promise<Material>;
    remove(id: ID): Promise<void>;
    recommend(sampleId: ID, opts?: { categoryFilter?: MaterialCategory[] }): Promise<Recommendation[]>;
  };

  steps: {
    list(projectId: ID): Promise<RestorationStep[]>;
    create(input: Omit<RestorationStep, 'id' | 'created_at'>): Promise<RestorationStep>;
    update(id: ID, patch: Partial<RestorationStep>): Promise<RestorationStep>;
    remove(id: ID): Promise<void>;
  };

  /**
   * 材料领用（批次追溯）。
   * 批次/流水存全局库（材料为全局资源，可跨项目领用）；领用时必须指定项目与工序，
   * 使选材结果（工序 material_ids）能够追溯到实际使用的批次与领用量。
   */
  inventory: {
    /** 批次列表（可按材料过滤），每项含按流水实时计算的剩余数量 */
    batches(materialId?: ID): Promise<MaterialBatchWithQty[]>;
    /** 批次详情：基础信息、剩余数量、完整流水（含合成入库行）与关联工序 */
    batchDetail(batchId: ID): Promise<BatchDetail>;
    /** 从材料库登记批次：批次号、计量单位、入库数量 */
    createBatch(input: NewBatchInput): Promise<MaterialBatch>;
    /** 批次备注/批次号等元信息（不允许改入库数量，入库以流水留痕） */
    updateBatch(id: ID, patch: Partial<Pick<MaterialBatch, 'batch_no' | 'supplier_lot' | 'received_at' | 'note'>>): Promise<MaterialBatch>;
    /** 删除批次：仅在没有任何领用/退料流水时允许（保持台账完整） */
    removeBatch(id: ID): Promise<void>;
    /** 从工序记录选择批次领料；projectId/stepId 标识来源工序，stepId 可空表示整卷领用 */
    issue(input: IssueInput): Promise<StockMovement>;
    /** 退料：必须指向某次领料，数量不超过其未退数量，支持部分退料/多次退料 */
    returnToStock(input: ReturnInput): Promise<StockMovement>;
    /** 某道工序的全部领料（含每条已退/未退数量） */
    stepIssues(stepId: ID): Promise<StepIssueRow[]>;
    /** 某项目下的全部领用/退料流水（供项目内核对） */
    projectMovements(projectId: ID): Promise<StockMovement[]>;
  };

  versions: {
    list(folioId: ID): Promise<PlanVersion[]>;
    /** 以当前图层/标注生成新版本快照 */
    save(folioId: ID, input: { label: string; note: string; author: string }): Promise<PlanVersion>;
    /** 回退：把快照覆盖为当前图层/标注；回退前自动存一个回退前快照 */
    restore(versionId: ID, author: string): Promise<PlanVersion>;
    snapshot(folioId: ID): Promise<PlanSnapshot>;
  };

  comments: {
    list(projectId: ID): Promise<Comment[]>;
    create(input: {
      project_id: ID;
      folio_id?: ID | null;
      target_type: CommentTarget;
      target_id?: ID | null;
      author: string;
      body: string;
    }): Promise<Comment>;
    resolve(id: ID, resolved: boolean): Promise<Comment>;
    remove(id: ID): Promise<void>;
  };

  archive: {
    /** 生成档案前的预览：汇总信息、风险、前后对比图与校验清单（不落库） */
    preview(projectId: ID, opts: { includeOriginal: boolean }): Promise<ExportPreview>;
    /** 用户确认预览后生成离线 HTML 档案 + 原图/对照图/校验清单 zip */
    exportProject(
      projectId: ID,
      opts: { includeOriginal: boolean; operator?: string }
    ): Promise<ExportResult>;
    /** 历次导出尝试记录（成功/失败，最近在前） */
    records(projectId: ID): Promise<ExportRecord[]>;
  };

  dashboard: {
    /** 项目进度与风险看板：由叶/标注/工序/批注/版本实时推导，不落库 */
    get(projectId: ID): Promise<DashboardReport>;
  };

  dialog: {
    pickImages(): Promise<{ name: string; path: string }[]>;
    saveZip(defaultName: string): Promise<string | null>;
  };

  /** 项目媒体的只读 URL（Electron guji-media://；Mock 为相对路径） */
  mediaUrl(projectId: ID, rel: string): string;
}

declare global {
  interface Window {
    guji?: GujiApi;
  }
}

/* ---------------- 材料领用 DTO ---------------- */

/** 批次列表行：批次 + 实时余量 + 材料名 */
export interface MaterialBatchWithQty extends MaterialBatch {
  remaining_qty: number;
  issued_total: number; // 累计领料（含已退）
  returned_total: number; // 累计退料
  material_name: string;
  material_category: Material['category'];
}

/** 批次详情里关联工序的摘要 */
export interface BatchLinkedStep {
  step_id: ID;
  project_id: ID;
  project_name: string;
  title: string;
  order_index: number;
  qty: number; // 该工序从该批次累计净领用
}

export interface BatchDetail {
  batch: MaterialBatch;
  material: Material | null;
  remaining_qty: number;
  /** 完整流水（含由批次合成的入库行），时间升序 */
  ledger: StockMovement[];
  linked_steps: BatchLinkedStep[];
}

export interface NewBatchInput {
  material_id: ID;
  batch_no: string;
  unit: string;
  initial_qty: number;
  supplier_lot?: string;
  received_at: string; // ISO 或 yyyy-mm-dd
  note?: string;
}

export interface IssueInput {
  batch_id: ID;
  project_id: ID;
  step_id?: ID | null; // null = 整卷领用，不绑定具体工序
  qty: number;
  operator: string;
  moved_at: string;
  note?: string;
}

export interface ReturnInput {
  /** 指向原领料流水（退料只能源于领料） */
  source_move_id: ID;
  qty: number;
  operator: string;
  moved_at: string;
  note?: string;
}

/** 工序领料行：流水 + 批次/材料名 + 已退/未退数量 */
export interface StepIssueRow {
  move: StockMovement;
  batch: MaterialBatch | null;
  material: Material | null;
  returned_qty: number;
  outstanding_qty: number;
}

export {};
