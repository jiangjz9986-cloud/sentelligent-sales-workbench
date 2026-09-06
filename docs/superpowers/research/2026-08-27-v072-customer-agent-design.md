# v0.7.2 小小·客户画像 agent 实施设计（调研定稿）

> 产出：2026-08-27 深夜 · 只读调研，未改代码。实施对应总蓝图 D 阶段。
> 实施前提：v0.7.1 已冻结上线（本设计引用的行号以当时代码为准，实施时如有漂移以语义定位）。

# v0.7.2「小小·客户画像 agent」实施设计

> 调研范围：`repos/sentelligent-sales-workbench/.worktrees/integrate-v0626-candidate`，全部结论来自源码，文中行号均以当前工作树为准。

---

## 零、现状链路结论（实施前必读）

### 0.1 消息入口 → 意图路由 → 回复的完整链路

1. **入口**：微信 worker（`backend/src/weixin/worker.js:94-107`）通过 vendored SDK 收消息，`remoteAgent.js:237-245` POST 到 `POST /api/integrations/weixin-agent/events`（`server.js:3278-3388`）。该路由做：机器 token 鉴权（`auth/machineAuthorization.js:99-123`）→ 事件校验（`assistant/weixinEvent.js:124-178`，含 `quotedMessageId/quotedText/confirmationCode` 字段）→ 发送者白名单（`weixinEvent.js:99-115`）→ 构造 `context{owner,channel:"weixin",conversation,event,requestId}` 与 `serverData{auditMetadata{senderHash,chatType,financialScope},media,quote}` → 调 `assistantOrchestrator.handle`。
2. **编排器**（`assistant/orchestrator.js:312-706`）：事件幂等（`eventRepository.receive/claim`，重放直接返回历史响应）→ **先调 `pendingActionHandler`（= 记账运行时 `handlePending`）**→ 六位码/取消/重发确认码的"scoped command"处理（L435-522）→ 否则 `router.route()` 出 plan → 风险评估：`isRisky`（R2/R3 或 requiresConfirmation，L164-166）且未确认 → **自动创建 pending action + 六位码 + 10 分钟 TTL**（L568-601），回复 `safePendingResponse`（L277-287）→ 非风险 plan 直接执行 `toolHandlers[tool.name]`（含 toolRun 幂等，L616-661）。
3. **意图注册与分发**：工具在 `assistant/agentRegistry.js:35-66`（`TOOL_DEFINITIONS`）注册，agent 在 L11-29；策略在 `assistant/policy.js:6-33`（未注册工具一律 denied）；路由在 `assistant/router.js`：斜杠命令与中文别名 `explicitPlan`（L104-157）、自然语言 `naturalPlan`（L159-287，按序正则匹配，末尾有"拜访"兜底 L278-285）。manifest 在 `assistant/agentManifest.js:173-202`（customer），`validateAgentManifest`（L508-528）会**拒绝未注册工具**。参数合同 `assistant/contracts.js`：**参数键禁止 `owner/actor/path/sql` 等**（L5-10、L44-51），字符串值禁止路径样式。
4. **回复**：编排器返回 `{status, body}`，events 路由把 `runtimeBody.text → toolResult.text → runtimeBody.message` 映射为**顶层 `text`**（`server.js:3369-3386`），SDK 只发送顶层 `response.text`（`vendor/weixin-agent-sdk/dist/index.mjs:2315-2323`）。即：**同步回复即可送达用户，无需 outbox**。

### 0.2 customerAssistantAdapter 现状（`assistant/customerAssistantAdapter.js`）

- taskTypes：`search/detail/summarize/change_preview`（L6）；**只读**，`writebackAllowed: false`，note 明示"客户写入工具尚未开放"（L164-171）。
- `change_preview`（L114-144）：`CHANGEABLE_FIELDS = {name,region,type,level}`（L9），输出 `{entity,customerId,expectedVersion:null,before,after,changedFields,rejectedFields,requiresHumanConfirmation:true}`。**expectedVersion 目前恒为 null**——因为快照投影不含 version。
- 解析策略（L231-249）：先按 `customerId` 精确查，查不到用 `query` 走 `customerSearch`；**唯一匹配自动采用，多匹配 status="clarify"**，零匹配 "not_found"。有 `agentRunRepository` 幂等重放（L215-229）。
- 快照层 `assistant/businessSnapshotAdapter.js`：`customerSearch`（L236-252）= owner 限定 + `name/region/type LIKE %kw%`（转义过），上限 100；`customerDetail`（L210-228）投影**仅 id/name/region/type/level/updated_at**（L152-162）。

### 0.3 客户实体 CRUD（服务端）

