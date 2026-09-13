# 架构说明

## 进程边界

```
┌─────────────────────────────── Renderer (Svelte / Konva) ──────────────────────────────┐
│ src/views/*          页面级组件；src/lib/editor.ts 为 Konva 控制器（框架无关）           │
│ src/lib/api.ts       适配层：Electron 用 window.guji；浏览器/Playwright 用同构内存 Mock │
└─────────────┬───────────────────────────────────────────────────────────────────────────┘
              │ IPC:  invoke('namespace.method', ...args)     媒体：guji-media://（只读）
┌─────────────┴─────────────────────────────── Main (Node, CJS bundle) ───────────────────┐
│ electron/main.ts      窗口 / 对话框 / 只读媒体协议 / IPC 路由                            │
│ electron/services/    业务编排（项目、叶、图层、标注、样本、材料、工序、版本、批注）     │
│   images.ts          sharp：只读复制、缩略图、ROI 平均取色、修复后图                   │
│   archive.ts         adm-zip：单文件 HTML 报告 + manifest + checksums + 媒体            │
│   sample-import.ts   内置样例（走真实导入通道）                                         │
│ electron/db/          schema(SQLite DDL) + repo(行/对象映射、事务)                      │
└─────────────┬───────────────────────────────────────────────────────────────────────────┘
              │ better-sqlite3 (同步) / sharp(原生)
┌─────────────┴─────────────── guji-data/（应用数据目录，全部本机） ─────────────────────┐
│ library.db   projects/<id>/project.db   projects/<id>/{original,thumb,after,photos}      │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

`shared/` 同时被主进程、渲染进程与测试引用：

- `types.ts` 领域模型；`protocol.ts` 完整后端契约（GujiApi）。
- `geometry.ts` 面积（矩形/椭圆/鞋带公式）、命中、包围盒、质心。
- `color.ts` sRGB→XYZ→Lab（D65）、CIEDE2000、色相符度分。
- `recommend.ts` 多维加权推荐与逐条理由。
- `inventory.ts` 批次台账：剩余数量、领料/退料校验、工序领料汇总（纯函数，不落库）。
- `dashboard.ts` 进度/风险看板：五阶段流水线（导入→标注→立项→施作→对比）与规则化风险清单，纯函数推导、不落库。

## 关键不变量

1. **原图不被修改**：只复制到 `original/`，`chmod 444`；渲染进程只能经 `guji-media://` GET 读取；任何写操作都在 `thumb/after/photos/`。
2. **坐标基于原图像素**：标注存原图像素坐标；画布缩放/平移仅改变 Konva transform，不入库。
3. **版本即快照**：`plan_versions.snapshot` 存该叶全部 layers+shapes；恢复在单事务内 replacePlan。
4. **回退可逆**：restore 前先插入“回退前自动备份”版本。
5. **推荐是提示不是结论**：无测色数据时该维度权重置零，总分给中性 50 并在理由中声明数据缺失。

## 数据模型（简）

见 `electron/db/schema.ts`。全局库存项目索引/样本/材料/**材料批次与领用流水**；项目库存叶、图层、标注、工序、版本、批注（外键级联）。布尔以 0/1 存；Lab/几何/材料 id 列表/快照以 JSON 文本存。

### 材料领用（批次追溯）

选材（工序 `material_ids`）只回答“用哪种材料”，材料领用模块回答“实际用了哪个批次、多少量”：

- 全局库 `material_batches` 登记批次号、计量单位、入库数量；`stock_movements` 为只追加台账（`issue` 领料 / `return` 退料；入库由批次 `initial_qty` 在查看流水时合成一条 `in` 行，不单独落库）。
- 领料必须绑定项目与工序（可整卷领用、不绑工序）；退料必须指向某次领料，支持部分退料/多次退料，不能超退。
- 库存不存冗余余量：`剩余 = 入库 - Σ领料 + Σ退料`，口径在 `shared/inventory.ts` 纯函数中统一，主进程/渲染/单测共用。
- 批次有任何流水即不可删除（台账可追溯）；材料被批次引用时 `ON DELETE RESTRICT`；删工序解绑流水工序引用（转整卷领用），删项目清理该项目流水并回滚余量。

## 测试策略

- Vitest（node 环境）只覆盖**纯函数**：面积/命中、Lab/ΔE2000、推荐打分与权重退化、几何规范化。
- Playwright 对 `vite build` 的产物跑 e2e；页面在无 `window.guji` 时使用 localStorage 内存 Mock（`src/lib/api.ts`），保证同构交互可在无显示环境验证。
- 主进程链路（导入只读副本/checksum/zip 清单/SQLite 事务）由 Electron 在桌面环境实际运行；核心纯逻辑已被单测覆盖，避免在 CI 引入 Xvfb 依赖。
