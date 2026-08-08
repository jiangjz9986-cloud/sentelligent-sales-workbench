# 差旅自动记账与发票管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有个人差旅报销模块上增加安全的 iCost 文本双写、DeepSeek 结构化记账、付款凭证逐笔关联、微信图片/PDF导入、发票仓库、人工复核、合规候选匹配、自然周报销整理和 A4 四联发票打印。

**Architecture:** 保持现有 React 19 + Node.js + SQLite 单体架构。iCost 使用独立随机令牌的只写 Webhook，微信继续复用现有 `weixin-agent-sdk` 工作者；图片先在服务器执行 OCR/PDF 文本提取，再由 DeepSeek 只处理文本和结构化字段。发票原件、识别结果、匹配关系、人工确认和候选建议分别持久化，所有自动动作保留人工确认及审计，不把无关发票自动冒充真实票据。

**Tech Stack:** React 19、Vite 6、Lucide React、Node.js 24、`node:http`、SQLite、DeepSeek OpenAI-compatible Chat Completions、可插拔 OCR/PDF 文本提取、Node test runner、Playwright/WebKit、iOS Shortcuts plist。

---

## 已确认的产品和设计约束

- 用户为个人销售人员，默认周期为周一至周日，不增加审批角色。
- 视觉继续使用已选“方案 1”：克制蓝白企业工作台、表格优先、状态清晰、卡片最少。
- 设计读法：`Operate` 模式，`DESIGN_VARIANCE=3`、`MOTION_INTENSITY=2`、`VISUAL_DENSITY=8`。
- iCost 接口只接受文本写入，不提供查询、修改、删除能力；令牌与微信机器令牌分离。
- 发票自动匹配只产生候选。确认匹配、确认无票、采用候选均必须由登录用户执行。
- 金额全部使用整数分；文件以内容哈希去重；真实票据、数据库、日志、令牌、密钥和私钥不得进入 Git。
- Windows 不能为共享快捷指令生成 Apple 签名，交付物包含可复现生成器、未签名 plist 和 macOS 原生签名命令，不使用第三方在线签名站。

## 文件边界

- `backend/src/integrations/icostWebhook.js`：iCost Bearer token、文本限制、限流键和只写身份。
- `backend/src/travelExpense/ingestionAnalysis.js`：文本账单的规则解析、DeepSeek JSON 解析和归一化。
- `backend/src/travelExpense/ingestionRepository.js`：幂等写入、解析状态和自动创建费用。
- `backend/src/travelExpense/invoiceRecognition.js`：文件类型识别、OCR/PDF 文本提取、DeepSeek 发票字段归一化与冲突计算。
- `backend/src/travelExpense/invoiceRepository.js`：发票仓库、哈希去重、人工复核、匹配、无票确认和候选建议。
- `backend/src/db/migrations/0008_expense_ingestion_invoices.mjs`：新增业务表、索引、账单可见编号和旧数据回填。
- `backend/src/weixin/agentBridge.js`：新增付款凭证和发票图片/PDF命令，不改现有快速记录语义。
- `outputs/product-design-prototype/src/features/travelExpense/PaymentProofCenter.jsx`：付款凭证逐付款行上传和匹配状态。
- `outputs/product-design-prototype/src/features/travelExpense/InvoiceManager.jsx`：发票仓库、原件预览、OCR/DeepSeek对比、人工复核和匹配。
- `outputs/product-design-prototype/src/features/travelExpense/InvoicePrintPreview.jsx`：每页四张固定版位的 A4 横向打印。
- `integrations/icost-shortcut/`：快捷指令生成器、未签名 plist、签名与导入说明。

### Task 1: Webhook 配置、认证、限流和只写边界

**Files:**
- Create: `backend/tests/icost-webhook-security.test.js`
- Create: `backend/src/integrations/icostWebhook.js`
- Modify: `backend/src/config.js`
- Modify: `backend/tests/config.test.js`
- Modify: `backend/.env.example`

