# v0.7.5 小小·商机 agent 实施设计（调研定稿）

> 产出：2026-08-28 · 只读调研，未改代码。实施对应总蓝图 G 阶段（`docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md`：小小·商机 agent：查/改阶段、金额、下一步动作；阶段升级联动销售决策 agent）。
> 前置：v0.7.2 客户画像 agent 已上线（本文引用其**已落地代码**）；v0.7.3 快速记录 agent 正在收尾——**调研时本工作树 HEAD=668aa04 且带 v0.7.3 未提交改动**（policy/router/orchestrator/runtimeHandlers/registry/manifest/catalog 已改，`quickRecords/`、`spokenDate.js`、`quickRecordPendingPreviewProviders.js` 新增；orchestrator 的 affirm_language 分支**已实测在工作树**）。v0.7.4（F 阶段）尚未实施，其设计稿 `2026-08-28-v074-todo-agent-design.md` 的工具挂载与本版无命名交集（4.2 撞车防范）。
> 行号声明：文中行号以调研时（v0.7.3 未提交态）工作树为准，v0.7.3 冻结合入与 v0.7.4 实施后 `router.js`/`policy.js`/`agentRegistry.js`/`runtimeHandlers.js`/`server.js` 必然漂移，实施时以语义定位。

---

## 零、现状调研结论（全部来自源码，实施前必读）

### 0.1 商机实体现状

**表结构**（`backend/src/schema.sql:26-45` + 迁移 0002）：`id` PK / `customer_id` **NOT NULL** FK→customers ON DELETE CASCADE / `name` NOT NULL / `customer`（冗余客户名）/ `stage` TEXT / `amount` TEXT / `owner` / `probability` INT 0-100 / `days` / `requirements`·`competitors`·`solution_direction`（JSON 数组文本）/ `source_record` / `risk` / **`next`（下一步动作字段已存在）** / `tone`；迁移 0002 已补 `version`（乐观锁）+ `deleted_at/deleted_by`（软删）。**本版零迁移**——所有需要的列都在。

**stage 无任何枚举约束**（DB 与校验层均自由文本 ≤100 字，`validation/requests.js:199`）。词表唯一权威在 Web 前端 `outputs/product-design-prototype/src/data/salesWorkbenchData.js:473-481` `kanbanStages`：**线索 → 初步沟通 → 调研机会 → 方案输出 → 方案交流 → 预算确认 → 暂停观察**（7 段）。看板页（`pages.jsx:3605-3704` KanbanPage）按此序推进/回退（`stages[currentIndex±1]` → PATCH stage），**词表外阶段动态追加列**（L3615-3617 extraStages），编辑表单的阶段/金额都是自由文本 input（L1697-1702）。注意：蓝图例句"推进到投标"的"投标"**不在已知词表**——看板会为它新增一列，不报错。

**amount 单位与格式惯例**：自由文本直存直显，seed 实证 `"3000 万"`、`"规划类"`（`seed.js:64,82`），Web 详情 `MetricInline label="金额" value={selected.amount}`（pages.jsx:2247）原样展示。**与记账域的 cents 整数体系无关**（`moneyFromCents` 是差旅报销专用），不做任何数字解析/换算——改金额 = 字符串替换。

**CRUD/审计**（`server.js`）：`GET /api/opportunities`（L5957，join customers 过滤双方 deleted_at）、`POST`（L5971：`opportunityCreate` schema → `requireActiveCustomer` → `createOpportunity` L1384 → 审计 **`opportunity.create`**）、`GET :id`（L5993）、`PATCH :id`（L6000：If-Match `parseExpectedVersion` → `opportunityPatchSchema`=partialSchema(opportunityCreate)（L1042）→ `updateOpportunity` L1427 **runVersionedUpdate 全字段 patchValue 模式** → 审计 **`opportunity.update`**，metadata `{changedFields, stage, probability}`）、`DELETE :id`（L6030：`softDeleteRecord` 通用软删 → 审计 **`opportunity.delete`**，metadata `{name, customerId, stage}`）。**写函数仍在 server.js 内未抽 store**（客户已抽 `customers/customerStore.js`，v0.7.2）。

**owner 双口径（设计要点）**：Web 写路径 `activeOpportunityEntityRow(db,id,owner)`（L1296-1311）传 owner 时要求 `opportunities.owner=$owner AND customers.owner=$owner`（双与）且 Web 路由实际**不传 owner**（不过滤）；小小快照 `opportunityById`/`opportunitySearch`（`businessSnapshotAdapter.js:235-242,275-293`）用 `opportunity.owner=$owner OR (opportunity.owner IS NULL AND customer.owner=$owner)`（或）。本版微信写路径以**快照或口径复核可见性**、store 层不加 owner 列条件（与 Web 行为一致，靠 handler 复核），见 4.5-风险5。

**既有商机写入方（并存不冲突）**：Web 确认页深写回 `syncOpportunityFromQuickRecord`（server.js:1836-1864）——targetVersions.opportunity 钉版，只 append requirements/solutionDirection、覆盖 sourceRecord、`COALESCE` 补 risk/next，**不碰 stage/amount**；本版微信写与它同走 version 乐观锁，天然互斥。

**关联**：action_items/risk_items/quick_records/solution_drafts 均有 `opportunity_id` FK（SET NULL）；客户删档时商机经 join 过滤隐藏（v0.7.2 删档预览卡已提示商机数，`countActiveOpportunities`）。

**Web 商机页交互**：列表（搜索商机/客户/阶段/负责人）→ 详情（金额/赢率/负责人/阶段 metrics + 需求/竞对/方案方向/来源记录 + 修改/删除按钮）→ 编辑表单；看板页独立提供 stage 流转按钮。**Web 端本版零改动**。

### 0.2 销售决策 agent（sales_decision_analysis）现状

**两条独立链路**：

1. **Web API**：`POST /api/ai/sales-decisions`（server.js:6549-6596）→ `buildSalesDecisionContext`（L2384：customerId/opportunityId/quickRecordId 三选一起底，拼 actions/risks/knowledge）→ `analyzeSalesDecision` → `salesDecisionRepository.create` 落 **`sales_decision_analyses` 表**（迁移 0006：analysis_type 枚举 opportunity_diagnosis/customer_analysis/meeting_preparation/next_step_decision）→ 审计 **`sales_decision_analysis.create`**。
2. **小小侧**：工具 `sales-decision.preview`（policy R1/none，registry L62）→ handler（runtimeHandlers.js:1147-1191）→ `salesLoopPreviewService.previewSalesDecision`（`salesLoopPreview.js:430-461`）：`buildSnapshot`（服务端拼 owner-scoped 商机+客户+快速记录 ≤100 条+行动风险+知识，**sourceRefs 全部服务端重建、不信任调用方**）→ `salesDecisionAssistantAdapter.analyze`（模型调用+agent run 持久化到 `assistant_agent_runs`，**不落 sales_decision_analyses、无审计 action**）→ `salesDecisionPreviewText` 渲染（L350-373：判断 code+置信度 / 阶段 current+recommended+**gatePassed** / 评分 / 结论 / 合规 / 待确认 / 下一步）。触发方式：router 别名"项目分析"（L394 explicit、L482 naturalPlan，无参用 `context.opportunityId`）；handler 内置商机消歧（opportunitySearch 多命中 → `ambiguousEntityResult`）。

