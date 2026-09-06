# v0.10.3 Web 小小对话面板 · 实施级设计

日期：2026-08-29 · 作者：预研泳道 B · 状态：**定稿，可直接作为实施任务书**
基线：worktree `integrate-v0626-candidate`；前端根 `outputs/product-design-prototype/`；**本文以文件名+函数名为锚点，不引行号**。
范围依据：总蓝图 v0.10.3 行；审计B §6.2（Web 无对话入口，最大结构性双端割裂）；战役二验收「同一 assistant runtime、同一确认安全模型」。
**硬前置**：v0.10.0（toast/`ConfirmDialog`）、v0.10.1（context/懒加载）、v0.10.2（移动底栏+FAB）视为已落地；v0.9.2 owner 硬隔离与 CSRF 会话模型不变。实施时未合入先 rebase。

## 0. 结论先行

- **消灭双端割裂**：新增 `channel:"web"` HTTP 边界，复用 `createAssistantOrchestrator().handle()` 与 `assistant_pending_actions` 状态机；微信仍走机器令牌 `WEIXIN_ASSISTANT_EVENT_ROUTE`，**两通道永不混用鉴权**。
- **确认模型对齐、呈现分化**：R0 直答；R1 `affirm_language`→面板内单钮「确认」；R2/R3 `explicit_code`→`AssistantConfirmCard` 点按确认（**不向用户展示六位码**）；服务端用 `deriveWebExplicitCredential`（与 `deriveAffirmCredential` 同构）在 HTTP 层注入内部 credential，仓库 `confirm()` 路径与微信字节一致。
- **同步对话、无 outbox**：Web 请求—响应同步返回；`confirmation-outbox` 仅 weixin worker；可选 `GET` 拉历史，**不做**服务端 push/SSE（v0.10.4+）。
- **入口裁定（与 v0.10.2 协调）**：桌面 ≥761px **右下角 Sparkles FAB**；移动 ≤760px **顶栏 `icon-button`「小小」**（避免与 v0.10.2 快速记录 FAB 双 FAB 抢拇指位）；底栏「更多」抽屉增二级入口「AI 对话」作发现性备份。
- **历史 v1**：`sessionStorage` 展示缓存 + `localStorage` 持久 `conversationId`；刷新后 `GET /api/assistant/history` 只读 `assistant_draft_parts`（过滤控制占位符）。**无 DB 迁移**。
- **能力 v1**：开放 HELP 子集（战情/客户/待办/知识/招标 + 商机读与轻写）；**封闭**记账财务链、凭证 ingest、请款结算预览、`visit-capture` 全链（仍微信）。

---

## 1. 后端 Web Channel

### 1.1 路由与鉴权

| 方法 | 路径 | 鉴权 | CSRF |
| --- | --- | --- | --- |
| `POST` | `/api/assistant/chat` | 会话 Cookie `authenticateRequest` → `request.authContext.account` | `assertCsrfToken` |
| `POST` | `/api/assistant/confirm` | 同上 | 同上 |
| `GET` | `/api/assistant/history` | 同上 | 不需要 |

**禁止**：上述路由不得接受 `Authorization: Bearer` 机器令牌；`assertMachineRouteAllowed` 白名单不含 assistant web 路由（防混用）。

`server.js` 装配位置：置于用户 API 块（`request.authContext` 已解析、`assertCsrfToken` 之后），与 `WEIXIN_ASSISTANT_EVENT_ROUTE` 块分离。

### 1.2 `POST /api/assistant/chat`

**Body**（`readJson`，上限见 §5.2）：

```json
{ "message": "查客户 协和", "conversationId": "可选，UUID 或省略" }
```

**处理**：

1. `owner := request.authContext.account`（v0.9.2 硬隔离，无跨账号参数）。
2. `conversationId` 缺省时：`web:conversation:v1:{sha256(owner|sessionId)}`，`sessionId` 取自活跃会话 `request.authContext.id`；客户端显式传入时须匹配 `^[a-zA-Z0-9:_-]{8,200}$`。
3. `eventId := web:event:v1:{sha256(owner|conversation|clientMessageId)}`，`clientMessageId` 由 body 可选 `clientMessageId` 或服务端 `randomUUID()`。
4. 限流：`consumeLoginRateLimit`（§5.1）。
5. 调用：