- [ ] **Step 1: 写失败测试**

```js
it("accepts only the dedicated iCost token and only on the ingestion POST route", () => {
  const config = { icostWebhookToken: "<icost-webhook-token>" };
  assert.equal(authenticateIcostWebhook("Bearer <icost-webhook-token>", config)?.integration, "icost");
  assert.equal(authenticateIcostWebhook("Bearer <weixin-webhook-token>", config), null);
  assert.equal(isIcostWebhookRouteAllowed("POST", "/api/integrations/icost/expenses"), true);
  assert.equal(isIcostWebhookRouteAllowed("GET", "/api/integrations/icost/expenses"), false);
});

it("limits repeated writes without returning any account data", () => {
  const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, clock: () => 1_000 });
  assert.equal(limiter.consume("client-a|ip-a").allowed, true);
  assert.equal(limiter.consume("client-a|ip-a").allowed, true);
  assert.equal(limiter.consume("client-a|ip-a").allowed, false);
});
```

- [ ] **Step 2: 确认 RED**

Run: `npm --prefix backend test -- --test-name-pattern="iCost webhook"`

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 最小实现**

导出：

```js
export function authenticateIcostWebhook(header, config) { /* constant-time Bearer comparison */ }
export function isIcostWebhookRouteAllowed(method, path) { return method === "POST" && path === "/api/integrations/icost/expenses"; }
export function validateIcostTextPayload(body) { /* own keys: text, capturedAt, sourceId; text 1..12000 */ }
export function createFixedWindowLimiter({ limit, windowMs, clock }) { /* bounded in-memory windows */ }
```

配置增加 `ICOST_WEBHOOK_TOKEN`、`ICOST_WEBHOOK_RATE_LIMIT`、`ICOST_WEBHOOK_WINDOW_MS`，生产环境仅在配置令牌后开放该路由。

- [ ] **Step 4: 确认 GREEN**

Run: `npm --prefix backend test -- --test-name-pattern="iCost webhook|config"`

Expected: PASS。

### Task 2: 迁移 0008 和稳定账单编号

**Files:**
- Create: `backend/src/db/migrations/0008_expense_ingestion_invoices.mjs`
- Create: `backend/tests/expense-ingestion-invoice-migrations.test.js`
- Modify: `backend/src/db/migrate.js`
- Modify: `backend/tests/migrations.test.js`

- [ ] **Step 1: 写失败迁移测试**

断言迁移后存在：

```sql
ALTER TABLE travel_expenses ADD COLUMN display_code TEXT;
CREATE UNIQUE INDEX ux_travel_expense_display_code ON travel_expenses(display_code);
CREATE TABLE travel_expense_ingestions (... raw_text TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL ...);
CREATE TABLE invoice_documents (... sha256 TEXT NOT NULL, content_blob BLOB NOT NULL, status TEXT NOT NULL ...);
CREATE TABLE invoice_matches (... status TEXT NOT NULL, covered_cents INTEGER NOT NULL ...);
CREATE TABLE expense_invoice_exceptions (... expense_id TEXT NOT NULL UNIQUE ...);
CREATE TABLE invoice_match_suggestions (... status TEXT NOT NULL ...);
```

同时断言旧费用被回填为 `EXP-YYYYMMDD-XXXX`、同一幂等键不能重复、同一 owner + sha256 不能重复发票。

- [ ] **Step 2: 确认 RED**

Run: `node --test backend/tests/expense-ingestion-invoice-migrations.test.js`

Expected: FAIL，0008 尚未注册。

- [ ] **Step 3: 实现同步迁移与回填**

迁移必须同步、事务内可执行、重复应用安全；日期取 `occurred_on`，后缀由现有主键 SHA-256 的前四位大写字符生成，碰撞时扩展至六位。

- [ ] **Step 4: 确认 GREEN**

Run: `node --test backend/tests/expense-ingestion-invoice-migrations.test.js backend/tests/migrations.test.js`