**模型行为**（`ai/agents/salesDecisionAgent.js`）：`analyzeSalesDecision`（L605-638）**永不 throw**——`aiAnalysisMode!=="model"` → 确定性 mock；模型失败 → `mock_model_fallback`；`stage.current` 强制取确定性推导（中文阶段文本→canonical 枚举映射 L131-142：决策|承诺→decision_commitment、商务|报价|采购→commercial_progress、方案|验证|测试|评审→solution_validation、深度|调研→deep_discovery、线索→lead、默认 initial_discovery——"调研机会"→deep_discovery、"方案输出"→solution_validation 均可正确映射）。**超时 = max(config.modelTimeoutMs, 120_000) 恒 ≥120s**（L10,19-25，config 默认 30s 被下限顶掉）——阶段联动同步调用必须在外层用 race 预算包裹（见 2.2）。

**联动挂点结论**：`previewSalesDecision({owner, opportunityId, analysisType, eventId})` 是唯一正确挂点——服务端证据拼装、owner 校验、run 持久化、fail-safe 全部现成；`assistant_agent_runs` 的 `UNIQUE(owner,channel,request_hash)` + event 唯一索引（迁移 0022:44-48）提供重复保护。

### 0.3 小小侧现有商机能力

- **适配器已存在**：`opportunityAssistantAdapter.js`（opportunity-v1）：taskTypes `search/detail/stage_review/change_preview`；`CHANGEABLE_FIELDS` 仅 name/risk/next（L9）；`protectedFields:["customerId","stage","amount","probability","version"]`、`changePreview.expectedVersion:null`（L174-179——**投影没有 version，钉版是本版必修**）；`writebackAllowed:false`，note 明示"商机写入工具尚未开放"（L230-236）；`validateRelationship` 强制商机→客户可见性校验（L263-279）；`stageReview` 只陈述现状并 `requiresSalesDecisionAgent:true`（L184-193）。
- **快照层**：`opportunityFromRow`（businessSnapshotAdapter.js:184-204）投影 **无 version**（对比 customerFromRow 有——v0.7.2 为钉版加的）；`opportunitySearch`（L275-293）`LIKE 商机名 OR 客户名`——**"客户名→商机列表"的两级消歧被一次搜索天然覆盖**。
- **工具/路由**：唯一注册工具 `opportunity.detail`（R0/none）；handler（runtimeHandlers.js:1095-1145）已支持"ID 直查失败→按同字符串搜索→多命中 `ambiguousEntityResult("商机", matches)`（只列名称）"，成功后 `contextUpdate` 钉双 ID 进会话业务上下文（迁移 0023 表，customer_id+opportunity_id 两列）。router 商机句式仅两条：别名/naturalPlan"商机详情"（L393/L473）、"项目分析"（L394/L482）。**HELP 文案（router.js:8）未提商机**。战情 `dashboard.summary` 含 opportunities 计数。
- **R0 业务快照对商机的呈现**：detail 卡 5 行（商机/阶段/金额/成交概率/下一步，L1124-1130）；无列表工具（"XX有哪些商机"今天落 unknown）。
- **v0.7.3 已交付的商机消歧先例**：`quickRecordPendingPreviewProviders.js:159-178` `resolveOpportunityChange`——零命中/多命中（≤5 候选卡）/客户关系冲突三种 block，本版 provider 直接同构复用。

### 0.4 客户消歧器复用面（v0.7.2 已落地）

`createCustomerPendingPreviewProviders`（customerAssistantAdapter.js:414-560）可复用的构件：`writeGate`（direct 私聊 + `resolveBusinessOwner` 精确闭合映射，businessOwnerResolver.js:20-27）、`normalizedWriteTarget`（query/ID 归一）、`resolutionBlock`（clarify ≤5 候选行 `- 名称 [id] / 区域`、not_found 引导建档）、**version 缺失 block**（"客户资料版本无法确认"）、预览卡 `【…待确认】名称 [id]（当前 vN）` + 逐字段 before→after。两级消歧结论：

- **查/改商机**：一级搜索即够（opportunitySearch 已 join 客户名）。"日照的商机"→ LIKE 客户名命中该客户全部商机；唯一→直达，多个→候选卡（本版扩展为带 **阶段+金额+ID 尾 6 位**，比现状 `ambiguousEntityResult` 只列名称更可定位）。同客户多商机靠阶段/金额/尾码区分；同名商机跨客户靠候选行里的客户名区分。
- **建商机**：客户必须唯一命中（`customer_id` NOT NULL）——复用 `customerAdapter.analyze(taskType:"detail", query)`，clarify/not_found 均 block（v0.7.3 `resolveCustomerChange` 同款），**不做"多命中默认取第一个"**。
- **ID 尾码指代**：商机 ID 是 UUID/seed 字符串，候选卡展示尾 6 位，回指用 `findByIdSuffix`（owner 可见范围内 `LIKE '%'||suffix` 唯一命中，v0.7.3 quickRecordStore 同款含 LIKE 转义）。

### 0.5 编排器与确认机制现状（v0.7.2+v0.7.3 已在工作树）

- **affirm_language 全链已落**（orchestrator.js）：`safeAffirmPendingResponse`（L295-304，"回复"确认"写入，回复"取消"放弃；10 分钟内有效"）、`deriveAffirmCredential`（L309-314，HMAC 派生内部凭据）、裸"确认"仅在 pending 工具 policy=affirm_language 时生效（L471-484）、affirm pending 收到六位码/重发 → 引导文案不计 attempt（L499-526）、affirm 建 pending 预生成 actionId（L692-728）。**本版 R1 工具直接坐享，零编排器改动**。
- **pendingPreviewProviders 合同**（L653-696）：provider 入参 `{arguments, context, businessContext, serverData}`，返回 `{block,text,bodyStatus,status}` 或 `{arguments(重验证钉死), previewText, previewSummary}`；block 不建 action；provider 抛错走 fail 安全响应；preview 随"重发确认码"重发。注入点 server.js:2927-2941（customer+quickRecord 两组已合并展开，本版第三组续接）。
- **单 pending 约束**：同会话已有待确认操作 → 409 "当前会话已有待确认操作，请先确认或取消"（L714-718）。改阶段联动不产生第二个 pending（联动是执行后附带的只读分析）。
- **幂等三层**：pendingAction `claimExecution` 重放已存结果（L745-755）→ toolRun 以 `assistant-action:{actionId}` 摘要重放（L783-800）→ 实体层 create 以 actionId 为主键 / update·delete 以 expectedVersion 兜底（customer 先例，runtimeHandlers.js:908-1092）。
- **handlePending 让路**（shortcutBookkeepingRuntime.js:2243-2274）：guard1——非记账 pending 且未引用记账草稿 → return null（六位码/取消/"确认"/普通文本全放行）；guard2——`bookkeepingLanguage` 含 `text==="确认"`，但仅在**无非记账 pending** 时才把裸"确认"绑给记账草稿。商机语式（"推进到""商机""金额改成"）不在记账词表（`parseShortcutBookkeepingIntent` 的 CONFIRM/CANCEL/CORRECTION 均不含）→ guard2 放行；商机 pending 活跃时 guard1 先命中 → 六位码与"确认"都归通用边界。**与 v0.7.3/v0.7.4 同一合同，回归用例固化（6.2 T-BK 组）**。
- 事件链：worker（`weixin/remoteAgent.js` POST `/api/integrations/weixin-agent/events`，**fetch 无显式超时**）→ 机器鉴权+白名单+conversationScope → `orchestrator.handle` 同步响应顶层 text 即回复（回复上限 20000 字，远够）。

