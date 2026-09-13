import { describe, expect, it } from 'vitest';
import type { Material, MaterialBatch, StockMovement } from '@shared/types';
import {
  batchLedger,
  batchLinkedStepIds,
  batchRemaining,
  checkBatchNo,
  checkIssue,
  checkReturn,
  issueOutstanding,
  makeMovement,
  roundQty,
  stepIssues
} from '@shared/inventory';

function batch(over: Partial<MaterialBatch> = {}): MaterialBatch {
  return {
    id: 'bat_1',
    material_id: 'mat_1',
    batch_no: 'B-1',
    unit: '张',
    initial_qty: 50,
    supplier_lot: 'lot-x',
    received_at: '2026-09-01T00:00:00.000Z',
    note: '',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over
  };
}

function move(over: Partial<StockMovement>): StockMovement {
  return {
    id: 'mv_x',
    batch_id: 'bat_1',
    kind: 'issue',
    qty: 10,
    project_id: 'prj_1',
    step_id: 'stp_1',
    operator: '甲',
    moved_at: '2026-09-02T00:00:00.000Z',
    note: '',
    related_move_id: null,
    created_at: '2026-09-02T00:00:00.000Z',
    ...over
  };
}

describe('库存纯函数', () => {
  it('roundQty 消除浮点尾差', () => {
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
    expect(roundQty(-0)).toBe(0);
  });

  it('makeMovement 数量取绝对值，方向由 kind 表达', () => {
    const m = makeMovement({
      id: 'm', batch_id: 'b', kind: 'issue', qty: -5, operator: '', moved_at: 't', created_at: 'c'
    });
    expect(m.qty).toBe(5);
  });

  it('剩余 = 入库 - 领料 + 退料', () => {
    const b = batch();
    expect(batchRemaining(b, [])).toBe(50);
    const issue1 = move({ id: 'i1', qty: 10 });
    expect(batchRemaining(b, [issue1])).toBe(40);
    // 部分退料 4
    const ret = move({ id: 'r1', kind: 'return', qty: 4, related_move_id: 'i1', step_id: 'stp_1' });
    expect(batchRemaining(b, [issue1, ret])).toBe(44);
  });

  it('入库流水由批次合成，台账首尾完整且按时间升序', () => {
    const b = batch();
    const issue = move({ id: 'i1', qty: 6, moved_at: '2026-09-05T00:00:00.000Z' });
    const ledger = batchLedger(b, [issue]);
    expect(ledger).toHaveLength(2);
    expect(ledger[0].kind).toBe('in');
    expect(ledger[0].qty).toBe(50);
    expect(ledger[1].id).toBe('i1');
  });

  it('领料校验：非正数与超余量被拒绝', () => {
    const b = batch({ initial_qty: 5 });
    expect(checkIssue(b, [], 0)).toMatch(/大于 0/);
    expect(checkIssue(b, [], 6)).toMatch(/剩余不足/);
    // 考虑已退料后的余量
    const issue = move({ id: 'i1', qty: 4 });
    const ret = move({ id: 'r1', kind: 'return', qty: 4, related_move_id: 'i1' });
    expect(checkIssue(b, [issue, ret], 5)).toBeNull();
  });

  it('退料未退数量随部分/多次退料递减，不能超退', () => {
    const issue = move({ id: 'i1', qty: 10 });
    expect(issueOutstanding(issue, [issue])).toBe(10);
    const r1 = move({ id: 'r1', kind: 'return', qty: 3, related_move_id: 'i1' });
    expect(issueOutstanding(issue, [issue, r1])).toBe(7);
    // 超退报错并带单位
    expect(checkReturn(issue, [issue, r1], 8, '张')).toMatch(/超过.*7 张/);
    // 退完
    const r2 = move({ id: 'r2', kind: 'return', qty: 7, related_move_id: 'i1' });
    expect(issueOutstanding(issue, [issue, r1, r2])).toBe(0);
    expect(checkReturn(issue, [issue, r1, r2], 1)).toMatch(/超过/);
  });

  it('checkReturn 拒绝非领料流水', () => {
    const inbound = move({ id: 'x', kind: 'return' });
    expect(checkReturn(inbound, [], 1)).toMatch(/领料记录/);
  });

  it('stepIssues 汇总工序领料的已退/未退，并关联材料与批次', () => {
    const material: Material = {
      id: 'mat_1', name: '净皮棉连', category: 'xuan', color_hex: '#fff', lab: null,
      fiber: '', thickness_mm: null, weight_gsm: null, weave: '', ph: null,
      supplier: '', note: '', created_at: '', updated_at: ''
    };
    const b = batch();
    const i1 = move({ id: 'i1', qty: 10, step_id: 'stp_1', moved_at: '2026-09-03T00:00:00.000Z' });
    const i2 = move({ id: 'i2', qty: 4, step_id: 'stp_1', moved_at: '2026-09-04T00:00:00.000Z' });
    const r1 = move({ id: 'r1', kind: 'return', qty: 2, related_move_id: 'i1', step_id: 'stp_1' });
    const other = move({ id: 'i3', qty: 9, step_id: 'stp_2' });
    const rows = stepIssues('stp_1', {
      movements: [i1, i2, r1, other],
      batches: [b],
      materials: [material]
    });
    expect(rows).toHaveLength(2); // 仅 stp_1 的两条领料，按时间升序
    expect(rows[0].move.id).toBe('i1');
    expect(rows[0].material?.name).toBe('净皮棉连');
    expect(rows[0].returned_qty).toBe(2);
    expect(rows[0].outstanding_qty).toBe(8);
    expect(rows[1].outstanding_qty).toBe(4);
  });

  it('batchLinkedStepIds 去重返回关联工序', () => {
    const moves = [
      move({ id: 'i1', step_id: 's1' }),
      move({ id: 'i2', step_id: 's1' }),
      move({ id: 'i3', step_id: 's2' }),
      move({ id: 'r1', kind: 'return', step_id: 's1', related_move_id: 'i1' })
    ];
    expect(batchLinkedStepIds('bat_1', moves)).toEqual(['s1', 's2']);
  });

  describe('checkBatchNo 批次号唯一校验', () => {
    const batches: MaterialBatch[] = [
      batch({ id: 'b1', material_id: 'm1', batch_no: '2026-A-01' }),
      batch({ id: 'b2', material_id: 'm1', batch_no: '2026-B-07' }),
      batch({ id: 'b3', material_id: 'm2', batch_no: '2026-A-01' })
    ];

    it('空批次号被拒绝', () => {
      expect(checkBatchNo('   ', batches, 'm1')).toMatch(/请填写批次号/);
    });

    it('同一材料下批次号重复（忽略大小写/空白）被拒绝', () => {
      expect(checkBatchNo(' 2026-a-01 ', batches, 'm1')).toMatch(/已存在批次号/);
    });

    it('不同材料允许相同批次号', () => {
      expect(checkBatchNo('2026-A-01', batches, 'm9')).toBeNull();
    });

    it('同一材料下不重复的批次号通过', () => {
      expect(checkBatchNo('2026-C-99', batches, 'm1')).toBeNull();
    });

    it('编辑自身时传入 excludeId 排除当前批次：改成自己的号允许', () => {
      expect(checkBatchNo('2026-a-01', batches, 'm1', 'b1')).toBeNull();
    });

    it('编辑时改成同材料其它批次的号仍被拒绝', () => {
      expect(checkBatchNo('2026-b-07', batches, 'm1', 'b1')).toMatch(/已存在批次号/);
      // 排除 id 不属于该材料不影响查重
      expect(checkBatchNo('2026-B-07', batches, 'm1', 'b3')).toMatch(/已存在批次号/);
    });
  });
});