- 表结构 `backend/src/schema.sql:1-22` + 迁移补 `version/deleted_at/deleted_by`。字段：`name,region,type,level,owner,contact,relation` + JSON 数组 `stakeholders/decision_chain/history_projects/infrastructure/sync_preview/needs/risks/opportunities` + `budget,summary`。**没有别名/标签列**。
- 路由 `server.js:5900-5985`：POST 用 `requestSchemas.customerCreate`（`validation/requests.js:188-195`，name 必填 200，region 100，level 50，contact 500，summary 5000）；PATCH 用 `partialSchema` + `If-Match: "N"` 乐观锁（`parseExpectedVersion` L1120-1133，缺头 428，版本不符 409 `VERSION_CONFLICT` L1163-1173）；DELETE 走通用 `softDeleteRecord`（L1209-1269，`deleted_at/deleted_by/version+1`）。
- 写函数：`createCustomer` L1375-1410、`updateCustomer` L1455-1502（`runVersionedUpdate` L1175-1203）、`customerFromRow` L612-637 —— **均为 server.js 私有函数**。
- 审计：`customer.create/update/delete`（L5916-5926、5952-5962、5972-5982），actor=登录账号，`insertAudit`（`audit/auditRepository.js:51+`）自动脱敏——**键名含 `contact/phone/email` 的字段会被从 before/after 快照剔除**（L3、L35）。
- 可见性：小小侧查询 owner 限定（`businessOwnerResolver.js:20-27`：机器账号必须等于 `config.weixinAgentOwner` 才映射，否则 null → 查不到）。**owner 为 NULL 的客户对小小不可见**。

### 0.4 快捷记账确认链路（参照）与本设计的两处关键冲突

- 记账不用六位码：`bookkeeping.confirm` policy 为 `explicit_language`（`policy.js:19`）；pending action 的 `confirmationCode` 是内部派生凭据（`shortcutBookkeepingRuntime.js:1158-1170`），确认靠**引用草稿 + 自然语言**（意图解析 `integrations/shortcutBookkeepingIntent.js:6-8`：确认/取消/修改… 正则）。
- `handlePending`（`shortcutBookkeepingRuntime.js:2243-2397`）挂在编排器最前面。**冲突 1**：存在"已送达、未确认"的记账草稿时，`implicitCurrentAction`（L940-967，单一候选无时间窗限制、TTL 30 天）会把**任意普通文本**选为隐式目标，最终落到 L2396 的 clarify（"请回复确认入账/修改/取消"）——普通客户查询会被劫持。**冲突 2**：同场景下用户回复六位码会命中 L2372-2376（"小小记账不使用六位确认码"）——**客户写操作的六位码会被吞掉**。两处必须修（见 3.6）。
- 六位码机制（通用路径，`assistant/pendingActionRepository.js`）：HMAC-SHA256(secret, code) 存 `confirmation_code_hash`（L28-32）；`confirm` 校验 timingSafeEqual + 过期置 expired/410（L363-424）；错码计数 5 次锁定 `ASSISTANT_CONFIRMATION_LOCKED`（L253-310）；`renewConfirmation` 换码（L426-481）；状态机 `pending→confirmed→processing(租约)→executed`，另有 `cancelled/expired/failed`；每会话最多 1 个活跃 action（L193-199）；审计 `assistant.action.create/confirm/renew/cancel/execute`。**明文码只出现在同步 live 响应文本里**，事件存档用 `STORED_CONFIRMATION_TEXT` 洗掉（`orchestrator.js:493-495、598-600`）。

### 0.5 outbox 推送（`weixin/outboxRepository.js` + `outboxWorker.js`）

仅用于**主动推送**（记账草稿、招标通知），`enqueue(owner, conversationId, idempotencyKey, payload≤20KB)`；**payload 键禁止 `confirmation/code/token/owner/account/source` 等**（L7、L52-56）；worker 轮询 `leaseNext(renderMessage=runtime.renderOutboxMessage)` 渲染后经 `bot.sendMessageTo` 发送，且投递范围锁定在记账绑定私聊（`worker.js:140-163`）。**本设计的确认/回执全部走同步响应，不新增 outbox 消息类型**（v0.7.6 晨报再复用）。

---

## 一、意图设计

四个意图归属现有 `customer` agent（`agentRegistry.js:15`），全部**确定性正则解析，不经模型**。owner 由服务端上下文注入，模型/用户永远不能指定 owner（contracts 层已禁止）。

### 1.1 工具与确认边界

