/**
 * 材料领用（批次追溯）的纯领域逻辑：批次台账、剩余数量、退料余量与校验。
 * 主进程服务、渲染进程 UI 与单测共用，避免库存口径在多处漂移。
 *
 * 库存口径（只追加流水，不存冗余余量）：
 *   剩余 = 入库数量 - Σ领料 + Σ退料
 * 入库本身不单独落 movement，而是建批次时由 initial_qty 登记；
 * 查看流水时由批次合成一条「入库」记录，使台账首尾完整、可追溯。
 */
import type { MaterialBatch, Material, StockMoveKind, StockMovement, ID } from './types.js';

/** 数量浮点误差容差（界面录入支持小数，如 12.5cm） */
const EPS = 1e-6;

/** 汇总数量时消除浮点尾差（保留到 0.000001） */
export function roundQty(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

/** 展示用：去掉多余尾零（12.50 → 12.5，12 → 12） */
export function formatQty(n: number): string {
  return String(roundQty(n));
}

/** 批次的全部流水（含由批次合成的入库记录），按发生时间升序 */
export function batchLedger(batch: MaterialBatch, movements: StockMovement[]): StockMovement[] {
  const inbound: StockMovement = {
    id: `in:${batch.id}`,
    batch_id: batch.id,
    kind: 'in',
    qty: batch.initial_qty,
    project_id: null,
    step_id: null,
    operator: '',
    moved_at: batch.received_at,
    note: batch.supplier_lot ? `入库登记（${batch.supplier_lot}）` : '入库登记',
    related_move_id: null,
    created_at: batch.created_at
  };
  return [inbound, ...movements.filter((m) => m.batch_id === batch.id)].sort(
    (a, b) => a.moved_at.localeCompare(b.moved_at) || a.created_at.localeCompare(b.created_at)
  );
}

/** 批次当前剩余数量 = 入库 - 累计净领料（领料 - 退料） */
export function batchRemaining(batch: MaterialBatch, movements: StockMovement[]): number {
  let issued = 0;
  let returned = 0;
  for (const m of movements) {
    if (m.batch_id !== batch.id) continue;
    if (m.kind === 'issue') issued += m.qty;
    else if (m.kind === 'return') returned += m.qty;
  }
  return roundQty(batch.initial_qty - issued + returned);
}

/** 某次领料当前未退数量（可部分退料，允许多次退料累计） */
export function issueOutstanding(issue: StockMovement, movements: StockMovement[]): number {
  if (issue.kind !== 'issue') return 0;
  let returned = 0;
  for (const m of movements) {
    if (m.kind === 'return' && m.related_move_id === issue.id) returned += m.qty;
  }
  return roundQty(Math.max(0, issue.qty - returned));
}

/** 领料校验：数量合法且批次余量充足；返回错误信息，合法为 null */
export function checkIssue(batch: MaterialBatch, movements: StockMovement[], qty: number): string | null {
  if (!Number.isFinite(qty) || qty <= 0) return '领用量必须大于 0';
  const remaining = batchRemaining(batch, movements);
  if (qty > remaining + EPS) return `批次剩余不足：当前剩余 ${formatQty(remaining)} ${batch.unit}`;
  return null;
}

/** 退料校验：源流水须为领料，数量合法且不超过该次领料未退数量；unit 用于错误信息 */
export function checkReturn(
  source: StockMovement,
  movements: StockMovement[],
  qty: number,
  unit = ''
): string | null {
  if (source.kind !== 'issue') return '只能针对领料记录退料';
  if (!Number.isFinite(qty) || qty <= 0) return '退料数量必须大于 0';
  const outstanding = issueOutstanding(source, movements);
  if (qty > outstanding + EPS) {
    return `退料数量超过该次领料未退数量（${formatQty(outstanding)}${unit ? ' ' + unit : ''}）`;
  }
  return null;
}

/** 关联到具体工序/批次/材料的一条领料（含已退、未退），用于工序用材与批次流水展示 */
export interface StepIssueUsage {
  move: StockMovement;
  material: Material | null;
  batch: MaterialBatch | null;
  returned_qty: number;
  outstanding_qty: number;
}

/** 汇总某道工序的全部领料记录（不含退料；退料挂在对应领料下展示） */
export function stepIssues(
  stepId: ID,
  ctx: {
    movements: StockMovement[];
    batches: MaterialBatch[];
    materials: Material[];
  }
): StepIssueUsage[] {
  const batchById = new Map(ctx.batches.map((b) => [b.id, b]));
  const matById = new Map(ctx.materials.map((m) => [m.id, m]));
  return ctx.movements
    .filter((m) => m.kind === 'issue' && m.step_id === stepId)
    .sort((a, b) => a.moved_at.localeCompare(b.moved_at))
    .map((move) => {
      const batch = batchById.get(move.batch_id) ?? null;
      return {
        move,
        batch,
        material: batch ? matById.get(batch.material_id) ?? null : null,
        returned_qty: roundQty(move.qty - issueOutstanding(move, ctx.movements)),
        outstanding_qty: issueOutstanding(move, ctx.movements)
      };
    });
}

/** 批次在某项目下被哪些工序领用（去重，供批次详情“关联工序”） */
export function batchLinkedStepIds(batchId: ID, movements: StockMovement[]): ID[] {
  const ids: ID[] = [];
  for (const m of movements) {
    if (m.batch_id === batchId && m.kind === 'issue' && m.step_id && !ids.includes(m.step_id)) {
      ids.push(m.step_id);
    }
  }
  return ids;
}

/** 构造一条流水的工厂（统一数量取正、方向由 kind 表达） */
export function makeMovement(input: {
  id: ID;
  batch_id: ID;
  kind: StockMoveKind;
  qty: number;
  project_id?: ID | null;
  step_id?: ID | null;
  operator: string;
  moved_at: string;
  note?: string;
  related_move_id?: ID | null;
  created_at: string;
}): StockMovement {
  return {
    id: input.id,
    batch_id: input.batch_id,
    kind: input.kind,
    qty: roundQty(Math.abs(input.qty)),
    project_id: input.project_id ?? null,
    step_id: input.step_id ?? null,
    operator: input.operator,
    moved_at: input.moved_at,
    note: input.note ?? '',
    related_move_id: input.related_move_id ?? null,
    created_at: input.created_at
  };
}