```js
await assistantOrchestrator.handle({
  context: {
    owner,
    channel: "web",
    conversation: conversationScope,
    event: eventId,
    requestId,
  },
  input: { text: message.trim() },
  serverData: {}, // 无 auditMetadata / media / quote
});
```

6. 响应经 `mapAssistantWebResponse(result)` 归一化（§1.4），HTTP 状态码与 orchestrator `result.status` 一致。

**幂等**：同一 `clientMessageId` + 同 conversation 重放返回缓存响应（复用 `assistant_inbound_events` requestHash，digest 含 `channel:web`）。

### 1.3 `POST /api/assistant/confirm`

**Body**：

```json
{ "pendingActionId": "uuid", "conversationId": "与 chat 一致", "intent": "confirm" | "cancel" }
```

**处理**：

- `intent:"cancel"` → `handle({ input: { text: "取消", pendingActionId } })`（与微信取消语义一致）。
- `intent:"confirm"`：
  - 查 `pendingActionRepository.get(pendingActionId, { owner, channel:"web", conversationId })`；404→`ASSISTANT_ACTION_NOT_FOUND`。
  - 读 tool policy：`affirm_language` → `input: { text:"确认", pendingActionId }`；`explicit_code` → HTTP 层注入 `confirmationCode: deriveWebExplicitCredential(confirmationSecret, pendingActionId)` + `pendingActionId`（**客户端永不接触码**）。
  - 新 `eventId := web:confirm:v1:{sha256(pendingActionId|intent|nonce)}`，`nonce` 每次随机（防事件表碰撞）。

**Orchestrator 最小补丁**（`orchestrator.js`）：

- 导出 `deriveWebExplicitCredential`（HMAC 域 `sentelligent/assistant-web-explicit-confirmation/v1` + actionId）。
- 在 explicit_code 确认分支：当 `context.channel==="web"` 且 `structuredCode` 来自 HTTP 注入（非用户文本解析）时，走与 `affirmConfirmation` 相同的「服务端重导 credential」路径。
- 新增 `safeWebPendingResponse(tool, { preview })`：`channel==="web"` 时替代 `safePendingResponse`，响应含结构化 `card`（§2.1），**不含** `confirmationCode` 字段。

### 1.4 微信 vs Web 差异表

| 维度 | 微信 `weixin` | Web `web` |
| --- | --- | --- |
| 鉴权 | 机器令牌 + binding.account | 会话 Cookie + CSRF |
| owner 来源 | `weixin_bindings.activeBySender` | `authContext.account` |
| conversation | senderId/chatType/group 哈希 | account+session 或显式 id |
| auditMetadata | senderHash/financialScope/… | **无**（`serverData:{}`） |
| financialScope | 私聊+绑定开关 | **恒 false**；`advance-settlement.preview`/`bookkeeping.*` 路由层+orchestrator 双层拒绝 |
| R1 确认 | 用户发「确认」 | 面板按钮 → `POST /confirm` |
| R2/R3 确认 | 六位码文本 | `AssistantConfirmCard` → `POST /confirm`（内部 credential） |
| 出站 | `confirmation-outbox` worker | **不适用**；同步 JSON |
| 响应码展示 | 微信文案含码 | `card` JSON，无码 |
| 媒体/语音 | `serverData.media` | v1 **不支持**上传 |

### 1.5 `GET /api/assistant/history`

Query：`conversationId`（必填）。返回：

```json
{
  "conversationId": "...",
  "items": [
    { "role": "user"|"assistant", "text": "...", "at": "ISO", "status": "ok"|"clarify"|... }
  ]
}
```

数据源：`sessionRepository.listDraftParts`；过滤 `CONTROL_MESSAGES`（`runtimeHandlers.js`）与 `"<confirmation-code>"`；`owner`+`channel:web` 不匹配→404（防枚举）。

### 1.6 错误码词表