### 0.6 技术债定位（画像句式排除名单）

- **登记原文**：v0.7.2 设计稿风险 3（`2026-08-27-v072-customer-agent-design.md:338`）："画像句式 `X什么情况` 放在意图链末端仍可能吞掉未来意图（如 v0.7.5 商机 agent 的"XX项目什么情况"）；建议模式里显式排除以`项目/商机`结尾的主语，并在商机阶段重排优先级"；交付报告 `docs/releases/v0.7.2.md:19` 记录了排除名单的落地。
- **精确代码位置**（当前工作树）：`backend/src/assistant/router.js:611-626`——customerProfile 兜底正则 `^(.{2,60}?)(?:的)?(?:什么情况|情况怎么样|情况如何|近况|画像|资料|档案)\s*[?？]?$`（L611-613）+ 排除名单 `const excluded = /(?:项目|商机|报销|周报|记账|请款|发票|凭证|行程|差旅|风险|待办|知识)$/u.test(subject)`（L616）。
- **现状行为**：`日照医院的商机什么情况` → 主语"日照医院的商机"以"商机"结尾 → excluded → 跌出 if → 不含拜访词 → **unknown**（排除名单只做了"不误吞"，没有"接住"）。重排方案见 3.3。

---

## 一、意图与风险分级设计

### 1.1 工具清单（复用 `opportunity` agent，零新 agent）

`opportunity` agent 注册描述"查询商机阶段金额和下一步；**阶段金额及删除属于敏感变更，必须确认并校验版本**"（agentRegistry.js:16）——注册时即为本版预留。新增 6 个工具（全部确定性解析、不经模型；owner 由服务端注入，contracts.js 禁 owner/actor 键）：

| 工具 | 风险/确认 | 触发语式（示例） | 说明 |
|---|---|---|---|
| `opportunity.list` | **R0 / none** | `日照医院有哪些商机`、`日照的商机`、`商机列表` | 按客户名/关键词列 ≤8 条（阶段+金额+尾码） |
| 既有 `opportunity.detail` | R0 / none（不动 policy） | `XX医院的商机什么进展`、`商机详情 X` | 详情卡增补风险/更新时间两行 |
| `opportunity.updateStage` | **R1 / affirm_language** | `把日照的商机推进到投标`、`黄岛商机阶段改成方案输出`、`把XX的商机回退到调研机会` | 阶段变更；**前进方向确认后触发决策联动（二）** |
| `opportunity.updateNext` | **R1 / affirm_language** | `把日照商机的下一步改成 下周带售前调研`、`XX商机下一步：补齐规划材料` | 只改 next 字段 |
| `opportunity.update` | **R2 / explicit_code** | `把日照商机的金额改成 3000 万`、`把XX商机的名称改成…`、`XX商机的风险改成…` | changes 白名单：amount/name/risk |
| `opportunity.create` | **R2 / explicit_code** | `新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院，阶段 线索，金额 500 万` | 客户唯一命中必填 |
| `opportunity.delete` | **R3 / explicit_code** | `删除商机 a1b2c3`、`删掉商机 日照中医医院十五五规划` | 软删除 |

### 1.2 风险分级论证（回答蓝图问句"改阶段 R1 还是 R2？金额 R2？删除 R3？"）

- **改阶段 = R1 affirm_language**。正方：单字段、完全可逆（改回即恢复，无数据丢失）、非财务、预览卡强制回显 `当前阶段 → 目标阶段` + version 钉死；与 v0.7.4 设计中"待办完成/顺延 R1"（状态翻转可逆）同构；阶段变更是商机 agent 的**最高频动作**（看板每次推进都是一条），六位码摩擦与频率不匹配。反方（已考虑，不采纳）：客户改档是 R2，同为"改既有实体字段"存在一致性论——但客户档案改的是**身份与关系字段**（名称/联系人/级别），错误影响的是"这个客户是谁"；阶段是**流程状态字段**，错误影响的是"走到哪一步"，可逆且看板一眼可见。联动的决策分析是**只读预览**（不写任何表），不放大写风险，不构成升级为 R2 的理由。
- **改下一步动作 = R1 affirm_language**。描述性文本字段，深写回本就在 `COALESCE` 补写同字段（0.1），错误可再改零成本；与 R1 定义（错误可全量修复）完全吻合。
- **改金额 = R2 explicit_code**。金额虽是展示文本（非记账事实），但语义敏感：它进入销售决策分析输入（salesLoopPreview opportunityRow 投影含 amount）、v0.8.2 商机漏斗的统计基础、以及周报/汇报口径；错误金额误导决策的隐性成本高、且不像阶段有看板即时纠错的可见性。与 customer.update（含"预算"字段，R2 profile_write）先例对齐。name/risk 并入同工具同级：改名影响全局指代识别（搜索/消歧都靠名称），R2 合理；风险说明单独看可 R1，但为避免第四个写工具的复杂度并入（预览卡同样逐字段回显，成本仅是"改风险要输码"，频率极低）。
- **建商机 = R2 explicit_code**。新建重业务实体，与 customer.create（R2）同构；不同于 v0.7.4 建待办 R1——待办是轻实体可随手删，商机进漏斗/周报/决策分析证据链。
- **删商机 = R3 explicit_code**。destructive_write，与 customer.delete、visit-capture.void（均 R3）先例一致；软删可由管理员恢复，但微信端不可见化一整条商机及其关联引用（行动/风险/记录的挂接展示都会失联），预览卡强提示关联计数。
- **查询 = R0**。与既有 opportunity.detail/customer.search 同级；商机数据属商务信息，list/detail 均限**私聊**（provider 之外的读工具由 handler 检查 `serverData.auditMetadata.chatType`——现状 detail 未限，本版顺手对齐？**不改**：现状 detail 群聊可用已上线一个版本，收窄属行为变更，记开放问题 7.6）。

### 1.3 阶段词表（后端常量）

新模块 `backend/src/opportunities/stageVocabulary.js`（~30 行）：

```js
export const KNOWN_STAGES = Object.freeze(["线索", "初步沟通", "调研机会", "方案输出", "方案交流", "预算确认", "暂停观察"]);
export function stageIndex(stage) { /* trim 后 indexOf，未知 -1 */ }
export function stageDirection(from, to) {
  // both known: to>from → "forward"，to<from → "backward"，相等 → "same"
  // 任一未知 → "unknown"
}
```

镜像 Web `kanbanStages`（salesWorkbenchData.js:473-481）的顺序，注释互指；跨包（backend/outputs）无法共享常量，漂移风险记入 7.4（L 阶段工程健康统一）。用途：① 联动方向判定（仅 forward 触发）；② 目标阶段不在词表时预览卡提示（不阻断——Web extraStages 已兼容）；③ "推进到下一阶段"这类相对语式 → clarify 列出已知序列（本版不自动推算相对移动，克制；开放问题 7.2）。

---

## 二、阶段升级联动销售决策 agent

### 2.1 方案裁定：同步附带 + 时间预算，不做 outbox 推送、不做开关

