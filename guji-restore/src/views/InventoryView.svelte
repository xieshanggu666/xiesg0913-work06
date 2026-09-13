<script lang="ts">
  import { api } from '../lib/api';
  import {
    batches,
    inventoryMaterialFilter,
    inventoryPrefillMaterial,
    materials,
    projects
  } from '../lib/stores';
  import { guard, toast } from '../lib/toast';
  import { MATERIAL_CATEGORIES, MATERIAL_CATEGORY_META, STOCK_MOVE_META, STOCK_UNITS } from '@shared/constants';
  import { applyLibraryQuery, type LibrarySortKey } from '@shared/list-query';
  import { formatQty } from '@shared/inventory';
  import type { MaterialCategory } from '@shared/types';
  import type { BatchDetail, MaterialBatchWithQty } from '@shared/protocol';

  type SortKey = LibrarySortKey;
  let category: MaterialCategory | '' = '';
  let materialFilter = '';
  let query = '';
  let sortKey: SortKey = 'updated';
  let sortAsc = false;

  let editing: any = null; // 新建/编辑批次表单
  let detail: BatchDetail | null = null;

  // 从材料库“登记批次”带入：store 非空即打开弹窗并立即清空（一次性信号，避免重进页面误弹）
  inventoryMaterialFilter.subscribe((id) => {
    if (id) {
      materialFilter = id;
      category = '';
    }
  });
  let consumedPrefill: string | null = null;
  $: if ($inventoryPrefillMaterial && $inventoryPrefillMaterial !== consumedPrefill) {
    consumedPrefill = $inventoryPrefillMaterial;
    openCreate($inventoryPrefillMaterial);
    inventoryPrefillMaterial.set(null);
  }

  function blank(prefillMaterial = '') {
    return {
      material_id: prefillMaterial || $materials[0]?.id || '',
      batch_no: '',
      unit: STOCK_UNITS[0] as string,
      initial_qty: '',
      supplier_lot: '',
      received_at: new Date().toISOString().slice(0, 10),
      note: ''
    };
  }
  function openCreate(prefill = '') {
    materialFilter = prefill || materialFilter;
    editing = blank(prefill);
  }
  function openEdit(b: MaterialBatchWithQty) {
    editing = {
      id: b.id,
      material_id: b.material_id,
      batch_no: b.batch_no,
      unit: b.unit,
      supplier_lot: b.supplier_lot,
      received_at: (b.received_at || '').slice(0, 10),
      note: b.note
    };
  }

  async function save() {
    if (!editing.material_id) return toast('请选择材料', 'error');
    if (!editing.batch_no.trim()) return toast('请填写批次号', 'error');
    if (!editing.unit.trim()) return toast('请填写计量单位', 'error');
    if (editing.id) {
      const r = await guard(
        api.inventory.updateBatch(editing.id, {
          batch_no: editing.batch_no.trim(),
          supplier_lot: editing.supplier_lot,
          received_at: editing.received_at,
          note: editing.note
        }),
        '保存失败'
      );
      if (r) {
        editing = null;
        batches.set(await api.inventory.batches());
        if (detail) await openDetail(detail.batch.id);
        toast('批次已更新');
      }
    } else {
      const qty = Number(editing.initial_qty);
      if (!Number.isFinite(qty) || qty <= 0) return toast('入库数量必须大于 0', 'error');
      const r = await guard(
        api.inventory.createBatch({
          material_id: editing.material_id,
          batch_no: editing.batch_no.trim(),
          unit: editing.unit.trim(),
          initial_qty: qty,
          supplier_lot: editing.supplier_lot,
          received_at: editing.received_at,
          note: editing.note
        }),
        '登记批次失败'
      );
      if (r) {
        editing = null;
        // 登记后按该材料过滤，便于立刻看到新批次
        inventoryMaterialFilter.set(r.material_id);
        materialFilter = r.material_id;
        batches.set(await api.inventory.batches());
        toast('批次已登记，入库数量已计入台账');
      }
    }
  }

  async function remove(b: MaterialBatchWithQty) {
    if (!confirm(`删除批次「${b.batch_no}」？\n仅在该批次尚无任何领用/退料记录时允许。`)) return;
    const r = await guard(api.inventory.removeBatch(b.id), '删除失败');
    if (r === undefined) {
      batches.set(await api.inventory.batches());
      toast('批次已删除');
    }
  }

  async function openDetail(id: string) {
    const r = await guard(api.inventory.batchDetail(id), '读取批次流水失败');
    if (r) detail = r;
  }
  function closeDetail() {
    detail = null;
  }

  function matName(id: string) {
    return $materials.find((m) => m.id === id)?.name ?? '已删除材料';
  }

  // 类别 + 材料筛选后再做关键词搜索与排序
  $: categoryFiltered = category ? $batches.filter((b) => b.material_category === category) : $batches;
  $: materialFiltered = materialFilter
    ? categoryFiltered.filter((b) => b.material_id === materialFilter)
    : categoryFiltered;
  $: visible = applyLibraryQuery(
    materialFiltered.map((b) => ({
      ...b,
      // applyLibraryQuery 按 name/updated_at 排序；用材料名+批次号参与名称排序
      name: `${matName(b.material_id)} ${b.batch_no}`,
      updated_at: b.received_at
    })),
    query,
    [(b) => b.name, (b) => b.batch_no, (b) => b.supplier_lot, (b) => b.note],
    { key: sortKey, asc: sortAsc }
  );
