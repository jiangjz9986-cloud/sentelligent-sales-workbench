# v0.7.3 小小·拜访与快速记录 agent 实施设计（调研定稿）

> 产出：2026-08-28 · 只读调研，未改代码。实施对应总蓝图 E 阶段（`docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md`）。
> 实施前提：v0.7.1（Web 去二次确认+记账日志）与 v0.7.2（客户画像 agent，含 pendingPreviewProviders / handlePending 让路守卫）先行冻结上线。
> 行号声明：调研时工作区带 v0.7.1 未提交改动（`git status` 有 27 个修改文件，但均不涉及本设计引用的 assistant/quick-record 链路文件）；文中行号以调研时工作树为准，实施时如有漂移以语义定位。

---

## 零、现状链路结论（实施前必读，全部来自源码）

### 0.1 quick_record 实体与 Web 全链路

**表结构**：`backend/src/schema.sql:45-56` + 迁移 0002（`db/migrations/0002_phase1_write_integrity.mjs`）补 `version`（乐观锁）与 `voided_at/voided_by/void_reason` 三列。字段：`owner, raw_content, occurred_at, source_channel, customer_id, opportunity_id, status('recorded'→'analyzed'→'confirmed')`。**注意：`voided_at` 三列自 0002 引入后全库无任何写入点（全仓 `SET voided_at` 零命中）——作废能力有列无路**。配套表：`ai_insights`（每次分析一行，`analysis_json` 全量 JSON，取"最新"按 `created_at DESC, rowid DESC`，`server.js:1852-1861`）、`manual_confirmations`（`(quick_record_id, target)` 唯一，target ∈ customer/opportunity/weekly）、`action_items.source_record_id`（UNIQUE 指回记录）、`risk_items(source_type='quick_record', source_id)`（部分唯一索引，迁移 0003）。

**HTTP 路由（`server.js`）**：
| 路由 | 行为 | 审计 action |
|---|---|---|
| `GET /api/quick-records`（L6392-6403） | 列表 `voided_at IS NULL`；`quickRecordOwnerScope`（L1381-1395）：**machine 身份限定 owner=account，Web 登录用户不限定（看全量）**；每行附最新 analysis + confirmations（L1867-1884） | 无 |
| `POST /api/quick-records/preview`（L6405-6424） | 只分析不落库：`searchKnowledgeForAnalysis`（L1798-1828，知识加权匹配 ≤4 条）+ `analyzeQuickRecord` | 无 |
| `POST /api/quick-records`（L6426-6471） | 创建；`sourceChannel ?? "快速记录"`；`validateCustomerOpportunityPair` 校验客户商机关系（L1372-1379）；owner=authContext.account | `quick_record.create` |
| `POST /:id/analyze`（L6473-6546） | 插一行 ai_insights + status→analyzed | `quick_record.analyze` |
| `PATCH /:id/analysis`（L6548-6635） | **只能改最新 insight 的 `summary.{request,feedback,risk,action}.text` 四段**（schema `quickRecordAnalysisPatch`，`validation/requests.js:208-216`）；`If-Match` 对 quick_records 乐观锁（`runVersionedUpdate` 只 bump version），insight 行原地覆盖 | `quick_record.analysis.update` |
| `POST /:id/confirm`（L6760-6997） | Idempotency-Key + If-Match(记录版本) + `targetVersions{customer,opportunity}`；写 manual_confirmations、status→confirmed，然后**深写回**：`syncCustomerFromQuickRecord`（L1908-1933，customers.sync_preview/needs/risks 追加，各截 8 条）、`syncOpportunityFromQuickRecord`（L1935-1963，requirements/solution_direction/source_record/risk/next）、`upsertActionFromQuickRecord`（L1965-2034，action_items 按 source_record_id 幂等 upsert，assignee 硬编码"继振"）、`upsertRiskFromQuickRecord`（L2258+） | `quick_record.confirm`（before/after 全景证据） |

**没有的能力**（v0.7.3 的增量空间）：无检索端点（按客户/日期/关键词）、无 rawContent/occurredAt/挂接关系的修改端点、无作废/删除端点。

### 0.2 微信侧 visit-capture 现状（三步式）

- **agent 与工具**：`agentRegistry.js:14`（visit-capture agent）+ L58-60 三工具；policy（`policy.js:24-26`）：`collect=R1/none`、`preview=R1/none`、`confirm=R2/simple`。**`simple` 与 `explicit_code` 在编排器里行为完全相同**（`evaluatePolicy` 只看 `!== "none"`，isRisky→pending action+六位码）。
- **路由（`router.js`）**：兜底正则 `(拜访|拜会|电话|会议|沟通|走访|客户现场)`（L278-285）→ collect 暂存；等值 `"记录"`（L257）→ preview；等值 `"录入"`（L265）→ confirm（六位码）。斜杠/别名：`拜访/拜访预览/拜访确认`（L126-128）。
- **暂存机制**：collect 把用户消息累进会话草稿（`sessionRepository.appendDraftPart`，编排器对每条入站消息 L379 自动 append）；`draftText`（`runtimeHandlers.js:60-68`）取全部 user 角色、非控制词（`记录/录入/确认/取消/帮助/<confirmation-code>`，L49-54）的 parts 拼接。**通用"取消"不清草稿**（只取消 pending action），草稿仅在 confirm 成功后清空（L1188-1193）。
- **preview**（L1063-1080）：`visitCaptureAssistantAdapter.analyze(taskType="preview")` → `previewText` 卡（L70-102：客户/商机/诉求/风险/建议+候选校验行+runId+"回复录入"）。
- **confirm 执行器**（L1082-1200）：`actionId` 作 quick_records 主键实现幂等重放；`reusableVisitRun`（L418-443，按 event/conversation + rawContent + businessContext 匹配复用 agent run，免二次模型调用）；`resolveQuickRecordLinks`（L253-292，客户/商机**唯一命中才挂**，关系不一致弃商机）；INSERT `source_channel='微信助手'`、`occurred_at=now()`、owner=context.owner → ai_insights → status='analyzed'；审计 `quick_record.create` + `quick_record.analyze`（metadata 含 sourceChannel/customerId/opportunityId）。**不写 manual_confirmations、不做深写回**（adapter 输出 `writebackAllowed:false`，`visitCaptureAssistantAdapter.js:357-374` 明示"只创建快速记录"）。
- **周报联动**：`source_channel='微信助手'` 的 analyzed 记录**免 weekly 确认直接进周报预览**（`businessSnapshotAdapter.js:768-776`、`salesLoopPreview.js:503-514` 双处 `qr.source_channel = '微信助手'` 精确匹配）——新工具必须沿用该 channel 值。
- **owner 语义**：写入 owner=context.owner（微信机器账号）；查询侧 `resolveBusinessOwner`（`businessOwnerResolver.js:20-27`）为精确匹配 `config.weixinAgentOwner`（`server.js:2908-2912`），即**机器账号与业务 owner 配置一致时两者同值**，写与查天然对齐；不一致时 resolver 返回 null → 查不到（闭合语义）。