Expected: PASS。

### Task 3: 文本账单解析和 ingestion repository

**Files:**
- Create: `backend/tests/travel-expense-ingestion-analysis.test.js`
- Create: `backend/tests/travel-expense-ingestion-repository.test.js`
- Create: `backend/src/travelExpense/ingestionAnalysis.js`
- Create: `backend/src/travelExpense/ingestionRepository.js`
- Modify: `backend/src/modelAnalysis.js`

- [ ] **Step 1: 写规则解析和模型归一化失败测试**

```js
it("parses a Chinese payment line into integer cents", async () => {
  const result = await analyzeExpenseText("2026-08-04 午餐 招待客户 支付宝 128.50元", mockConfig);
  assert.deepEqual(result.expense, {
    occurredOn: "2026-08-04",
    category: "lunch",
    description: "招待客户",
    merchant: "支付宝",
    amountCents: 12850,
    reimbursementCents: 12850,
  });
});
```

覆盖：早餐/午餐/晚餐、住宿、交通、招待、负数拒绝、缺日期进入 `needs_review`、模型 JSON fence、模型错误回退、不得把令牌写入结果。

- [ ] **Step 2: 确认 RED**

Run: `node --test backend/tests/travel-expense-ingestion-analysis.test.js backend/tests/travel-expense-ingestion-repository.test.js`

Expected: FAIL，分析器与仓库尚不存在。

- [ ] **Step 3: 最小实现**

`analyzeExpenseText` 先做确定性字段提取，再在模型可用时调用只输出 JSON 的 DeepSeek；归一化返回 `status: ready|needs_review`、`confidence`、`expense`、`warnings`、`source`。仓库以 `owner + idempotency_key` 去重，`ready` 时在同一事务创建一条费用和一笔付款，复用 `createTravelExpenseRepository` 的校验与整数分约束。

- [ ] **Step 4: 确认 GREEN**

Run: `node --test backend/tests/travel-expense-ingestion-analysis.test.js backend/tests/travel-expense-ingestion-repository.test.js`

Expected: PASS。

### Task 4: iCost 只写 API

**Files:**
- Create: `backend/tests/icost-webhook-api.test.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: 写 API 失败测试**

覆盖：无令牌 401、错误令牌 401、GET 403/404、缺 `Idempotency-Key` 428、重复请求完全重放、同键不同正文 409、超长文本 422、限流 429、响应只含 `receiptId/status/duplicate`、数据库只新增一次。

- [ ] **Step 2: 确认 RED**

Run: `node --test backend/tests/icost-webhook-api.test.js`

Expected: FAIL，路由尚不存在。

- [ ] **Step 3: 实现独立认证分支**

在 Cookie/Machine 认证前只识别精确路径；成功身份固定为 `{ account: configuredOwner, kind: "integration", integration: "icost" }`。请求体只允许 `{ text, capturedAt, sourceId }`，审计只记录摘要和哈希，不记录令牌。

- [ ] **Step 4: 确认 GREEN**

Run: `node --test backend/tests/icost-webhook-api.test.js backend/tests/auth-http.test.js`

Expected: PASS，现有认证边界无回归。

### Task 5: 发票识别、文件安全和仓库

**Files:**
- Create: `backend/tests/invoice-recognition.test.js`
- Create: `backend/tests/invoice-repository.test.js`
- Create: `backend/src/travelExpense/invoiceRecognition.js`
- Create: `backend/src/travelExpense/invoiceRepository.js`
- Modify: `backend/src/config.js`
- Modify: `backend/.env.example`

- [ ] **Step 1: 写失败测试**

覆盖：JPEG/PNG/WebP/PDF magic bytes 与声明 MIME 一致、SVG/HTML/可执行文件拒绝、文件大小限制、SHA-256 去重、PDF 内嵌文本提取、OCR 适配器不可用进入 `needs_review`、DeepSeek 字段归一化、OCR 与模型金额/日期冲突标记、原文件可读取但列表绝不返回 BLOB。

- [ ] **Step 2: 确认 RED**

Run: `node --test backend/tests/invoice-recognition.test.js backend/tests/invoice-repository.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现可插拔提取流水线**

