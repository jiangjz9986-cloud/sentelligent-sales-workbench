# 个人差旅费用与报销 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在森特智行中新增一个纯个人、人工录入、按自然周统计的差旅费用与报销模块，支持费用主记录与多笔实际付款、付款凭证、提前请款、多退少补、实际付款记录表导出和 A4 打印。

**Architecture:** 前端新建独立 `src/features/travelExpense/` 功能目录，`App.jsx` 只负责导航与页面装配；金额统一使用整数分，周范围由纯函数计算。后端使用 SQLite 迁移和独立 repository，费用、实际付款、附件、请款分表保存；附件与发票统一引用同账号隔离的内容寻址 BLOB 仓库，按 `docs/superpowers/plans/2026-08-04-lossless-document-storage.md` 执行无损压缩、去重与完整性校验。导出使用 UTF-8 BOM CSV，打印使用同一份付款视图模型与专用 `@media print` 页面，避免屏幕表格和正式输出口径分叉。

**Tech Stack:** React 19、Vite 6、Lucide React、Node.js 24、`node:http`、SQLite、Node test runner、Playwright/WebKit、本地 in-app Browser。

---

## 产品与数据约束

- 仅个人使用，不增加审批人、财务、领导或角色流转。
- 第一版仅人工录入，不实现 OCR、微信/语音录入、自动合规判断或发票查验。
- 分类固定为 `breakfast/lunch/dinner/lodging/transport/hospitality/other`。
- 资金来源固定为 `personal/company/advance`；公司直付不进入个人结算。
- 个人结算：`个人垫付中计入报销金额 + 请款资金中计入报销金额 - 已收到提前请款`。结果为正时公司应补，为负时个人应退。
- 未确认额度、超标和发票政策只展示“规则待配置”或“待人工确认”。
- 费用与付款为 1:N；一张凭证可以包含多笔付款，附件必须能标记关联付款和图片序号。
- 所有金额以整数分存储和计算，显示时再格式化为人民币两位小数。
- 周范围按周一至周日计算；2026-08-04 所在自然周为 2026-08-03 至 2026-08-09。

## 文件边界

- `outputs/product-design-prototype/src/features/travelExpense/travelExpenseModel.js`：周范围、金额汇总、分类、付款与结算纯函数。
- `outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.js`：付款行、CSV、分页和打印附件页纯函数。
- `outputs/product-design-prototype/src/features/travelExpense/TravelExpensePage.jsx`：数据加载、页签、表单/预览状态和 API 编排。
- `outputs/product-design-prototype/src/features/travelExpense/*.jsx`：周总览、费用账本、票据中心、请款结算、报销整理、编辑抽屉、打印预览。
- `outputs/product-design-prototype/src/features/travelExpense/travelExpense.css`：模块专属屏幕与打印样式；不把业务样式塞回全局 CSS。
- `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`：仅增加差旅 CRUD、附件、请款客户端方法。
- `outputs/product-design-prototype/src/App.jsx`：仅增加 import、导航装配和必要 props。
- `backend/src/travelExpense/repository.js`：费用、付款、附件、请款的事务化读写与乐观锁。
- `backend/src/travelExpense/validation.js`：严格请求校验与日期/金额/附件限制。
- `backend/src/db/migrations/0007_travel_expenses.mjs`：费用、付款、附件、附件付款关系、请款五张业务表及约束、索引和外键。
- `backend/src/server.js`：认证 API、CSRF、If-Match、附件二进制响应和审计编排。

### Task 1: 路由、导航和模块边界

**Files:**
- Modify: `outputs/product-design-prototype/src/app/routes.test.js`
- Modify: `outputs/product-design-prototype/src/app/routes.js`
- Modify: `outputs/product-design-prototype/src/data/salesWorkbenchData.js`
- Create: `outputs/product-design-prototype/scripts/travel-expense-page.test.mjs`
- Modify: `outputs/product-design-prototype/package.json`

- [ ] **Step 1: 写失败的路由与导航测试**

向 `routeCases` 增加：

