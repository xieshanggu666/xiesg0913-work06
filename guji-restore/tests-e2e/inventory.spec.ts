import { expect, test } from '@playwright/test';

// 材料领用（批次追溯）端到端：针对内存 Mock API。
// 覆盖：登记批次 → 工序领料 → 批次余量/流水/关联工序 → 部分退料 → 批次不可删。
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('材料领用：登记批次、工序领料、退料与批次追溯', async ({ page }) => {
  // 载入样例（含材料与工序），但样例批次/领料不影响新建批次的独立流程
  await page.getByRole('button', { name: '载入样例' }).click();
  await expect(page.getByText('《稼轩长短句》样卷')).toBeVisible({ timeout: 10_000 });

  // 1) 进入材料领用页：样例已为净皮棉连登记批次 50 张、虫孔嵌补领料 6 张 → 剩余 44
  await page.getByRole('button', { name: '材料领用' }).click();
  await expect(page.getByRole('heading', { name: '材料领用与批次追溯' })).toBeVisible();
  await expect(page.getByText('2026-A-01')).toBeVisible();

  // 2) 登记一个新批次（仿古色棉连 30 张）
  await page.getByRole('button', { name: '＋ 登记批次' }).click();
  const modal = page.locator('.modal');
  await expect(modal.getByRole('heading', { name: '登记入库批次' })).toBeVisible();
  // 选择第二种材料（仿古色棉连）
  await modal.locator('select').first().selectOption({ index: 1 });
  await modal.getByPlaceholder('如 2026-A-01').fill('E2E-B-01');
  await modal.locator('input[type="number"]').first().fill('30');
  await modal.getByRole('button', { name: '保存' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByText('E2E-B-01')).toBeVisible();

  // 3) 到修复工序，对“干揭分离叶面”领料 8 张
  await page.getByRole('button', { name: '修复工序' }).click();
  const step = page.locator('.step').filter({ hasText: '干揭分离叶面' });
  await step.getByRole('button', { name: '领料' }).click();
  const issueModal = page.locator('.modal');
  await issueModal.getByText('领料出库 · 干揭分离叶面').waitFor();
  // 材料选第二种“仿古色棉连”（E2E-B-01 即登记在该材料下）
  await issueModal.locator('.field').first().locator('select').selectOption({ index: 1 });
  // 批次下拉联动后显式选择 E2E-B-01（label 不支持正则，按选项文本取 value）
  const batchSelect = issueModal.locator('.field').nth(1).locator('select');
  const batchValue = await batchSelect.locator('option', { hasText: 'E2E-B-01' }).first().getAttribute('value');
  await batchSelect.selectOption(batchValue!);
  await issueModal.getByPlaceholder(/不超过/).fill('8');
  await issueModal.getByRole('button', { name: '确认领料' }).click();
  await expect(issueModal).toHaveCount(0);
  await expect(page.getByText('批次 E2E-B-01')).toBeVisible();
  await expect(page.getByText(/未退 8/)).toBeVisible();

  // 4) 部分退料 3 张
  await page.getByRole('button', { name: '退料' }).first().click();
  const retModal = page.locator('.modal');
  await retModal.getByRole('heading', { name: '退料入库' }).waitFor();
  await retModal.locator('input[type="number"]').fill('3');
  await retModal.getByRole('button', { name: '确认退料' }).click();
  await expect(retModal).toHaveCount(0);
  await expect(page.getByText(/已退 3/)).toBeVisible();
  await expect(page.getByText(/未退 5/)).toBeVisible();

  // 5) 回材料领用页核对：剩余 30 - 8 + 3 = 25，并查看批次流水/关联工序
  await page.getByRole('button', { name: '材料领用' }).click();
  const row = page.locator('tr').filter({ hasText: 'E2E-B-01' });
  await expect(row).toContainText('25 张');

  await row.getByRole('button', { name: '流水' }).click();
  const detail = page.locator('.modal.wide');
  await expect(detail.getByRole('heading', { name: '批次流水 · E2E-B-01' })).toBeVisible();
  await expect(detail.getByText('剩余').locator('..')).toContainText('25 张');
  // 入库 / 领料 / 退料三段流水
  await expect(detail.locator('.ledger')).toContainText('入库');
  await expect(detail.locator('.ledger')).toContainText('领料');
  await expect(detail.locator('.ledger')).toContainText('退料');
  // 关联工序列出干揭分离叶面、净领用 5 张
  await expect(detail.locator('.linked')).toContainText('干揭分离叶面');
  await expect(detail.locator('.linked')).toContainText('净领用 5 张');
  await detail.getByRole('button', { name: '关闭' }).click();

  // 6) 整卷领用（不绑定工序）2 张，独立区块展示，可退料
  await page.getByRole('button', { name: '修复工序' }).click();
  await page.getByRole('button', { name: /整卷领用/ }).first().click();
  const wholeModal = page.locator('.modal');
  await wholeModal.getByText('领料出库 · 整卷').waitFor();
  await wholeModal.locator('.field').first().locator('select').selectOption({ index: 1 });
  const wBatchSelect = wholeModal.locator('.field').nth(1).locator('select');
  const wVal = await wBatchSelect.locator('option', { hasText: 'E2E-B-01' }).first().getAttribute('value');
  await wBatchSelect.selectOption(wVal!);
  await wholeModal.getByPlaceholder(/不超过/).fill('2');
  await wholeModal.getByRole('button', { name: '确认领料' }).click();
  await expect(wholeModal).toHaveCount(0);
  const wholeCard = page.locator('.whole-roll');
  await expect(wholeCard).toBeVisible();
  await expect(wholeCard).toContainText('整卷领用');
  await expect(wholeCard).toContainText(/未退 2/);
  // 整卷余量：25 - 2 = 23
  await page.getByRole('button', { name: '材料领用' }).click();
  await expect(page.locator('tr').filter({ hasText: 'E2E-B-01' })).toContainText('23 张');

  // 7) 有流水的批次不能删除（先注册 dialog 处理，confirm 会阻塞页面）
  page.once('dialog', (d) => d.accept());
  const row2 = page.locator('tr').filter({ hasText: 'E2E-B-01' });
  await row2.getByRole('button', { name: '删除' }).click();
  // 删除被阻止：批次仍在列表与内存库中（台账只追加、保持可追溯）
  await expect(page.getByText('E2E-B-01').first()).toBeVisible();
  const batchesAfter = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('guji-mock-db-v1') || '{}').batches || []).map((b: any) => b.batch_no)
  );
  expect(batchesAfter).toContain('E2E-B-01');
});

test('材料库卡片可跳转登记批次并带入材料', async ({ page }) => {
  await page.getByRole('button', { name: '载入样例' }).click();
  await expect(page.getByText('《稼轩长短句》样卷')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '材料推荐' }).click();
  // 第一张材料卡片点“登记批次”→ 跳到材料领用并打开弹窗，材料预选
  await page.locator('.material').first().getByRole('button', { name: '登记批次' }).click();
  await expect(page.getByRole('heading', { name: '登记入库批次' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '材料领用与批次追溯' })).toBeVisible();
});