| 维度 | 同步（handler 内 await + race 预算）✅ | 异步（outbox 新 kind 推送） |
|---|---|---|
| 投递通道 | 确认回执同一条消息，用户正在会话中等待 | 需新增 payload kind + 渲染分支 + 预渲染文本 |
| 时延 | 预算内（默认 8s）完成则一条闭环；超时止损提示 | 出箱轮询 5s + 投递，总归"第二条消息" |
| 失败面 | `analyzeSalesDecision` 永不 throw（0.2），race 外再包 try/catch | detached promise 错误处理 + 幂等键 + 陈旧消息判定，全新增面 |
| 先例 | v0.7.3 capture 预览 provider 已同步调模型（quickRecordPendingPreviewProviders.js:205-208 注释明示） | 招标通知（周期批处理场景，与"确认后即时反馈"语义不符） |

**裁定：同步**。唯一障碍是决策模型超时下限 120s（0.2）——不可改内层（Web API 共用），在 handler 外层 `Promise.race([previewSalesDecision(...), budget])` 解决；被放弃的 promise 继续在后台完成并把 run 持久化（无副作用，用户可用"项目分析"拉取到完整结果）。

### 2.2 触发条件与行为（克制的默认行为）

```
触发：opportunity.updateStage 确认执行成功（版本已提交）
  且 stageDirection(before.stage, after.stage) === "forward"
  且 after.stage !== "暂停观察"（词表尾段属挂起不属升级）
不触发（回执附一行手动提示代替）：
  backward / same（same 已被 provider 拦）/ unknown（任一阶段不在词表，方向不可判）
调用：Promise.race([
  salesLoopPreviewService.previewSalesDecision({
    owner, channel, conversationId,
    eventId: `assistant-action:${actionId}:stage-review`,   // agent runs event 唯一索引挡重（0.2）
    opportunityId, analysisType: "opportunity_diagnosis",   // gatePassed 直接回答"这次升级是否有据"
  }),
  sleep(config.opportunityStageReviewBudgetMs)              // 默认 8000，env 键 OPPORTUNITY_STAGE_REVIEW_BUDGET_MS，钳 [1000, 30000]
])
```

**推送格式**（回执卡尾部追加，非独立消息）：

```
已推进：日照中医医院十五五规划（v5）。阶段：方案输出 → 方案交流。
——阶段升级检查（销售决策 agent）——
判断：advance_with_conditions（置信度 62）
阶段门槛：未满足（缺：客户确认评估标准、关键技术角色参与）
评分：58 ｜ 下一步：请现有联系人邀请信息科负责人参加下次方案讨论
完整分析发送"项目分析 日照中医医院十五五规划"查看。
```

（渲染函数 `stageReviewSummaryText(result)`：取 decision.code+confidence、stage.gatePassed+missingGateEvidence 前 2、score.total、nextActions[0]，共 ≤4 行；复用 `salesDecisionPreviewText` 的字段路径但独立精简函数，避免全量 9 行卡把回执撑长。）

**失败/超时：提示不静默**——尾部改为一行 `阶段已更新。决策分析未在时限内完成，发送"项目分析 <商机名>"可查看完整分析。`（分析 run 在后台完成后即可拉取）。**不做重试、不做独立推送、不做配置开关**（固定行为写入 release notes；若真机反馈需要关闭或改异步，见 7.3 升级路径）。审计不加新 action：`opportunity.update` 的 metadata 增 `stageReview: "attached" | "timeout" | "failed" | "skipped_backward" | "skipped_unknown_stage" | "skipped_pause"`，可观测且零审计面扩张。

---

## 三、对话流与路由设计

### 3.1 对话流样例

**查进展（R0 免确认，一级消歧直达）**：

```
用户：日照医院的商机什么进展
小小：商机：日照中医医院十五五规划 […an-plan]
      客户：日照中医医院 ｜ 阶段：方案输出 ｜ 金额：规划类
      成交概率：66% ｜ 下一步：补齐规划材料，形成三段式方案。
      风险：移动云体验和数据自主权是核心矛盾…（截 120 字）
      更新：2026-08-27T…
```

**多商机消歧（两级合一）**：

```
用户：把胜利油田的商机推进到预算确认
小小：找到 2 个商机，请确认（回复更完整名称或编号）：
      - 胜利油田 PACS 双活 […f3a9c1] 方案交流 ｜ 金额待确认
      - 服务器采购计划 […8be2d7] 预算确认 ｜ 金额待确认
用户：把 f3a9c1 推进到预算确认
小小：【商机阶段变更待确认】胜利油田 PACS 双活 […f3a9c1]（客户：胜利油田中心医院，当前 v3）
      阶段：方案交流 → 预算确认
      确认后将自动运行阶段升级检查（销售决策分析）。
      待确认操作：修改商机阶段
      回复"确认"写入，回复"取消"放弃；10 分钟内有效。
用户：确认
小小：已推进：胜利油田 PACS 双活（v4）。阶段：方案交流 → 预算确认。
      ——阶段升级检查（销售决策 agent）——（2.2 格式）
```

**词表外阶段**：预览卡在阶段行后加 `注意：「投标」不在看板已知阶段（线索/初步沟通/调研机会/方案输出/方案交流/预算确认/暂停观察），确认后看板将新增该列，且不触发升级检查（方向不可判）。`

**改金额（R2 六位码）**：

```
用户：把黄岛区中医院的商机金额改成 5000 万
小小：【商机改档待确认】黄岛区中医院双活机房建设 […ao-tcm]（客户：黄岛区中医院，当前 v2）
      金额：3000 万 → 5000 万
      待确认操作：修改商机档案
      确认码：483921 ｜ 有效期：10 分钟 ｜ 回复"取消"放弃，回复"重发确认码"轮换。
用户：483921
小小：已更新：黄岛区中医院双活机房建设（v3）。金额 3000 万→5000 万。
```

**建商机（客户先唯一命中）**：

```
用户：新建商机 黄岛人民医院AI算力项目，客户 黄岛人民医院，阶段 线索，金额 500 万
小小：【商机建档待确认】
      名称：黄岛人民医院AI算力项目
      客户：黄岛人民医院 [hd-renmin]（已核验）
      阶段：线索 ｜ 金额：500 万 ｜ 下一步：待补充
      确认码：…（六位码卡）
```

客户多命中 → block 卡列客户候选（v0.7.2 同款）；零命中 → `未找到客户：X。请先发送"新建客户 X，…"建档后再建商机。`

**删商机（R3）**：预览卡 = 商机名[尾码]（客户，当前 vN）+ 阶段/金额 + `关联引用：行动 2 条、风险 1 条、快速记录 3 条将失去商机挂接展示（数据保留）。软删除可由管理员恢复。请确认这不是误操作。` + 六位码。

**改下一步（R1）**：预览卡 `下一步：<旧值截 80> → <新值>` + 轻确认。

**上下文代词**：`把它推进到方案交流` / 无主语的 `推进到方案交流` → `businessContext.opportunityId`（先前 detail/list 的 contextUpdate 已钉）；无上下文 → clarify"请说明商机名称或编号"。

### 3.2 router 正则（`backend/src/assistant/router.js`，全部纯函数可单测）

