import type { Database as DBType } from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Comment,
  CommentTarget,
  Folio,
  Geometry,
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
} from '@shared/types';
import type { DamageKind, LayerKind, MaterialCategory } from '@shared/types';
import { newId, nowIso } from '@shared/id';
import { geometryArea } from '@shared/geometry';
import { hexToLab } from '@shared/color';
import { recommendMaterials } from '@shared/recommend';
import { buildDashboard, type DashboardReport } from '@shared/dashboard';
import { INITIAL_PLAN_VERSION, LAYER_KIND_META } from '@shared/constants';
import {
  batchLedger,
  batchRemaining,
  checkIssue,
  checkReturn,
  issueOutstanding,
  makeMovement,
  roundQty
} from '@shared/inventory';
import type {
  BatchDetail,
  BatchLinkedStep,
  IssueInput,
  MaterialBatchWithQty,
  NewBatchInput,
  ReturnInput,
  StepIssueRow
} from '@shared/protocol';
import { openLibrary, openProject } from '../db/schema';
import * as repo from '../db/repo';
import { averageColorHex, importAfterImage, importOriginal } from './images';

export class ServiceContext {
  constructor(public dataDir: string) {}

  private libDb: DBType | null = null;
  private projectDbs = new Map<string, DBType>();

  library(): DBType {
    if (!this.libDb) this.libDb = openLibrary(this.dataDir);
    return this.libDb;
  }

  projectDir(projectId: ID): string {
    return join(this.dataDir, 'projects', projectId);
  }

  projectDb(projectId: ID): DBType {
    let db = this.projectDbs.get(projectId);
    if (!db) {
      db = openProject(this.projectDir(projectId));
      this.projectDbs.set(projectId, db);
    }
    return db;
  }

