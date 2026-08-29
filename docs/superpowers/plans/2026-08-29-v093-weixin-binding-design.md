# v0.9.3 微信绑定层 · 实施级设计（weixin_bindings / 绑定码流 / worker 多目标 / 调度器多播）

日期：2026-08-29 · 作者：预研泳道 B · 状态：**定稿，可直接作为实施任务书**
基线：工作树 `.worktrees/integrate-v0626-candidate`（实施工人并行中，**本文一律以文件名+函数名为锚点，不引行号**）。
范围依据：总蓝图 v0.9.3 行；多账号设计 L3 与 §6 决策（D2 已裁定 sender 白名单入 DB、D3 已裁定晨报订阅制绑定默认开）；审计A §2.5/§2.6/§4（#3/#4/#5/#6/#7/#12/#13/#18）；v0.9.1 认证设计（users=0030）；v0.9.2 隔离设计（0031，Web 硬隔离）。
**硬前置**：v0.9.0（0029）、v0.9.1（0030 users + `requireAdminRole`）、v0.9.2（0031 隔离）均已合入上线。实施开始时若未合入，先 rebase。

## 0. 结论先行与版本边界

- **迁移编号核对**：任务口径"0033"经实读修正为 **0032**——迁移链现况 0001–0029 在库，0030（v0.9.1）、0031（v0.9.2）已被前序设计占用，顺延即 0032。
- **安全模型是本版核心**：投错人=越权泄露。三道闸：①入口"未绑定 sender 能力面={绑定意图}，其余零能力"；②出站 `conversation_id ≡ deliveryScope ≡ hash(owner, senderId)` 不变式（源码实读确认现有五类出站消息全部经 `conversationFor` 派生会话，不变式天然成立）；③lease 侧+worker 侧双保险校验，任一失败即终态 `WEIXIN_DELIVERY_SCOPE_MISMATCH`。
- **裁定重申**：单机器人多绑定，**不上多 worker**（审计A #7）；机器令牌与路由白名单一字不动（#18，通道鉴权与业务归属自此解耦）；`businessOwnerResolver` 闭合语义必须保留（#5）。
- **本版三条新裁定（推荐，实施前可复核）**：
  1. **一账号至多一条 active 绑定**（partial UNIQUE 索引强制）。简化 scope 推理与回执/调度目标解析；表结构支持将来放开。
  2. **绑定码新建绑定 `financial_enabled=0` 默认关**，admin 在 Web 显式开启（财务写入是最高风险面，显式授权）；种子行 jiangjz=1 维持现语义。
  3. **`digest_enabled` 语义=主动推送总闸**（晨报+周五收尾+待办提醒+招标推送），绑定默认开（D3）；免打扰时间窗本版沿用全局现值（招标 9–20 窗口、晨报 09:00/16:30），每绑定自定义窗口登记遗留 v0.10+。
- 本版**不做**：多机器人/多 worker；每绑定免打扰时间列；v0.9.1 登录 env 回退轨移除（原计划本版评估——裁定：绑定层改动已够大，保留至 v0.10.0，收官检查表登记）；`GET/POST/DELETE /api/integrations/weixin-agent/login`（机器人 QR 登录页）不动，与用户绑定是两回事。

## 1. 迁移 0032 与新模块

### 1.1 白名单承载取舍（D2 落地）

**裁定：bindings 表本身即白名单，不建独立 allowlist 表。** 理由：绑定码即准入机制——能出示有效码=admin 已授权，独立白名单表徒增"先加白再绑定"两步摩擦与双状态漂移；未绑定 sender 的能力面恒为 {绑定意图}，等价于"白名单外默认拒绝"。env `WEIXIN_ALLOWED_SENDER_IDS` 降级为 bootstrap 种子来源+回滚兜底（保留一版，运行时不再参与 sender 过滤；群聊键仍生效）。

### 1.2 `backend/src/db/migrations/0032_weixin_bindings.mjs`（要点全文）