### 0.3 微信消息分流与记账边界

- **入口链**：SDK worker（`weixin/worker.js:94-107`，typing 指示 10s 刷新，`vendor/weixin-agent-sdk/dist/index.mjs:2279-2285`；`agent.chat` 无超时，失败发"⚠️ 处理消息失败"）→ `remoteAgent.js:237-245` POST `/api/integrations/weixin-agent/events`（`server.js:3300-3410`）→ 机器鉴权+事件校验+白名单 → `assistantOrchestrator.handle` → 同步响应顶层 `text` 即回复（L3395-3408）。`weixin/agentBridge.js` 为遗留实现，仅测试引用，生产不挂。
- **进快速记录的消息类型（现状）**：仅纯文本三类——兜底正则命中的口语、显式 `/拜访` 系命令、控制词"记录/录入"。**媒体消息一律不进**：无文字媒体→`bookkeeping.ingest`（router L320-323），"发票/付款凭证"文字+媒体→对应 ingest。
- **记账优先边界**：`naturalPlan` L242 `/记账|支出|收入|借款到账/` 在拜访兜底**之前**——含这些字样的拜访描述今天就会被记账吃掉（如"拜访时聊了记账系统"）；本设计的新前缀意图必须处理该歧义（见 1.3）。
- **handlePending 现状（v0.7.2 调研后有演进，仍有两冲突）**：`shortcutBookkeepingRuntime.js:2243-2397` 顶部已加"shortcutSignal"注释与判定（L2248-2260），**无活跃记账草稿时**裸六位码/取消/普通文本会 `return null` 放行（L2320）；但**存在单条已送达记账草稿时**，`implicitCurrentAction`（L940-967：单候选无时间窗、需 outbox status=sent）仍会把任意普通文本选为隐式目标 → 普通文本落 L2396 clarify（劫持），六位码落 L2372-2375"小小记账不使用六位确认码"（吞码）。**v0.7.2 设计 3.6 的两条早退修复仍然必要**，是本设计的硬前置（见第四章）。
- **确认词现状**：`classifyWeixinConfirmationText`（`weixinEvent.js:117-122`）只识别 `六位数字/取消/重发确认码`；"确认"是 ordinary。router 对裸"确认"走 `input.pendingPlan` 分支（L301-307），**编排器从不传 pendingPlan** → 现状裸"确认"在无记账草稿时一律回"当前没有待确认的操作。"。

### 0.4 AI 分析路径与时延/失败（微信场景）

- `analyzeQuickRecord`（`modelAnalysis.js:495-516`）：**同步 await、单次调用**（非异步任务，无任务表）。`aiAnalysisMode!=="model"` → 确定性 mock（`quickRecordAnalysis.js`）；缺 key → `mock_missing_model_key`；模型路径 → deepseek `chat/completions`，`response_format=json_object`、`temperature 0.1`、`max_tokens 3200`、**`AbortSignal.timeout(modelTimeoutMs ?? 30000)`**（L133，config `config.js:295`）；任何异常 catch → `mock_model_fallback`，**永不上抛**。
- visit-capture 适配器再包一层（`visitCaptureAssistantAdapter.js:512-524`）：模型层失败 → `minimalLegacyAnalysis(…, "fallback")`；`sourceClass`（L73-79）把 `fallback/mock_*` 归 fallback 档（候选置信降档、输出 status="fallback"）。agent run 持久化于 `assistant_agent_runs`（`agentRunRepository`），同输入重放。
- **时延结论**：微信"发文字→等分析→回确认卡"= 事件同步链路上一次 ≤30s 的模型调用 + 若干本地查询。SDK 侧有 typing 指示兜底观感、事件幂等（`eventRepository.receive/claim` + provider 侧 Idempotency-Key=sourceMessageId）保证 provider 重试不重复执行。**结论：无需引入异步任务/outbox 回推，沿用同步模式**；失败兜底 = 确定性 fallback 卡 + 文案标注（见 2.5）。

### 0.5 visit_itinerary 与"拜访历史"的关系（范围裁定）

- `visit_itineraries`（迁移 0005）：行程规划实体（title/visit_date/status planned|completed|cancelled/request_json/plan_json，version+软删），repository `itinerary/repository.js`（create/list(status)/update 全字段替换/softDelete），HTTP `GET/POST /api/itineraries`、`GET/PATCH/DELETE /:id`（`server.js:5761-5921`，PATCH 必须重跑 `buildItineraryPlan`→**AMAP 未配置直接 503**，L3009-3024），审计 `visit_itinerary.create/update/delete`。小小侧只有 R0 `itinerary.summary`（`created_by=owner`，无日期过滤）；`itineraryAssistantAdapter` 有 change_preview taskType 但**写工具未注册**（manifest note"行程写入工具尚未开放"）。
- **裁定**：蓝图 E 的"查/改历史记录"指 **quick_records（拜访记录）**，不是 visit_itineraries（行程计划）——用户口语"上周去XX的记录"语义是已发生的拜访内容；行程的微信写入牵涉 AMAP 重规划链，属 v0.8.2（行程↔差旅联动）更合适。本版**不动 itinerary**，`itinerary.summary` 保持现状。

### 0.6 outbox 与既有确认卡（复用声明）

- outbox 仅用于主动推送（记账草稿/招标），payload 键禁 `confirmation/code/token/secret/credential/password/authorization/owner/actor/identity/account/source/idempotency`（`weixin/outboxRepository.js:7,52-56`），worker 投递范围锁定记账绑定私聊（`worker.js:140-163`）。**本设计全部走 events 同步响应，零 outbox 改动**。
- 六位码确认卡样式与安全不变量（live 响应含码、事件存档洗成 `STORED_CONFIRMATION_TEXT`、错码 5 次锁定、单会话单 pending、10 分钟 TTL、`重发确认码` 换码）沿用 `orchestrator.js:277-287,435-521,568-601` + `pendingActionRepository`，v0.7.2 已总结，不重复设计。
- **内部派生凭据模式**（轻确认的实现基础）：记账 pending 不向用户发码，`deriveShortcutStateCredential(actionId, version, secret)`（`shortcutBookkeepingRuntime.js:181-191`，HMAC 派生六位数字）作为 `pendingActionRepository.create({id, confirmationCode})` 的内部状态闸，确认时重派生传入 `confirm()`。本设计的 R1 轻确认复用该模式（3.3）。

