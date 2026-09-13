<script lang="ts">
  import { api } from '../lib/api';
  import { onMount } from 'svelte';
  import {
    batches,
    currentProjectId,
    folios,
    materials,
    operator,
    steps,
    stepIssuesMap
  } from '../lib/stores';
  import { guard, toast } from '../lib/toast';
  import { writable } from 'svelte/store';
  import { TECHNIQUES, STOCK_MOVE_META } from '@shared/constants';
  import { formatQty } from '@shared/inventory';
  import type { StockMovement } from '@shared/types';
  import type { MaterialBatchWithQty, StepIssueRow } from '@shared/protocol';

  let editing: any = null;
  let issuingFor: { stepId: string | null; stepTitle: string; suggestedMaterial: string } | null = null;
  let issueForm: any = null;
  let returningFor: StepIssueRow | null = null;
  let returnForm: any = null;

  // 不绑定具体工序的整卷领用/退料流水（项目级）
  const projectMoves = writable<StockMovement[]>([]);
  let wholeRollRows: StepIssueRow[] = [];

  onMount(() => loadProjectMoves());
  async function loadProjectMoves() {
    if ($currentProjectId) projectMoves.set(await api.inventory.projectMovements($currentProjectId));
  }
  // 整卷领料行（kind=issue 且无 step_id），附批次/材料与已退/未退
  $: wholeRollRows = $projectMoves
    .filter((m) => m.kind === 'issue' && !m.step_id)
    .map((move) => {
      const b = $batches.find((x) => x.id === move.batch_id) ?? null;
      const returned = $projectMoves
        .filter((m) => m.kind === 'return' && m.related_move_id === move.id)
        .reduce((a, m) => a + m.qty, 0);
      return {
        move,
        batch: b,
        material: b ? $materials.find((x) => x.id === b.material_id) ?? null : null,
        returned_qty: Math.round(returned * 1e6) / 1e6,
        outstanding_qty: Math.round((move.qty - returned) * 1e6) / 1e6
      } as StepIssueRow;
    });

  function blank() {
    return {
      title: '',
      technique: TECHNIQUES[0],
      folio_id: '',
      material_ids: [],
      operator: $operator,
      performed_at: new Date().toISOString().slice(0, 10),
      duration_min: '',
      note: ''
    };
  }

  async function save() {
    const pid = $currentProjectId;
    if (!pid || !editing.title.trim()) return toast('请填写工序名称', 'error');
    const payload = {
      project_id: pid,
      folio_id: editing.folio_id || null,
      order_index: editing.id
        ? steps.find((s) => s.id === editing.id)?.order_index ?? $steps.length + 1
        : $steps.length + 1,
      title: editing.title.trim(),
      technique: editing.technique,
      material_ids: editing.material_ids,
      operator: editing.operator || '修复师',
      performed_at: editing.performed_at,
      duration_min: editing.duration_min === '' ? null : Number(editing.duration_min),
      photo_rel: null,
      note: editing.note
    };
    const r = editing.id
      ? await guard(api.steps.update(editing.id, payload), '保存失败')
      : await guard(api.steps.create(payload), '新建工序失败');
    if (r) {
      editing = null;
      steps.set(await api.steps.list(pid));
      toast('工序已记录');
    }
  }
  async function remove(id: string) {
    if (!confirm('删除该道工序记录？该工序的领料流水会保留并转为整卷领用。')) return;
    await guard(api.steps.remove(id), '删除失败');
    steps.set(await api.steps.list($currentProjectId));
    await refreshIssues();
  }
  async function move(id: string, dir: -1 | 1) {
    const list = [...$steps].sort((a, b) => a.order_index - b.order_index);
    const i = list.findIndex((s) => s.id === id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    await guard(api.steps.update(id, { order_index: list[j].order_index }), '调整失败');
    await guard(api.steps.update(list[j].id, { order_index: list[i].order_index }), '调整失败');
    steps.set(await api.steps.list($currentProjectId));
  }
  function matName(id: string) {
    return $materials.find((m) => m.id === id)?.name ?? id;
  }

  /* ---------------- 领料 / 退料 ---------------- */

  $: batchesOfStepMaterial = (materialId: string) =>
    $batches.filter((b) => b.material_id === materialId && b.remaining_qty > 0);

  // 直接在模板里读 store（$stepIssuesMap），Svelte 才能在整表替换时重新渲染；
  // 用函数包裹会丢失响应式依赖（曾导致领料后不显示，需切换页面才刷新）。
  function issuesOf(stepId: string, map: Record<string, StepIssueRow[]>): StepIssueRow[] {
    return map[stepId] ?? [];
  }

  function openIssue(stepId: string | null, stepTitle: string, suggestedMaterial = '') {
    if (!$currentProjectId) return toast('请先选择项目', 'error');
    issuingFor = { stepId, stepTitle, suggestedMaterial };
    // 默认选：建议材料（工序用材）的第一个有余量批次，否则第一个有余量批次
    const withStock = $batches.filter((b) => b.remaining_qty > 0);
    const first =
      (suggestedMaterial && withStock.find((b) => b.material_id === suggestedMaterial)) || withStock[0];
    issueForm = {
      batch_id: first?.id ?? '',
      material_id: first?.material_id ?? suggestedMaterial,
      qty: '',
      operator: $operator,
      moved_at: new Date().toISOString().slice(0, 10),
      note: ''
    };
  }

  // 选择材料时联动默认批次；选择批次时回填材料
  function onMaterialChange() {
    const cand = $batches.find((b) => b.material_id === issueForm.material_id && b.remaining_qty > 0);
    issueForm.batch_id = cand?.id ?? '';
  }
  function onBatchChange() {
    const b = $batches.find((x) => x.id === issueForm.batch_id);
    if (b) issueForm.material_id = b.material_id;
  }
  function selectedBatch(): MaterialBatchWithQty | undefined {
    return $batches.find((b) => b.id === issueForm?.batch_id);
  }
  function issuePlaceholder(): string {
    const b = selectedBatch();
    return b ? `不超过 ${formatQty(b.remaining_qty)} ${b.unit}` : '';
  }

  async function submitIssue() {
    const pid = $currentProjectId;
    if (!pid || !issuingFor) return;
    if (!issueForm.batch_id) return toast('请选择有库存的批次', 'error');
    const qty = Number(issueForm.qty);
    if (!Number.isFinite(qty) || qty <= 0) return toast('领用量必须大于 0', 'error');
    const r = await guard(
      api.inventory.issue({
        batch_id: issueForm.batch_id,
        project_id: pid,
        step_id: issuingFor.stepId,
        qty,
        operator: issueForm.operator || '修复师',
        moved_at: issueForm.moved_at,
        note: issueForm.note
      }),
      '领料失败'
    );
    if (r) {
      issuingFor = null;
      issueForm = null;
      batches.set(await api.inventory.batches());
      await refreshIssues();
      toast('已登记领料，批次余量已扣减');
    }
  }

  function openReturn(row: StepIssueRow) {
    returningFor = row;
    returnForm = {
      qty: String(row.outstanding_qty),
      operator: $operator,
      moved_at: new Date().toISOString().slice(0, 10),
      note: ''
    };
  }
  async function submitReturn() {
    if (!returningFor) return;
    const qty = Number(returnForm.qty);
    if (!Number.isFinite(qty) || qty <= 0) return toast('退料数量必须大于 0', 'error');
    const r = await guard(
      api.inventory.returnToStock({
        source_move_id: returningFor.move.id,
        qty,
        operator: returnForm.operator || '修复师',
        moved_at: returnForm.moved_at,
        note: returnForm.note
      }),
      '退料失败'
    );
    if (r) {
      returningFor = null;
      returnForm = null;
      batches.set(await api.inventory.batches());
      await refreshIssues();
      toast('已登记退料，批次余量已回补');
    }
  }

  async function refreshIssues() {
    const map: Record<string, StepIssueRow[]> = {};
    await Promise.all(
      $steps.map(async (s) => {
        map[s.id] = await api.inventory.stepIssues(s.id);
      })
    );
    stepIssuesMap.set(map);
    await loadProjectMoves();
  }

  function batchName(b: MaterialBatchWithQty | null) {
    return b ? b.batch_no : '批次已删除';
  }
</script>

<div class="view-head">
  <h2>修复工序记录</h2>
  <div class="spacer"></div>
  <button class="btn secondary" on:click={() => (editing = blank())}>＋ 记一道工序</button>
</div>

<ol class="step-list">
  {#each [...$steps].sort((a, b) => a.order_index - b.order_index) as s, i}
    <li class="card step">
      <div class="ord">{s.order_index}</div>
      <div class="body">
        <h3>{s.title}</h3>
        <div class="meta">
          <span class="tag" style="background:var(--green)">{s.technique}</span>
          {s.folio_id ? $folios.find((f) => f.id === s.folio_id)?.name : '整卷'}
          <span class="muted">· {s.operator} · {s.performed_at.slice(0, 10)}</span>
          {#if s.duration_min}<span class="muted"> · {s.duration_min} 分钟</span>{/if}
        </div>
        {#if s.material_ids.length}
          <div class="mats">选材：{s.material_ids.map(matName).join('、')}</div>
        {/if}

        {#if issuesOf(s.id, $stepIssuesMap).length}
          <ul class="issues">
            {#each issuesOf(s.id, $stepIssuesMap) as row (row.move.id)}
              <li>
                <span class="tag kind" style={`background:${STOCK_MOVE_META.issue.color}`}>领料</span>
                <b>{row.material?.name ?? '已删除材料'}</b>
                <span class="muted">批次 {batchName(row.batch)}</span>
                <span class="qty">领 {formatQty(row.move.qty)} {row.batch?.unit ?? ''}</span>
                {#if row.returned_qty > 0}
                  <span class="ret">已退 {formatQty(row.returned_qty)}</span>
                {/if}
                <span class="outstanding">未退 {formatQty(row.outstanding_qty)}</span>
                <span class="muted when">{row.move.moved_at.slice(0, 10)}</span>
                {#if row.outstanding_qty > 0}
                  <button class="btn tiny ghost" on:click={() => openReturn(row)}>退料</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if s.note}<p class="note">{s.note}</p>{/if}
      </div>
      <div class="ops">
        <button class="btn tiny ghost" on:click={() => move(s.id, -1)} disabled={i === 0}>↑</button>
        <button class="btn tiny ghost" on:click={() => move(s.id, 1)} disabled={i === $steps.length - 1}>↓</button>
        <button class="btn tiny ghost" on:click={() => openIssue(s.id, s.title, s.material_ids[0] || '')}>领料</button>
        <button class="btn tiny ghost" on:click={() => (editing = { ...s, folio_id: s.folio_id ?? '', material_ids: [...s.material_ids], duration_min: s.duration_min ?? '' })}>编辑</button>
        <button class="btn tiny ghost" on:click={() => remove(s.id)}>删除</button>
      </div>
    </li>
  {/each}
</ol>

{#if wholeRollRows.length}
  <div class="card whole-roll">
    <div class="wr-head">
      <h3>整卷领用（不绑定工序）</h3>
      <button class="btn tiny secondary" on:click={() => openIssue(null, '整卷')}>＋ 整卷领用</button>
    </div>
    <ul class="issues">
      {#each wholeRollRows as row (row.move.id)}
        <li>
          <span class="tag kind" style={`background:${STOCK_MOVE_META.issue.color}`}>领料</span>
          <b>{row.material?.name ?? '已删除材料'}</b>
          <span class="muted">批次 {batchName(row.batch)}</span>
          <span class="qty">领 {formatQty(row.move.qty)} {row.batch?.unit ?? ''}</span>
          {#if row.returned_qty > 0}<span class="ret">已退 {formatQty(row.returned_qty)}</span>{/if}
          <span class="outstanding">未退 {formatQty(row.outstanding_qty)}</span>
          <span class="muted when">{row.move.moved_at.slice(0, 10)}</span>
          {#if row.outstanding_qty > 0}
            <button class="btn tiny ghost" on:click={() => openReturn(row)}>退料</button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{:else if $steps.length > 0}
  <div class="bulk-row">
    <button class="btn tiny secondary" on:click={() => openIssue(null, '整卷')}>整卷领用（不绑定工序）</button>
  </div>
{/if}

{#if editing}
  <div class="modal-backdrop" on:click={() => (editing = null)}>
    <div class="modal" on:click|stopPropagation>
      <h3>{editing.id ? '编辑工序' : '新建工序'}</h3>
      <div class="two">
        <div class="field"><label>工序名称 *</label><input bind:value={editing.title} placeholder="如：虫孔嵌补" /></div>
        <div class="field">
          <label>工艺</label>
          <select bind:value={editing.technique}>
            {#each TECHNIQUES as t}<option value={t}>{t}</option>{/each}
          </select>
        </div>
      </div>
      <div class="two">
        <div class="field">
          <label>对应叶次</label>
          <select bind:value={editing.folio_id}>
            <option value="">整卷级</option>
            {#each $folios as f}<option value={f.id}>{f.name}</option>{/each}
          </select>
        </div>
        <div class="field"><label>施作日期</label><input type="date" bind:value={editing.performed_at} /></div>
      </div>
      <div class="two">
        <div class="field"><label>修复师</label><input bind:value={editing.operator} /></div>
        <div class="field"><label>耗时（分钟）</label><input type="number" bind:value={editing.duration_min} /></div>
      </div>
      <div class="field">
        <label>使用材料（可多选，选材结果）</label>
        <select multiple bind:value={editing.material_ids} size="4">
          {#each $materials as m}<option value={m.id}>{m.name}</option>{/each}
        </select>
      </div>
      <div class="field"><label>记录</label><textarea bind:value={editing.note} placeholder="操作要点、异常、可逆性说明…"></textarea></div>
      <div class="actions">
        <button class="btn ghost" on:click={() => (editing = null)}>取消</button>
        <button class="btn" on:click={save}>保存</button>
      </div>
    </div>
  </div>
{/if}

{#if issuingFor && issueForm}
  <div class="modal-backdrop" on:click={() => (issuingFor = null)}>
    <div class="modal" on:click|stopPropagation>
      <h3>领料出库 · {issuingFor.stepTitle}</h3>
      <p class="muted tiny">从材料库批次选择并填写领用量；批次余量实时扣减，可在批次流水追溯。</p>
      <div class="field">
        <label>材料</label>
        <select bind:value={issueForm.material_id} on:change={onMaterialChange}>
          {#each $materials as m}<option value={m.id}>{m.name}</option>{/each}
        </select>
      </div>
      <div class="field">
        <label>批次 *</label>
        <select bind:value={issueForm.batch_id} on:change={onBatchChange}>
          {#if batchesOfStepMaterial(issueForm.material_id).length === 0}
            <option value="">该材料暂有余量为 0 或未登记批次</option>
          {/if}
          {#each $batches.filter((b) => b.material_id === issueForm.material_id) as b}
            <option value={b.id} disabled={b.remaining_qty <= 0}>
              {b.batch_no}（剩余 {formatQty(b.remaining_qty)} {b.unit}）{b.remaining_qty <= 0 ? ' · 无余量' : ''}
            </option>
          {/each}
        </select>
      </div>
      <div class="two">
        <div class="field">
          <label>领用量 *</label>
          <input type="number" step="0.01" min="0" bind:value={issueForm.qty} placeholder={issuePlaceholder()} />
        </div>
        <div class="field"><label>领用日期</label><input type="date" bind:value={issueForm.moved_at} /></div>
      </div>
      <div class="two">
        <div class="field"><label>领用人</label><input bind:value={issueForm.operator} /></div>
        <div class="field"><label>备注</label><input bind:value={issueForm.note} placeholder="用于哪个部位 / 异常说明" /></div>
      </div>
      <div class="actions">
        <button class="btn ghost" on:click={() => (issuingFor = null)}>取消</button>
        <button class="btn" on:click={submitIssue}>确认领料</button>
      </div>
    </div>
  </div>
{/if}

{#if returningFor && returnForm}
  <div class="modal-backdrop" on:click={() => (returningFor = null)}>
    <div class="modal" on:click|stopPropagation>
      <h3>退料入库</h3>
      <p class="muted tiny">
        原领料：{returningFor.material?.name} · 批次 {batchName(returningFor.batch)} ·
        领 {formatQty(returningFor.move.qty)} {returningFor.batch?.unit ?? ''}，
        当前未退 {formatQty(returningFor.outstanding_qty)}。可部分退料、多次退料。
      </p>
      <div class="two">
        <div class="field">
          <label>退料数量 *（不超过未退 {formatQty(returningFor.outstanding_qty)}）</label>
          <input type="number" step="0.01" min="0" max={returningFor.outstanding_qty} bind:value={returnForm.qty} />
        </div>
        <div class="field"><label>退料日期</label><input type="date" bind:value={returnForm.moved_at} /></div>
      </div>
      <div class="two">
        <div class="field"><label>退料人</label><input bind:value={returnForm.operator} /></div>
        <div class="field"><label>备注</label><input bind:value={returnForm.note} placeholder="未使用 / 裁切余料退回…" /></div>
      </div>
      <div class="actions">
        <button class="btn ghost" on:click={() => (returningFor = null)}>取消</button>
        <button class="btn" on:click={submitReturn}>确认退料</button>
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
  h2 {
    font-size: 17px;
  }
  .spacer {
    flex: 1;
  }
  .step-list {
    padding: 14px 22px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .step {
    display: flex;
    gap: 14px;
    padding: 14px 16px;
    align-items: flex-start;
  }
  .ord {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    flex: none;
  }
  .step .body {
    flex: 1;
    min-width: 0;
  }
  .step h3 {
    font-size: 14px;
    margin-bottom: 4px;
  }
  .meta {
    font-size: 12px;
    color: var(--ink-soft);
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .mats {
    font-size: 12px;
    margin-top: 6px;
    color: #6f6150;
  }
  .note {
    font-size: 13px;
    margin: 6px 0 0;
    white-space: pre-wrap;
  }
  .ops {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  select[multiple] {
    height: 88px;
  }
  .tiny {
    font-size: 12px;
  }

  .issues {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .issues li {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12.5px;
    background: #faf3e6;
    border: 1px solid #eadfc8;
    border-radius: 5px;
    padding: 5px 9px;
  }
  .issues .kind {
    min-width: 34px;
    text-align: center;
  }
  .issues .qty {
    font-variant-numeric: tabular-nums;
    color: var(--blue);
  }
  .issues .ret {
    color: #b08900;
    font-variant-numeric: tabular-nums;
  }
  .issues .outstanding {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .issues .when {
    margin-left: auto;
  }
  .bulk-row {
    padding: 0 22px 30px;
  }
  .whole-roll {
    margin: 0 22px 30px;
    padding: 12px 14px;
  }
  .wr-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .wr-head h3 {
    font-size: 13px;
  }
</style>