| 工具 | 风险/确认（policy.js 新增） | 触发语式 | 说明 |
|---|---|---|---|
| `customer.search`（已有） | R0 / none，免确认 | `/客户 kw`、`客户 kw`、`查询客户 kw`、**新增 `查询 kw`** | 列表，最多 5 条展示 |
| `customer.detail`（已有） | R0 / none，免确认 | `/客户详情 X`、`客户详情 X`、**新增画像句式**：`X什么情况` `X的情况` `X近况` `X画像` `X的资料` `X档案`（允许结尾问号） | X 可为名称/别名/ID；命中唯一即出画像卡 |
| `customer.create`（新增） | **R2 / explicit_code** | `新建客户 …`、`新增客户 …`、`建档：…`、`/customer.create …` | 字段键值式解析 |
| `customer.update`(新增) | **R2 / explicit_code** | `修改客户 X 级别为A`、`把X的区域改成日照`、`给X加别名Y`、`X的联系人改成张三`、`改档：X，级别A` | 支持上下文代词（见下） |
| `customer.delete`（新增） | **R3 / explicit_code** | `删除客户 X`、`删档 X` | 软删除 |

- **查询免确认**：R0 → `evaluatePolicy` requiresConfirmation=false → 编排器直接执行。
- **写操作确认**：R2/R3 + `explicit_code` → `isRisky` 为真 → 编排器自动建 pending action + 六位码 + 10 分钟 TTL。与蓝图"查免确认/增改删六位码"完全对应，且**零新增确认机制**。

### 1.2 字段模型（写操作可改集合）

微信端可写字段（标量 + 两个新字符串数组）：`name`（建档必填/改档可改）、`region`、`type`、`level`、`contact`、`budget`、`summary`、**`aliases`（新增列）**、**`tags`（新增列）**。
结构化数组（`stakeholders/decisionChain/...`）微信端**拒绝**，`rejectedFields` 提示"请在系统网页中修改"。

**别名/标签需要迁移 0027**（现表无此列，见 3.1）。别名同时进入检索：`customerSearch` 的 LIKE 条件加 `aliases`，让"人民医院"这类俗称可查（对 JSON 文本做 LIKE 子串即可）。

### 1.3 解析策略（router.js `naturalPlan` 内新增，全部确定性）

**插入位置与优先级**（关键，避免误吞）：写意图与画像句式插在 `录入` 块之后、`^(?:客户|查询客户)\s` 之前（即 `router.js:272 与 273 之间`）；画像兜底句式放在**知识检索之后、"拜访"兜底（L278）之前**。这样既不会截胡记账/周报/请款等既有意图（它们在更前面），又能先于 visit-capture 兜底命中。

```text
建档：^(?:新建客户|新增客户|建档|客户建档)\s*[:：]?\s*(.+)$
改档A：^(?:修改客户|更新客户|改档|客户改档)\s*[:：]?\s*(.+)$
改档B：^(?:把|将)?(.{2,60}?)的?(名称|区域|类型|级别|联系人|预算|摘要|备注|别名|标签)
        (?:改成|改为|设为|设置为|更新为|换成)(.+)$
改档C（数组增删）：^(?:给|为)?(.{2,60}?)(?:加|添加|新增|移除|去掉|删除)(别名|标签)(.+)$
删档：^(?:删除客户|删档|客户删档)\s*[:：]?\s*(.+)$
画像：^(.{2,60}?)(?:的)?(?:什么情况|情况怎么样|情况如何|近况|画像|资料|档案)\s*[?？]?$
查询：^查询\s*(.+)$   → customer.search（补齐 agentBridge 时代的旧话术）
```

- **键值段解析**（建档/改档A共用一个 `parseCustomerProfileArgs`）：按 `，,、；;` 分段；每段匹配 `(名称|区域|类型|级别|联系人|预算|摘要|备注|别名|标签)\s*[:：为是]?\s*(.+)`；建档时第一个无键段视为 `name`；`别名/标签` 值再按 `、/` 拆成数组。解析出未知键 → `clarify("暂不支持修改 X，可改：区域/类型/级别/联系人/预算/摘要/别名/标签")`。
- **上下文代词**：改档B/C 中目标名可为 `它|这个客户|该客户`，此时取 `context.customerId`（编排器已把会话业务上下文注入 `input.context`，router L19-28、orchestrator L369-373；`customer.detail` 成功后会写入 businessContext，`orchestrator.js:206-208`）。无上下文 → `clarify("请说明客户名称")`。
- **目标客户消歧**：plan 只带 `{query 或 customerId, changes}`。真正解析发生在**确认前的 change_preview 阶段**（见 3.4）：唯一命中→出预览卡；多命中→clarify 列候选（含 ID，用户可用 ID 重发指令）；零命中→not_found。**与 adapter 现有语义一致（manifest 系统提示"匹配不唯一必须澄清，不得按相似度擅自选择"，`agentManifest.js:197`）。**
- **写操作范围门**：写意图要求 `serverData.auditMetadata.chatType === "direct"`（群聊拒绝，文案"客户档案修改仅支持与小小的私聊"），并要求 `resolveBusinessOwner(owner)` 非空。查询维持现状（白名单内即可）。