```js
export async function recognizeInvoiceDocument(file, options) {
  const detected = detectDocumentType(file.buffer);
  const extractedText = await options.textExtractor.extract(detected, file.buffer);
  const model = await options.analyzeText(extractedText);
  return compareRecognitionSources({ extractedText, model });
}
```

默认提取器通过配置的 `OCR_COMMAND` 与 `PDF_TEXT_COMMAND` 执行本地命令；命令不可用时保留原件并进入人工复核，不把原件发送给模型服务。仓库支持创建、列表、详情、内容读取、人工修订和哈希重复提示。

- [ ] **Step 4: 确认 GREEN**

Run: `node --test backend/tests/invoice-recognition.test.js backend/tests/invoice-repository.test.js`

Expected: PASS。

### Task 6: 发票匹配、无票确认、合规候选和后端 API

**Files:**
- Create: `backend/tests/invoice-matching.test.js`
- Create: `backend/tests/invoice-api.test.js`
- Modify: `backend/src/travelExpense/invoiceRepository.js`
- Modify: `backend/src/server.js`
- Modify: `shared/salesWorkbenchApiContract.mjs`

- [ ] **Step 1: 写失败测试**

覆盖：按账单编号精确匹配；编号不存在 404；确认覆盖额不得超过发票总额或账单待覆盖额；同一确认不可重复；人工无票确认可撤销；自然周缺票额按报销额减已确认覆盖额计算；候选只选择未占用、日期合理、分类兼容的发票，且仅保存 `suggested`，不自动变成 `confirmed`。

- [ ] **Step 2: 确认 RED**

Run: `node --test backend/tests/invoice-matching.test.js backend/tests/invoice-api.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现事务、审计与 API**

新增认证 API：

```text
GET    /api/invoices
POST   /api/invoices
GET    /api/invoices/:id
GET    /api/invoices/:id/content
PATCH  /api/invoices/:id/review
POST   /api/invoices/:id/matches
DELETE /api/invoice-matches/:id
POST   /api/travel-expenses/:id/no-invoice
DELETE /api/travel-expenses/:id/no-invoice
POST   /api/travel-expense-weeks/:start/invoice-suggestions
```

所有写入要求 CSRF、`If-Match` 或幂等键，并写入不可变审计日志。

- [ ] **Step 4: 确认 GREEN**

Run: `node --test backend/tests/invoice-matching.test.js backend/tests/invoice-api.test.js backend/tests/transaction-audit.test.js`

Expected: PASS。

### Task 7: 付款凭证逐付款关联和微信图片/PDF命令

**Files:**
- Modify: `backend/tests/weixin-agent.test.js`
- Modify: `backend/src/weixin/agentBridge.js`
- Modify: `backend/src/weixin/worker.js`
- Modify: `backend/src/auth/machineAuthorization.js`
- Modify: `backend/tests/travel-expense-api.test.js`

- [ ] **Step 1: 写失败测试**

覆盖微信命令：`/付款凭证 EXP-...` 只接受图片并上传后按金额/时间给出候选付款；`/发票` 接受图片/PDF并进入发票仓库；无媒体、错误类型、文件不存在、后端失败均返回可恢复提示。机器令牌只新增所需 POST 路由，不获得任何发票/费用读取权限。

- [ ] **Step 2: 确认 RED**

Run: `node --test backend/tests/weixin-agent.test.js backend/tests/travel-expense-api.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现媒体读取与后端调用**

媒体从 SDK 已解密的 `filePath` 读取，转 base64 后写入后端；付款凭证命令必须带账单编号或返回候选列表提示，发票命令允许无匹配直接入仓。微信 token 与 iCost token 始终独立。