  /** 删项目：关库并移除整个项目目录（含原图副本） */
  disposeProject(projectId: ID): void {
    const db = this.projectDbs.get(projectId);
    db?.close();
    this.projectDbs.delete(projectId);
    const dir = this.projectDir(projectId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- 项目 ---------------- */

export function createProject(
  ctx: ServiceContext,
  input: { name: string; author: string; shelf_no: string; era: string; description: string }
): Project {
  const now = nowIso();
  const p: Project = { id: newId('prj_'), ...input, created_at: now, updated_at: now };
  repo.insertProject(ctx.library(), p);
  return p;
}

export function listProjects(ctx: ServiceContext): Project[] {
  return repo.listProjects(ctx.library());
}

export function updateProject(ctx: ServiceContext, id: ID, patch: Partial<Project>): Project {
  return repo.updateProjectRow(ctx.library(), id, patch);
}

export function removeProject(ctx: ServiceContext, id: ID): void {
  // 先清理全局库存中该项目的领用/退料流水并回滚批次余量，再删项目目录
  repo.deleteMovementsByProject(ctx.library(), id);
  repo.deleteProjectRow(ctx.library(), id);
  ctx.disposeProject(id);
}

export function projectStats(ctx: ServiceContext, id: ID) {
  const db = ctx.projectDb(id);
  const shapes = db.prepare('SELECT COALESCE(SUM(area_px),0) AS a, COUNT(*) AS n FROM shapes').get() as any;
  const steps = db.prepare('SELECT COUNT(*) AS n FROM steps').get() as any;
  const comments = db.prepare('SELECT COUNT(*) AS n FROM comments').get() as any;
  const folios = db.prepare('SELECT COUNT(*) AS n FROM folios').get() as any;
  return {
    folios: folios.n as number,
    shapes: shapes.n as number,
    damagedAreaPx: shapes.a as number,
    steps: steps.n as number,
    comments: comments.n as number
  };
}

/* ---------------- 进度与风险看板 ---------------- */

/** 聚合项目库全部数据，交给共享纯函数推导看板（不入库） */
export function projectDashboard(ctx: ServiceContext, projectId: ID): DashboardReport {
  const project = repo.getProject(ctx.library(), projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  const db = ctx.projectDb(projectId);
  return buildDashboard({
    project,
    folios: repo.listFolios(db),
    layers: (db.prepare('SELECT * FROM layers').all() as any[]).map(repo.layerRow),
    shapes: (db.prepare('SELECT * FROM shapes').all() as any[]).map(repo.shapeRow),
    steps: repo.listSteps(db, projectId),
    comments: repo.listComments(db, projectId),
    versions: (db.prepare('SELECT * FROM plan_versions').all() as any[]).map(repo.versionRow)
  });
}

/* ---------------- 叶（扫描） ---------------- */

export function listFolios(ctx: ServiceContext, projectId: ID): Folio[] {
  return repo.listFolios(ctx.projectDb(projectId));
}

export async function importFolios(
  ctx: ServiceContext,
  projectId: ID,
  files: { name: string; srcPath: string }[]
): Promise<Folio[]> {
  const db = ctx.projectDb(projectId);
  const seqRow = db.prepare('SELECT COALESCE(MAX(sequence),0) AS s FROM folios').get() as any;
  let seq = (seqRow.s as number) + 1;
  const out: Folio[] = [];
  for (const f of files) {
    const id = newId('fol_');
    const info = await importOriginal(ctx.projectDir(projectId), f.srcPath, id);
    const folio: Folio = {
      id,
      project_id: projectId,
      name: f.name.replace(/\.[^.]+$/, ''),
      sequence: seq++,
      original_rel: info.originalRel,
      original_checksum: info.checksum,
      width: info.width,
      height: info.height,
      thumb_rel: info.thumbRel,
      after_rel: null,
      after_checksum: null,
      imported_at: nowIso(),
      note: ''
    };
    repo.insertFolio(db, folio);
    ensureDefaultLayers(db, folio);
    out.push(folio);
  }
  touchProject(ctx, projectId);
  return out;
}

export function updateFolio(ctx: ServiceContext, id: ID, patch: Partial<Pick<Folio, 'name' | 'note'>>): Folio {
  const folio = mustFolio(ctx, id);
  const next = repo.updateFolioRow(ctx.projectDb(folio.project_id), id, patch);
  touchProject(ctx, folio.project_id);
  return next;
}

export function removeFolio(ctx: ServiceContext, id: ID): void {
  const folio = mustFolio(ctx, id);
  repo.deleteFolioRow(ctx.projectDb(folio.project_id), id);
  touchProject(ctx, folio.project_id);
}

export async function setAfterImage(ctx: ServiceContext, folioId: ID, srcPath: string): Promise<Folio> {
  const folio = mustFolio(ctx, folioId);
  const { rel, checksum } = importAfterImage(ctx.projectDir(folio.project_id), folioId, srcPath);
  const next = repo.updateFolioRow(ctx.projectDb(folio.project_id), folioId, {
    after_rel: rel,
    after_checksum: checksum
  });
  touchProject(ctx, folio.project_id);
  return next;
}

export async function folioAverageColor(
  ctx: ServiceContext,
  folioId: ID,
  geo: Geometry | null
): Promise<{ hex: string }> {
  const folio = mustFolio(ctx, folioId);
  const hex = await averageColorHex(ctx.projectDir(folio.project_id), folio.original_rel, geo);
  return { hex };
}

/* ---------------- 图层与标注 ---------------- */

function ensureDefaultLayers(db: DBType, folio: Folio): void {
  const exists = db.prepare('SELECT COUNT(*) AS n FROM layers WHERE folio_id = ?').get(folio.id) as any;
  if (exists.n > 0) return;
  const defs: { name: string; kind: LayerKind }[] = [
    { name: '破损标注', kind: 'damage' },
    { name: '修补方案', kind: 'repair' },
    { name: '批注', kind: 'note' }
  ];
  defs.forEach((d, i) =>
    repo.insertLayer(db, {
      id: newId('lay_'),
      folio_id: folio.id,
      name: d.name,
      kind: d.kind,
      color: LAYER_KIND_META[d.kind].color,
      visible: true,
      locked: false,
      opacity: 0.5,
      order_index: i,
      created_at: nowIso()
    })
  );
  // 初始方案版本（空标注基线，便于后续 diff）
  repo.insertVersion(db, {
    id: newId('ver_'),
    project_id: folio.project_id,
    folio_id: folio.id,
    version: INITIAL_PLAN_VERSION,
    label: '建档基线',
    note: '导入扫描时自动建立的空基线',
    author: 'system',
    snapshot: { layers: repo.listLayers(db, folio.id), shapes: [] },
    created_at: nowIso()
  });
}

export function listLayers(ctx: ServiceContext, folioId: ID): Layer[] {
  const folio = mustFolio(ctx, folioId);
  return repo.listLayers(ctx.projectDb(folio.project_id), folioId);
}

export function createLayer(
  ctx: ServiceContext,
  folioId: ID,
  input: { name: string; kind: LayerKind; color: string }
): Layer {
  const folio = mustFolio(ctx, folioId);
  const db = ctx.projectDb(folio.project_id);
  const row = db.prepare('SELECT COALESCE(MAX(order_index),0)+1 AS n FROM layers WHERE folio_id=?').get(folioId) as any;
  const layer: Layer = {
    id: newId('lay_'),
    folio_id: folioId,
    name: input.name,
    kind: input.kind,
    color: input.color || LAYER_KIND_META[input.kind].color,
    visible: true,
    locked: false,
    opacity: 0.5,
    order_index: row.n,
    created_at: nowIso()
  };
  repo.insertLayer(db, layer);
  touchProject(ctx, folio.project_id);
  return layer;
}

export function updateLayer(ctx: ServiceContext, id: ID, patch: Partial<Layer>): Layer {
  const layer = mustLayer(ctx, id);
  const next = repo.updateLayerRow(ctx.projectDb(layer.project_id), id, patch);
  touchProject(ctx, layer.project_id);
  return next;
}

export function removeLayer(ctx: ServiceContext, id: ID): void {
  const layer = mustLayer(ctx, id);
  repo.deleteLayerRow(ctx.projectDb(layer.project_id), id);
  touchProject(ctx, layer.project_id);
}

/* ---------------- 标注 ---------------- */

export function listShapes(ctx: ServiceContext, folioId: ID): Shape[] {
  const folio = mustFolio(ctx, folioId);
  return repo.listShapes(ctx.projectDb(folio.project_id), folioId);
}

export function createShape(
  ctx: ServiceContext,
  folioId: ID,
  input: { layer_id: ID; damage: DamageKind; geometry: Geometry; label?: string; note?: string }
): Shape {
  const folio = mustFolio(ctx, folioId);
  const db = ctx.projectDb(folio.project_id);
  const row = db.prepare('SELECT COALESCE(MAX(order_index),0)+1 AS n FROM shapes WHERE folio_id=?').get(folioId) as any;
  const shape: Shape = {
    id: newId('shp_'),
    folio_id: folioId,
    layer_id: input.layer_id,
    damage: input.damage,
    geometry: normalizeGeometry(input.geometry),
    label: input.label ?? '',
    note: input.note ?? '',
    area_px: geometryArea(input.geometry),
    order_index: row.n,
    created_at: nowIso()
  };
  repo.insertShape(db, shape);
  touchProject(ctx, folio.project_id);
  return shape;
}

export function updateShape(ctx: ServiceContext, id: ID, patch: Partial<Shape>): Shape {
  const shape = mustShape(ctx, id);
  const next = { ...patch };
  if (patch.geometry) {
    next.geometry = normalizeGeometry(patch.geometry);
    next.area_px = geometryArea(next.geometry);
  }
  const updated = repo.updateShapeRow(ctx.projectDb(shape.project_id), id, next);
  touchProject(ctx, shape.project_id);
  return updated;
}

export function removeShape(ctx: ServiceContext, id: ID): void {
  const shape = mustShape(ctx, id);
  repo.deleteShapeRow(ctx.projectDb(shape.project_id), id);
  touchProject(ctx, shape.project_id);
}

/** 规范化几何：丢弃负值宽高、去除重复末点 */
function normalizeGeometry(g: Geometry): Geometry {
  if (g.type === 'polygon') {
    const pts = (g.points ?? []).map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
    if (pts.length > 1) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) pts.pop();
    }
    return { type: 'polygon', points: pts };
  }
  let { x = 0, y = 0, w = 0, h = 0 } = g;
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  return { type: g.type, x, y, w, h };
}

/* ---------------- 样本库 ---------------- */

export function listSamples(ctx: ServiceContext, kind?: SampleKind): Sample[] {
  return repo.listSamples(ctx.library(), kind);
}

export function createSample(ctx: ServiceContext, input: Omit<Sample, 'id' | 'created_at' | 'updated_at'>): Sample {
  const withLab: Omit<Sample, 'id' | 'created_at' | 'updated_at'> = {
    ...input,
    lab: input.lab ?? (input.color_hex ? hexToLab(input.color_hex) : null)
  };
  const ts = nowIso();
  const sample: Sample = { ...withLab, id: newId('smp_'), created_at: ts, updated_at: ts };
  repo.insertSample(ctx.library(), sample);
  return sample;
}

export function updateSample(ctx: ServiceContext, id: ID, patch: Partial<Sample>): Sample {
  // 改了颜色但未显式给 Lab 时自动重算
  if (patch.color_hex && !('lab' in patch)) patch.lab = hexToLab(patch.color_hex);
  return repo.updateSampleRow(ctx.library(), id, patch);
}

export function removeSample(ctx: ServiceContext, id: ID): void {
  repo.deleteSampleRow(ctx.library(), id);
}

/* ---------------- 材料库 ---------------- */

export function listMaterials(ctx: ServiceContext, category?: MaterialCategory): Material[] {
  return repo.listMaterials(ctx.library(), category);
}

export function createMaterial(
  ctx: ServiceContext,
  input: Omit<Material, 'id' | 'created_at' | 'updated_at'>
): Material {
  const withLab: Omit<Material, 'id' | 'created_at' | 'updated_at'> = {
    ...input,
    lab: input.lab ?? (input.color_hex ? hexToLab(input.color_hex) : null)
  };
  const ts = nowIso();
  const mat: Material = { ...withLab, id: newId('mat_'), created_at: ts, updated_at: ts };
  repo.insertMaterial(ctx.library(), mat);
  return mat;
}

export function updateMaterial(ctx: ServiceContext, id: ID, patch: Partial<Material>): Material {
  if (patch.color_hex && !('lab' in patch)) patch.lab = hexToLab(patch.color_hex);
  return repo.updateMaterialRow(ctx.library(), id, patch);
}

export function removeMaterial(ctx: ServiceContext, id: ID): void {
  // 被批次引用的材料不能删除（外键 ON DELETE RESTRICT），给出可读原因
  const used = ctx
    .library()
    .prepare('SELECT COUNT(*) AS n FROM material_batches WHERE material_id = ?')
    .get(id) as any;
  if ((used.n as number) > 0) throw new Error('该材料已有入库批次，请先处理批次后再删除');
  repo.deleteMaterialRow(ctx.library(), id);
}

export function recommend(ctx: ServiceContext, sampleId: ID, categoryFilter?: MaterialCategory[]): Recommendation[] {
  const rows = repo.listSamples(ctx.library());
  const sample = rows.find((s) => s.id === sampleId) ?? null;
  const materials = repo.listMaterials(ctx.library());
  return recommendMaterials(sample, materials, { categoryFilter });
}

/* ---------------- 工序 ---------------- */

export function listSteps(ctx: ServiceContext, projectId: ID): RestorationStep[] {
  return repo.listSteps(ctx.projectDb(projectId), projectId);
}

export function createStep(ctx: ServiceContext, input: Omit<RestorationStep, 'id' | 'created_at'>): RestorationStep {
  const step: RestorationStep = { ...input, id: newId('stp_'), created_at: nowIso() };
  repo.insertStep(ctx.projectDb(input.project_id), step);
  touchProject(ctx, input.project_id);
  return step;
}

export function updateStep(ctx: ServiceContext, id: ID, patch: Partial<RestorationStep>): RestorationStep {
  // 工序归属同一项目，直接用全库查 project_id 不现实；逐项目极少，这里要求 patch 不带 project_id
  const lib = ctx.library();
  // 找到包含该工序的项目
  for (const p of repo.listProjects(lib)) {
    const db = ctx.projectDb(p.id);
    const hit = db.prepare('SELECT project_id FROM steps WHERE id = ?').get(id) as any;
    if (hit) {
      const updated = repo.updateStepRow(db, id, patch);
      touchProject(ctx, p.id);
      return updated;
    }
  }
  throw new Error(`工序不存在: ${id}`);
}

export function removeStep(ctx: ServiceContext, id: ID): void {
  for (const p of repo.listProjects(ctx.library())) {
    const db = ctx.projectDb(p.id);
    const hit = db.prepare('SELECT 1 FROM steps WHERE id = ?').get(id);
    if (hit) {
      repo.deleteStepRow(db, id);
      // 领料流水保留可追溯，但解除工序引用（转为整卷领用），避免悬空 step_id
      repo.detachMovementsFromStep(ctx.library(), id);
      touchProject(ctx, p.id);
      return;
    }
  }
}

/* ---------------- 材料领用（批次追溯） ---------------- */

/** 批次/流水存全局库；工序按项目分库，这里只追加全局流水，不改项目库 */

export function listBatches(ctx: ServiceContext, materialId?: ID): MaterialBatchWithQty[] {
  const lib = ctx.library();
  const materials = repo.listMaterials(lib);
  const matById = new Map(materials.map((m) => [m.id, m]));
  const moves = repo.listMovements(lib);
  return repo.listBatches(lib, materialId).map((b) => {
    let issued = 0;
    let returned = 0;
    for (const m of moves) {
      if (m.batch_id !== b.id) continue;
      if (m.kind === 'issue') issued += m.qty;
      else if (m.kind === 'return') returned += m.qty;
    }
    const mat = matById.get(b.material_id);
    return {
      ...b,
      remaining_qty: batchRemaining(b, moves),
      issued_total: roundQty(issued),
      returned_total: roundQty(returned),
      material_name: mat?.name ?? '(已删除材料)',
      material_category: mat?.category ?? 'other'
    };
  });
}

export function getBatchDetail(ctx: ServiceContext, batchId: ID): BatchDetail {
  const lib = ctx.library();
  const batch = repo.getBatch(lib, batchId);
  if (!batch) throw new Error(`批次不存在: ${batchId}`);
  const moves = repo.listMovements(lib).filter((m) => m.batch_id === batchId);
  const material = repo.getMaterial(lib, batch.material_id);
  const linked = buildLinkedSteps(ctx, moves);
  return {
    batch,
    material,
    remaining_qty: batchRemaining(batch, moves),
    ledger: batchLedger(batch, moves),
    linked_steps: linked
  };
}

/** 汇总批次被哪些工序领用（按项目分库查工序标题） */
function buildLinkedSteps(ctx: ServiceContext, moves: StockMovement[]): BatchLinkedStep[] {
  // stepId → 净领用数量（领料 - 退料）
  const net = new Map<ID, number>();
  for (const m of moves) {
    if (m.kind !== 'issue' || !m.step_id) continue;
    net.set(m.step_id, (net.get(m.step_id) ?? 0) + m.qty);
  }
  for (const m of moves) {
    if (m.kind !== 'return' || !m.step_id) continue;
    net.set(m.step_id, (net.get(m.step_id) ?? 0) - m.qty);
  }
  const projects = repo.listProjects(ctx.library());
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const out: BatchLinkedStep[] = [];
  for (const p of projects) {
    const db = ctx.projectDb(p.id);
    for (const [stepId, qty] of net) {
      const step = db.prepare('SELECT * FROM steps WHERE id = ?').get(stepId) as any;
      if (step) {
        out.push({
          step_id: stepId,
          project_id: p.id,
          project_name: projectName.get(p.id) ?? p.name,
          title: step.title,
          order_index: step.order_index,
          qty: roundQty(qty)
        });
      }
    }
  }
  return out.sort((a, b) => a.order_index - b.order_index);
}

export function createBatch(ctx: ServiceContext, input: NewBatchInput): MaterialBatch {
  const lib = ctx.library();
  const material = repo.getMaterial(lib, input.material_id);
  if (!material) throw new Error(`材料不存在: ${input.material_id}`);
  const qty = Number(input.initial_qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('入库数量必须大于 0');
  const no = input.batch_no.trim();
  if (!no) throw new Error('请填写批次号');
  const unit = input.unit.trim();
  if (!unit) throw new Error('请填写计量单位');
  const duplicate = repo
    .listBatches(lib, input.material_id)
    .some((b) => b.batch_no.trim().toLocaleLowerCase() === no.toLocaleLowerCase());
  if (duplicate) throw new Error(`该材料已存在批次号「${no}」`);
  const ts = nowIso();
  const batch: MaterialBatch = {
    id: newId('bat_'),
    material_id: input.material_id,
    batch_no: no,
    unit,
    initial_qty: roundQty(qty),
    supplier_lot: input.supplier_lot?.trim() ?? '',
    received_at: input.received_at ? normalizeDate(input.received_at) : ts,
    note: input.note?.trim() ?? '',
    created_at: ts
  };
  repo.insertBatch(lib, batch);
  return batch;
}

export function updateBatch(
  ctx: ServiceContext,
  id: ID,
  patch: Partial<Pick<MaterialBatch, 'batch_no' | 'supplier_lot' | 'received_at' | 'note'>>
): MaterialBatch {
  const clean: typeof patch = { ...patch };
  if (clean.received_at) clean.received_at = normalizeDate(clean.received_at);
  if (clean.batch_no !== undefined) clean.batch_no = clean.batch_no.trim();
  return repo.updateBatchRow(ctx.library(), id, clean);
}

export function removeBatch(ctx: ServiceContext, id: ID): void {
  const lib = ctx.library();
  const batch = repo.getBatch(lib, id);
  if (!batch) throw new Error(`批次不存在: ${id}`);
  // 有任何领用/退料流水都不允许删除：批次须可追溯到实际使用
  if (repo.countMovementsOfBatch(lib, id) > 0) {
    throw new Error('该批次已有领用或退料记录，不能删除（台账只追加、保持可追溯）');
  }
  repo.deleteBatchRow(lib, id);
}

export function issueMaterial(ctx: ServiceContext, input: IssueInput): StockMovement {
  const lib = ctx.library();
  const batch = repo.getBatch(lib, input.batch_id);
  if (!batch) throw new Error(`批次不存在: ${input.batch_id}`);
  if (!input.project_id) throw new Error('领料必须指定项目');
  if (input.step_id) assertStepExists(ctx, input.project_id, input.step_id);
  const qty = Number(input.qty);
  const all = repo.listMovements(lib);
  const err = checkIssue(batch, all, qty);
  if (err) throw new Error(err);
  const move = makeMovement({
    id: newId('mv_'),
    batch_id: batch.id,
    kind: 'issue',
    qty,
    project_id: input.project_id,
    step_id: input.step_id ?? null,
    operator: input.operator?.trim() || '修复师',
    moved_at: normalizeDate(input.moved_at),
    note: input.note?.trim() ?? '',
    created_at: nowIso()
  });
  repo.insertMovement(lib, move);
  touchProject(ctx, input.project_id);
  return move;
}

export function returnMaterial(ctx: ServiceContext, input: ReturnInput): StockMovement {
  const lib = ctx.library();
  const source = repo.getMovement(lib, input.source_move_id);
  if (!source || source.kind !== 'issue') throw new Error('只能针对领料记录退料');
  const batch = repo.getBatch(lib, source.batch_id);
  if (!batch) throw new Error(`批次不存在: ${source.batch_id}`);
  const qty = Number(input.qty);
  const all = repo.listMovements(lib);
  const err = checkReturn(source, all, qty, batch.unit);
  if (err) throw new Error(err);
  const move = makeMovement({
    id: newId('mv_'),
    batch_id: source.batch_id,
    kind: 'return',
    qty,
    project_id: source.project_id,
    step_id: source.step_id,
    operator: input.operator?.trim() || '修复师',
    moved_at: normalizeDate(input.moved_at),
    note: input.note?.trim() ?? '',
    related_move_id: source.id,
    created_at: nowIso()
  });
  repo.insertMovement(lib, move);
  if (source.project_id) touchProject(ctx, source.project_id);
  return move;
}

export function listStepIssues(ctx: ServiceContext, stepId: ID): StepIssueRow[] {
  const lib = ctx.library();
  const moves = repo.listMovements(lib).filter((m) => m.kind === 'issue' && m.step_id === stepId);
  const batches = repo.listBatches(lib);
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const materials = repo.listMaterials(lib);
  const matById = new Map(materials.map((m) => [m.id, m]));
  const all = repo.listMovements(lib);
  return moves.map((move) => {
    const batch = batchById.get(move.batch_id) ?? null;
    return {
      move,
      batch,
      material: batch ? matById.get(batch.material_id) ?? null : null,
      returned_qty: roundQty(move.qty - issueOutstanding(move, all)),
      outstanding_qty: issueOutstanding(move, all)
    };
  });
}

export function listProjectMovements(ctx: ServiceContext, projectId: ID): StockMovement[] {
  return repo.listMovementsByProject(ctx.library(), projectId);
}

/** 校验工序确实属于该项目（避免领料挂到别的项目工序上） */
function assertStepExists(ctx: ServiceContext, projectId: ID, stepId: ID): void {
  const hit = ctx
    .projectDb(projectId)
    .prepare('SELECT 1 FROM steps WHERE id = ? AND project_id = ?')
    .get(stepId, projectId);
  if (!hit) throw new Error(`工序不存在或不属于当前项目: ${stepId}`);
}

/** 表单日期（yyyy-mm-dd 或 ISO）统一为 ISO；已是完整时间则原样返回 */
function normalizeDate(v: string): string {
  if (!v) return nowIso();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v;
}


/* ---------------- 方案版本 ---------------- */

export function snapshotOf(ctx: ServiceContext, folioId: ID): PlanSnapshot {
  const folio = mustFolio(ctx, folioId);
  const db = ctx.projectDb(folio.project_id);
  return { layers: repo.listLayers(db, folioId), shapes: repo.listShapes(db, folioId) };
}

export function saveVersion(
  ctx: ServiceContext,
  folioId: ID,
  input: { label: string; note: string; author: string }
): PlanVersion {
  const folio = mustFolio(ctx, folioId);
  const db = ctx.projectDb(folio.project_id);
  const versions = repo.listVersions(db, folioId);
  const version: PlanVersion = {
    id: newId('ver_'),
    project_id: folio.project_id,
    folio_id: folioId,
    version: versions.length ? versions[0].version + 1 : INITIAL_PLAN_VERSION,
    label: input.label,
    note: input.note,
    author: input.author,
    snapshot: { layers: repo.listLayers(db, folioId), shapes: repo.listShapes(db, folioId) },
    created_at: nowIso()
  };
  repo.insertVersion(db, version);
  touchProject(ctx, folio.project_id);
  return version;
}

export function listVersions(ctx: ServiceContext, folioId: ID): PlanVersion[] {
  const folio = mustFolio(ctx, folioId);
  return repo.listVersions(ctx.projectDb(folio.project_id), folioId);
}

export function restoreVersion(ctx: ServiceContext, versionId: ID, author: string): PlanVersion {
  const target = findVersion(ctx, versionId);
  if (!target) throw new Error(`版本不存在: ${versionId}`);
  const db = ctx.projectDb(target.project_id);
  // 回退前自动保存当前状态，保证回退可逆
  const current: PlanVersion = {
    id: newId('ver_'),
    project_id: target.project_id,
    folio_id: target.folio_id,
    version: (repo.listVersions(db, target.folio_id)[0]?.version ?? INITIAL_PLAN_VERSION) + 1,
    label: `回退至 v${target.version} 前的自动备份`,
    note: '系统在执行版本回退时自动创建',
    author,
    snapshot: { layers: repo.listLayers(db, target.folio_id), shapes: repo.listShapes(db, target.folio_id) },
    created_at: nowIso()
  };
  repo.insertVersion(db, current);
  repo.replacePlan(db, target.folio_id, target.snapshot);
  touchProject(ctx, target.project_id);
  return target;
}

function findVersion(ctx: ServiceContext, versionId: ID): PlanVersion | null {
  for (const p of repo.listProjects(ctx.library())) {
    const db = ctx.projectDb(p.id);
    const v = repo.getVersion(db, versionId);
    if (v) return v;
  }
  return null;
}

/* ---------------- 批注 ---------------- */

export function listComments(ctx: ServiceContext, projectId: ID): Comment[] {
  return repo.listComments(ctx.projectDb(projectId), projectId);
}

export function createComment(
  ctx: ServiceContext,
  input: {
    project_id: ID;
    folio_id?: ID | null;
    target_type: CommentTarget;
    target_id?: ID | null;
    author: string;
    body: string;
  }
): Comment {
  const comment: Comment = {
    id: newId('cmt_'),
    project_id: input.project_id,
    folio_id: input.folio_id ?? null,
    target_type: input.target_type,
    target_id: input.target_id ?? null,
    author: input.author,
    body: input.body,
    resolved: false,
    created_at: nowIso()
  };
  repo.insertComment(ctx.projectDb(input.project_id), comment);
  touchProject(ctx, input.project_id);
  return comment;
}

export function resolveComment(ctx: ServiceContext, id: ID, resolved: boolean): Comment {
  const projectId = commentProjectId(ctx, id);
  const next = repo.resolveCommentRow(ctx.projectDb(projectId), id, resolved);
  touchProject(ctx, projectId);
  return next;
}

export function removeComment(ctx: ServiceContext, id: ID): void {
  const projectId = commentProjectId(ctx, id);
  repo.deleteCommentRow(ctx.projectDb(projectId), id);
  touchProject(ctx, projectId);
}

/** 批注所属项目（批注按项目分库存储） */
function commentProjectId(ctx: ServiceContext, id: ID): ID {
  for (const p of repo.listProjects(ctx.library())) {
    const hit = ctx.projectDb(p.id).prepare('SELECT 1 FROM comments WHERE id = ?').get(id);
    if (hit) return p.id;
  }
  throw new Error(`批注不存在: ${id}`);
}

/* ---------------- 工具 ---------------- */

function touchProject(ctx: ServiceContext, id: ID): void {
  repo.updateProjectRow(ctx.library(), id, { updated_at: nowIso() });
}

function mustFolio(ctx: ServiceContext, id: ID): Folio {
  for (const p of repo.listProjects(ctx.library())) {
    const f = repo.getFolio(ctx.projectDb(p.id), id);
    if (f) return f;
  }
  throw new Error(`扫描叶不存在: ${id}`);
}

/** 按 ID 反查图层所属叶与项目（图层/标注只存 folio_id，而项目库按项目分文件） */
function mustLayer(ctx: ServiceContext, id: ID): { folio_id: ID; project_id: ID } {
  for (const p of repo.listProjects(ctx.library())) {
    const row = ctx.projectDb(p.id).prepare('SELECT folio_id FROM layers WHERE id = ?').get(id) as any;
    if (row) return { folio_id: row.folio_id, project_id: p.id };
  }
  throw new Error(`图层不存在: ${id}`);
}

function mustShape(ctx: ServiceContext, id: ID): { folio_id: ID; project_id: ID } {
  for (const p of repo.listProjects(ctx.library())) {
    const row = ctx.projectDb(p.id).prepare('SELECT folio_id FROM shapes WHERE id = ?').get(id) as any;
    if (row) return { folio_id: row.folio_id, project_id: p.id };
  }
  throw new Error(`标注不存在: ${id}`);
}

/** 供样本/材料表单使用：从 hex 推导 Lab */
export function labOf(hex: string) {
  return hexToLab(hex);
}