---

## 二、对话流（消息往返示例）

以下"小小"回复全部是 events 端点的**同步响应文本**（顶层 `text`）。

### 2.1 画像查询（免确认）

```
用户：日照中医医院什么情况
小小：客户画像：日照中医医院 [c-1f3a…]
      区域：日照 ｜ 类型：医院 ｜ 级别：A
      联系人：张主任 137…（未填则"待补充"）
      预算：约300万（未填则"待补充"）
      别名：日照中医院 ｜ 标签：十五五、信创
      摘要：正推进十五五信息化规划…
      在办商机 2 个；更新时间：2026-08-20
      （联系人、决策链未录入的字段不会猜测，可发送"修改客户 …"补充。）
```

多匹配：`找到 3 个客户，请确认：\n- 日照中医医院 [c-1f3a…] / 日照\n- 日照市中医院 [c-9d2c…] / 日照\n…\n请用"客户详情 <ID>"或更完整名称重试。`
零匹配：`未找到客户：XX。可发送"新建客户 XX，区域…，类型…"建档。`

### 2.2 建档（增，六位码确认）

```
用户：新建客户 莒县人民医院，区域日照，类型医院，级别B，联系人王科长，标签 信创
小小：【客户建档待确认】
      名称：莒县人民医院
      区域：日照 ｜ 类型：医院 ｜ 级别：B
      联系人：王科长 ｜ 标签：信创
      其余字段（预算/摘要/别名）暂空，确认后可再修改。

      待确认操作：新增客户档案
      确认码：4 8 2 9 1 3 → 实际为六位数字（示例 482913）
      有效期：10 分钟
      请在同一微信会话中直接回复这六位数字；不要转发给其他会话。
      回复"取消"可放弃本次操作，回复"重发确认码"可轮换确认码。
用户：482913
小小：已建档：莒县人民医院（ID：c-7be2…，v1）。
      发送"客户详情 c-7be2…"可查看；后续可"修改客户 …"补充画像。
```

*重名保护*：预览阶段若同 owner 下已存在同名活跃客户 → 不建 pending，直接 `clarify("已存在同名客户 [ID]，如确需新建请在名称中加区分（如院区），或直接修改现有档案")`。

### 2.3 改档（六位码确认，展示 change_preview）

```
用户：把莒县人民医院的级别改成A，再加个别名 莒县医院
小小：【客户改档待确认】莒县人民医院 [c-7be2…]（当前 v2）
      级别：B → A
      别名：（空） → 莒县医院
      不支持的字段：无

      待确认操作：修改客户档案
      确认码：931D 六位数字（示例 574201）
      有效期：10 分钟；回复"取消"放弃，回复"重发确认码"换码。
用户：574201
小小：已更新：莒县人民医院（v3）。级别 B→A；别名 +莒县医院。
```

异常分支：
- **错码**：`确认信息无效或已过期，请重新发起操作。`（409，复用现有 `SAFE_CONFIRMATION_FAILURE`；连错 5 次锁定，需重新发起）
- **超时（>10min）**：同上文案（410），pending 置 expired。
- **取消**：`已取消当前操作。`（audit `assistant.action.cancel`）
- **重发确认码**：重发预览摘要 + 新码（旧码即刻失效，`renewConfirmation`）。
- **执行时版本冲突**（网页并发改过）：`客户资料刚在其他端被修改，本次未写入。请重新发送修改指令查看最新资料。`
- **无字段变化**（before==after）：预览阶段直接回 `内容与现有档案一致，无需修改。` 不建 pending。

### 2.4 删档（六位码 + 强提示）

```
用户：删除客户 测试医院
小小：【客户删档待确认】测试医院 [c-33aa…]（当前 v5）
      区域：- ｜ 类型：医院 ｜ 级别：C
      关联商机 2 个将随档案一起隐藏（软删除，可由管理员恢复）。
      请确认这不是误操作。

      待确认操作：删除客户档案（软删除）
      确认码：（六位数字）
      有效期：10 分钟；回复"取消"放弃。
用户：308846
小小：已删除（归档）：测试医院。原关联商机已隐藏；如需恢复请联系管理员。
```

### 2.5 与记账草稿并存（修复后的行为）

- 有未确认记账草稿时发"日照中医医院什么情况" → 正常返回画像（不再被劫持）。
- 客户改档等待六位码时，**引用记账草稿回复"确认"** → 仍确认该笔记账（quote 优先，互不干扰）。
- 客户改档等待六位码时**未引用**直接回复"取消" → 取消的是客户改档（通用 pending 优先）；记账草稿仍需引用后操作。
- 同会话已有待确认客户操作又发起新写操作 → `当前会话已有待确认操作，请先确认或取消。`（现有 409 行为，orchestrator L584-588）。