```js
[
  "/travel-expenses",
  expectedRoute({ page: "travel-expenses", active: "expense", mode: "index" }),
  "/travel-expenses",
],
```

静态页面测试读取 `salesWorkbenchData.js` 与 `App.jsx`，断言导航顺序为 `itinerary -> expense -> weekly`，并断言 `TravelExpensePage` 从独立 feature 目录导入，`App.jsx` 内不存在费用业务表格 JSX。

- [ ] **Step 2: 运行测试并确认因页面元数据和导航不存在而失败**

Run: `npm --prefix outputs/product-design-prototype run test:routes && node --test outputs/product-design-prototype/scripts/travel-expense-page.test.mjs`

Expected: FAIL，错误明确指向 `/travel-expenses` 回退总览或 `expense` 导航不存在。

- [ ] **Step 3: 最小实现路由和导航**

在 `PAGE_META` 增加：

```js
"travel-expenses": Object.freeze({ active: "expense", defaultMode: "index", readOnly: false }),
```

在单页 `index` 匹配和 `pathForRoute` 中加入 `travel-expenses`。在导航数据中使用 `ReceiptText`：

```js
{ id: "itinerary", label: "智能拜访行程", icon: MapPinned },
{ id: "expense", label: "差旅报销", icon: ReceiptText },
{ id: "weekly", label: "周报与汇报", icon: FileText },
```

- [ ] **Step 4: 重跑路由测试并保持绿色**

Run: `npm --prefix outputs/product-design-prototype run test:routes`

Expected: PASS。

### Task 2: 自然周、金额、付款与结算模型

**Files:**
- Create: `outputs/product-design-prototype/src/features/travelExpense/travelExpenseModel.test.js`
- Create: `outputs/product-design-prototype/src/features/travelExpense/travelExpenseModel.js`
- Modify: `outputs/product-design-prototype/package.json`

- [ ] **Step 1: 写周范围和结算红灯测试**

```js
it("uses Monday through Sunday for the natural week", () => {
  assert.deepEqual(naturalWeekFor("2026-08-04T10:00:00+08:00"), {
    start: "2026-08-03",
    end: "2026-08-09",
  });
});

it("excludes company-direct payments from personal settlement", () => {
  const summary = summarizeTravelExpenses([
    expenseWithPayments([
      { amountCents: 12000, reimbursementCents: 12000, fundingSource: "personal" },
      { amountCents: 8000, reimbursementCents: 8000, fundingSource: "company" },
      { amountCents: 3000, reimbursementCents: 2500, fundingSource: "advance" },
    ]),
  ], [{ receivedCents: 5000 }]);
  assert.equal(summary.actualPaidCents, 23000);
  assert.equal(summary.companyDirectCents, 8000);
  assert.equal(summary.personalSettlementCents, 9500);
});
```

同时覆盖：七个独立分类、一项费用多笔付款、实际付款与计入报销差额、未录入请款与 `0` 元请款的区别、负结算显示个人应退、非法负金额和超过安全整数。

- [ ] **Step 2: 运行模型测试并确认模块不存在**

Run: `node --test outputs/product-design-prototype/src/features/travelExpense/travelExpenseModel.test.js`

Expected: FAIL，`ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现金额与周纯函数**

导出：

```js
export const EXPENSE_CATEGORIES = Object.freeze([...]);
export const FUNDING_SOURCES = Object.freeze([...]);
export function naturalWeekFor(value) { /* UTC-safe local calendar calculation */ }
export function summarizeTravelExpenses(expenses, advances) { /* integer cents only */ }
export function flattenPaymentRows(expenses) { /* stable occurredOn/paidAt/sequence order */ }
export function formatCny(cents) { /* zh-CN, CNY, two decimals */ }
```

`summarizeTravelExpenses` 必须分别返回 `actualPaidCents`、`reimbursementCents`、`personalAdvanceCents`、`companyDirectCents`、`advanceFundedCents`、`advanceReceivedCents`、`personalSettlementCents`、分类汇总和票据状态汇总。

- [ ] **Step 4: 运行模型测试并确认通过**

Run: `node --test outputs/product-design-prototype/src/features/travelExpense/travelExpenseModel.test.js`

Expected: PASS。

### Task 3: 实际付款记录导出与打印分页模型

**Files:**
- Create: `outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.test.js`
- Create: `outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.js`

- [ ] **Step 1: 写 CSV 和分页红灯测试**

```js
it("exports one row per actual payment with a UTF-8 BOM", () => {
  const csv = buildPaymentRecordCsv({ expenses, week, generatedOn: "2026-08-04" });
  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.match(csv, /实际支付日期\/时间,分类,费用事由\/收款方,实付金额/);
  assert.equal(csv.split("\r\n").filter(Boolean).length, 4);
});