- [ ] **Step 4: 确认 GREEN**

Run: `node --test backend/tests/weixin-agent.test.js backend/tests/auth-http.test.js backend/tests/travel-expense-api.test.js`

Expected: PASS。

### Task 8: 前端 API 合同和六标签工作台

**Files:**
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.js`
- Modify: `outputs/product-design-prototype/src/api/salesWorkbenchApi.test.js`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/TravelExpensePage.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/PaymentProofCenter.jsx`
- Create: `outputs/product-design-prototype/src/features/travelExpense/InvoiceManager.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/ReceiptCenter.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/ReimbursementOrganizer.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/travelExpense.css`
- Modify: `outputs/product-design-prototype/scripts/travel-expense-page.test.mjs`

- [ ] **Step 1: 写失败测试**

断言标签顺序为“周总览、费用账本、付款凭证、发票管理、请款结算、报销整理”；付款上传必须选择一笔或多笔 paymentId；发票管理包含仓库列表、原件预览、OCR/DeepSeek 对比、冲突提示、匹配账单、确认无票和生成候选；加载、空、失败、处理中状态均存在；图标只用现有 Lucide。

- [ ] **Step 2: 确认 RED**

Run: `npm --prefix outputs/product-design-prototype run test:api && npm --prefix outputs/product-design-prototype run test:travel-expense`

Expected: FAIL。

- [ ] **Step 3: 最小可用实现**

页面保持现有 8px/低圆角/单一蓝色强调体系。桌面采用左列表右详情；980px 以下改为上下堆叠；760px 以下工具栏纵向排列；所有按钮至少 44px、焦点可见、冲突不仅靠颜色表达。只增加状态驱动的 150-200ms 过渡，不做装饰性动画。

- [ ] **Step 4: 确认 GREEN**

Run: `npm --prefix outputs/product-design-prototype run test:api && npm --prefix outputs/product-design-prototype run test:travel-expense && npm --prefix outputs/product-design-prototype run build`

Expected: PASS。

### Task 9: A4 实付表和四联发票打印

**Files:**
- Modify: `outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.js`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.test.js`
- Create: `outputs/product-design-prototype/src/features/travelExpense/InvoicePrintPreview.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/PaymentRecordPrintPreview.jsx`
- Modify: `outputs/product-design-prototype/src/features/travelExpense/travelExpense.css`

- [ ] **Step 1: 写失败打印模型测试**

```js
it("keeps four fixed invoice slots per landscape A4 page", () => {
  const pages = paginateInvoices([invoiceA, invoiceB, invoiceC, invoiceD, invoiceE]);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].slots.length, 4);
  assert.equal(pages[1].slots.length, 4);
  assert.equal(pages[1].slots.filter(Boolean).length, 1);
});
```

同时断言付款表一笔付款一行、自然周标题、账单编号、金额合计、分页不拆行。

- [ ] **Step 2: 确认 RED**

Run: `node --test outputs/product-design-prototype/src/features/travelExpense/travelExpenseExport.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现打印布局**

四联发票使用 A4 横向 2x2 固定网格，不足四张保留空槽；图片 `object-fit: contain`；PDF 使用浏览器内嵌第一页预览并保留文件名/发票号说明；`@page`、页边距、分页和 `print-color-adjust` 明确设置。

- [ ] **Step 4: 确认 GREEN**

Run: `npm --prefix outputs/product-design-prototype run test:travel-expense && npm --prefix outputs/product-design-prototype run qa:webkit`

Expected: PASS，打印预览无裁切。

### Task 10: iCost 快捷指令生成器和交付物

**Files:**
- Create: `integrations/icost-shortcut/README.md`
- Create: `integrations/icost-shortcut/build-shortcut.mjs`
- Create: `integrations/icost-shortcut/verify-shortcut.mjs`
- Create: `integrations/icost-shortcut/icost-dual-write.unsigned.plist`
- Create: `integrations/icost-shortcut/icost-dual-write.shortcut.example.json`
- Create: `backend/tests/icost-shortcut.test.js`