---

## 三、技术方案（文件清单与改动要点）

### 3.1 `backend/src/db/migrations/0027_customer_profile_aliases.mjs`（新增）

```js
export function apply(db) {
  db.exec(`
    ALTER TABLE customers ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE customers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
  `);
}
```
同步改 `backend/src/schema.sql:1-22`（customers 表加两列，供新库基线）。跑法沿用现有 migrations 机制（0001-0026 同目录惯例）。

### 3.2 共享客户写库模块 `backend/src/customers/customerStore.js`(新增，~180 行）

**目的：微信写路径与 Web HTTP 写路径共用一份 SQL，杜绝双实现漂移。**
- 从 `server.js` **迁出**（非复制）：`customerFromRow`（L612-637，+aliases/tags 解析）、`createCustomer`（L1375-1410，+aliases/tags 列）、`updateCustomer`（L1455-1502，+aliases/tags patch）、内部 `runVersionedUpdate`/`throwVersionFailure` 的客户特化或参数化引用。
- 新增导出：`softDeleteCustomer(db,{id,expectedVersion,deletedBy,requestId,metadata})`（等价 `softDeleteRecord` 的 customers 特化，L1209-1269 语义不变：404/409 HttpError、`deleted_at/deleted_by/version+1`、audit 由调用方或本函数完成——**保持与现有 DELETE 路由相同的审计快照结构 `softDeleteAuditSnapshot`**）、`countActiveOpportunities(db, customerId)`（`SELECT COUNT(*) FROM opportunities WHERE customer_id=? AND deleted_at IS NULL`，删档预览用）、`findActiveCustomerByExactName(db,{owner,name})`（建档重名检查）。
- `server.js` 改为 import 该模块（删除本地同名函数；`/api/customers` 四个路由行为不变，PATCH/DELETE 校验与审计代码原样保留在路由内）。

### 3.3 注册与策略（4 个小改动）

| 文件 | 改动 |
|---|---|
| `backend/src/assistant/agentRegistry.js`（L35-66） | `TOOL_DEFINITIONS` 增 3 条：`customer.create`（args: `name` required + `region/type/level/contact/budget/summary` string + `aliases/tags`）、`customer.update`（`customerId`?、`query`?、`changes` required object）、`customer.delete`（`customerId`?、`query`?）。 |
| `backend/src/assistant/policy.js`（L6-33） | 增：`["customer.create",{risk:"R2",confirmation:"explicit_code",reason:"profile_write"}]`、`customer.update` 同上、`["customer.delete",{risk:"R3",confirmation:"explicit_code",reason:"destructive_write"}]`。 |
| `backend/src/assistant/agentManifest.js`（L173-202） | customer manifest：`tools` 增 3 个（validateAgentManifest 要求先注册）；`taskTypes` 增 `create_preview`、`delete_preview`；inputSchema.properties 增 `changes/expectedVersion` 说明；systemPrompt 增"写操作必须六位码确认，由服务端执行"。 |
| `backend/src/assistant/capabilityCatalog.js`（L76-97 附近） | 增 3 个能力条目（描述性）：`customer.create/update/delete`，confirmationLevel:"explicit"，apis 对应 `POST/PATCH/DELETE /api/customers*`。 |

### 3.4 路由与预览（核心）

**`backend/src/assistant/router.js`**
- L114-141 aliases 表增：`新建客户/建档 → customer.create`、`修改客户/改档 → customer.update`、`删除客户/删档 → customer.delete`（值函数用共享 `parseCustomerProfileArgs`）。
- `naturalPlan` 按 1.3 的插入点与正则新增分支；`查询 X → customer.search`。
- 新增模块内函数 `parseCustomerProfileArgs(text, mode)`（~60 行，纯函数便于测试）。
- 改档B/C 的上下文回退：`arguments.customerId = context.customerId`（模式同 L148 的 customer.detail 回退）。

**`backend/src/assistant/orchestrator.js`（唯一的编排器改动，约 +30 行）**
- 工厂新增可选项 `pendingPreviewProviders = {}`（`server.js` 注入，缺省不影响任何现有行为）。
- `isRisky` 块（L568 起）在 `pendingActionRepository.create` **之前**：