it("keeps a payment row intact and moves extra images to attachment pages", () => {
  const pages = paginatePaymentRecord({ rows: twentyFiveRows, attachments, rowsPerPage: 9, attachmentsPerPage: 4 });
  assert.deepEqual(pages.detailPages.map((page) => page.rows.length), [9, 9, 7]);
  assert.equal(pages.attachmentPages.every((page) => page.attachments.length <= 4), true);
});
```

覆盖 CSV 引号/换行转义、账号只保留末四位、两种打印模式、每行最多两个缩略图、其余凭证进入附页、页码和自然周页脚。

- [ ] **Step 2: 运行测试并确认导出模块不存在**

Run: `node --test outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现统一付款输出模型**

导出：

```js
export function buildPaymentRecordRows(expenses) { /* one row per payment */ }
export function buildPaymentRecordCsv(input) { /* BOM + CRLF + RFC4180 escaping */ }
export function paymentRecordFilename(weekStart) { return `实际付款记录-${weekStart}.csv`; }
export function paginatePaymentRecord(input) { /* detailPages + attachmentPages */ }
```

- [ ] **Step 4: 重跑模型与导出测试**

Run: `node --test outputs/product-design-prototype/src/features/travelExpense/travelExpenseModel.test.js outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.test.js`

Expected: PASS。

### Task 4: SQLite 迁移和事务化 repository

**Files:**
- Create: `backend/tests/travel-expense-migrations.test.js`
- Create: `backend/tests/travel-expense-repository.test.js`
- Create: `backend/src/db/migrations/0007_travel_expenses.mjs`
- Create: `backend/src/travelExpense/repository.js`
- Modify: `backend/src/db/migrate.js`

- [ ] **Step 1: 写迁移红灯测试**

断言创建：

```text
travel_expenses
travel_expense_payments
travel_expense_attachments
travel_expense_attachment_payments
travel_expense_advances
```

约束包括：正版本、整数非负金额、七分类、三资金来源、附件类型、真实日期、活动周索引、费用到付款/附件的外键。`schema_migrations` 必须出现版本 `0007` 和 64 位校验和。

- [ ] **Step 2: 运行迁移测试并确认表不存在**

Run: `node --test backend/tests/travel-expense-migrations.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现 0007 同步迁移并注册**

附件表保存：

```sql
content BLOB NOT NULL,
media_type TEXT NOT NULL,
size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152)
```

`travel_expense_payments` 使用 `expense_id` 外键；附件通过 `travel_expense_attachment_payments` 与零到多笔付款建立多对多关系，因此一张截图能够关联多笔实际付款。所有业务查询按 `owner` 隔离。

- [ ] **Step 4: 写 repository 红灯测试**

覆盖：创建费用及两笔付款、按周列出、更新时整体替换付款并递增版本、过期版本冲突、软删除、附件 BLOB 元数据/内容读取、附件删除、多个提前请款、不同账号不可见、事务失败不留半成品。

- [ ] **Step 5: 运行 repository 测试并确认模块不存在**

Run: `node --test backend/tests/travel-expense-repository.test.js`

Expected: FAIL。

- [ ] **Step 6: 实现 repository**

入口：

```js
export function createTravelExpenseRepository(db, { idFactory = randomUUID, clock = () => new Date() } = {}) {
  return {
    createExpense, getExpense, listExpenses, updateExpense, softDeleteExpense,
    addAttachment, getAttachmentContent, deleteAttachment,
    createAdvance, listAdvances, updateAdvance, softDeleteAdvance,
  };
}
```

所有复合写操作使用 `withImmediateTransaction` 或 repository 内等价的同步事务；冲突错误携带 `currentVersion`。

- [ ] **Step 7: 重跑迁移、repository 和通用迁移测试**

Run: `node --test backend/tests/travel-expense-migrations.test.js backend/tests/travel-expense-repository.test.js backend/tests/migrations.test.js`

Expected: PASS。

### Task 5: 认证 API、严格校验、审计和前端客户端

**Files:**
- Create: `backend/src/travelExpense/validation.js`
- Create: `backend/tests/travel-expense-validation.test.js`
- Create: `backend/tests/travel-expense-api.test.js`
- Modify: `backend/src/server.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `shared/salesWorkbenchApiContract.mjs`