---

## 一、意图设计

四个新工具全部挂在现有 `visit-capture` agent 下（零新 agent），全部**确定性正则解析，不经模型**；owner 由服务端上下文注入（contracts 层禁 owner/actor 键，`contracts.js:5-10`）。

### 1.1 工具与确认边界（风险分级论证见 2.1）

| 工具 | 风险/确认（policy.js 新增） | 触发语式 | 说明 |
|---|---|---|---|
| `visit-capture.capture`（新） | **R1 / `affirm_language`（轻确认，新确认级别）** | `记一下：…`、`记录一下…`、`帮我记一下…`、`快速记录：…`、`记拜访：…`、`/记一下 …` | 一步式：分析→摘要卡→回复"确认"写入 |
| `visit-capture.search`（新） | R0 / none，免确认 | `查一下上周去XX的记录`、`上周的拜访记录`、`XX医院的记录`、`最近的拜访记录` | owner 限定，≤5 条卡片 |
| `visit-capture.update`（新） | **R2 / explicit_code（六位码）** | `把那条记录的下一步改成…`、`把记录 <ID后缀> 的时间改成昨天`、`把最近一条记录的客户改成XX` | 可改：分析四段/发生时间/挂接客户/商机 |
| `visit-capture.void`（新） | **R3 / explicit_code（六位码）** | `作废那条记录`、`删除记录 <ID后缀>` | 首次启用 voided_at 三列，软作废 |
| 既有 `collect/preview/confirm` | 原样保留（confirm 仍 R2/simple 六位码） | 原语式 | 向后兼容；退役与否见开放问题 6.2 |

### 1.2 与记账/客户 agent 的分流规则（优先级与歧义处理）

**优先级总表**（`naturalPlan` 自上而下）：

```
[新] capture 前缀（含内部记账歧义门）        ← 函数最前（前缀是最强的用户意图信号）
销售周报 → 报销周报 → 请款 → 周报clarify → 快捷记账提示 → 战情
客户详情 → 商机详情 → 项目分析 → 动作风险 → 跟进句式 → 行程 → 差旅
记账正则 /记账|支出|收入|借款到账/           ← 不动（L242）
知识检索 → "记录"(等值→preview) → "录入"(等值→confirm)
[新] search 正则 → update 正则 → void 正则   ← 插在 L272 与 L273（客户/查询客户）之间
客户/查询客户 → [v0.7.2 建档/改档/删档/画像/查询] → 拜访兜底（L278）
```

**歧义处理三条规则**：
1. **capture 前缀 vs 记账**：前缀剥离后对正文 body 做记账启发——body 命中 `/记账|支出|收入|借款|报销|发票|付款/` **或** `/\d+(?:\.\d+)?\s*(?:元|块钱?)/`，且未命中拜访词 `(拜访|拜会|电话|会议|沟通|走访|客户|医院|项目)` → `clarify("这段更像记账内容：直接发送「支出 …」即可记账；如果是拜访记录请以「记拜访：…」开头重发。")`。`记拜访：` 强前缀无条件进 capture（歧义逃生门）。这样"记一下：打车 50 元"→clarify，"记一下：今天拜访了日照中医医院，谈了预算 300 万"→capture（有拜访词豁免）。
2. **search vs 知识检索/拜访兜底**：search 正则要求句尾"记录"且满足 [时间词存在] 或 [主语非空且 ∉ {会议,电话,沟通,拜访,快速,历史}]。因此"会议记录"（无时间词、主语在排除表）继续走现状拜访兜底 collect，"上周的记录""日照的记录"进 search。裸"记录"被 L257 等值判断先命中（preview），不受影响。
3. **update/void 的"记录"关键词 vs v0.7.2 改档**：v0.7.2 改档B正则捕获 `(.{2,60}?)的?(名称|区域|…)` 不含"下一步/诉求/时间"等本设计字段词，且本设计正则要求显式"记录"词干（`(?:那条|这条|最近…)?记录`），两组正则互斥；插入顺序上 update/void 在 v0.7.2 写意图之前（先长词干后短词干），实施时以联合用例固化（5.2）。

### 1.3 解析正则（放 `router.js`，纯函数便于测试）

```text
capture：^(?:记一下|记录一下|帮我记(?:一下|录)?|快速记录|记拜访)\s*[:：]?\s*(.+)$   [s 标志，body 可多行]
         body 归一化后跑歧义门（规则1）；"记拜访"前缀跳过歧义门
search： ^(?:查一下|查查|查询|查)?\s*(上上周|上周|本周|这周|上个月|上月|本月|今天|昨天|前天|最近)?
         \s*(?:去|拜访)?(.{0,60}?)的?(?:拜访记录|快速记录|记录)\s*[?？]?$
         → { query: 主语||null, dateStart, dateEnd }（时间词→Asia/Shanghai 自然周/月/日区间；"最近"→近14天；均空→近14天）
update： ^(?:把|将)?(?:那条|这条|上一条|最近(?:一条|的)?)?记录\s*([A-Za-z0-9-]{6,64})?\s*的?
         (发生时间|时间|日期|客户|商机|诉求|反馈|风险|建议|下一步|待办)\s*(?:改成|改为|设为|更新为|换成)\s*(.+)$
         → { quickRecordId: ID后缀||null, field: 归一化字段名, value }
         字段映射：时间/日期/发生时间→occurredAt；客户→customerQuery；商机→opportunityQuery；
                   诉求→summary.request；反馈→summary.feedback；风险→summary.risk；建议/下一步/待办→summary.action
void：   ^(?:作废|删除|撤销)(?:那条|这条|最近的?)?记录\s*([A-Za-z0-9-]{6,64})?\s*$
```