```js
const previewProvider = pendingPreviewProviders[tool.name];
let enriched = null;
if (typeof previewProvider === "function") {
  enriched = await previewProvider({ arguments: invocation.arguments, context, businessContext: routingContext, serverData });
  if (enriched?.block) {
    return finish(enriched.status ?? 200, { status: enriched.bodyStatus ?? "clarify", message: enriched.text }, { draftText: enriched.text });
  }
}
// payload.plan.arguments 用 enriched.arguments（已钉死 customerId/expectedVersion/规范化 changes）
// payload.preview 存 enriched.previewSummary（≤2000 字，不含码）
// publicBody 用 safePendingResponse(tool, { code, preview: enriched?.previewText })
```
- `safePendingResponse`（L277-287）加可选 `preview` 段（预览文本 + 空行置于"待确认操作"前）。
- `重发确认码` 分支（L485-495）：从 `pendingAction.payload?.preview` 取摘要一并重发。
- 安全不变量不动：live 响应含码，storedBody 仍整体替换为 `STORED_CONFIRMATION_TEXT`（预览文本也不会进事件存档；变更内容本就持久化在 `payload_json` 与审计里）。

**预览提供者实现：`backend/src/assistant/customerAssistantAdapter.js` 扩展**
- `TASK_TYPES` 增 `create_preview/delete_preview`（L6）；`CHANGEABLE_FIELDS` 扩为 `{name,region,type,level,contact,budget,summary,aliases,tags}`（L9），数组字段走新 `boundedStringArray`（每项 ≤120 字、≤20 项）。
- `normalizeCustomer`（L65-77）增 `version/contact/budget/summary/aliases/tags`。
- `changePreview`（L114-144）：`expectedVersion` 填 `customer.version`；数组字段支持 `{add:[],remove:[]}` 或整组替换，before/after 输出为逗号串。
- 新增导出 `createCustomerPendingPreviewProviders({ adapter, db, resolveBusinessOwner })` 返回 `{ "customer.create": fn, "customer.update": fn, "customer.delete": fn }`：
  - 公共门：`chatType!=="direct"` → block("客户档案修改仅支持与小小的私聊")；`resolveBusinessOwner(owner)` 为空 → block("当前账号未绑定业务负责人")。
  - create：重名检查（`findActiveCustomerByExactName`）→ block 或 `{previewText, arguments:{...规范化字段}}`。
  - update/delete：`adapter.analyze({taskType:"change_preview"|"delete_preview", customerId, query, changes})` → clarify/not_found → block；ok → `{previewText(前述卡片), previewSummary, arguments:{customerId, expectedVersion, changes: 规范化 after, intent}}`（delete 附 `countActiveOpportunities` 警示行）。

**`backend/src/server.js`**
- L2997-3006 `createAssistantOrchestrator` 注入 `pendingPreviewProviders: createCustomerPendingPreviewProviders({ adapter: assistantCustomerAdapter, db, resolveBusinessOwner: assistantBusinessOwnerResolver })`（customerAdapter 现由 runtimeHandlers 内建，需把它提为 server.js 显式构造后同时传给 `createAssistantToolHandlers({ customerAssistantAdapter })`——工厂已有该参数，L460）。
- `validation/requests.js:188-195`：`customerCreate` 增 `aliases: stringArray(20,120), tags: stringArray(20,120)`（PATCH 自动继承 partialSchema）。

### 3.5 执行处理器 `backend/src/assistant/runtimeHandlers.js`

- 导入 `customerStore`；三个新 handler（模式对齐 `visit-capture.confirm` L1082-1199 与 `invoice.ingest` 的审计写法 L1250-1277）：
  - `"customer.create"(args, context)`：**幂等**——`id = context.actionId ?? randomUUID()`，先查 `SELECT * FROM customers WHERE id=$id`，命中即返回"已建档"（重放安全）；否则 `withImmediateTransaction`：`createCustomer(db,{...args, owner: resolveBusinessOwner(context.owner)})` + `insertAudit({action:"customer.create", actor: context.owner, requestId: context.requestId, metadata:{source:"weixin-assistant", actionId: context.actionId}})`；回 `{text:"已建档：… (ID… v1)", status:"created", customer, contextUpdate:{customerId,...}}`。
  - `"customer.update"(args, context)`：取 before（不存在 → "客户不存在或已删除"）；`updateCustomer(db, args.customerId, args.changes, args.expectedVersion)`，捕获 `VERSION_CONFLICT` → 友好文案；audit `customer.update`（metadata.changedFields）；回执列出逐字段 `before→after`。**重放**：claimExecution 层已保证单次执行 + 结果重放（orchestrator L605-615），处理器内再以 `expectedVersion` 兜底（重复执行必然版本不符 → 不会二次写）。
  - `"customer.delete"(args, context)`：`softDeleteCustomer(db,{id:args.customerId, expectedVersion:args.expectedVersion, deletedBy: context.owner, requestId: context.requestId})`；audit 在 store/路由同构；回执含"软删除、可恢复"。
- `"customer.detail"`（L835-875）回复卡扩展：联系人/预算/别名/标签/摘要/在办商机数（`countActiveOpportunities`）/更新时间；保持 `contextUpdate` 逻辑。
- `"customer.search"`（L1202-1228）不变（快照层加了 aliases LIKE 自动生效）。