- [ ] **Step 1: 写校验和 API 红灯测试**

覆盖：

```text
GET    /api/travel-expenses?weekStart=YYYY-MM-DD
GET    /api/travel-expenses/:id
POST   /api/travel-expenses
PATCH  /api/travel-expenses/:id
DELETE /api/travel-expenses/:id
POST   /api/travel-expenses/:id/attachments
GET    /api/travel-expense-attachments/:id/content
DELETE /api/travel-expense-attachments/:id
GET    /api/travel-expense-advances?weekStart=YYYY-MM-DD
POST   /api/travel-expense-advances
PATCH  /api/travel-expense-advances/:id
DELETE /api/travel-expense-advances/:id
```

所有接口必须认证；写接口必须 CSRF；PATCH/DELETE 和附件变更必须 `If-Match`。拒绝未知字段、负金额、非整数分、非法日期、非图片/PDF附件、解码后超过 12 MiB 的附件、伪造其他账号 owner。

- [ ] **Step 2: 运行 API 测试并确认 404/模块不存在**

Run: `node --test backend/tests/travel-expense-validation.test.js backend/tests/travel-expense-api.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现校验和 API**

附件上传 JSON 上限设为 17 MiB；其余请求继续使用默认 1 MiB。内容响应设置准确 `Content-Type`、原始文件 `Content-Length`、`Cache-Control: private, max-age=300` 和 `X-Content-Type-Options: nosniff`。

审计动作：

```text
travel_expense.create/update/delete
travel_expense.attachment_add/attachment_delete
travel_expense_advance.create/update/delete
```

- [ ] **Step 4: 写 API 客户端红灯测试**

断言 URL 编码、周查询、If-Match、CSRF、附件 base64 负载、二进制内容 URL 和未授权失效行为。

- [ ] **Step 5: 运行客户端测试并确认方法不存在**

Run: `npm --prefix outputs/product-design-prototype run test:api`

Expected: FAIL。

- [ ] **Step 6: 实现客户端方法并重跑前后端 API 测试**

Run: `node --test backend/tests/travel-expense-validation.test.js backend/tests/travel-expense-api.test.js && npm --prefix outputs/product-design-prototype run test:api`

Expected: PASS。

### Task 6: 五个工作视图、人工录入和票据交互

**Files:**
- Create: `outputs/product-design-prototype/src/features/travelExpense/TravelExpensePage.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/WeeklyExpenseOverview.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/ExpenseLedger.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/ReceiptCenter.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/AdvanceSettlement.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/ReimbursementOrganizer.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/ExpenseEditorDrawer.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/PaymentRecordPrintPreview.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/travelExpense.css`
- Modify: `outputs/product-design-prototype/src/App.jsx`
- Modify: `outputs/product-design-prototype/src/main.jsx`
- Modify: `outputs/product-design-prototype/scripts/travel-expense-page.test.mjs`
- Modify: `outputs/product-design-prototype/scripts/visual-rhythm.test.mjs`
- Modify: `outputs/product-design-prototype/scripts/integration-qa.mjs`
- Modify: `outputs/product-design-prototype/scripts/webkit-qa.mjs`

- [ ] **Step 1: 扩展页面红灯测试**

静态与渲染测试必须看到：五个页签、自然周选择、`记一笔`、分类筛选、`仅看待核对`、实际付款表、凭证缩略图、录入请款、结算公式、`导出表格`、`打印实际付款记录`、空态和错误恢复；按钮具备可访问名称，表单使用显式 label，状态不只靠颜色。

- [ ] **Step 2: 运行页面测试并确认组件不存在**

Run: `node --test outputs/product-design-prototype/scripts/travel-expense-page.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 实现页面外壳和数据编排**