</script>

<div class="view-head">
  <h2>材料领用与批次追溯</h2>
  <div class="spacer"></div>
  <button class="btn secondary" on:click={() => openCreate()}>＋ 登记批次</button>
</div>

<div class="toolbar">
  <div class="filters">
    <button class="btn tiny ghost" class:on={category === ''} on:click={() => (category = '')}>全部类别</button>
    {#each MATERIAL_CATEGORIES as c}
      <button class="btn tiny ghost" class:on={category === c} on:click={() => { category = c; materialFilter = ''; }}>
        {MATERIAL_CATEGORY_META[c]}
      </button>
    {/each}
  </div>
  <select bind:value={materialFilter} aria-label="按材料筛选" class="mat-select">
    <option value="">全部材料</option>
    {#each $materials as m}
      <option value={m.id}>{m.name}</option>
    {/each}
  </select>
  <div class="search-box">
    <input type="search" bind:value={query} placeholder="搜索批次号、供应商批号、备注…" aria-label="搜索批次" />
    {#if query}
      <button class="clear" on:click={() => (query = '')} aria-label="清空搜索" title="清空搜索">×</button>
    {/if}
  </div>
  <label class="sort">
    排序
    <select bind:value={sortKey} aria-label="排序字段">
      <option value="updated">按入库时间</option>
      <option value="name">按材料/批次名</option>
    </select>
    <button class="btn tiny ghost" on:click={() => (sortAsc = !sortAsc)} title="切换升序/降序">
      {sortAsc ? '升序 ↑' : '降序 ↓'}
    </button>
  </label>
  <span class="count">共 {visible.length} 个批次</span>
</div>

{#if visible.length === 0}
  <div class="empty">
    {#if $batches.length === 0}
      尚无入库批次。先在「材料推荐」录入材料，再点击右上角「＋ 登记批次」登记批次号、计量单位与入库数量。
    {:else}
      当前筛选条件下没有批次，可
      <button class="link" on:click={() => { category = ''; materialFilter = ''; query = ''; }}>清空筛选</button>。
    {/if}
  </div>
{/if}

<div class="table-wrap card">
  <table class="batch-table">
    <thead>
      <tr>
        <th>材料</th>
        <th>批次号</th>
        <th>供应商批号 / 来源</th>
        <th>入库日期</th>
        <th class="num">入库</th>
        <th class="num">已领</th>
        <th class="num">已退</th>
        <th class="num">剩余</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      {#each visible as b (b.id)}
        <tr class:empty-qty={b.remaining_qty <= 0}>
          <td>
            <div class="mat-cell">
              <i class="dot" style={`background:${$materials.find((m) => m.id === b.material_id)?.color_hex || '#ccc'}`}></i>
              <span>{b.material_name}</span>
            </div>
            <div class="muted cat">{MATERIAL_CATEGORY_META[b.material_category]}</div>
          </td>
          <td><b>{b.batch_no}</b></td>
          <td class="muted">{b.supplier_lot || '—'}</td>
          <td class="muted">{(b.received_at || '').slice(0, 10)}</td>
          <td class="num">{formatQty(b.initial_qty)} {b.unit}</td>
          <td class="num out">{formatQty(b.issued_total)}</td>
          <td class="num back">{b.returned_total ? formatQty(b.returned_total) : '—'}</td>
          <td class="num"><b class:zero={b.remaining_qty <= 0}>{formatQty(b.remaining_qty)} {b.unit}</b></td>
          <td class="ops">
            <button class="btn tiny ghost" on:click={() => openDetail(b.id)}>流水</button>
            <button class="btn tiny ghost" on:click={() => openEdit(b)}>编辑</button>
            <button class="btn tiny ghost danger" on:click={() => remove(b)}>删除</button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<p class="hint muted">
  领料与退料在「修复工序」中按工序记录选择批次并填写数量；批次流水只追加、不修改，保证选材结果可追溯到实际使用批次。
</p>

{#if editing}
  <div class="modal-backdrop" on:click={() => (editing = null)}>
    <div class="modal" on:click|stopPropagation>
      <h3>{editing.id ? '编辑批次' : '登记入库批次'}</h3>
      <div class="field">
        <label>材料 *</label>
        <select bind:value={editing.material_id} disabled={!!editing.id}>
          {#each $materials as m}<option value={m.id}>{m.name}（{MATERIAL_CATEGORY_META[m.category]}）</option>{/each}
        </select>
      </div>
      <div class="two">
        <div class="field"><label>批次号 *</label><input bind:value={editing.batch_no} placeholder="如 2026-A-01" /></div>
        <div class="field">
          <label>计量单位 *</label>
          <input list="stock-units" bind:value={editing.unit} placeholder="张 / cm / g" />
          <datalist id="stock-units">
            {#each STOCK_UNITS as u}<option value={u} />{/each}
          </datalist>
        </div>
      </div>
      {#if !editing.id}
        <div class="two">
          <div class="field"><label>入库数量 *</label><input type="number" step="0.01" min="0" bind:value={editing.initial_qty} /></div>
          <div class="field"><label>入库日期</label><input type="date" bind:value={editing.received_at} /></div>
        </div>
      {:else}
        <div class="field"><label>入库日期</label><input type="date" bind:value={editing.received_at} /></div>
      {/if}
      <div class="field"><label>供应商批号 / 来源说明</label><input bind:value={editing.supplier_lot} placeholder="如 泾县宣纸厂 / 入厂批号 2603" /></div>
      <div class="field"><label>备注</label><textarea bind:value={editing.note}></textarea></div>
      {#if editing.id}<p class="muted tiny">入库数量不可直接修改；如需调整请通过领料/退料流水留痕。</p>{/if}
      <div class="actions">
        <button class="btn ghost" on:click={() => (editing = null)}>取消</button>
        <button class="btn" on:click={save}>保存</button>
      </div>
    </div>
  </div>
{/if}

{#if detail}
  <div class="modal-backdrop" on:click={closeDetail}>
    <div class="modal wide" on:click|stopPropagation>
      <div class="detail-head">
        <h3>批次流水 · {detail.batch.batch_no}</h3>
        <button class="btn tiny ghost" on:click={() => openEdit(detail.batch)}>编辑批次</button>
      </div>
      <div class="detail-meta">
        <div><span class="muted">材料</span><b>{detail.material?.name ?? '已删除材料'}</b></div>
        <div><span class="muted">单位</span>{detail.batch.unit}</div>
        <div><span class="muted">入库</span>{formatQty(detail.batch.initial_qty)}</div>
        <div><span class="muted">剩余</span><b class={detail.remaining_qty <= 0 ? 'zero' : ''}>{formatQty(detail.remaining_qty)} {detail.batch.unit}</b></div>
        <div><span class="muted">入库日期</span>{(detail.batch.received_at || '').slice(0, 10)}</div>
        {#if detail.batch.supplier_lot}<div><span class="muted">来源</span>{detail.batch.supplier_lot}</div>{/if}
      </div>

      <h4 class="sub">批次流水</h4>
      <ul class="ledger">
        {#each detail.ledger as m (m.id)}
          <li>
            <span class="tag kind" style={`background:${STOCK_MOVE_META[m.kind].color}`}>{STOCK_MOVE_META[m.kind].label}</span>
            <span class="when">{(m.moved_at || '').slice(0, 10)}</span>
            <span class="who muted">{m.operator || '—'}</span>
            {#if m.kind !== 'in'}
              <span class="muted where">
                {#if m.project_id}{$projects.find((p) => p.id === m.project_id)?.name ?? '项目'}{/if}
                {m.step_id ? ' · 工序领用' : m.project_id ? ' · 整卷' : ''}
              </span>
            {/if}
            <span class="qty" class:in={m.kind === 'in' || m.kind === 'return'} class:out={m.kind === 'issue'}>
              {m.kind === 'issue' ? '−' : '+'}{formatQty(m.qty)} {detail.batch.unit}
            </span>
            <span class="note muted">{m.note}</span>
          </li>
        {/each}
      </ul>

      <h4 class="sub">关联工序（{detail.linked_steps.length}）</h4>
      {#if detail.linked_steps.length === 0}
        <p class="muted tiny">该批次尚未被任何工序领用。领料请在「修复工序」中选择本批次。</p>
      {:else}
        <ul class="linked">
          {#each detail.linked_steps as ls (ls.step_id)}
            <li>
              <span class="ord">{ls.order_index}</span>
              <span class="t">{ls.title}</span>
              <span class="muted">{ls.project_name}</span>
              <span class="qty net">净领用 {formatQty(ls.qty)} {detail.batch.unit}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="actions">
        <button class="btn ghost" on:click={closeDetail}>关闭</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .view-head {
    display: flex;
    align-items: center;
    padding: 16px 22px 0;
  }
  h2 { font-size: 17px; }
  .spacer { flex: 1; }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 10px 22px 0;
  }
  .filters { display: flex; gap: 6px; flex-wrap: wrap; }
  .mat-select { padding: 5px 8px; font-size: 12px; max-width: 160px; }
  .search-box {
    position: relative;
    flex: 1 1 200px;
    min-width: 180px;
    max-width: 320px;
  }
  .search-box input { width: 100%; padding: 5px 26px 5px 10px; font-size: 13px; }
  .clear {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    border: none; background: transparent; color: #8a7d6b; font-size: 16px;
    line-height: 1; cursor: pointer; padding: 2px 4px;
  }
  .sort { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6f6150; white-space: nowrap; }
  .sort select { padding: 4px 6px; font-size: 12px; }
  .count { font-size: 12px; color: #8a7d6b; }
  .empty {
    margin: 18px 22px 0;
    background: #f5eddc;
    border: 1px dashed var(--line);
    border-radius: 8px;
  }
  .link {
    border: none; background: none; color: var(--accent); cursor: pointer;
    font-size: inherit; padding: 0; text-decoration: underline;
  }
  .table-wrap { margin: 14px 22px 0; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #ece2cd; white-space: nowrap; }
  th { font-size: 12px; color: #8a7d6b; font-weight: 500; background: #faf4e8; position: sticky; top: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:last-child td { border-bottom: none; }
  tr.empty-qty { opacity: 0.62; }
  .mat-cell { display: flex; align-items: center; gap: 7px; }
  .dot { width: 10px; height: 10px; border-radius: 2px; border: 1px solid var(--line); display: inline-block; }
  .cat { font-size: 11px; margin-top: 2px; }
  .out { color: var(--blue); }
  .back { color: #b08900; }
  .zero { color: #b08900; }
  .ops { display: flex; gap: 5px; }
  .danger { color: #a23a2c; }
  .hint { margin: 12px 22px 0; font-size: 12px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .tiny { font-size: 12px; }

  .modal.wide { min-width: 600px; max-width: 720px; }
  .detail-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .detail-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 13px; margin-bottom: 14px; }
  .detail-meta div { display: flex; flex-direction: column; gap: 2px; }
  .detail-meta .muted { font-size: 11px; }
  .sub { font-size: 13px; margin: 14px 0 8px; color: var(--ink-soft); }
  .ledger { display: flex; flex-direction: column; gap: 6px; }
  .ledger li {
    display: flex; align-items: center; gap: 10px; font-size: 12.5px;
    padding: 6px 8px; background: #fbf6ec; border-radius: 5px;
  }
  .ledger .when { min-width: 86px; }
  .ledger .who { min-width: 70px; }
  .ledger .qty { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
  .ledger .qty.out { color: var(--blue); }
  .ledger .qty.in { color: var(--green); }
  .ledger .note { flex: 1; }
  .kind { min-width: 38px; text-align: center; }
  .linked { display: flex; flex-direction: column; gap: 6px; }
  .linked li {
    display: flex; align-items: center; gap: 10px; font-size: 12.5px;
    padding: 6px 8px; background: #fbf6ec; border-radius: 5px;
  }
  .linked .ord {
    width: 22px; height: 22px; border-radius: 50%; background: var(--paper-deep);
    display: flex; align-items: center; justify-content: center; font-size: 11px;
  }
  .linked .t { font-weight: 600; }
  .linked .qty { margin-left: auto; }
  .linked .qty.net { color: var(--accent); }
</style>