**`backend/src/assistant/businessSnapshotAdapter.js`**
- `customerFromRow`（L152-162）增 `version/contact/budget/summary/aliases/tags`（数组 JSON.parse 有界）。
- `customerById`（L210-214）与 `customerSearch`（L240-247）的 SELECT 列同步扩展；search 的 WHERE 增 `OR aliases LIKE $pattern ESCAPE '\'`。

### 3.6 记账运行时让路修复 `backend/src/assistant/shortcutBookkeepingRuntime.js`

`handlePending` 顶部（L2246 `intent` 解析后、L2254 shortcutSignal 前）加两道早退：

```js
// 1) 主会话存在非记账 pending action（如客户写操作）且本条消息未引用记账草稿：
//    六位码/取消/重发确认码/普通文本一律交回通用边界。
if (action && action.actionType !== SHORTCUT_BOOKKEEPING_ACTION && !shortcutQuote) return null;
// 2) 无引用、无 pendingActionId 时，非记账语言（意图未接受、非修改前缀、
//    非 code/cancel/resend、非"确认"）不做隐式草稿绑定，放行给路由器。
const bookkeepingLanguage = intent.status === "accepted" || Boolean(explicitModification(text))
  || textClassification.kind !== "ordinary" || text === "确认";
if (!quote && !pendingActionId && !bookkeepingLanguage) return null;
```

效果：客户画像问答、建/改/删档指令及其六位码在记账草稿活跃时也能正常工作；引用草稿的确认/修改/取消、借款/区域意图、隐式"确认"完全保留。**回归面**：原先被劫持的闲聊文本将改走路由器（unknown → "暂时无法识别…"），不再回"请回复确认入账…"——需在测试里固化新行为。

### 3.7 文档与版本（DoD 惯例）

`CHANGELOG.md` 条目、`docs/releases/v0.7.2.md`、`VERSION` 统一、蓝图 `docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md` D 行状态更新。

### 3.8 复用点总结

| 复用 | 位置 |
|---|---|
| change_preview 结构与消歧 | `customerAssistantAdapter.changePreview/analyze`（扩展而非重写） |
| 六位码生成/校验/换码/过期/锁定 | `orchestrator` isRisky 路径 + `pendingActionRepository`（零改动） |
| 幂等执行 | `eventRepository` toolRun + `claimExecution` 租约 + create 用 actionId 作实体 ID |
| 回复通道 | events 同步响应顶层 `text`（不动 outbox） |
| 审计 | `insertAudit` 与 Web 端同名 action |
| 上下文代词 | businessContext/conversationContext（orchestrator L203-275） |

---

## 四、审计与安全

1. **审计 action 命名**：沿用 Web 端 `customer.create / customer.update / customer.delete`（同一实体同一动词，报表/实时日志天然聚合）；来源区分靠 `metadata.source="weixin-assistant"` + `metadata.actionId` + `requestId`。确认链本身已有 `assistant.action.create/confirm/renew/cancel/execute` 五段审计（pendingActionRepository 内建），形成"谁发起→谁确认→何时执行"的完整链。注意：`contact` 字段会被审计脱敏器剔除（`auditRepository.js:3`），属预期。
2. **幂等**：入站事件按 `sourceMessageId` 哈希去重（events 路由 L3327-3329 + eventRepository.receive）；确认执行经 `claimExecution` 租约单飞 + 结果重放；`customer.create` 以 actionId 为实体主键，重试不产生重复客户；`customer.update/delete` 以 `expectedVersion` 兜底（重复执行 → VERSION_CONFLICT → 不二次写）。
3. **防误删**：删除 = 软删除（`deleted_at/deleted_by`，可恢复）+ R3 六位码 + 预览卡列出关联商机数量 + 10 分钟过期 + 错码 5 次锁定 + 单会话单 pending。六位码只在 live 响应出现，事件存档/会话草稿均以占位文本落库（现有机制）。
4. **越权面**：写操作仅 direct 私聊（auditMetadata.chatType 门）+ 发送者白名单（HTTP 边界）+ owner 由机器身份解析（`businessOwnerResolver` 精确匹配，不匹配即不可见/不可写）；工具参数合同禁止 `owner/actor` 键，用户与模型都无法指定归属；写入的 owner 一律 `resolveBusinessOwner(context.owner)`。
5. **秘密与日志**：不新增任何 outbox payload（避开其敏感键校验）；预览文本只含业务字段 before/after，不含码。

---

## 五、测试面（`backend/tests/`，node:test + assert/strict 惯例）