- **口语时间**：新纯函数模块 `assistant/spokenDate.js`（3.6），capture 正文内的日期词（今天/昨天/前天/上周X/本周X/X月X日/N天前）解析为 `occurredAt = ${date}T12:00:00+08:00 → ISO`；解析不到 → null（执行时取 now，与现状一致）。update 的时间值同一解析器。
- **记录指代**：不带 ID 时（"那条/最近"），目标 = 该 owner **近 3 天内最新一条未作废记录**；预览卡展示原文摘要供核对（六位码确认本身即二次核对）；3 天内无记录 → clarify("最近三天没有可修改的记录，请发送「最近的记录」查看并使用记录编号。")。ID 后缀 ≥6 位，owner 内 `id LIKE '%'||suffix` 唯一命中，多命中 → clarify 列候选。**不扩展 businessContext 存 quickRecordId**（零迁移原则，开放问题 6.4）。

---

## 二、对话流与确认分级论证

### 2.1 风险分级论证（核心决策）

**新增记录用 R1 轻确认（回复"确认"），不用六位码**：
1. **写入性质**：追加型、非财务、不触碰既有实体（客户/商机仅唯一命中时挂 ID 引用，不改其字段）；错误可通过 update/void 全量修复——满足 R1"低风险普通写"定义。对比：六位码保护的场景是资金写入（R3 记账最终也没用六位码而用自然语言）与实体变更/删除（v0.7.2 R2/R3）。
2. **所见即所写**：轻确认发生在 AI 摘要卡之后，用户确认的就是卡上内容；旧三步流的六位码确认时用户面对的是"录入"指令而非最终内容，防误触价值更高。
3. **交互一致性**：记账（更高风险的财务写入）的确认词就是"确认"；拜访记录若要求六位码将出现"记 300 万预算的拜访免码、记 50 元打车要码"的倒挂。
4. **安全底线不降**：轻确认仍走 pending action 全套机制——单会话单 pending、10 分钟 TTL、"取消"可弃、执行租约单飞、audit 五段链（`assistant.action.*`）；确认词只在同一微信会话内有效（会话隔离与六位码等强，六位码额外防的"转发码到他会话"在 affirm 模式下无码可转）。
5. **回退成本**：若产品层否决，`policy.js` 一行改回 `explicit_code` 即回退全部行为（orchestrator 的 affirm 分支按 confirmation 值判定，天然失活）。

**改历史 = R2 六位码**：修改的是已落库业务记录（且分析文本可能已被周报/项目分析引用），语义等价 v0.7.2 客户改档。**作废 = R3 六位码**：不可见化一条历史记录（虽软作废可恢复），等价删档级别。

### 2.2 一步式记录（capture，轻确认）

```
用户：记一下：今天拜访了日照中医医院，张主任说十五五规划预算大概300万，
      担心移动云数据导出问题，下周要给他们出一版架构对比材料
（小小 typing ≤30s）
小小：【拜访记录待确认】
      时间：2026-08-28（今天）
      客户：日照中医医院 [服务端候选，待本人确认]（唯一命中则挂接）
      商机：日照中医医院十五五规划 [服务端候选]
      诉求：补齐本地数据中心健壮度…（AI 摘要，≤160 字）
      风险：预算路径未确认…
      建议动作：输出架构对比材料并同步商机
      候选校验：（仅当客户/商机不唯一或未命中时出现此行）
      ——
      回复"确认"写入系统，回复"取消"放弃；10 分钟内有效。
      写入后本条将自动进入本周周报素材；客户/商机档案不会被自动修改。
用户：确认
小小：已录入，记录 ID：…c7be21。
      已挂接客户：日照中医医院；AI 分析已保存。
      建议待办"输出架构对比材料"可在系统确认页写回客户/商机与待办。
      后续可发"最近的记录"查看，或"把那条记录的下一步改成…"修改。
```

异常分支：
- **回复六位数字**：`本操作无需确认码，回复"确认"写入，回复"取消"放弃。`（不进 confirm 尝试，**不累计错码计数**）
- **回复"重发确认码"**：重发摘要卡 + 同上引导（不换内部凭据）。
- **超时（>10min）后回"确认"**：`确认信息无效或已过期，请重新发起操作。`（pending 已 expired）
- **并发**：同会话已有待确认操作 → 现有 409 文案（orchestrator L584-588）。
- **正文为空**（"记一下："后无内容）：预览 provider block → `请把拜访、电话或会议内容跟在"记一下："后面一起发我。`

### 2.3 查历史（免确认）

```
用户：查一下上周去日照的记录
小小：找到 2 条记录（2026-08-18 ~ 08-24，关键词：日照）：
      1. 08-20 日照中医医院 ｜ 已分析 ｜ …c7be21
         十五五规划预算300万，移动云数据导出顾虑…（原文截 60 字）
      2. 08-22 （未挂客户） ｜ 已确认 ｜ …9d2c4a
         电话沟通灾备方案报价…
      发送"把记录 c7be21 的下一步改成…"可修改；"作废记录 9d2c4a"可作废。
```

- 零结果：`上周没有找到与"日照"相关的记录。可发送"最近的记录"查看全部。`
- \>5 条：展示前 5 + `共 N 条，请补充客户名或缩小时间范围。`
- 唯一结果且挂有客户 → `contextUpdate{customerId}` 写会话上下文（衔接 v0.7.2 画像问答"这个客户什么情况"）。

### 2.4 改/作废历史（六位码，复用 v0.7.2 预览卡链）

```
用户：把那条记录的下一步改成 周三前发对比材料给张主任
小小：【拜访记录修改待确认】…c7be21（08-20，日照中医医院，当前 v2）
      原文：十五五规划预算300万，移动云数据导出顾虑…（截60字）
      建议动作：输出架构对比材料并同步商机
              → 周三前发对比材料给张主任
      （原始拜访原文不可修改；如记录本身有误请作废后重记。）
      待确认操作：修改拜访记录分析
      确认码：……（六位数字，10 分钟有效；回复"取消"放弃，"重发确认码"换码）
用户：<六位码>
小小：已更新记录 …c7be21（v3）：建议动作已修改。
      注意：已进入周报草稿或已确认写回的内容不会自动回改。
```

作废流程同构，预览卡强提示：`该记录将不再出现在记录列表、周报素材与项目分析中；已确认写回客户/商机的内容不会回退。作废后可由管理员在数据库层恢复。`（audit `quick_record.void`）。修改"客户"字段时复用 customerAdapter 消歧（唯一/多候选 clarify/零命中 not_found，语义同 v0.7.2 §1.3）。**rawContent 设计为不可改**：原始口述是审计凭据与 AI 分析的输入基线，改原文=改证据；要改内容走"作废+重记"。

### 2.5 失败/超时兜底话术（AI 分析）