| HTTP | code | 场景 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | 无会话/过期 |
| 403 | `FORBIDDEN` | 非 user 会话；工具 `denied`；财务类意图 |
| 404 | `NOT_FOUND` | 他人 pendingAction/conversation（统一 404 防枚举） |
| 405 | `METHOD_NOT_ALLOWED` | 方法错误 |
| 409 | `ASSISTANT_ACTION_STATE_CONFLICT` | 并发 pending；确认失败 |
| 410 | `ASSISTANT_ACTION_EXPIRED` | pending TTL 过期 |
| 422 | `VALIDATION_ERROR` | body 校验；message 超长/空 |
| 429 | `RATE_LIMITED` | 助手限流 |
| 500 | `INTERNAL_ERROR` | 未预期 |

消息体统一 `{ error: { code, message, details? } }`（读操作）或 orchestrator `{ status, message/text, ... }`（对话成功路径）。

---

## 2. 确认 UX 映射

### 2.1 `AssistantConfirmCard`（新组件）

路径：`src/components/assistant/AssistantConfirmCard.jsx` + `weixinCardParse.js`（从 `weixinCard` 文本解析 `【标题】`+`标签：值` 行→`{ title, fields[], footer }`；解析失败回退纯文本 `pre`）。

| orchestrator.status | UI |
| --- | --- |
| `ok` / help 文本 | `AssistantMessage` 气泡 |
| `clarify` / `unknown` | 助手气泡 + 浅色提示条 |
| `denied` | 错误 tone 气泡（同微信文案） |
| `confirmation_required` + `risk:R1` | 卡片 + 主钮「确认」+ 次钮「取消」 |
| `confirmation_required` + `risk:R2/R3` | 卡片 + `ConfirmDialog` 风格双钮（destructive 时确认钮 `tone-danger`） |
| `cancel` | 灰色系统消息「已取消」 |

**R3 删除类**：二次 `ConfirmDialog`（与 v0.10.0 删除范式一致）——卡片点「确认」后再弹全屏遮罩「此操作不可恢复」。

字段映射：`response.card ?? parseWeixinCard(response.text)`；`toolName`/`risk`/`actionId` 元数据入 message model。

### 2.2 与 toast / ConfirmDialog 集成

- 写操作成功（`status:"ok"` 且 tool 为写类）：`toast({ tone:"success", title:"已更新", description: result.summary })` + 触发 `refreshBootstrap()` / `refreshOverviewSummary()`（按 `toolName` 映射表）。
- 确认失败 409/410：`toast({ tone:"error", ... })`，卡片保持可重试。
- **不**用 `window.confirm`；R3 仅用样式 `ConfirmDialog`（`shared.jsx` 契约）。

### 2.3 Conversation 作用域

- 默认：**一账号一浏览器会话一线程**（`sessionId` 嵌入 conversation 哈希）；关浏览器重开→新 session→新 conversation（历史 GET 仍可按旧 `conversationId` 拉取若 localStorage 保留）。
- `localStorage` 键：`sentelligent_assistant_conversation_v1:{account}` 存 `conversationId`。
- pendingAction 绑定 `conversation_id`（仓库既有约束）；切换 conversation 前须无 active pending，否则 409 提示先处理。

---

## 3. 前端面板

### 3.1 入口（推荐）

| 视口 | 入口 | testid |
| --- | --- | --- |
| ≥761px | 固定右下 FAB，`bottom:24px; right:24px`，`Sparkles` 图标 | `assistant-fab` |
| ≤760px | 顶栏 `AvatarMenu` 左侧 `icon-button` | `assistant-topbar-button` |
| ≤760px | `MobileMoreDrawer` 列表项「AI 对话」 | `assistant-more-entry` |

z-index：低于 toast（`toast-region`），高于内容；移动 FAB **不新增**（避免与 `mobile-fab-quick-record` 冲突）。

### 3.2 `AssistantChatPanel`

路径：`src/components/assistant/AssistantChatPanel.jsx`（懒加载 chunk `assistant-chat`）。

- **容器**：`role="dialog"` `aria-modal` 右侧抽屉（桌面 `width:min(420px,100vw)`；移动全屏 `100dvh`）。
- **结构**：Header（标题「小小」+ 关闭）→ `AssistantMessageList`（虚拟滚动可选，v1 简单 map）→ `AssistantComposer`（textarea + 发送）。
- **状态**：`AssistantChatContext`（或 `useAssistantChat` hook）包 `messages/pending/conversationId/isOpen`；挂 `App.jsx` `ToastProvider` 内、路由壳外（全站可用）。
- **API**：`salesWorkbenchApi.postAssistantChat` / `postAssistantConfirm` / `getAssistantHistory`（均带 CSRF）。