| 文件 | 用例要点 |
|---|---|
| `assistant-customer-adapter.test.js`（扩展） | change_preview 填 expectedVersion；新字段（contact/budget/summary/aliases/tags）before/after；数组 add/remove；结构化字段进 rejectedFields；create_preview 重名/正常；delete_preview 卡片；多匹配 clarify 不自动选 |
| `assistant-customer-write-runtime.test.js`（新） | 三个 handler：建档写库+audit 行+owner 注入；actionId 幂等重放不重复建档；update 版本冲突友好失败且不写库；软删除后列表/详情不可见、商机隐藏；aliases 命中 customerSearch |
| `assistant-router.test.js`（扩展） | 1.3 全部语式 → 正确 plan（status=confirmation_required、tool、arguments）；`查询 X`；画像句式不吞"报销什么情况"（先命中报销）与"拜访…"；上下文代词回退；未知字段 clarify |
| `assistant-policy.test.js`（扩展） | 三个新工具的 risk/confirmation/reason；未确认 requiresConfirmation=true |
| `assistant-agent-manifest.test.js`（扩展） | customer manifest tools/taskTypes 断言更新 |
| `assistant-orchestrator.test.js`（扩展） | pendingPreviewProviders：block→clarify 不建 action；enriched arguments 落入 payload.plan 并在确认后传给 handler；live 文本含预览+码、stored 文本不含码；重发确认码带回 payload.preview |
| `assistant-customer-http-integration.test.js`（新，模式抄 `assistant-http-integration.test.js` 的 `confirmationCodeFrom`） | 全链路：建档→提码→执行→审计；错码×5 锁定；取消；换码后旧码失效；时钟拨过 10min → 410；group 事件写意图被拒；记账草稿共存时码不被吞 |
| `shortcut-bookkeeping-assistant.test.js` / `shortcut-bookkeeping-safety.test.js`（扩展） | 修复回归：草稿活跃+普通客户文本 → handlePending 返回 null；草稿活跃+存在通用 pending+六位码 → null；引用草稿+"确认" 在通用 pending 存在时仍确认记账；隐式"确认"、"修改金额为…" 行为不变 |
| `weixin-agent-http-integration.test.js`（扩展） | 端到端：草稿待确认期间"XX医院什么情况"返回画像 |

门禁：后端全量 + 前端 qa:local + Chrome/WebKit 集成 + 密钥扫描 + 根 test:deploy（DoD 固定项）。

---

## 六、风险与开放问题

**风险**
1. **`handlePending` 让路修复的回归面最大**——它是所有微信能力的共享前置钩子。两条早退的条件必须精确（尤其保留 quote 优先、隐式"确认"、"修改…"前缀），依赖上表回归用例兜底。
2. **orchestrator 是全渠道共用**：`pendingPreviewProviders` 必须严格可选、provider 抛错走既有 `fail()` 安全响应，避免影响 visit-capture 等既有确认流。
3. **正则误命中**：画像句式 `X什么情况` 放在意图链末端仍可能吞掉未来意图（如 v0.7.5 商机 agent 的"XX项目什么情况"）；建议模式里显式排除以`项目/商机`结尾的主语，并在商机阶段重排优先级。
4. **server.js 函数迁出**（customerStore）是机械重构但触碰主文件；靠现有 HTTP 集成测试兜底，且与 L 阶段（pages 拆分）方向一致。
5. **审计脱敏**导致 contact 变更在审计 before/after 中不可见（键被剔除），metadata.changedFields 仍可证明改了该字段——可接受，但要在 release notes 说明。
6. **owner=NULL 的存量客户**对小小不可见/不可改（businessOwnerResolver 精确匹配）。生产库若存在此类数据，画像查询会"查不到"，需要一次数据体检（可在发布验收时用只读 SQL 确认）。

**开放问题（不阻塞实施，默认取保守方案）**
1. 改 `name` 是否允许微信端进行？默认允许（走同一确认流），但预览卡置顶显示"名称变更"；若产品层担心引用断裂可从 CHANGEABLE_FIELDS 移除，1 行改动。
2. `aliases/tags` 是否需要 Web 端同步展示/编辑？本版仅后端+微信；建议并入 J 阶段（v0.8.1 视觉统一）补 Web 表单。
3. 删档是否要求"客户下无活跃商机才可删"？本设计选择"允许删但预览强提示商机数"；若要硬闸，`customer.delete` 预览 provider 里 block 即可。
4. 确认 TTL 是否与记账（30 天）对齐？本设计沿用通用 10 分钟（`pendingTtlMs` 默认值），写操作短时效更安全；如需调长仅改 orchestrator 入参。
5. 群聊是否放开只读画像查询？当前设计只限制写操作；若群内查询涉及隐私（联系人/预算），可将 detail 卡在群聊场景降级为基础四字段版本（handler 内按 chatType 分支，~5 行）。

Now I'll put together the full design document in Chinese.