| 场景 | 行为 | 话术要点 |
|---|---|---|
| 模型超时/5xx/解析失败 | `analyzeQuickRecord` 内部 catch → fallback 分析照常出卡（source=fallback，候选降档） | 卡首行追加：`（AI 分析暂时不可用，以下为按原文整理的基础要点；写入后可在系统里重新分析。）`；确认后正常写入，insight.source 落 `mock_model_fallback`/`fallback` |
| 适配器层异常（罕见） | orchestrator `fail()` → 安全响应 | `处理失败，请稍后重试。`（现有 SAFE_FAILURE，事件标 failed，provider 重试幂等重放） |
| 用户等待期 | SDK typing 指示已有（10s 刷新） | 无需额外设计；不引入"稍后推送"异步链（0.4 结论） |
| 确认后执行时模型不可用 | capture 执行器 `reusableVisitRun` 优先复用预览阶段 run；复用失败才重分析，重分析再失败走 fallback | 用户无感，insight 记录真实 source |

---

## 三、技术方案

### 3.1 新增/修改文件清单（精确路径）

| 文件 | 新/改 | 内容 |
|---|---|---|
| `backend/src/quickRecords/quickRecordStore.js` | **新**（~200 行） | owner 限定的查/改/作废 SQL（3.2） |
| `backend/src/assistant/spokenDate.js` | **新**（~70 行） | 口语日期/区间解析纯函数（Asia/Shanghai） |
| `backend/src/assistant/router.js` | 改 | 1.3 四组正则 + `parseQuickRecordCaptureArgs/SearchArgs/UpdateArgs` 纯函数；插入位置见 1.2 |
| `backend/src/assistant/policy.js` | 改 | 4 条新 policy（1.1）；新确认级别常量 `affirm_language` |
| `backend/src/assistant/agentRegistry.js` | 改 | `TOOL_DEFINITIONS` 增 4 条（args schema：capture={rawContent required, occurredAt?}; search={query?, dateStart?, dateEnd?}; update={quickRecordId?, field required, value required}; void={quickRecordId?}） |
| `backend/src/assistant/agentManifest.js` | 改 | visit-capture manifest：tools +4、taskTypes +`history_search`/`change_preview`/`void_preview`、systemPrompt 补"历史修改必须六位码确认" |
| `backend/src/assistant/capabilityCatalog.js` | 改 | visit-capture 能力条目 mappings.tools +4、apis 补 `GET /api/quick-records`、description 更新 |
| `backend/src/assistant/orchestrator.js` | 改（~+35 行） | affirm_language 轻确认分支（3.3）；依赖 v0.7.2 已落的 pendingPreviewProviders |
| `backend/src/assistant/visitCaptureAssistantAdapter.js` | 改（小） | 无结构性改动；导出 `previewCardText(analysis, {occurredAt})`（把 runtimeHandlers.previewText 迁来共用并支持 capture 卡首行/尾行差异） |
| `backend/src/assistant/runtimeHandlers.js` | 改 | 4 个新 handler（3.4）+ 注入 quickRecordStore |
| `backend/src/assistant/quickRecordPendingPreviewProviders.js` | **新**（~160 行） | capture/update/void 三个预览 provider（3.5），工厂签名对齐 v0.7.2 `createCustomerPendingPreviewProviders` |
| `backend/src/server.js` | 改（小） | `pendingPreviewProviders` 注入点合并 quick-record providers（v0.7.2 已把该选项接入，本版做 `{...customerProviders, ...quickRecordProviders}`）；`PATCH /:id/analysis` 路由核心迁调 store（防双实现漂移，行为不变） |
| `CHANGELOG.md`、`docs/releases/v0.7.3.md`、`VERSION`、蓝图 E 行 | 改 | DoD 惯例 |

**零数据库迁移**：voided_at 三列已存在（0002），quick_records 已有 version；不新增表/列。

### 3.2 `quickRecordStore.js`（共享读写模块）

```js
export function createQuickRecordStore(db, { clock } = {}) => Object.freeze({
  // 查：owner 必填（调用方已 resolveBusinessOwner），LIKE 转义同 businessSnapshotAdapter.likePattern
  search({ owner, query, dateStart, dateEnd, limit = 6 }),
  //   SELECT qr.*, c.name AS customer_name FROM quick_records qr
  //   LEFT JOIN customers c ON c.id = qr.customer_id AND c.deleted_at IS NULL
  //   WHERE qr.owner=$owner AND qr.voided_at IS NULL
  //     AND ($start IS NULL OR date(substr(COALESCE(qr.occurred_at,qr.created_at),1,10)) >= date($start))
  //     AND ($end   IS NULL OR … <= date($end))
  //     AND ($pattern IS NULL OR qr.raw_content LIKE $pattern ESCAPE '\' OR c.name LIKE $pattern ESCAPE '\')
  //   ORDER BY COALESCE(qr.occurred_at, qr.created_at) DESC, qr.id LIMIT $limit+1  → {items, truncated}
  findByIdSuffix({ owner, suffix }),       // id LIKE '%'||suffix（suffix 白名单 ^[A-Za-z0-9-]{6,64}$，LIKE 通配转义）→ {item|items[]}
  latestEditable({ owner, withinDays = 3 }),
  getWithLatestInsight({ owner, id }),     // 记录 + 最新 insight（复刻 server.js getLatestInsightRow 排序）
  updateFields({ owner, id, expectedVersion, occurredAt?, customerId?, opportunityId?, actor, requestId }),
  //   版本守卫 UPDATE … SET …, version=version+1 WHERE id AND owner AND version=$expected AND voided_at IS NULL
  //   changes!==1 → 复查行→ NOT_FOUND / VERSION_CONFLICT（错误对象带 currentVersion，模式同 itinerary/repository.js:92-98）
  //   customerId/opportunityId 变更前跑关系校验（等价 server.js validateCustomerOpportunityPair 语义：活跃客户、商机属于该客户）
  updateInsightSummary({ owner, id, expectedVersion, summaryPatch, actor, requestId }),
  //   复刻 PATCH /:id/analysis 事务语义（quick_records 版本 bump + 最新 ai_insights.analysis_json 覆盖 summary.X.text，
  //   summary 结构完整性校验照搬 server.js:6571-6586 的 DATA_INTEGRITY_ERROR 分支）；Web 路由改调本函数
  void({ owner, id, expectedVersion, voidedBy, reason }),
  //   SET voided_at=$now, voided_by, void_reason, version=version+1 WHERE … AND voided_at IS NULL（首个 voided_at 写入点）
});
```