### 3.3 历史取舍（v1 裁定）

| 方案 | 取舍 |
| --- | --- |
| **选用** sessionStorage 展示层 + GET 回填 | 零迁移；与 `assistant_draft_parts` 一致；刷新可恢复 |
| 仅 sessionStorage | 实现最简但刷新丢上下文 |
| 全服务端列表会话 | 需新 UI 会话列表，超 v1 范围 |

流程：打开面板→读 sessionStorage `messages`→若空则 GET history→合并展示；每次 chat/confirm 后写 sessionStorage。

### 3.4 键盘与 a11y

- `Enter` 发送（`textarea` 上 `onKeyDown` 拦截，`Shift+Enter` 换行）。
- `Escape` 关闭面板（焦点回到触发钮）。
- 发送中：`aria-busy` + 禁用输入；列表 `aria-live="polite"`。
- FAB/顶栏钮：`aria-expanded={isOpen}` `aria-controls="assistant-chat-panel"`。

---

## 4. 能力范围 v1

### 4.1 开放（与 `router.js` HELP 对齐子集）

| 意图域 | 工具（policy） | Web 行为 |
| --- | --- | --- |
| 帮助 | `help` | 展示 HELP 全文 |
| 战情 | `dashboard.summary` (R0) | 直答 |
| 客户 | `customer.search/detail` (R0)；`create/update` (R2)；`delete` (R3) | 写→确认卡 |
| 商机 | `list/detail` (R0)；`update-stage/update-next` (R1)；`update/create` (R2)；`delete` (R3) | 写→确认卡；成功后可选 `navigateTo` 实体 |
| 待办 | `action-risk.list/summary` (R0)；`create/complete/defer` (R1)；`delete` (R2) | 写→确认卡 |
| 知识 | `knowledge.search` (R0) | 直答+引用片段 |
| 招标 | `hospital-tender.summary` (R0) | 直答 |

路由层 **allowlist**：`createAssistantRouter` 外包 `webToolFilter`（`server.js` 注入 `channel` 到 route context），未注册工具→`denied`（403）。

### 4.2 首期不开放

| 封闭项 | 理由 |
| --- | --- |
| `bookkeeping.*` / `shortcut-bookkeeping.*` | 审计B §6.2 记账确认仅微信；v0.7.1 裁定 |
| `travel-expense.create` | 财务写入 R3 |
| `payment-proof.ingest` / `invoice.ingest` | 需微信媒体链 |
| `visit-capture.*` | 拜访六位码/录入链复杂；v1 简化，留微信 |
| `advance-settlement.preview` | 需 `financialScope` |
| `sales-report.preview` / `reimbursement-report.preview` | 非 HELP 核心；可 v0.11 放开 |
| 任意 `serverData.media` | v1 无上传 UI |

---

## 5. 安全

### 5.1 Rate limit

复用 `loginRateLimit.js`：

```js
loginRateLimitKey(authSessionSecret, `assistant-web:${account}`, remoteAddress)
```

阈值：**30 次 / 15 分钟 / account+IP**（对话+确认合计）；超限 429。绑定码流仍用独立 `weixin-binding:` 前缀，互不干扰。

### 5.2 消息上限

- `message`：`1..2000` 字符（trim 后）；超长 422。
- JSON body：`maxBytes = min(jsonBodyLimitBytes, 32_768)`。
- 响应 `text`/`card` 展示截断 8000 字符（前端）。

### 5.3 Owner 硬隔离

- 所有 assistant 表查询带 `owner = authContext.account`（v0.9.2 契约）。
- `pendingActionId` 跨账号→404。
- **无** admin 代查他人对话。

### 5.4 CSRF / 令牌

- `POST` chat/confirm 必须 `X-CSRF-Token`（与 `salesWorkbenchApi` 一致）。
- Web 路由拒绝 machine Bearer；微信路由拒绝 session Cookie（现状保持）。

---