- [ ] **Step 1: 写失败测试**

断言生成结果保留原四个动作的顺序和 iCost App Intent 参数，在 OCR 后插入“获取 URL 内容”动作，请求正文只有 `text/capturedAt/sourceId`，URL 和 Token 通过导入问题/变量填入，仓库产物中不含真实 token。

- [ ] **Step 2: 确认 RED**

Run: `node --test backend/tests/icost-shortcut.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现生成与验证**

生成器读取用户提供的未签名 plist 模板或项目内无密钥模板，插入 Webhook 动作并输出 plist。README 给出：

```bash
shortcuts sign --mode anyone --input icost-dual-write.unsigned.shortcut --output icost-dual-write.shortcut
```

明确说明只在可信 macOS 上签名，令牌在导入后本机填写，不上传在线签名服务。

- [ ] **Step 4: 确认 GREEN**

Run: `node --test backend/tests/icost-shortcut.test.js && node integrations/icost-shortcut/verify-shortcut.mjs integrations/icost-shortcut/icost-dual-write.unsigned.plist`

Expected: PASS。

### Task 11: 全量验证、清理、审查和发布

**Files:**
- Modify: `docs/开发日志.md`
- Modify: `docs/开发进度与路线图.md`
- Modify: `docs/需求与验收矩阵.md`
- Modify: `CHANGELOG.md`
- Modify: `VERSION`
- Modify: `package.json`
- Modify: `backend/package.json`
- Modify: `outputs/product-design-prototype/package.json`

- [ ] **Step 1: 清理隔离 QA 数据**

从 `.runtime/travel-expense-qa-20260804-1858.sqlite` 删除标签 `DESIGN_QA_FIXTURE_20260804` 及其从属记录，执行 `PRAGMA foreign_key_check` 和 `PRAGMA quick_check`；数据库文件仍保持未跟踪。

- [ ] **Step 2: 自动化验证**

Run:

```text
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
npm --prefix outputs/product-design-prototype run qa:integration
npm --prefix outputs/product-design-prototype run qa:webkit
npm run test:deploy
npm run scan:secrets
```

Expected: 全部 PASS，输出无真实密钥和票据路径。

- [ ] **Step 3: 机械设计检测和真实浏览器验收**

Run: `node C:/Users/50159/.codex/skills/impeccable/scripts/detect.mjs --json outputs/product-design-prototype/src/features/travelExpense/TravelExpensePage.jsx outputs/product-design-prototype/src/features/travelExpense/PaymentProofCenter.jsx outputs/product-design-prototype/src/features/travelExpense/InvoiceManager.jsx outputs/product-design-prototype/src/features/travelExpense/InvoicePrintPreview.jsx outputs/product-design-prototype/src/features/travelExpense/travelExpense.css`

用用户指定浏览器验证 1440px、980px、760px、375px、横屏、键盘焦点、上传、冲突复核、匹配、无票、候选和两类打印预览；截图与已选方案 1 同画布比较，最多一次集中修正和一次确认。

- [ ] **Step 4: 独立代码审查和发布预检**

审查重点：认证绕过、机器权限扩大、文件类型欺骗、BLOB 泄漏、金额覆盖超限、幂等重复、审计缺失、SQLite 迁移可重入、快捷指令密钥泄漏。发布前执行备份/恢复演练、包 SHA-256、服务器预检和回滚点确认。

- [ ] **Step 5: 提交、推送和不可变部署**

只暂存本计划列出的项目文件，排除 `.codex-tmp/`、`PRODUCT.md`、`design-options/`、`design-references/`、`.runtime/`、数据库、票据、CSV、日志、`.env`、密钥和 SSH 私钥。推送当前分支并按现有发布手册切换独立 release，验证本地/公网 health、静态哈希资源和核心 API 后再宣布完成。