```text
G-W 写组（词干"商机"或强动词"推进/回退到"）：
 updateStage:
   ^(?:把|将)?(.{0,60}?)(?:的)?(?:商机)?(?:的)?(?:阶段)?(?:推进|推)(?:到|至)\s*(.+)$
     （"推进到"本身视为商机域强动词，"商机"词干可省——覆盖无主语"推进到方案交流"与
      尾码指代"把 f3a9c1 推进到预算确认"；主语解析不到商机时 not_found block 引导，误伤面见测试反例）
 | ^(?:把|将)?(.{0,60}?)(?:的)?商机(?:的)?阶段(?:改成|改为|设为|设置为|更新为|换成|调整?到)\s*(.+)$
 | ^(?:把|将)?(.{0,60}?)(?:的)?商机(?:回退|退回)(?:到|至)\s*(.+)$
 updateNext:
   ^(?:把|将)?(.{0,60}?)(?:的)?商机(?:的)?(?:下一步(?:动作)?)(?:改成|改为|设为|更新为|换成)\s*(.+)$
 | ^(.{0,60}?)(?:的)?商机(?:的)?下一步\s*[:：]\s*(.+)$
 update（金额/名称/风险）:
   ^(?:把|将)?(.{0,60}?)(?:的)?商机(?:的)?(金额|名称|风险)(?:改成|改为|设为|更新为|换成)\s*(.+)$
 create:  ^(?:新建|新增|创建)商机\s*[:：]?\s*(.+)$    （正文逗号分段：首段=名称；`客户[:：]?X` 段必填；可选 阶段/金额/下一步 段）
 delete:  ^(?:删除|删掉)商机\s*[:：]?\s*(.+)$
G-Q 查组（组内顺序：detail 先于 list——detail 后缀更特异）：
 detail:  ^(.{2,60}?)(?:的)?商机(?:的)?(?:进展|什么进展|情况|什么情况|状态|怎么样)(?:如何|怎么样)?\s*[?？]?$
 list:    ^(.{0,60}?)(?:的)?(?:有哪些|有什么)?商机(?:列表|们)?\s*[?？]?$   （主语与"列表/有哪些"至少一个存在；裸"商机"两字 → clarify 引导）
主语为空或代词（它/这个商机/该商机）→ businessContext.opportunityId。
```

**naturalPlan 插入位置总表**（自上而下；含 v0.7.3 已落项与 v0.7.4 计划项的合并合同）：

```
capture 前缀（L438，v0.7.3 已落，最前）
[v0.7.4 预留：todo 前缀组/complete/defer/delete——词干"待办/提醒我"，与本版互斥]
销售周报(L442) → 报销周报(L445) → 请款(L448) → 周报 clarify(L457) → 战情(L461)
客户详情(L464) → 商机详情(L473)
[本版 G-W 写组] ← 插在"商机详情"之后、"项目分析"(L482)之前（词干强，前置安全；
                  必须在 customerFieldChange(L583) 之前——"把X商机的名称改成Y"含字段词"名称"会被其误吞）
项目分析(L482) → 动作风险(L494) → followUp(L502) → 行程(L511) → 差旅(L514) → 记账正则(L522)
知识(L528) → 记录(L537) → 录入(L545) → quickUpdate/Void/Search(L556-568,v0.7.3) → 客户写系列(L569-599)
[本版 G-Q 查组] ← 插在"客户/查询客户"(L601)与 bareSearch"查询X"(L606)之前
                 （"查询日照的商机"若先落 bareSearch 会变客户搜索）
客户查询(L601) → bareSearch(L606) → customerProfile+排除名单(L611-626，3.3 重排) → 拜访兜底(L627) → unknown
```

**与四个既有 agent 的分流规则**：

1. **vs 记账**：记账正则 L522 是 `/记账|支出|收入|借款到账/`——"把商机金额改成 5000 万/元"不含这些词干，不冲突；反向"支出 500 元"不含"商机"，不进 G 组。歧义句 `商机收入 500 万`（假想）：G-W 不命中（无"改成"类动词）、落记账正则——含"收入"进记账 ingest，其草稿卡会因无金额语义自然澄清；可接受（该句式真实场景近零）。
2. **vs 客户**：`把X的商机名称改成Y` G-W 先命中（含"商机"）；`把X的名称改成Y`（无"商机"）照旧 customerFieldChange；`X什么情况` 照旧客户画像；`X商机什么情况` → G-Q/排除名单重排接住（3.3）。
3. **vs 快速记录（v0.7.3）**：capture 前缀最前——`记一下：黄岛商机推进到投标了` 仍是拜访记录（叙事语义，正确）；`日照的商机记录` 含词干"记录"照旧 QUICK_SEARCH（查快速记录，正确）；quickUpdate 的字段表含"商机"（`记录…的商机改成…`）但要求"记录"词干先行，与 G-W 互斥。
4. **vs 待办（v0.7.4 未实施）**：其前缀词干"提醒我/待办：/记待办"与"商机"无交集；`提醒我跟进黄岛商机` 是建待办（前缀强制优先，正确）。两版并行实施时以本表为顺序合同（4.2-D3）。
5. **群聊**：写组 provider 统一 `chatType!=="direct"` block（writeGate 复用）；list 新工具 handler 同样限私聊（商务数据）；detail 维持现状不动（1.2 末）。

### 3.3 画像排除名单重排（技术债核销）

```js
// router.js customerProfile 段（现 L611-626）重构为：
const customerProfile = value.match(/^(.{2,60}?)(?:的)?(?:什么情况|情况怎么样|情况如何|近况|画像|资料|档案)\s*[?？]?$/u);
if (customerProfile) {
  const subject = clean(customerProfile[1]);
  // v0.7.5 重排：商机/项目主语从"排除后落 unknown"改为转发商机详情。
  // 正常流量已被上游 G-Q 组截获，此处是变体安全网（如"XX商机资料""XX项目近况"）。
  const opportunitySubject = subject.match(/^(.{0,58}?)(?:的)?(?:商机|项目)$/u);
  if (opportunitySubject) {
    return makePlan({ tool: registry.getTool("opportunity.detail"),
      arguments: { opportunityId: clean(opportunitySubject[1]) || context.opportunityId ?? "" },
      confidence, source: "natural" });
  }
  const excluded = /(?:报销|周报|记账|请款|发票|凭证|行程|差旅|风险|待办|知识)$/u.test(subject);
  if (!excluded) { /* 原客户详情逻辑不变 */ }
}
```

要点：① 排除名单**删去"项目|商机"两词**（职责移交给上方新分支——从"排除"变"接住"，这正是登记时预期的"重排优先级"）；② 其余排除词维持落 unknown 现状（报销/周报等各有前置正则，此处仍是防误吞）；③ `opportunity.detail` 的 handler 现状已支持 query 消歧（0.3），传"日照医院"这类客户名主语会经 opportunitySearch join 客户名命中；④ 回归固化：`XX医院的商机什么情况`（G-Q 截获）、`XX项目什么情况`（安全网转发）、`XX医院什么情况`（客户画像不变）、`上周报销什么情况`（仍 unknown 不误吞）四组用例入 router 测试。技术债在 CHANGELOG 与 release notes 标注核销。

---

## 四、技术方案

### 4.1 文件清单（精确路径）