默认页签为 `报销整理`，页签顺序：`周总览｜费用账本｜票据中心｜请款结算｜报销整理`。加载当前自然周；切换周重新读取；保存后以服务端返回版本替换本地记录；失败保留用户输入并显示恢复操作。

- [ ] **Step 4: 实现人工录入抽屉**

字段：发生日期、分类、事由、收款方、关联行程/客户说明、票据状态、备注；付款子行包含支付时间、实付金额、计入报销金额、资金来源、支付方式、账号末四位、差额原因。至少一笔付款；差额存在时要求人工填写原因。

- [ ] **Step 5: 实现五个非空工作视图**

- 周总览：分类金额、票据完整性、请款状态、个人结算和明确入口。
- 费用账本：表格、搜索、分类/资金来源/票据筛选、详情/编辑/删除。
- 票据中心：按已覆盖/部分覆盖/缺票/待核对分组，上传、查看、删除附件。
- 请款结算：录入已申请/已收到金额，透明展示公式，公司直付单列。
- 报销整理：一行一笔实际付款、差额提醒、导出和打印入口。

- [ ] **Step 6: 实现原文件上传、图片灯箱和 PDF 预览**

接受 JPEG/PNG/WebP/PDF；客户端不得缩放、转码或降低质量，原始字节交给服务端按 `2026-08-04-lossless-document-storage.md` 去重并做可逆压缩。凭证缩略图使用真实 `<img>`，PDF 使用明确的文件卡与预览入口；多图显示前两张与总数；灯箱支持上一张、下一张、旋转和 Escape 关闭。

- [ ] **Step 7: 实现克制的企业工作台样式**

继承 60px 白顶栏、232px 深蓝侧栏、品牌蓝、浅灰工作区、白面板、细分隔线、低圆角、Lucide 图标和紧凑表格；不增加营销 Hero、emoji、悬空按钮、玻璃拟态或无意义大卡。1180px 以下折叠汇总网格，980px 以下表格使用模块内滚动而非页面横向溢出。

- [ ] **Step 8: 页面与模型测试转绿**

Run: `npm --prefix outputs/product-design-prototype run test:travel-expense`

Expected: PASS。

### Task 7: CSV 下载、A4 横向打印和凭证附页

**Files:**
- Modify: `outputs/product-design-prototype/src/features/travelExpense/ReimbursementOrganizer.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/PaymentRecordPrintPreview.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/travelExpense.css`
- Modify: `outputs/product-design-prototype/src/downloadFile.test.js`
- Modify: `outputs/product-design-prototype/src/downloadFile.js`

- [ ] **Step 1: 写打印/下载行为红灯测试**

断言 CSV Blob 为 `text/csv;charset=utf-8`，文件名包含自然周；打印预览支持“含凭证缩略图/紧凑无图”、付款主体、票据覆盖、凭证附页、账号脱敏；打印动作只在图片加载完成后调用注入的 `print()`。

- [ ] **Step 2: 运行测试并确认新行为缺失**

Run: `npm --prefix outputs/product-design-prototype run test:download && npm --prefix outputs/product-design-prototype run test:travel-expense`

Expected: FAIL。

- [ ] **Step 3: 实现下载与打印预览**

正式表头：报销人、自然周、行程/说明、生成日期、记录数。正式列：序号、发生日期、支付日期/时间、分类、事由/收款方、实付金额、付款主体/方式、付款凭证、票据覆盖、差额/备注。

打印 CSS：