```js
// v0.9.3 L3：weixin_bindings（绑定表=sender 白名单）+ weixin_binding_codes（6 位码 HMAC 哈希）。
// 种子读 env（生产 cutover 后首启 EnvironmentFile 在位）；env-less 彩排跳过种子，
// 由 server.js 启动期 ensureBootstrapBinding 兜底——两处校验语义保持一致（0030 先例）。
export function apply(db) {
  db.exec(`
    CREATE TABLE weixin_bindings (
      sender_id TEXT PRIMARY KEY NOT NULL CHECK (length(sender_id) BETWEEN 1 AND 200),
      account TEXT NOT NULL REFERENCES users(account),
      display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 50),
      financial_enabled INTEGER NOT NULL DEFAULT 0 CHECK (financial_enabled IN (0, 1)),
      digest_enabled INTEGER NOT NULL DEFAULT 1 CHECK (digest_enabled IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      bound_at TEXT NOT NULL, bound_by TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_weixin_bindings_one_active_per_account
      ON weixin_bindings(account) WHERE status = 'active';
    CREATE TABLE weixin_binding_codes (
      code_hash TEXT PRIMARY KEY NOT NULL,
      account TEXT NOT NULL REFERENCES users(account),
      expires_at TEXT NOT NULL, used_at TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const senderId = String(process.env.WEIXIN_BOOKKEEPING_SENDER_ID ?? "").trim();
  const account = String(process.env.WEIXIN_BOOKKEEPING_OWNER ?? process.env.AUTH_ACCOUNT ?? "").trim();
  const hasUser = account && db.prepare("SELECT 1 FROM users WHERE account = ?").get(account);
  if (senderId && hasUser) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO weixin_bindings
      (sender_id, account, display_name, financial_enabled, digest_enabled, status,
       bound_at, bound_by, created_at, updated_at)
      VALUES ($s, $a, NULL, 1, 1, 'active', $now, 'system:bootstrap', $now, $now)`)
      .run({ $s: senderId, $a: account, $now: now });
  }
}
```

要点：FK 依赖 users（0030 先于 0032，`configureConnection` 恒开 foreign_keys）；种子行 `financial_enabled=1, digest_enabled=1` 对应现 BOOKKEEPING 绑定语义（jiangjz）；env-less 彩排=建表成功、种子跳过（预期差异写部署单，0030 §1.3 先例）；不回填 display_name（admin 可后补）。挂载 `db/migrate.js` 数组尾部 `{ version: "0032" }`；`migrations.test.js` 基线 30→**31**（五处计数/清单更新，0031 先例照抄）+ 新用例「0032 creates weixin bindings and seeds the env binding」：带 env 种子/无 env 跳过/CHECK 矩阵（status 非法、financial=2、双 active 同 account 违反 partial index）/二跑幂等。

### 1.3 新模块（三个，全同步、db 闭包、SQL 收敛单文件）

| 模块 | 契约 |
|---|---|
| `weixin/bindingsRepository.js` | `activeBySender(senderId)`、`activeByAccount(account)`、`hasActive()`、`listAll()`、`listDigestTargets()`（active∧digest_enabled=1，返回 `{account, senderId, conversationId}`，conversationId 现算自 `shortcutBookkeepingConversationId`）、`listAdminTargets(db 联 users.role='admin')`、`bind({senderId, account, displayName, boundBy, financialEnabled=0})`（`INSERT ON CONFLICT(sender_id) DO UPDATE` 支持同 sender 换绑；partial index 冲突映射 409 `ACCOUNT_ALREADY_BOUND`）、`disable(senderId, {by})`、`updateVersioned({senderId, expectedVersion, set})`（乐观锁，0030 usersStore 模式） |
| `weixin/bindingCodes.js` | `hashBindingCode(secret, code)`=`HMAC-SHA256(assistantConfirmationSecret, "sentelligent/weixin-binding-code/v1\0" + code)`（复用既有独立密钥，不加 env 键）；`issueCode({account, createdBy})`：先 DELETE 该 account 未用码（一账号一活跃码）→ 随机 6 位（`randomInt`）→ INSERT（PK 撞历史行则重试 ≤5）→ 返回 `{code, expiresAt=now+10min}` **明文只出现在本次响应**；`redeemCode({code, now})`：事务内 `UPDATE ... SET used_at=$now WHERE code_hash=$h AND used_at IS NULL AND expires_at > $now`，changes=1 才返回 account（一次性原子化）；`pruneExpired()` 顺手清理 >24h 陈行 |
| `assistant/weixinBindingGate.js` | 入口闸函数（§2.2），从 server.js 事件 handler 拆出，便于单测：`classifyBindingText(text)`（`^绑定\s*([0-9]{6})$`/`^解绑$`/`^确认解绑$`）与 `handleUnboundEvent`/`handleBindingControl` |

## 2. 安全模型：入口安全顺序与绑定流

### 2.1 events 入口安全顺序（核心裁定：绑定意图识别在 sender 白名单校验**之位**——白名单即绑定表，未绑定者仅放行绑定意图）

新同事的 senderId 按定义不在任何名单里，"白名单先行"会锁死绑定流；反之"未绑定全放行"=能力泄露。裁定为**闭合能力面**模型，`POST /api/integrations/weixin-agent/events` 按序：

| 序 | 闸 | 行为 | 不变项 |
|---|---|---|---|
| 1 | 机器令牌（通道鉴权） | `authenticateMachineRequest` + `assertMachineRouteAllowed` | 一字不动（#18） |
| 2 | 幂等键+payload 校验 | `validateWeixinAssistantEvent` | 不动 |
| 3 | 群聊闸 | `assertWeixinSenderAllowed` 拆分：群规则保留为 `assertWeixinGroupAllowed`（生产强制无群），**sender ∈ env 白名单分支删除** | 群闸语义不变 |
| 4 | 绑定解析 | `bindingsRepository.activeBySender(body.senderId)` | 新增 |
| 5a | **未绑定**（无行或 disabled） | 仅识别绑定意图：命中「绑定 ######」→ 防爆破限流 → `redeemCode` → `bind` → 欢迎卡；错码/过期/已用 → 拒绝文案；**其余任何文本/媒体一律固定拒答**——不入 orchestrator、不落 assistant_inbound_events、不写 blob，回 200 `{status:"denied", text:"您尚未绑定工作台账号，请联系管理员获取绑定码后发送：绑定 123456"}`（返回 200 保证 worker 把引导文案回给用户；403 会被 worker 当错误吞掉） | 未绑定能力面={绑定} |
| 5b | **已绑定** | 绑定控制词优先：「绑定 ######」→ 回"当前微信已绑定 <displayName/account>，如需换绑请先发送「解绑」"（**不消耗码**，防误换绑）；「解绑」→ 回轻确认引导；「确认解绑」→ `disable` + 告别语（两段纯文本协议，无状态窗口，误触可由 admin 重发码恢复，低频可接受）；其余 → 正常编排（§3.1） | 解绑自助轻确认 |

防爆破：复用 `auth/loginRateLimit.js` 全套（表+窗口 5 次/15 分钟+prune），key=`loginRateLimitKey(authSessionSecret, "weixin-binding:" + senderId, "weixin")`；错码 `recordLoginFailure`，命中锁定回"尝试过于频繁，请 15 分钟后再试"，绑定成功 `clearLoginFailures`。码空间 10^6 × TTL 10 分钟 × 一次性 × 5 次/15 分钟限流，暴破期望不可行。

### 2.2 绑定流全景（admin 生成 → 微信兑换）

1. admin 于 Web 用户管理页对某账号点「生成绑定码」→ `POST /api/admin/weixin-bindings/codes {account}`（`requireAdminRole`；校验 users 行 active；该账号已有 active 绑定 → 409 `ACCOUNT_ALREADY_BOUND`，提示先解绑）→ 201 `{code, expiresAt}` **展示一次**，UI 明示"10 分钟内有效、只可使用一次、请当面/电话告知本人"。
2. 该同事微信对小小发「绑定 123456」→ §2.1 序 5a → 落 bindings（`financial_enabled=0, digest_enabled=1`）→ 回**欢迎卡**（能力清单：客户/商机/待办/拜访/晨报…；明示"每天 09:00 晨报默认开启，回复「解绑」可随时解除；记账能力需管理员开通"）。
3. 解绑：微信侧两段自助（§2.1 序 5b）；Web 侧 admin `PATCH /api/admin/weixin-bindings/:senderId {status:"disabled", expectedVersion}`。解绑后：该 sender 回到未绑定态（仅可再绑定）；其 owner 的在途 outbox 行由 lease 闸静默终态（§4.2）。

### 2.3 admin API 与审计词表

端点（均 `requireAdminRole`，机器路由白名单**不加**）：`GET /api/admin/weixin-bindings`（listAll+users 联查 displayName）；`POST /api/admin/weixin-bindings/codes`；`PATCH /api/admin/weixin-bindings/:senderId`（displayName/financialEnabled/digestEnabled/status + expectedVersion 必填；status→active 需通过 one-active 索引否则 409）。`validation/requests.js` 增 `adminWeixinBindingCode`/`adminWeixinBindingPatch` 两 schema。前端：`UserManagementPage.jsx` 增「微信绑定」Panel（列表+生成码弹窗一次性展示+开关+解绑确认），api 层四个新方法；注册点沿 v0.9.1 §6.4 既有页面，无新路由。

审计词表（entity_type="weixin_binding"，entity_id=senderId 的 sha256 前 16 位即 senderHash 短形，**senderId 明文与绑定码明文绝不入审计**）：
`weixin.binding.code_issued`（actor=admin，metadata={account, expiresAt}）、`weixin.binding.bound`（actor=绑定账号，metadata={senderHash, via:"weixin"}）、`weixin.binding.code_rejected`（actor="weixin-agent"，metadata={senderHash, reason∈invalid|expired|used|rate_limited}）、`weixin.binding.denied`（未绑定非绑定文本，actor="weixin-agent"）、`weixin.binding.unbound`（metadata={via:"weixin_self"|"web_admin"}）、`weixin.binding.updated`（admin 改开关，before/after 限已变字段；financial 开关变更必产生本行=财务授权可追溯）。

## 3. 入口与运行时改造

### 3.1 events 端点正常路径改造（server.js 事件 handler）

- `owner := binding.account`（替代 `machineIdentity.account` 固定 owner；机器令牌仅通道鉴权）。`conversationTuple`/`eventTuple` 首元素同步改 binding.account——种子绑定 account==machineIdentity.account=='jiangjz'，**升级前后哈希不变，幂等/会话零漂移**。
- `shortcutConversation` 判定改为"binding 存在 ∧ chatType=direct"→ `conversationScope = shortcutBookkeepingRuntime.conversationFor(binding.account, body.senderId)`；泛型 `weixin:conversation:v1:` 分支仅余群聊（生产不可达），保留作防御。
- **financialScope := chatType==="direct" ∧ binding.financial_enabled===1 ∧ runtime.enabled**（替代四条件 env 比对）。下游零改动：orchestrator `auditMetadata.financialScope` 白名单、runtimeHandlers 三处 `financialScope !== true` 拒闸、`shortcutBookkeepingRuntime.handlePending` 的 metadata 检查，全部照旧生效。

### 3.2 `businessOwnerResolver` 改查表（闭合语义不变，#5）

`createBusinessOwnerResolver({ hasActiveBinding })` 替代 `{businessOwner}`：`(account) => normalizeOwner(account) && hasActiveBinding(account) ? account : null`。装配处传 `(a) => Boolean(weixinBindingsRepository.activeByAccount(a))`。**无绑定→null 拒答，不回退全量**；`digestContent.resolvedOwnerOf`→`no_business_owner` 空报、快照适配器 owner=null 空集语义全部自动继承。既有 resolver 单测改注入桩，断言闭合矩阵（绑定中/未绑定/disabled/空串/超长）。

### 3.3 `shortcutBookkeepingRuntime` 装配点改动清单（实读列举；runtime 业务函数已全收 `account` 参数，不动）

| 位置（函数锚点） | 现状 | 改动 |
|---|---|---|
| 工厂顶部闭包段（`createShortcutBookkeepingAssistantRuntime`） | `enabled/senderId/owner/senderAllowed/ready` 五常量取自 config | `enabled` 保留 config；`senderId/owner/senderAllowed` 删除；新增依赖 `bindingsRepository`；`ready` 改函数=`enabled ∧ hasActive()` |
| `isReadyFor(account)` | `ready && account === owner` | `enabled && Boolean(activeByAccount(account))` |
| `conversationFor(account, requestedSender)` | 闭包 senderId 比对 | 查 `activeByAccount(account)`，无 → 503 `WEIXIN_BOOKKEEPING_CONFIRMATION_NOT_READY`（文案改"该账号未绑定微信"）；requestedSender 缺省=binding.sender_id，不等 → 403 `WEIXIN_SENDER_NOT_ALLOWED`；返回 `shortcutBookkeepingConversationId(account, binding.sender_id)` |
| 导出面 `owner`/`senderId` 字段 | 被 server.js 六处消费 | **删除**，消费方逐一改造（下三行+§5） |
| `settleFromWeb` 的 `conversationFor(normalizedAccount)` | 无绑定即抛 503，会阻断 Web 复核 | 改可空：无 active 绑定 → 跳过回执入队（财务落库照常），返回 `outbox:null`，审计 metadata `receiptSkipped:true`——Web 端解绑用户仍可正常记账复核 |
| `reconcileAcceptedReceipts` 行循环内 `conversationFor(row.owner)` | 单 owner 恒成立 | 逐行 try/catch，无绑定行跳过不中断循环 |
| server.js `weixinTenderDeliveryReady` | `runtime.ready && isReadyFor(runtime.owner)` | 改 `runtime.ready`（=enabled ∧ hasActive()），命名改 `weixinDeliveryEnabled` |
| server.js outbox GET 内 `reconcileWeixinInvoiceAttachments({owner: runtime.owner})` | 单 owner | 遍历 active bindings 逐 owner 执行（行数≤个位，开销可忽略） |
| server.js digest dryRun `digestOwner = runtime.owner` | 泄露面已由 v0.9.2 admin 门禁+account 收口 | 改 `request.authContext.account`（未绑定者得 `no_business_owner` 空报，符合"预览微信侧将发什么"语义） |

### 3.4 config 生产校验改造（`validateProductionConfig`）

- **删除三条**：`WEIXIN_BOOKKEEPING_SENDER_ID` 必填、必须 ∈ `WEIXIN_ALLOWED_SENDER_IDS`、`WEIXIN_BOOKKEEPING_OWNER === WEIXIN_AGENT_OWNER`。
- **保留**：`WEIXIN_AGENT_OWNER` 必填（机器身份/workerId，仍是通道概念）；群聊两条硬校验；令牌熵与独立性校验。
- **替代=运行时检查**：`createServer` 启动期 `ensureBootstrapBinding(db, config)`（表无 active 行 ∧ env sender/owner 合法 ∧ users 有该账号 → 只插不改，actor="system:bootstrap"，0030 `ensureBootstrapAdmin` 同构，紧随其后调用）；随后若 `!hasActive()` → `console.warn("category=weixin bindings_empty")` 且 `opsAlertStatusSnapshot` 增 `weixinBindings:{active:N}` 字段供 5 分钟巡检 timer 告警——**不 fail 启动**（零绑定时微信面自动静默，Web 面不受影响）。
- env 过渡：`WEIXIN_BOOKKEEPING_OWNER/SENDER_ID`、`WEIXIN_ALLOWED_SENDER_IDS` 三键保留解析**一版**（仅 bootstrap 消费），v1.0.0-rc 连同键值一起退役（收官检查表登记）。

## 4. worker 多目标投递与 scope 矩阵

### 4.1 现状实读结论

outbox 行本身**无 deliveryScope 列**：`weixin_confirmation_outbox.conversation_id` 即 scope（`weixin:shortcut:v1:{sha256(owner\0senderId)}`，`bookkeepingDeliveryScope.js`）；lease 响应的 `deliveryScope` 字段是后端现算的 `conversationFor(item.owner)`。五类生产者（记账卡 `runtime.enqueue`、晨报/周五 `digestScheduler`、提醒 `reminderScheduler`、招标 `hospitalTender/weixinNotifier`、告警 `opsAlertService`）全部以 `conversationFor` 结果入队 ⇒ **`conversation_id ≡ deliveryScope` 不变式对全部行成立**。worker 侧 `configuredBookkeepingDeliveryScope` 闭包持唯一 `{owner, senderId}`，`sendMessageTo` 只发这一人。哈希不可逆 ⇒ 多目标必须由后端在 lease 响应中给出明文目标。

### 4.2 投递协议 v2（双保险）

- **入队侧一致性（第一道）**：所有生产者只能经 `conversationFor(account)` 取会话（查活跃绑定现算），入队即绑定一致；绑定变更后旧行自然失配，由下一道闸截获。
- **lease 侧（backend，替换现 `isReadyFor(lease.item.owner)` 判废逻辑，模式不变）**：`binding = activeByAccount(item.owner)`；无绑定 ∨ `item.conversationId !== shortcutBookkeepingConversationId(item.owner, binding.sender_id)`（解绑/换绑前的旧行）→ `discardLeased(WEIXIN_DELIVERY_SCOPE_MISMATCH)` + 204；通过 → 响应 item 增 **`targetSenderId: binding.sender_id`**（additive 字段，`deliveryScope` 照发=conversationId）。
- **worker 侧二次校验（第二道，`runWeixinOutboxPump` 的 `authorizeDelivery` 重写）**：worker 用本地 `shortcutBookkeepingConversationId(item.owner, item.targetSenderId)` **重算哈希**，要求 `=== item.deliveryScope === item.conversationId`；不满足 → ack `terminal:true, WEIXIN_DELIVERY_SCOPE_MISMATCH`（后端伪造/错配 fail-closed）。通过 → `isCurrent` 防超发（不动）→ `bot.isDeliveryTarget(targetSenderId)` 假 → 抛 `WEIXIN_CONTEXT_NOT_READY`（**可重试**，联系人同步中/对方暂不可达不应终态，8 次耗尽自然 failed）→ `bot.sendMessageTo(targetSenderId, message, {clientId})`（clientId 派生不变）。`outboxWorker.createWeixinOutboxHttpClient.lease` 增解析 `targetSenderId`（boundedText ≤200）。
- **解绑后消息静默**：解绑即 lease 闸判废在途行（terminal，不投递、不报错给任何人）；换绑新 sender 后新会话 id 生效，旧行同样判废——**旧消息永不追投新 sender**（会话隔离按 senderId 维度成立）。

### 4.3 deliveryReadiness 就绪头多绑定语义

现三态（`weixinDeliveryReportFromHeaders`）：`ready` 需回显唯一 expectedScope，否则 `delivery_scope_mismatch`/`worker_scope_missing`。N 绑定无唯一 scope，协议升级：
- worker `getDeliveryStatus` 改报 `deliveryScope: "weixin:multi:v1"`（常量哨兵）；`ready = 登录态 ∧ sdkSupportsBoundDelivery ∧ runtime confirmationEnabled`，`recipient_mismatch` 三态原因**退役**（目标判定移到逐条投递期，一个不可达目标不再全局熄火）。
- backend `expectedScope := "weixin:multi:v1"`（`hasActive()` 为假时维持 null → `configuration_incomplete` 不放租约）。`outboxWorker.js`/`outboxClient` 两处 scope 正则放宽为 `^weixin:(shortcut:v1:[0-9a-f]{64}|multi:v1)$`。
- 升级窗口 fail-closed：旧 worker 报旧 scope → 后端判 `delivery_scope_mismatch` 不放租约 → cutover 重启 worker 后对齐（积压自动消化，等价现有 worker 掉线语义）。`deliveryReadiness.js` 本身零改动。

### 4.4 scope 矩阵测试设计（新文件 `backend/tests/weixin-outbox-scope-matrix.test.js`，测试先写，≥20 断言）

夹具：users(jiangjz admin, testb member) + bindings(A=jiangjz→senderA financial=1, B=testb→senderB financial=0) + 假 SDK bot（记录 `sendMessageTo(target, message)` 调用簿）。矩阵：
1. **五类生产者 × 两 owner 交叉投递**（核心 10 断言）：各为 A/B 入队记账卡/晨报/提醒/招标/告警 → 跑 pump 排空 → 调用簿断言 A 的每条只到 senderA、B 的只到 senderB，计数恰好、零交叉。
2. **篡改与错配 fail-closed（≥6）**：直插"owner=A、conversation=B 会话"的行 → lease 判废 terminal；lease 响应 targetSenderId 被篡改为 senderB → worker 重算哈希不等 → terminal mismatch；无绑定 owner=ghost 的行 → 判废；`isDeliveryTarget` 假 → ack 非终态 `WEIXIN_CONTEXT_NOT_READY` 且 attempt+1。
3. **绑定生命周期（≥4）**：解绑 B → B 在途行判废、A 不受影响；B 换绑 senderB2 → 旧行判废、新入队行到 senderB2。
4. **就绪协议（≥3）**：worker 报旧 scope → 204 不放租约；`multi:v1` → 放；`hasActive()=false` → `configuration_incomplete`。

## 5. 调度器多播

三调度器现均为 `resolveOwner: () => runtime.owner` + `resolveConversationId`（server.js 装配段实读），另有任务未点名但同模式的**第四消费者 `opsAlertService`**。统一改造：装配处以 `bindingsRepository.listDigestTargets()` 注入。

| 消费者 | 改造 | 幂等键（加 owner 维度） |
|---|---|---|
| 晨报 `digestScheduler` | `resolveOwner/resolveConversationId` 换为 `resolveDeliveries: () => listDigestTargets()`；`runOnce/runManual` 循环 deliveries 逐 owner `hasKey→build→enqueue`；`dailyEmptySkipDate` 改 per-owner Map；`markers()` 改返回逐 owner 数组（`GET /api/digest/status` 形状 additive）；空 deliveries → skipped | `daily-digest:{owner}:{date}`、`friday-closeout:{owner}:{friday}`。**升级日双发风险**：新键查不到旧行 → 过渡逻辑=对 bootstrap 种子 owner 额外 `hasKey` 旧格式键（`daily-digest:{date}`），v0.10.0 移除；辅以部署窗口避开 09:00±30min |
| 待办提醒 `reminderScheduler` | 循环 deliveries，逐 owner `store.dueReminders({owner})`（批上限 per-owner 不变）；owner 无绑定 → 其到期项不扫描、不置 reminded_at，**后补绑定即补发**（>24h 自动带"过期待办"标记，语义现成） | `action-reminder:{owner}:{id}:{ms}`（`reminded_at` 双保险使键换代零双发） |
| 招标推送 `hospitalTender/weixinNotifier` | 重构 notify：`notice.match.matchedCustomerIds` → 批量查 `customers.owner`（0031 后 NOT NULL）→ **按 owner 分组**（一公告可入多组，组内去重）→ 每组投对应 digest 目标；**无路由组（客户 owner 无 active∧digest 绑定）→ 全部投 active∧digest_enabled 的 admin 绑定**（裁定：admin 而非全体——公告是全局情报但推送是打扰，admin 是用户治理与情报兜底的天然收口人；admin 也无绑定 → PushPlus 兜底 → 再无 → 审计 `hospital_tender.push.unrouted` 计数后视为已处理）；notify 返回值语义=全部成功入队/审计丢弃的公告数，保持 `notified===newHighNotices.length` 的调度器重试契约（入队异常仍抛出 → partial → 整批重试，chunk 幂等键防重复） | `hospital-tender:{owner}:cycle:{n}:chunk:{i}:{digest}`（chunk 按 owner 分组后各自编号） |
| 告警 `opsAlertService` | `resolveDeliveries: () => listAdminTargets()`（active admin 绑定，**无视 digest_enabled**——告警非订阅内容）；无 → PushPlus 兜底（现有） | 现有键 + `:{owner}` 后缀 |

- 每 owner 数据范围：`buildDailyDigest({owner})`/`buildFridayCloseout({owner})` 已参数化（实读确认，内部经 `resolveBusinessOwner` 闭合），复用 v0.9.2 隔离即得各自内容，**零改动**；`digestContent` 的行动三分支收敛由 v0.9.2 §3-5 完成。
- 免打扰：见 §0 裁定 3——招标 9–20 全局窗口、晨报/周五时刻全局，每绑定独立时间窗不做；`digest_enabled=0` 即该绑定对四类主动推送整体免打扰（告警除外）。
- 调度器 `deliveryReady` 参数：统一注入 `weixinDeliveryEnabled`（§3.3），worker 掉线时照旧 outbox 囤积顺延补发。

## 6. 测试清单（预估新增/改造断言 ≥90，含 §4.4 矩阵；门禁下限 70）

| 文件 | 要点 | 估算 |
|---|---|---|
| `migrations.test.js` | 基线 31 + 0032 用例（种子/无 env/CHECK 矩阵/one-active 索引/幂等） | ~14 |
| `weixin-bindings-store.test.js`（新） | repository CRUD/乐观锁/one-active 冲突/换绑 upsert；codes 生成-过期-一次性-撞库重试-同账号旧码作废 | ~18 |
| `weixin-binding-flow.test.js`（新，events harness） | 未绑定拒答固定文案（文本/媒体/确认码全拒）；绑定成功欢迎卡+审计+audit 无明文；错码/过期/已用/限流四拒；已绑定发绑定码不消耗；解绑两段+解绑后静默+再绑定；重放消息幂等 | ~22 |
| `weixin-outbox-scope-matrix.test.js`（新） | §4.4 全矩阵 | ~23 |
| 既有 `weixin-agent`/`shortcut-weixin-confirmation` 系列（改） | conversationScope/financialScope 改源（financial=0 绑定发记账 → 拒闸；=1 正常；senderId↔account 错配 403）；`settleFromWeb` 无绑定跳回执；`businessOwnerResolver` 闭合矩阵改桩 | ~14 |
| 调度器三件+ops（改/增） | 双绑定各收各的（内容含各自 owner 数据）；digest_enabled=0 跳过；幂等键含 owner；升级日旧键过渡不双发；招标 owner 分组/admin 兜底/unrouted 审计；提醒补绑定后补发 | ~18 |
| `admin-weixin-bindings-http.test.js`（新） | member 403/机器 403；码只出现一次响应；PATCH 开关+版本冲突；已绑定账号再发码 409 | ~12 |
| config/bootstrap（改） | 三条硬校验删除后生产 config 通过；`ensureBootstrapBinding` 只插不改/无 env no-op；bindings=0 告警字段 | ~6 |

## 7. 部署、env 过渡、验收与回滚

**部署序**：确认生产 schema_migrations 含 0030/0031 → 打包 → /dev/shm 彩排两遍（env-less 全链核对 31 项账本；带 env 新副本核对种子行 `jiangjz|senderId|1|1|active`）→ `VACUUM INTO` 手动备份 → 标准四关（cutover 同窗重启 backend+worker，就绪协议 v2 对齐；**窗口避开 09:00±30min**，见 §5 幂等键换代）→ 验收。env 键**零变更**（三枚绑定键保留一版仅供 bootstrap）。

**生产验收脚本**：① jiangjz 真机微信问"客户列表" → 回卡片照旧（**绑定不中断**）；查库 bindings=1 行 active/financial=1/digest=1；② 记一笔支出 → 确认卡照常到达（financialScope 保持）；③ 次晨晨报照常（或当日 `POST /api/digest/run` 验证 already_sent 幂等）；④ **第二账号演示**：admin 生成绑定码（页面一次性展示）→ 第二真机发「绑定 XXXXXX」→ 欢迎卡 → 问"今天待办"（只见自己的空数据）→ 建一条 5 分钟后提醒的待办 → 到点仅第二真机收到、jiangjz 不收 → `digest/run?dryRun=1` 两账号各自登录 Web 内容互异 → 演示完第二真机「解绑」「确认解绑」→ 再发消息得未绑定提示（**用完解绑**）；⑤ 只读查库：audit `weixin.binding.code_issued/bound/unbound` 各≥1、无 senderId/码明文；outbox 无 owner↔conversation 错配行；journal 无意外 scope mismatch；⑥ admin 页绑定列表状态与真机一致。

**回滚论证（回代码不回数据）**：旧代码（v0.9.2）不读 bindings 两表，留存无害；backend.env 三枚绑定键原封在位 → 旧 env 语义完整恢复（jiangjz 单绑定即刻工作）；窗口内新建的第二绑定行随回滚自然失效（旧代码闭包只认 env sender）；其在途 outbox 行被旧代码 lease 闸 `isReadyFor(owner)` 判废（owner≠jiangjz → discardLeased），静默无泄露；0032 已入账本，前滚免重跑。唯一 runbook 注意：回滚后 admin 生成的未用绑定码全部失效（表仍在但无人读），再前滚需重新生成。

## 8. v0.9.3 门禁清单

1. **测试先写**：scope 矩阵与绑定流两文件先于实施提交并红，实施后全绿；新增断言 ≥70（§6 估 ~127）。
2. 迁移账本：migrations 基线=31 全绿；双彩排证据归档（env-less + 带 env 种子）。
3. **契约红线自查**：绑定码明文只出现在 issue 响应（不入库/审计/日志，`project-secret-scan` findings=[]）；未绑定 sender 能力面={绑定意图}（矩阵测试固化）；outbox 协议 additive（`targetSenderId` 新增，旧字段与 ack 协议零 diff）；机器路由白名单与令牌零 diff（#18）；`conversation_id ≡ deliveryScope` 不变式测试固化。
4. rg 自查：`weixinBookkeepingOwner|weixinBookkeepingSenderId` 运行时读取仅剩迁移 0032 与 `ensureBootstrapBinding` 两处；`shortcutBookkeepingAssistantRuntime.owner`（属性访问）全仓归零。
5. 后端全量（≥ v0.9.2 基线）+ 前端 `qa:local` + `npm run qa:full` 全绿；四关部署全绿；§7 验收脚本 ①–⑥ 全过，证据回填 release 文档（含幂等键换代说明与回滚绑定码注意）。

## 9. 战役一收官检查表（v0.9.0–v0.9.3 四版合并 · 双账号真机验收卡要点）

- [ ] **Web 面（v0.9.1+v0.9.2）**：两真实账号各自登录，顶栏各显其名；业务八域互探全 404、各见各的；admin 仅多用户管理不见他人业务数据；各自改密生效。
- [ ] **微信面（v0.9.3）**：两账号各自绑定；各收各的晨报（内容仅含本人数据）、待办提醒、招标推送（按客户 owner 分发）；A 的记账确认卡永不出现在 B 的会话（scope 矩阵生产抽测）；解绑后静默、重绑恢复。
- [ ] **财务口**：仅 jiangjz 绑定 financial_enabled=1；第二账号发记账文本被拒闸（除非 admin 显式开通）。
- [ ] **告警面（v0.9.0）**：拔线演练一次 OnFailure→小小告警送达 admin 绑定；巡检 timer 对 bindings=0/outbox 积压可告警。
- [ ] **数据面（v0.9.0+v0.9.2）**：owner 分布对账单全为账号 id；四文件 `rg "owner IS NULL"` 归零；audit actor 词表规范（账号 id | weixin-agent | system:*）。
- [ ] **退役登记（交 v1.0.0-rc）**：三枚 WEIXIN 绑定 env 键退役；登录 env 回退轨移除评估结论（v0.9.1 §3.3 路径）；digest 幂等旧键过渡逻辑移除（v0.10.0）。
- [ ] 四版 release 文档证据齐全；审计 C 矩阵相关行复测 ✅；战役验收卡由用户在两台真机上逐项签核。