| 文件 | 新/改 | 内容 |
|---|---|---|
| `backend/src/opportunities/opportunityStore.js` | **新**（~230 行） | 从 server.js **迁出（非复制）**：`opportunityFromRow`(L626)、`createOpportunity`(L1384)、`updateOpportunity`(L1427)，新增 `getActiveOpportunity`、`softDeleteOpportunity`（`softDeleteRecord` 商机特化，或 server.js 继续用通用软删而 store 只包审计前查询——取前者，与 customerStore.softDeleteCustomer 对称）、`findByIdSuffix({ownerScopeSql…})`、`findActiveOpportunityByExactName(db,{customerId,name})`（建档查重）、`countOpportunityReferences(db, opportunityId)`（action/risk/quick_record/solution_draft 四表计数，删档预览用）。version 冲突语义照 customerStore `throwVersionFailure`（HttpError 409 VERSION_CONFLICT + currentVersion） |
| `backend/src/opportunities/stageVocabulary.js` | **新**（~30 行） | 1.3 词表与方向函数 |
| `backend/src/assistant/opportunityPendingPreviewProviders.js` | **新**（~280 行） | 五 provider（4.3），工厂签名对齐 v0.7.2/0.7.3 两组 |
| `backend/src/assistant/opportunityAssistantAdapter.js` | 改 | ① `normalizeOpportunity` 增 version 投影（对齐 customer L109）；② `CHANGEABLE_FIELDS` 扩为 name/risk/next/**stage/amount**（stage≤100、amount≤100、其余沿用）；③ `changePreview.expectedVersion = opportunity.version ?? null`、protectedFields 收为 `["customerId","probability","version"]`；④ taskTypes 增 `create_preview`/`delete_preview`（镜像 customer）；⑤ writebackPreview.note 更新（"阶段/金额/下一步经确认后由服务端执行；概率与客户关系保持只读"） |
| `backend/src/assistant/businessSnapshotAdapter.js` | 改（~2 行） | `opportunityFromRow` 增 `version`（asSafeInteger ≥1，模式抄 customerFromRow L167-170） |
| `backend/src/assistant/router.js` | 改 | 3.2 两组正则 + `parseOpportunityCreateArgs` 分段纯函数 + 3.3 排除名单重排 + HELP 增"商机查询与维护" |
| `backend/src/assistant/policy.js` | 改 | +6 条：list=R0/none/read_only、updateStage=R1/affirm_language/stage_write、updateNext=R1/affirm_language/ordinary_write、update=R2/explicit_code/profile_write、create=R2/explicit_code/profile_write、delete=R3/explicit_code/destructive_write |
| `backend/src/assistant/agentRegistry.js` | 改 | TOOL_DEFINITIONS +6（args schema：list={query required}；updateStage={opportunityId?,query?,stage required,expectedVersion?}；updateNext={opportunityId?,query?,next required,expectedVersion?}；update={opportunityId?,query?,changes required(object),expectedVersion?}；create={name required,customerQuery required,customerId?,stage?,amount?,next?}；delete={opportunityId?,query?,expectedVersion?}） |
| `backend/src/assistant/agentManifest.js` | 改 | opportunity manifest：tools 7 项、taskTypes +create_preview/delete_preview、systemPrompt 重写（"阶段金额下一步的变更必须走服务端确认执行，概率与客户关系只读"）、confirmation.write 保持 explicit |
| `backend/src/assistant/capabilityCatalog.js` | 改 | `opportunity.detail` 条目描述更新 + 新增 `opportunity.write` 能力条目（tools 6 写读、apis 对应 POST/PATCH/DELETE /api/opportunities、confirmationLevel explicit）+ `sales-decision.preview` 条目 description 补"阶段升级自动附带检查" |
| `backend/src/assistant/runtimeHandlers.js` | 改 | +6 handler（4.4）；`createAssistantToolHandlers` 增 `opportunityStore` 依赖注入（默认 `createOpportunityStore?` 不做——store 是纯函数集合，直接 import，与 customerStore 用法一致）；`ambiguousEntityResult` 商机分支升级为带阶段/金额/尾码的候选行（新 `opportunityCandidateLines`，客户分支不动） |
| `backend/src/server.js` | 改 | ① L626/L1384/L1427 三函数删除改 import（PATCH/POST/DELETE 路由与 `syncOpportunityFromQuickRecord`、`buildSalesDecisionContext` 的调用点同步换引用）；② providers 注入合并第三组 `...createOpportunityPendingPreviewProviders({...})`（L2927-2941）；③ 无新端点、无调度器 |
| `backend/src/config.js` | 改 | `opportunityStageReviewBudgetMs`（默认 8000，env `OPPORTUNITY_STAGE_REVIEW_BUDGET_MS`，钳 [1000,30000]） |
| `backend/src/validation/requests.js` | **不改** | Web 合同零变化 |
| `backend/src/db/migrations/` | **不改** | 零迁移（version/deleted_at 迁移 0002 已备；0028 编号留给 v0.7.4） |
| `CHANGELOG.md`、`docs/releases/v0.7.5.md`、`VERSION`、蓝图 G 行 | 改 | DoD 惯例 + 技术债核销标注 |

### 4.2 依赖漂移点（对 v0.7.3 冻结与 v0.7.4 实施的依赖清单）

| # | 依赖 | 现状（调研实测） | 实施前核对动作 |
|---|---|---|---|
| D1 | **affirm_language 编排器分支** | 已在工作树（orchestrator.js L291-314/471-526/688-728），policy 已有 `visit-capture.capture=R1/affirm_language` 先例 | v0.7.3 冻结提交后核对判定键 `policy.confirmation === "affirm_language"` 未改名；本版零移植 |
| D2 | **pendingPreviewProviders 注入点** | server.js:2927-2941 已是 customer+quickRecord 两组展开合并 | 第三组续接展开；若 v0.7.4 先实施会有第四组（actionItem），合并顺序无语义（键名互斥） |
| D3 | **naturalPlan 插入顺序** | v0.7.3 组已落（L438/L556-568）；v0.7.4 计划 todo 组在 capture 后最前 | 以 3.2 总表为三版共同合同；商机 G-W 组锚点="商机详情正则之后"、G-Q 组锚点="客户查询正则之前"（语义锚点不受行号漂移影响）；与 v0.7.4 词干互斥已论证（3.2-4） |
| D4 | **handlePending 让路守卫** | guard1/guard2 现状已放行商机语式（0.5） | v0.7.4 若收窄 guard1 为 actionType 白名单，需把 `opportunity.*` 纳入；T-BK 回归用例固化（6.2） |
| D5 | **迁移编号** | 本版零迁移 | 与 v0.7.4 的 0028 无竞争；先后次序自由 |
| D6 | **opportunityAssistantAdapter 契约消费方** | `assistant-opportunity-adapter.test.js` 现有断言 protectedFields 含 stage/amount、writebackAllowed:false | 本版改契约字段语义（writeback 仍 false——写不经 adapter 而经 store，adapter 只产预览），测试同步改断言；salesDecision/快照消费方不读 changePreview，无涟漪 |
| D7 | **v0.7.4 action-risk 工具挂载** | 其设计规划 `action-risk.create/list/complete/defer/delete` 5 工具 + spokenTime | 与本版 `opportunity.*` 6 工具零命名交集；本版**不需要任何时间解析**（商机字段无时间语义），spokenDate/spokenTime 零依赖——两版实施完全正交，唯一共享面是 D3 顺序表与 D4 守卫 |

### 4.3 预览 providers（`opportunityPendingPreviewProviders.js`）

工厂 `createOpportunityPendingPreviewProviders({ opportunityAdapter, customerAdapter, snapshotAdapter, db, resolveBusinessOwner })`，返回五键（updateStage/updateNext/update/create/delete），公共构件：

- `writeGate`：`chatType!=="direct"` → block（`商机档案修改仅支持与小小的私聊。`）；`resolveBusinessOwner` 空 → block（v0.7.2 同款）。
- `resolveOpportunityTarget({owner, opportunityId, query, businessContext})`：① 精确 ID（`snapshotAdapter.opportunityDetail`）；② 6-64 位 `[A-Za-z0-9-]` 后缀（`opportunityStore.findByIdSuffix`，owner 可见范围内 LIKE 唯一命中，多命中列候选、零命中提示）；③ query → `opportunityAdapter.analyze(taskType:"detail", query)`（内部 opportunitySearch join 客户名）——clarify → block 候选卡（`- 名称 […尾6] 阶段 ｜ 金额`，≤5 行 + "回复更完整名称或编号重试"）、not_found → block、relationship review_required → block（"商机与客户关系无法核验"）；④ 全空 → `businessContext.opportunityId`；⑤ 仍无 → block（"请说明商机名称或编号，如「把日照的商机推进到方案交流」"）。命中后 **version 缺失 → block**（"商机资料版本无法确认，请稍后在系统网页中处理"——投影已加 version，此为防御线）。
- **updateStage**：目标唯一 → stage 归一（trim、剥尾部语气词 `了/吧/呀/啦` 与句读、≤100，空 block——"推进到投标了" → "投标"）→ 与当前一致 → block（"该商机已处于「X」阶段。"）→ `stageDirection` 计算 → 预览卡（3.1 格式：阶段行 + 词表外提示 + forward 时联动预告/backward 时"回退不触发升级检查"）→ `arguments:{opportunityId, expectedVersion, stage}`。
- **updateNext**：同目标解析 → 与当前一致 block → 预览卡 `下一步：旧(截80) → 新` → `arguments:{opportunityId, expectedVersion, next}`。
- **update**：changes 白名单（amount/name/risk；经 `opportunityAdapter.analyze(taskType:"change_preview", changes)` 产 before/after，rejectedFields 提示"其余字段请在系统网页修改"）→ changedFields 空 → block（"内容与现有档案一致"）→ 预览卡逐字段 before→after（v0.7.2 改档卡同款）→ `arguments:{opportunityId, expectedVersion, changes(仅 changedFields)}`。
- **create**：`name` 空 block；`customerQuery` → `customerAdapter.analyze(taskType:"detail")` 唯一命中钉 customerId（clarify/not_found block，0.4）；同客户下 `findActiveOpportunityByExactName` 查重 → block 引导改名或改档；stage 词表外提示行；预览卡（3.1）→ `arguments:{name, customerId, stage?, amount?, next?}`。
- **delete**：目标唯一 → `countOpportunityReferences` → 预览卡（3.1 强提示）→ `arguments:{opportunityId, expectedVersion}`。

### 4.4 runtimeHandlers 六个 handler（幂等与乐观锁）

- 公共：`resolveBusinessOwner(context.owner)` 空 → denied 文案；写 handler 先 `snapshotAdapter.opportunityDetail({owner, opportunityId})` 复核可见性（防 provider→confirm 窗口内可见性变化，快照或口径 0.1）。
- `opportunity.list`：`chatType!=="direct"` → denied（3.2-5）；`opportunitySearch` → 卡片 `X 的商机（N 个）：\n1. 名称 […尾6] ｜ 阶段 ｜ 金额\n…`（≤8 条 + truncated 提示）；唯一命中时附 `发送"商机详情 <名称>"查看完整信息`；`contextUpdate` 仅在唯一命中时钉双 ID。
- `opportunity.updateStage` / `updateNext` / `update`：args 已被 provider 钉死（opportunityId+expectedVersion+字段）；`withImmediateTransaction { updateOpportunity(db, id, changes, expectedVersion) + insertAudit("opportunity.update", {before, after, entityVersion, metadata:{changedFields, stage, probability, source:"weixin-assistant", actionId, ...(updateStage ? {stageReview} : {})}}) }`；`VERSION_CONFLICT` → `商机资料刚在其他端被修改，本次未写入，请重新发起。`；`NOT_FOUND` → 对应文案。updateStage 事务提交后执行 2.2 联动（race 在事务外，分析失败不回滚业务写）。回执含 `contextUpdate` 钉双 ID。**执行重放**：claimExecution 租约 + toolRun 摘要（0.5）双兜底，重复确认返回已存结果。
- `opportunity.create`：`id = context.actionId`（六位码 pending 必有）为实体主键幂等（customer.create 先例 L913-928：已存在同 id → 回执 replayed）；`withImmediateTransaction { requireActiveCustomer 语义复核（customer 可见且未删）→ createOpportunity(db, {…, customer: 客户名, owner: businessOwner}) + insertAudit("opportunity.create", metadata source/actionId) }`；回执 `已建档：X（ID 尾码，v1），客户：Y。发送"商机详情 X"可查看。` + contextUpdate。**owner 写入 businessOwner**（快照或口径下对小小可见；Web 全量列表不受影响）。
- `opportunity.delete`：`softDeleteOpportunity({id, expectedVersion, deletedBy: context.owner, metadata:{source:"weixin-assistant", actionId}})` → 审计 `opportunity.delete`；回执 `已删除（归档）：X。关联行动/风险/记录的商机挂接已隐藏；如需恢复请联系管理员。` + `contextUpdate:{opportunityId:null}`（customerId 保留——删商机不清客户上下文）。

**审计命名总结**：全部沿用 Web 同名 `opportunity.create/update/delete`（与 v0.7.2 customer 先例一致），微信来源以 `metadata.source="weixin-assistant"` + `metadata.actionId` + requestId 区分；阶段联动经 `metadata.stageReview` 观测（2.2）；确认链自带 `assistant.action.*` 五段审计；**零新审计 action**。v0.7.1 记账实时日志按记账前缀过滤，不受影响。

### 4.5 风险

1. **stage 词表前后端漂移**：后端常量镜像前端数组，任何一侧改词表需同步（注释互指 + release notes 提醒）；根治并入 L 阶段（7.4）。
2. **排除名单重排的回归面**：customerProfile 是兜底正则，改动影响所有"X什么情况"流量——四组正反例（3.3）+ 既有 router 测试全量回归兜底。
3. **同步联动的时延**：8s 预算内模型未返回则止损（提示拉取），最坏用户等待 = 确认回复往返 + 8s；worker 事件 POST 无显式超时（0.5）不会断连。若真机体验差 → 7.3。
4. **server.js 函数迁出**：机械重构但触碰主文件三处调用点（PATCH 路由、深写回、决策上下文）——现有 `api.test.js`/`assistant-sales-loop.test.js` 全量兜底；与 customerStore 先例同风险等级。
5. **owner 双口径**：微信写路径经快照或口径复核 + create 写 owner=businessOwner；**存量 owner=NULL 商机**（客户 owner 匹配时）小小可见可改（快照或口径），Web 不受限——行为与查询一致，无新增面。生产存量数据 owner 是否匹配 `WEIXIN_AGENT_OWNER` 在发布验收做只读体检（v0.7.2 先例）。
6. **改名与消歧的相互作用**：改名后旧名称检索不到属预期；候选卡/回执始终带 ID 尾码兜底指代。

---

## 五、依赖与实施顺序

实施顺序建议（单人 ~2.5 人日；前置：v0.7.3 冻结提交核对 D1-D4）：

1. `opportunityStore` 迁出 + `stageVocabulary` + 快照/adapter version 投影 + 单测（0.5d，无依赖可先行）
2. policy/registry/manifest/catalog + router 两组正则与排除名单重排 + 单测（0.5d）
3. providers + handlers（含联动 race）+ server.js 装配 + 单测（1d）
4. HTTP 集成（六位码 + 轻确认 + 联动三态）+ 分流回归 + 门禁全绿（0.5d）

---

## 六、测试面（`backend/tests/`，node:test + assert/strict 惯例）

### 6.1 新增文件

| 文件 | 用例要点 |
|---|---|
| `opportunity-store.test.js` | 迁出函数行为等价（create 全字段/update patchValue 模式/版本冲突 409+currentVersion/软删）；findByIdSuffix 唯一/多命中/LIKE 转义/owner 可见范围；findActiveOpportunityByExactName 同客户查重；countOpportunityReferences 四表计数 |
| `stage-vocabulary.test.js` | 词表顺序；direction forward/backward/same/unknown 全组合；trim 归一 |
| `assistant-opportunity-write-runtime.test.js` | 六 handler 直测（模式抄 assistant-customer-write-runtime）：updateStage 成功+审计 metadata.stageReview 各态；联动 race 超时（注入慢 salesLoopPreviewService）→ timeout 提示且业务写已提交；backward/词表外 skipped；VERSION_CONFLICT 文案；create actionId 幂等重放；delete 软删+contextUpdate；owner 复核失败 denied |
| `assistant-opportunity-http-integration.test.js` | 端到端（模式抄 assistant-customer-http-integration，六位码用 confirmationCodeFrom helper）：`把X的商机推进到Y` → affirm 卡（断言无六位数字、含 before→after 与联动预告）→"确认"→ 库变更+audit+回执含"阶段升级检查"（mock 模型 fetch）；多商机消歧卡→尾码重试；改金额六位码全链（错码×5 锁定、重发确认码、取消）；建商机（客户 clarify block / 唯一命中 / 同名查重 block）；删商机 R3 全链+关联计数；`日照医院的商机什么进展`→detail 卡；`X有哪些商机`→list 卡；群聊写拒绝；TTL 过期 |

### 6.2 扩展既有文件（含四 agent 分流回归）

| 文件 | 用例要点 |
|---|---|
| `assistant-router.test.js` | 3.2 全正反例 + **分流回归四组**：记账组（`支出 500 元`→仍 bookkeeping；`把商机金额改成 5000 万`→opportunity.update 不落记账）；客户组（`把X的名称改成Y`→仍 customer.update；`把X商机的名称改成Y`→opportunity.update；`X什么情况`→仍 customer.detail；`X商机什么情况`→opportunity.detail；`X项目什么情况`→opportunity.detail【排除名单重排】；`上周报销什么情况`→仍 unknown）；快速记录组（`记一下：黄岛商机推进到投标了`→仍 capture【前缀最强】；`日照的商机记录`→仍 visit-capture.search）；待办组（v0.7.4 实施后联测：`提醒我跟进黄岛商机`→todo create；未实施时该句现状落拜访兜底/unknown 断言不变）；`查询日照的商机`→list 不落 bareSearch；代词/上下文用例；**推进到宽正则边界组**：`黄岛商机推进到投标了`（无前缀叙事）→updateStage 且 stage 归一剥"了"；`会议推进到下周`→updateStage 命中但商机 not_found block（行为变更：原落拜访兜底，release notes 标注）；`把行程推进到下周`同上（真实话术近零，block 文案自澄清） |
| `assistant-policy.test.js` / `assistant-registry.test.js` / `assistant-agent-manifest.test.js` / `capability-catalog.test.js` | 6 条新 policy 的 risk/confirmation/reason；args schema；manifest tools/taskTypes/systemPrompt；能力目录条目 |
| `assistant-opportunity-adapter.test.js` | version 投影；CHANGEABLE_FIELDS 扩展（stage/amount 可变更、probability/customerId 仍 rejected）；expectedVersion 钉版非 null |
| `assistant-business-snapshot-adapter.test.js` | opportunityFromRow version 投影 + 既有字段回归 |
| `assistant-sales-loop-preview.test.js` / `assistant-sales-loop-runtime.test.js` | previewSalesDecision 带显式 eventId 幂等（event 唯一索引重放不炸）；stage-review eventId 命名 |
| `shortcut-bookkeeping-safety.test.js` | T-BK 组：记账草稿 + 商机 affirm pending 并存——未引用"确认"归商机（guard1）；引用记账草稿"确认"仍入账；商机六位码 pending 时码归通用边界 |
| `api.test.js` | 商机 CRUD 路由行为不变（store 迁出等价性）；深写回/决策上下文调用点回归 |

门禁：后端全量 + 前端 qa:local + Chrome/WebKit 集成 + 密钥扫描 + 根 test:deploy（DoD 固定项）。

---

## 七、风险与开放问题（默认保守，不阻塞实施）

1. **概率（probability）变更**不在蓝图范围，保持 protected 只读；若产品要，加入 update 白名单一行 + 校验 0-100（一次小改）。
2. **"推进到下一阶段"相对语式**：本版 clarify 列已知序列（用户显式说目标）；观察真实话术后若高频，用 stageVocabulary 索引 +1 实现（需处理词表外当前阶段）。
3. **联动升级路径**：若真机反馈同步附带体验差（超时率高/嫌长），升级为 outbox 异步推送——预渲染文本 payload kind=`opportunity_stage_review`、幂等键 `stage-review:{opportunityId}:{version}`、渲染分支一处（0.5 outbox 机制现成）；或加 config 开关。本版均不做。
4. **stage 词表统一**：前后端两份常量，根治方案是 L 阶段（v0.8.3 pages 拆分）时把词表下沉到后端 API（GET /api/opportunities/stages）或共享包；本版注释互指。
5. **裸"商机"两字/无主语查询**的引导文案是否并入 HELP：本版 clarify 引导（"请带上客户或商机名称，如「日照医院有哪些商机」"），HELP 加一句总述。
6. **opportunity.detail 群聊可用**的现状是否收窄为私聊：本版不动（已上线行为）；若商务数据保密要求提级，与 list 一起统一 direct 门（一行改动）。
7. **同名商机跨客户的建档查重**只查同客户（`findActiveOpportunityByExactName(db,{customerId,name})`）——跨客户同名是合法业务（不同医院同类项目），不拦。
8. **删商机后关联 action/risk 的 opportunity_id 仍指向软删行**（FK SET NULL 只在硬删触发）：现状 Web 同款行为（join 过滤后不可见），不做级联清理。

---

## 附：与蓝图 G 阶段验收的对照

- 查阶段/金额/下一步 ✅（detail/list R0）
- 改阶段 ✅（updateStage R1 轻确认 + 词表提示）
- 改金额 ✅（update R2 六位码）
- 改下一步动作 ✅（updateNext R1 轻确认）
- 阶段升级联动销售决策 agent ✅（前进方向确认后同步附带 8s 预算检查，opportunity_diagnosis 的 gatePassed 回答"升级是否有据"）
- 附加交付：建/删商机（注册描述既有承诺）、画像排除名单技术债核销（3.3）、商机写路径 store 化（对齐 L 阶段方向）