## 6. 测试清单（预估 ≥42 断言）

### 6.1 后端 HTTP（`assistant-web-http-integration.test.js`，~22）

| # | 断言要点 |
| --- | --- |
| 1–3 | 未登录 401；错误 CSRF 403；机器令牌打 web 路由 401 |
| 4–6 | `help` 200+HELP 文案；`dashboard.summary` 200；超长 message 422 |
| 7–9 | R1 待办创建→confirm→DB 有记录；cancel 路径；过期 410 |
| 10–14 | R2 客户更新：chat 返回 `confirmation_required` **无** confirmationCode；confirm 成功；错误 pendingId 404；双 pending 409 |
| 15–17 | R3 删除二次确认流；owner B 访问 A 的 actionId 404 |
| 18–20 | 限流 429；幂等 clientMessageId 重放；history GET 过滤控制消息 |
| 21–22 | `bookkeeping` 意图 403；`visit-capture` 403 |

### 6.2 Orchestrator 单元（~6）

- `deriveWebExplicitCredential` 确定性；`safeWebPendingResponse` 无码；web channel explicit 确认与微信码路径隔离。

### 6.3 前端（~14）

| 文件 | 要点 |
| --- | --- |
| `weixinCardParse.test.mjs` | 4：标题/字段/footer/容错 |
| `AssistantConfirmCard.test.mjs` | 4：R1/R2/R3 钮；denied 展示 |
| `assistantChatModel.test.mjs` | 3：sessionStorage 合并；pending 状态机 |
| `assistant-fab.test.mjs` | 3：760 断点顶栏 vs 桌面 FAB |

### 6.4 浏览器走查（手工卡，不计入自动化条数）

登录→开面板→「帮助」→查客户→改待办确认→列表刷新可见。

---

## 7. 部署与验收

### 7.1 部署

- **无迁移**（复用 `assistant_conversations` / `assistant_draft_parts` / `assistant_pending_actions`）。
- 发布：常规 preflight→cutover→postflight；新增路由计入 HTTPS 冒烟抽测。
- 回滚：切回上一 release；pending 行随 channel 隔离，无交叉污染。

### 7.2 生产验收脚本

1. 登录生产 → 点「小小」→ 发「帮助」→ 见 HELP 列表。
2. 发「查客户 {已知客户名}」→ 返回档案摘要卡片/文本。
3. 发「把待办 XXX 标完成」→ 出现确认卡 → 点确认 → toast 成功。
4. 打开待办列表 → 状态已更新；切战情总览 → 数字刷新。
5. 发「记一笔午餐 50」→ 403/拒绝文案（财务仅微信）。
6. 微信端同账号发消息 → 行为与升级前一致（回归）。

证据：`docs/superpowers/reports/assets/v0103-web-chat/` 截图 ≥6。

### 7.3 门禁清单

1. 后端 `npm test` 全绿（存量 + 新增 ≥28）。
2. 前端 `qa:local` 全绿（存量 + 新增 ≥14）。
3. `rg '/api/assistant'` 仅 `server.js`+测试+api 客户端；无机器路由泄漏。
4. `rg confirmationCode` 前端助手目录 **零**命中（码不出浏览器）。
5. 桌面 1440 无面板时布局与 v0.10.2 **零 diff**；移动无第三 FAB。
6. 双账号隔离抽测：A 的 `pendingActionId` B 确认 404。
7. §7.2 生产脚本 6 步全过。

---

## 8. 实施顺序（建议提交点）

1. **后端**：`deriveWebExplicitCredential` + web 响应映射 + 三路由 + allowlist + 集成测试。
2. **前端 API + 解析器**：`salesWorkbenchApi` 三方法 + `weixinCardParse`。
3. **UI**：`AssistantConfirmCard` → `AssistantChatPanel` → 入口接线。
4. **收尾**：bootstrap 刷新映射、门禁、release 文档。

---

## 9. 本版不做

- 语音/图片消息、服务端 ASR（v0.10.4）。
- Web Push / SSE 对话推送。
- 拜访 `visit-capture` 六位码简化版（留后续）。
- 记账财务确认界面（永久仅微信，除非产品改裁定）。
- 多会话列表 UI、跨设备 conversation 同步。