审计不在 store 内做（与 customerStore 决策一致），由 handler 统一 `insertAudit`。

### 3.3 orchestrator 轻确认增量（affirm_language）

复用 0.6 的内部派生凭据模式，新增模块内函数：

```js
function deriveAffirmCredential(secret, actionId) {
  const digest = createHmac("sha256", confirmationKey(secret))
    .update(`sentelligent/assistant-affirm-confirmation/v1\u0000${actionId}`, "utf8").digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}
```

三处改动（全部以 `registry.getTool(actionType)?.policy?.confirmation === "affirm_language"` 判定，对既有工具零影响）：
1. **创建**（isRisky 块，L568 起）：affirm 工具走同一分支，但 `actionId = randomUUID()` 先生成 → `code = deriveAffirmCredential(secret, actionId)` → `pendingActionRepository.create({ id: actionId, …, confirmationCode: code })`（create 已支持显式 id，记账在用）；`publicBody` 不含 confirmationCode 字段，文案用新 `safeAffirmPendingResponse(tool, { preview })`：预览卡 + `回复"确认"写入，回复"取消"放弃；10 分钟内有效。`；storedBody=publicBody（无码可洗，预览文本随事件存档——内容本就持久化在记录里，无敏感增量）。
2. **确认**：在 scopedCommand 判定（L435）**之前**加分支——`text.trim()==="确认"` 且存在 pendingAction 且其确认级别为 affirm_language → 重派生凭据，走与 kind==="code" 完全相同的 `confirm → claimExecution → handler → completeExecution` 链（代码路径合一，只是 code 来源不同）。**若 pendingAction 是码类工具**（explicit_code/simple），裸"确认"维持现状落 router（clarify"当前没有待确认的操作。"——不改，避免扩大回归面；开放问题 6.5 记录优化）。
3. **码类文本防误锁**：scopedCommand 分支内，pendingAction 为 affirm 工具且 kind∈{code,resend} → 直接 finish 引导文案（2.2），**不调 confirm() 不计错码**；kind=cancel 走现有取消。

安全不变量核对：凭据仅服务端派生与校验、从不出网；attempt 计数/锁定/TTL/租约/审计（`assistant.action.create/confirm/cancel/execute`）全部由 repository 原机制承担；"确认"文本进事件存档无敏感性。

### 3.4 runtimeHandlers 四个新 handler

- **`visit-capture.capture`(args, context)**：结构复刻既有 `visit-capture.confirm`（L1082-1200）差异三点——rawContent 来自 `args.rawContent`（不读 draft parts、不清 draft）；`occurredAt = args.occurredAt ?? now`；预览阶段 run 经 `reusableVisitRun`（conversation 维度，rawContent 相同即命中）复用。幂等：`recordId = context.actionId`（affirm pending 必有 actionId），已存在即重放回执。写入序列与审计与现状完全一致（INSERT quick_records `source_channel='微信助手'` → owner 回填 → audit `quick_record.create` → ai_insights → status='analyzed' → audit `quick_record.analyze`，metadata 增 `{source:"weixin-assistant", actionId}`）。回执文本见 2.2。
- **`visit-capture.search`(args, context)**：`owner = resolveBusinessOwner(context.owner)`，为空 → `当前账号未绑定业务负责人，无法查询记录。`；`store.search` → 2.3 卡片（状态字典 recorded=待分析/analyzed=已分析/confirmed=已确认）；唯一结果带 customerId → `contextUpdate`。
- **`visit-capture.update`(args, context)**：args 已被预览 provider 钉死为 `{quickRecordId(全 ID), expectedVersion, changes}`；`changes.summaryPatch` → `store.updateInsightSummary`（audit 沿用 **`quick_record.analysis.update`**，与 Web 同名聚合）；`changes.fields`（occurredAt/customerId/opportunityId）→ `store.updateFields`（audit 新 action **`quick_record.update`**，entityType quick_record，before/after 为字段快照）；VERSION_CONFLICT → `这条记录刚在其他端被修改，本次未写入。请重新发起修改。`；重复执行由 claimExecution 重放 + expectedVersion 双保险。
- **`visit-capture.void`(args, context)**：`store.void` → audit 新 action **`quick_record.void`**（metadata 含 reason="weixin-assistant-void"、原 status、是否已 confirmed）；回执 2.4。

### 3.5 预览 providers（`quickRecordPendingPreviewProviders.js`）

工厂 `createQuickRecordPendingPreviewProviders({ visitCaptureAdapter, store, resolveBusinessOwner, clock })` 返回三键对象，签名与返回结构对齐 v0.7.2（`{block,status,bodyStatus,text} | {arguments, previewText, previewSummary}`）：

- 公共门（三者同）：`serverData.auditMetadata.chatType !== "direct"` → block(`拜访记录的写入与修改仅支持与小小的私聊。`)；`resolveBusinessOwner(owner)` 为空 → block(`当前账号未绑定业务负责人。`)。
- **capture**：正文空 → block（2.2 文案）；`await visitCaptureAdapter.analyze({taskType:"preview", rawContent, occurredAt, sourceChannel:"微信助手", businessContext})`（模型 ≤30s 发生在此处，provider 为 async——v0.7.2 编排器实现为 `await previewProvider(...)`，天然支持）；产出 `previewText`（2.2 卡）+ `arguments:{rawContent, occurredAt}`。分析结果**不塞进 arguments**（20KB payload 上限与 contracts 字符串校验风险），执行时靠 reusableRun 复用。
- **update**：定位目标（ID 后缀唯一化 / latestEditable）→ 零命中 not_found、多命中 clarify 列候选；`field=客户/商机` 时用 customerAdapter/snapshotAdapter 消歧（唯一命中才钉 ID）；产出 before→after 预览卡（2.4）+ `arguments:{quickRecordId, expectedVersion, changes}`；before==after → block(`内容与现有分析一致，无需修改。`)。
- **void**：定位同上；预览卡含原文摘要、状态、是否已确认/已进周报窗口的提示行；`arguments:{quickRecordId, expectedVersion}`。

`server.js` 注入：`pendingPreviewProviders: { ...createCustomerPendingPreviewProviders(...), ...createQuickRecordPendingPreviewProviders(...) }`。

### 3.6 spokenDate 模块