```css
@page { size: A4 landscape; margin: 10mm; }
@media print {
  .topbar, .sidebar, .expense-print-settings, .no-print { display: none !important; }
  .product-window, .workspace, .content { height: auto !important; min-height: 0 !important; overflow: visible !important; }
  .expense-print-sheet { break-after: page; box-shadow: none; margin: 0; }
  .expense-print-row { break-inside: avoid; }
  thead { display: table-header-group; }
}
```

凭证附页每页 4 张，标注付款编号、日期、金额和图片序号；表内最多两张缩略图，其余明确写“见凭证附页 Pn”。

- [ ] **Step 4: 重跑下载和功能测试**

Run: `npm --prefix outputs/product-design-prototype run test:download && npm --prefix outputs/product-design-prototype run test:travel-expense`

Expected: PASS。

### Task 8: 完整验证、真实浏览器验收和设计 QA

**Files:**
- Modify: `outputs/product-design-prototype/package.json`
- Modify: `outputs/product-design-prototype/design-qa.md`
- Create: `outputs/product-design-prototype/design-qa/travel-expense-implementation-1536x1024.png`
- Create: `outputs/product-design-prototype/design-qa/travel-expense-print-1536x1024.png`
- Create: `outputs/product-design-prototype/design-qa/travel-expense-main-comparison.png`
- Create: `outputs/product-design-prototype/design-qa/travel-expense-print-comparison.png`

- [ ] **Step 1: 注册质量脚本并运行定向测试**

`test:travel-expense` 包含模型、导出、API 客户端和页面测试。

Run: `npm --prefix outputs/product-design-prototype run test:travel-expense`

- [ ] **Step 2: 运行后端完整测试**

Run: `npm --prefix backend test`

- [ ] **Step 3: 运行前端完整本地质量门**

Run: `npm --prefix outputs/product-design-prototype run qa:local`

- [ ] **Step 4: 运行根目录完整质量门**

Run: `npm run qa:full`

- [ ] **Step 5: 启动本地完整栈并在 in-app Browser 验收**

Run: `npm run dev:start`

真实操作：登录、进入差旅报销、切换五个页签、创建含两笔付款的费用、编辑、筛选、上传/查看/删除凭证、录入请款、验证多退少补、导出 CSV、打开打印预览、切换打印模式、执行浏览器打印、删除记录。检查桌面 1536×1024、1180px、980px 和窄屏；检查键盘导航、焦点、Escape、控制台错误和失败恢复。

- [ ] **Step 6: 完成同图视觉比较**

源视觉：

```text
D:/Codex项目/森特智行/design-options/travel-expense/expense-organize-main.png
D:/Codex项目/森特智行/design-options/travel-expense/payment-record-print-preview.png
```

将每张源图与同为 1536×1024、同状态的实现截图拼入一张比较图。按字体、布局节奏、颜色 token、图片质量、文案逐项检查；修复所有 P0/P1/P2 后重新截图和比较。

- [ ] **Step 7: 写设计 QA 最终报告**

`outputs/product-design-prototype/design-qa.md` 必须记录源图、实现截图、像素尺寸、CSS viewport、状态、交互、控制台、每轮问题与修复，并以精确文本结束：

```text
final result: passed
```

- [ ] **Step 8: 最终差异和仓库检查**

Run: `git diff --check && git status --short && git diff --stat`

确认没有密钥、真实付款截图、临时数据库、下载文件或个人票据进入 Git；保留用户原有未跟踪的 `.codex-tmp/`、`PRODUCT.md`、`design-options/`、`design-references/`。

## 自审

- 规格覆盖：个人、自然周、人工录入、七分类、三资金来源、1:N 付款、凭证、请款结算、CSV、打印、附件页、规则待配置均有对应任务。
- 非范围功能：未加入审批链、OCR、自动合规、微信、语音或虚构报销标准。
- 类型一致性：全链路金额字段以 `*Cents` 命名并使用整数；日期使用 `YYYY-MM-DD`，支付时间使用 ISO 8601。
- 安全边界：附件受认证、owner 按登录账号隔离、写接口 CSRF、版本冲突、图片类型/大小限制、账号末四位脱敏。
- 验收边界：仅自动化测试不算完成；必须真实浏览器操作、控制台检查、同图视觉比较和 `final result: passed`。