`resolveSpokenDate(word, now)` / `resolveSpokenRange(word, now)`：基于 `Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"})`（模式照搬 `businessSnapshotAdapter.js:8-17,128-145` 的周起算），支持 今天/昨天/前天/上周/上上周/本周/这周/上月/上个月/本月/最近(14天)/上周X/本周X/X月X日/N天前；返回 `{date}` 或 `{start,end}`（YYYY-MM-DD）。实施时评估 `integrations/shortcutBookkeepingIntent.js` 的 friendlyDates 实现可否直接抽出共用；不可则独立实现并在两处注释互指。

### 3.7 幂等、审计与安全汇总

- **幂等**：入站事件 sourceMessageId 去重（现有）；capture 以 actionId 为记录主键（重试不重复建记录）；update/void 靠 claimExecution 租约重放 + expectedVersion 兜底；search 无副作用。
- **审计命名**：`quick_record.create/analyze`（沿用）、`quick_record.analysis.update`（沿用同名，Web/微信聚合）、`quick_record.update`（新）、`quick_record.void`（新）；来源区分 `metadata.source="weixin-assistant"` + actionId + requestId；确认链 `assistant.action.*` 五段自动成链。v0.7.1 的"记账实时日志"面板若按 action 白名单过滤，可顺带把 `quick_record.*` 纳入观察（非本版必做）。
- **越权面**：写/改/作废仅 direct 私聊 + 发送者白名单（HTTP 边界既有）+ owner 闭合解析；工具参数禁 owner/actor；ID 后缀查询 owner 限定（跨 owner 后缀撞库只会 not_found）。
- **contracts 路径守卫边界**：rawContent 以文件名结尾（如"…方案.pdf"）会被 `looksLikePath` 拒为 unsafe_path → 安全响应。这是 visit-capture.collect 的既有行为（同一校验），非本版新增风险；capture 的 clarify 文案不承诺支持文件名结尾文本（风险 6.1-5）。

---

## 四、与 v0.7.2 的依赖清单与漂移点

**必须先落地的 v0.7.2 机制**（本设计直接消费，不重复实现）：

| 依赖 | v0.7.2 设计位置 | 本设计消费点 |
|---|---|---|
| D1 `pendingPreviewProviders` 编排器钩子（含 `safePendingResponse` preview 段、`重发确认码` 带回预览） | v0.7.2 §3.4 | update/void 六位码预览卡；capture 的 affirm 预览也经同一钩子出卡 |
| D2 `handlePending` 两条让路早退 | v0.7.2 §3.6 | 记账草稿并存时：capture 意图文本、六位码、"确认"、"取消"能到达通用边界（0.3 已证现状会被劫持/吞码） |
| D3 customerAdapter 消歧语义（唯一采用/多候选 clarify/不得按相似度擅选） | v0.7.2 §0.2/§3.4 | update 改"客户/商机"字段的消歧 |
| D4 `createAssistantToolHandlers({customerAssistantAdapter})` 显式构造 + server.js 注入点 | v0.7.2 §3.4 server.js 段 | providers 合并注入的落点 |

**依赖漂移点**（v0.7.2 实施若有调整，本设计需同步刷新的部位）：

1. **D1 签名漂移**：provider 入参/返回键名（`block/text/arguments/previewText/previewSummary`）如有更名 → 3.5 全部 provider 与 3.3 的 `safeAffirmPendingResponse` 拼装点同步改。若 v0.7.2 最终实现不支持 async provider（设计稿为 `await`，应支持）→ capture 的模型调用必须移回 handler 侧、预览卡降级为"无分析的原文卡"，对话流 2.2 需重排——**实施前第一件事核对该点**。
2. **D2 条件漂移（高危）**：v0.7.2 §3.6 第二条早退把 `text === "确认"` 列为 bookkeepingLanguage（不放行）。该条件与本设计兼容的前提是**第一条早退先命中**（存在非记账 pending 且未引用记账草稿 → return null）——capture 的 affirm pending 属"非记账 pending"，因此"确认"会被第一条早退放行给通用边界，判定顺序不能反转。若 v0.7.2 实施时把第一条早退收窄为仅 `customer.*` 类 pending（按 actionType 白名单），必须把 `visit-capture.*` 一并纳入。回归用例（5.2 T-BK-1/2）固化：记账草稿 + capture pending 并存时，未引用"确认"→capture 写入；引用记账草稿"确认"→记账入账。
3. **D3 漂移**：若 v0.7.2 给 changePreview 填充 expectedVersion 的方式改为快照层投影 version，本设计 update 的 expectedVersion 取数点（store.getWithLatestInsight）不受影响（quick_records 自己的 version），无需跟改；仅当 v0.7.2 调整"多候选 clarify 文案模板"时统一文案。
4. **蓝图 C 段（v0.7.1）漂移**：若记账实时日志的审计轮询按 action 前缀过滤（`bookkeeping.*` 等），`quick_record.update/void` 不会出现在该面板，符合预期；若实现为全量流则自动可见，无需改动。

---

## 五、测试面（`backend/tests/`，node:test + assert/strict 惯例）

### 5.1 新增文件

| 文件 | 用例要点 |
|---|---|
| `quick-record-store.test.js` | search：owner 隔离、LIKE 转义（`%_\` 注入）、日期边界（occurred_at 空回退 created_at）、voided 排除、truncated；findByIdSuffix 唯一/多命中/跨 owner 不命中；updateFields 版本冲突 409 语义与 currentVersion、客户商机关系校验拒绝；updateInsightSummary 复刻 PATCH 语义（无 insight→not_found、summary 结构损坏→DATA_INTEGRITY）；void 首次写 voided_at 三列、重复 void 冲突、void 后 search/latestEditable 不可见 |
| `assistant-spoken-date.test.js` | 全词表 × 周界/月界/跨年样例（Asia/Shanghai 口径）；非法词返回 null |
| `assistant-quick-record-runtime.test.js` | capture handler：actionId 幂等重放、resolveQuickRecordLinks 唯一命中挂接/冲突弃商机、audit 两条 metadata.source、source_channel='微信助手'；search handler：owner 未绑定文案、contextUpdate；update/void handler：audit action 命名、版本冲突文案、summary 与 fields 双分支 |
| `assistant-quick-record-http-integration.test.js`（模式抄 `assistant-http-integration.test.js`，`confirmationCodeFrom` L49-53） | 端到端：`记一下：…`→affirm 卡（断言响应体**无 confirmationCode 键**、文本无六位数字）→"确认"→写库+audit 链→回执；"取消"路径；TTL 拨过 10min→410 文案；affirm 下发六位数字→引导文案且 pending 不锁定（连发 6 次仍可"确认"）；`查…记录` 免确认；update 全链（六位码、错码×5 锁定、换码）；void 全链；群聊事件写意图被拒；capture 后记录出现在销售周报预览素材（source_channel 联动） |

### 5.2 扩展既有文件

| 文件 | 用例要点 |
|---|---|
| `assistant-router.test.js` | 1.3 四组正则正反例：`记一下：打车50元`→clarify、`记一下：今天拜访…预算300万`→capture、`记拜访：打车50`→capture（逃生门）、`会议记录`→仍 collect 兜底、裸`记录`→仍 preview、`上周去日照的记录`/`最近的拜访记录`→search 参数断言、update 字段映射全表、`记一下：本周销售周报`不吞周报意图（前缀在最前的副作用核对）、与 v0.7.2 改档正则互斥联合用例 |
| `assistant-policy.test.js` | 4 条新 policy risk/confirmation；affirm_language 的 requiresConfirmation=true |
| `assistant-registry.test.js` / `assistant-agent-manifest.test.js` / `capability-catalog.test.js` | 工具注册、manifest tools/taskTypes、能力目录断言更新 |
| `assistant-orchestrator.test.js` | affirm 分支：创建（storedBody==publicBody、无码）、"确认"执行与结果重放、派生凭据错 actionId 不命中、码/重发引导文案不计 attempt、cancel、码类 pending 下裸"确认"仍走 router 现状；provider 抛错→fail 安全响应 |
| `shortcut-bookkeeping-assistant.test.js` / `shortcut-bookkeeping-safety.test.js` | T-BK-1：记账草稿(已送达)+capture affirm pending 并存，未引用"确认"→handlePending 返回 null（依赖 v0.7.2 D2）；T-BK-2：同场景引用记账草稿"确认"→记账入账；T-BK-3：记账草稿并存时`记一下：…`文本不被隐式劫持 |
| `weixin-agent-http-integration.test.js` | 真实事件端点：capture 轻确认全链 + 记账草稿并存冒烟 |
| `api.test.js`（或 `confirm-transaction.test.js`） | `PATCH /:id/analysis` 迁 store 后行为不变回归（If-Match 428/409、summary 校验、audit） |

门禁：后端全量 + 前端 qa:local + Chrome/WebKit 集成 + 密钥扫描 + 根 test:deploy（DoD 固定项）。

---

## 六、风险与开放问题

### 6.1 风险

1. **affirm_language 是新确认级别**，触碰编排器确认边界（全渠道共用）。缓解：分支全部以 confirmation 值门控、既有工具零路径变化；orchestrator 扩展用例 + http 集成全链兜底；一行 policy 可回退为六位码。
2. **capture 前缀正则放 naturalPlan 最前**，理论上可截胡未来更高优意图。缓解：前缀词表窄（记一下/记录一下/帮我记/快速记录/记拜访）、歧义门把记账样文本 clarify；router 测试固化"不吞周报/记账"。
3. **D2 依赖协同**（4.2）：v0.7.2 让路守卫的条件顺序决定"确认"归属，若两版实施并行需以 T-BK 用例作为集成合同，谁后合入谁跑通该组用例。
4. **预览 provider 内做模型调用**（capture）：确认卡生成路径引入 ≤30s 外呼，pending create 前的异常会走 `fail()`（安全响应）而非 fallback 卡——设计要求 provider 内部 catch 后仍产出 fallback 预览（2.5），实施时注意 provider 不向编排器抛模型错误。
5. **contracts 路径守卫**会拒绝以文件名结尾的 rawContent（0.3/3.7）：既有行为，不修；release notes 说明"记录文本请勿以文件名结尾"。若实际投诉，后续版本在 capture 解析层对正文尾部文件名做空格包裹归一化（1 行）。
6. **search 全文 LIKE 无索引**：quick_records 量级为个人销售记录（生产 <10^4），OR LIKE 全扫可接受；`idx_quick_records_status` 已有。若未来量级上升，加 `(owner, occurred_at)` 复合索引（一次迁移，不阻本版）。
7. **update 修改已确认记录的分析**不会回滚既有深写回（客户 needs/风险、action_items 标题）：预览卡与回执双提示（2.4），审计可追。语义上"分析修订不追溯派生物"与 Web 现状一致（Web 改 analysis 也不回改已确认写回）。

### 6.2-6.6 开放问题（默认取保守方案，不阻塞实施）

2. **旧三步流（collect/记录/录入）是否退役或降级为轻确认**：本版原样保留（六位码），双流并存一个版本观察使用占比；建议 v0.7.6 前决策（退役可删 ~120 行 handler + 路由三项）。
3. **微信端是否开放深写回（quick_record.confirm 的 customer/opportunity/weekly 同步）**：本版不做（0.2 现状 writebackAllowed:false 的边界维持；capture 回执引导去系统确认页）。若产品要做，方案为把 `server.js:6760-6997` confirm 事务核心抽 `quickRecords/confirmQuickRecord.js` 共享 + 新工具 `visit-capture.sync`（R2 六位码，targetVersions 由预览 provider 钉死）——工作量约 1.5 人日，建议并入 v0.7.5（商机 agent 需要同款抽取）。
4. **"那条记录"指代是否引入会话级 quickRecordId 上下文**：本版用"近 3 天最新一条 + 预览核对"启发式（零迁移）；若误指率高，v0.7.4+ 扩展 `assistant_business_context` 增列（一次迁移 + orchestrator contextUpdate 扩展）。
5. **码类 pending 下裸"确认"的引导**：现状回"当前没有待确认的操作。"（0.3），体验瑕疵但非本版回归面；可在 v0.7.4 顺手改为"请回复六位确认码"（orchestrator 3 行）。
6. **void 是否连带隐藏派生 action_items/risk_items**：本版不动派生记录（独立生命周期，预览卡已提示）；若产品要求联动，store.void 内按 source_record_id 软删（各 +3 行 SQL + audit）。
7. **Web 端补作废按钮/检索框**：后端能力（store + voided 过滤）本版就绪，Web UI 并入 J 阶段（v0.8.1 视觉统一）。

---

## 附：实施顺序建议（单人 ~3 人日）

1. spokenDate + quickRecordStore + 单测（0.5d，无依赖可先行）
2. policy/registry/manifest/catalog + router 正则 + 单测（0.5d）
3. orchestrator affirm 分支 + 单测（0.5d，核对 D1 实际签名）
4. providers + handlers + PATCH 路由迁 store（1d）
5. http 集成 + 记账并存回归 + 门禁全绿（0.5d）
