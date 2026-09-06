# v0.7.4 智能待办 + 到点提醒 实施设计（调研定稿）

> 产出：2026-08-28 · 只读调研，未改代码。实施对应总蓝图 F 阶段（`docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md`：自然语言识别（时间/对象/优先级）→ action_items（owner 扩展）→ 到点小小提醒（复用 outbox + 轻量调度））。
> 前置：v0.7.2 已上线（本文引用其**已落地代码**）；v0.7.3 正在另一进程实施。**调研开始时本工作树 HEAD=668aa04、`git status` 干净；调研结束时 v0.7.3 已开始落入未提交改动**（观测到：`spokenDate.js`/`quickRecords/` 新增，`policy.js` 已含 `visit-capture.capture = R1/affirm_language` 等四条新 policy，router/registry/manifest/catalog 已改；orchestrator 的 affirm 分支尚未观测到）。第四章依赖清单按"落地中"现实编写，**实施 v0.7.4 前必须以 v0.7.3 冻结提交重核 D1/D2**。
> 行号声明：文中行号以调研时（改动落入前的）工作树为准，v0.7.3 合入后 `router.js`/`policy.js`/`agentRegistry.js`/`runtimeHandlers.js`/`server.js` 必然漂移，实施时以语义定位。

---

## 零、现状调研结论（全部来自源码，实施前必读）

### 0.1 action_items 实体现状

**表结构**：`backend/src/schema.sql:115-130` + 迁移 0002 补 `version`（乐观锁）、`deleted_at/deleted_by`（软删）。字段：

| 列 | 现状语义 | v0.7.4 相关结论 |
|---|---|---|
| `id` TEXT PK | randomUUID | ID 后缀指代可复用 v0.7.3 记录指代设计 |
| `customer_id` / `opportunity_id` | FK，ON DELETE SET NULL，均可空 | 挂接外键已齐备，无需新列 |
| `title` NOT NULL / `customer`（冗余客户名）/ `reason` | 文本 | title≤500（actionPatch 校验） |
| `due` TEXT | **人读自由文本**：seed 数据为"今天 18:00""周一上午""周五 17:00"（`seed.js:104,117,172`）；深写回硬编码"待确认"（`server.js:1873`）；actionPatch 限 ≤50 字 | **不可用作调度时间源**，机器时间必须新列（3.5） |
| `assignee` TEXT | 人名；深写回硬编码"继振"（`server.js:1874`）；Web 编辑默认"继振" | 是"显示负责人"，**不是账号 owner** |
| `priority` | '高'/'中'/'低'，默认'中' | 自然语言"重要/紧急"映射高 |
| `status` | `pending/in_progress/done/deferred`（`server.js:1035`） | 完成=done、推迟=deferred 语义现成，**零状态机改动** |
| `source_record_id` | UNIQUE → quick_records | 微信新建待办**不占用**此列（保持 NULL），避免与快速记录深写回幂等键冲突 |
| **无 `owner` 列** | — | 蓝图"owner 扩展"的迁移点（3.5） |

**API（`server.js`）**：`GET /api/actions`（L6022-6033，全量列表**无 owner 过滤**，priority 排序）、`PATCH /api/actions/:id`（L6035-6065，If-Match 乐观锁 `parseExpectedVersion` L1103-1116 → 428/409；schema `actionPatch`＝`validation/requests.js:228-232`：title/reason/due/assignee/priority/status/tone；审计 `action.update`）、`DELETE /api/actions/:id`（L6067-6083，`softDeleteRecord` 通用软删，审计 `action.delete`，entityType `action`）。**没有 POST 创建端点**——全库唯一创建路径是 quick_record confirm 深写回 `upsertActionFromQuickRecord`（L1862-1931）：按 `source_record_id` 幂等 upsert，due="待确认"、assignee="继振"、priority=有风险文本则'高'、tone red/blue；软删后再 confirm 会复活（`deleted_at=NULL` + 重置 due/assignee/status）。

**消费方**：① 战情总览 openActions 计数（L819-824，status!=='done'）；② `getDraftActions`（L1933-1947，按客户/商机挂接）喂周报预览（L2436）与方案草稿（L7130）——**新建待办若挂了客户/商机会自动进入这两处素材，设计上属预期增益，无需改动**；③ 小小侧 `businessSnapshotAdapter.actionRows`（下节）。

**actionRows 的 owner 语义（本版最关键的现状缺口）**：`businessSnapshotAdapter.js:295-333`——owner 过滤完全靠 join：有 opportunity_id 时要求 `opportunity.owner=$owner`（或商机 owner 空时客户 owner），仅有 customer_id 时要求 `customer.owner=$owner`。因此 **customer_id 与 opportunity_id 双空的"独立待办"对小小永远不可见**；且生产存量客户 owner ≠ `WEIXIN_AGENT_OWNER`（v0.7.2 发布文档"只读数据体检"实测记录），挂在该客户下的待办同样不可见。"提醒我周五前给王工送方案"这类不挂客户的待办是本版主场景 → **owner 列 + 查询分支扩展是硬需求**。此外 actionRows 只回 `pending/in_progress/deferred`（done 排除）、due 原样返文本、LIMIT 100+truncated。

**微信侧已有查询**：`action-risk` agent（R0 `action-risk.summary`，policy.js:15）+ `actionRiskAssistantAdapter.js`（纯确定性、无模型；taskTypes 含 `follow_up_preview/status_change_preview` 但 manifest 明示"行动和风险写入工具尚未开放"，changePreview 仅支持 status/due/priority 三字段预览、`writebackAllowed:false`）。router 入口：别名"动作风险"（router.js:292）、正则 `^(?:动作风险|行动风险|风险动作)(?:摘要)?$`（L384）、口语句式 `^(?:(?:这个|当前|该)?(?:项目|商机|客户)?(?:还有哪些|…)?(?:跟进动作|待办|行动|风险|下一步))$`（L392-400，**裸"待办""有什么待办"今天已路由到 summary**）。handler 输出卡片（runtimeHandlers.js:1175-1201）：动作/风险各取前 3 条。

**Web 端**：`outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx` `ActionsPage`（L2354 起）：list/detail/edit 三视图；状态四态按钮 + due/assignee 自由文本输入 + 删除 confirm 弹窗；`actionStatusMeta` L2347-2352。**Web 端本版不动**（owner/remind_at 列对 Web 透明；`actionFromRow` L734-753 增投影字段即可让前端后续按需展示）。

### 0.2 调度器现状与差距评估

**招标调度器**（`hospitalTender/scheduler.js`，v0.7.0 上线）关键机制：

1. **定时形态**：`setTimeout` 链（`scheduleNext` L197-229 → `runNext` → finally 再 `scheduleNext`；`timer.unref?.()`），非 setInterval；delay = `max(minimumDelayMs, nextRunAt - now)` 且 cap 2^31-1。
2. **持久化**：状态全量落 `hospital_tender_scheduler_state` 单行表（迁移 0016，`id=1 CHECK`；0026 加 `active_start_hour/active_end_hour` 默认 9/20），含 enabled/interval_minutes/cursor/cycle 计数/last_* 全景/`next_run_at`；`schedulerRepository.updateState` 白名单键 + 校验。**重启恢复**＝`start()` 读 `nextRunAt` 重排 timer。
3. **互斥**：`hospital_tender_scheduler_lock` 单行租约（`tryAcquireLock` UPDATE WHERE `locked_until<=now`，lease 15min，L337-355）。
4. **窗口**：`activeWindowWaitMs`（scheduler.js:57-72）固定 UTC+8 偏移计算上海小时，窗外 → `lastStatus='waiting'` + `nextRunAt=下一窗口起点`；`runNext({force:true})` 绕过窗口与 nextRunAt（手动触发用）。fail-open：窗口参数损坏时返回 0（继续采集）。
5. **装配**（server.js:2606-2629）：`createServer` 内构建，`config.hospitalTenderAutoRun`（生产默认 true）且 `options.hospitalTenderSchedulerEnabled !== false` 才 `start()`；测试通过 `options.hospitalTenderSchedulerClock` 注入时钟；`server.close` 时 `stop()`（L7285）。
6. **管理面**：`GET /api/hospital-tenders/scheduler(/status)`、`POST …/run-next`（force）、`PATCH …`（enabled/interval/batch/窗口 → stop/start 重排）、`GET …/runs`（L4029-4144）。
7. **测试模式**（`tests/hospital-tender-scheduler.test.js`）：固定 clock 注入（`() => new Date("2026-08-17T00:00:00.000Z")`）+ **直接 `await scheduler.runNext({force:true})` 手动 tick（不启 timer）** + 计数器 idFactory + tmpdir SQLite；窗口用例以 UTC 时刻断言 `status=waiting/reason=window/nextRunAt` 精确值（L547-576）；并发用 pending-promise 挂起 runner 后二次 runNext 断言 `skipped/locked`（L535-544）。

**outbox 推送机制**（`weixin/outboxRepository.js` + 迁移 0019）：`weixin_confirmation_outbox` 表，`enqueue({owner, conversationId, idempotencyKey, payload})`——`UNIQUE(owner, idempotency_key_hash)`，同键同内容 → `replayed:true` 不重复入队，同键异内容 → 409（幂等防重炸的根）；payload ≤20KB、键名禁 `confirmation/code/token/secret/credential/password/authorization/owner/actor/identity/account/source/idempotency`（L7,52-56）。状态机 `queued→processing(30s lease)→sent/failed`，失败 2s 指数退避重试 ≤8 次；`leaseNext` 只取 `available_at<=now`（**schema 天然支持未来 available_at，但 enqueue 现固定 now**）。渲染在服务端：HTTP 出箱路由（server.js:3139-3141）把 `shortcutBookkeepingAssistantRuntime.renderOutboxMessage` 传入 leaseNext，该函数按 **`payload.kind` 分发**（shortcutBookkeepingRuntime.js:1217-1222：`hospital_tender_notice` → `renderHospitalTenderNoticeMessage`；`shortcut_advance_allocation`；默认记账草稿）——**新增提醒消息＝新增一个 kind 分支，零结构改动**。

**weixin-agent 服务边界**：SDK worker 独立进程（`weixin/worker.js`），入站消息 POST `/api/integrations/weixin-agent/events`；出站**只有** outbox 泵（`outboxWorker.js` 5s 轮询 `config.weixinOutboxPollMs`，默认 5000ms）：GET 出箱路由带 readiness 头（worker 掉线/未绑定 → 服务端 204 不租约，消息滞留 queued，**离线不丢**）→ `bot.sendMessageTo(绑定私聊 senderId)` → ack。投递范围锁定记账绑定私聊（`authorizeDelivery=isShortcutBookkeepingDeliveryScope`，worker.js:140-163、175-178）；招标通知已复用该通道（`hospitalTender/weixinNotifier.js:99-166`：`resolveOwner=() => runtime.owner`、`resolveConversationId=() => runtime.conversationFor(owner)`，server.js:2580-2592）。**待办提醒完全照搬招标的接线**。

**差距评估（核心裁定输入）**：招标是"周期批处理"（60min 间隔 + 客户游标 + 快照三表状态机），待办提醒是"到点触发"（分钟级、无游标、无快照）。待发送集合本身就持久化在 action_items 表（`remind_at<=now AND reminded_at IS NULL`），**表即队列，调度器不需要自己的状态表**；幂等由 outbox 唯一键 + `reminded_at` 标记双保险；重启恢复＝重启后第一次 tick 自然扫到。因此**不复制招标三表模式，新建轻量 timer 循环**（论证见 2.1）。

### 0.3 时间解析现状

**全库没有可复用的中文相对时间/时刻解析器**，只有三处零件：

1. `travelExpense/ingestionAnalysis.js:65-86`：`X年X月X日`/`X月X日`/`今天|昨日|昨天|前天` → date-only（**UTC 口径**，且只有过去向词汇，无"明天"）。
2. `integrations/shortcutBookkeepingAssistant.js` `friendlyDateValue`（L174-219）：ISO / `HH:MM`（取当前记录日期）/ `X年X月X日` / `X月X日` → `${date}T12:00:00+08:00`；**无任何相对词**（记账纠错场景专用，`parseShortcutBookkeepingCorrection` 经 `friendlyDates` 选项启用）。
3. `businessSnapshotAdapter.js:8-17,123-145`：`Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"})` 业务日/ISO 周一起算（周报口径）——**Asia/Shanghai 正确口径的唯一现成范式**。

v0.7.3 设计的 `assistant/spokenDate.js`（该设计 §3.6）调研开始时不存在、**调研结束时已以未提交改动落入**（前言）；实测词表为 今天/昨天/前天/上上周X/上周X/本周X/X月X日/N天前 + 区间词——**全部是"过去向"记录场景词，没有 明天/后天/下周X/时刻（上午十点、14:30）/截止语义（周五前）**。结论不变：v0.7.4 需要新建"未来向 + 时刻 + 截止"解析层 `spokenTime.js`（3.4），并复用 spokenDate 的周界/Intl 工具（4.1-D2 给出导出方案）。

### 0.4 提醒语义要素现状

- **去重**：无任何"提醒已发"标记 → 迁移加 `reminded_at`（3.5）；outbox 幂等键（`action-reminder:{actionId}:{remindAtEpoch}`）为第二道防线——即使 `reminded_at` 写失败重扫，enqueue 也只会 `replayed:true`，**结构性防重复轰炸**。
- **稍后提醒/顺延**：status 已有 `deferred`；顺延语义＝改 `remind_at` + 清 `reminded_at`（+ due 文本同步更新），零新列。
- **回复闭环**：提醒卡是 outbox 主动推送，用户回复是全新入站事件——**不能**依赖 pending action（10min TTL、单会话单 pending 会阻塞其他操作，`pendingActionRepository.create` L193-198 的 409 约束）。指代靠"提醒卡携带 ID 后缀 + 完成/推迟语式引用"（1.4）。`assistant_business_contexts`（迁移 0023）只有 customer/opportunity 列，**不为 todo 扩列**（零迁移面最小化，对齐 v0.7.3 开放问题 6.4 的裁定）。
- **时区**：存储统一 UTC ISO（outbox/调度比较均字符串 ISO）；解析组装用 `+08:00` 后缀（`friendlyDateValue` 惯例）；免打扰窗口若需判断，复制 `activeWindowWaitMs` 的固定偏移法或 snapshotAdapter 的 Intl 法。
- **重启恢复**：`remind_at<=now AND reminded_at IS NULL` 的行重启后首 tick 即扫到；已入 outbox 未投递的行由 worker 恢复投递。**宕机跨越提醒点不丢，但可能迟到**——迟到超过阈值（24h）时卡片标注"（过期提醒）"，见 2.4。

### 0.5 编排器与确认机制现状（v0.7.2 已落地）

- `orchestrator.js` 已有 `pendingPreviewProviders` 钩子（L308,581-608：async provider、`block/text/bodyStatus/status` 阻断、`arguments` 钉参、`previewText/previewSummary` 出卡、preview 随"重发确认码"重发 L488-497）；`server.js:2911-2915` 注入 `createCustomerPendingPreviewProviders({adapter, db, resolveBusinessOwner})`——v0.7.4 的 providers 合并注入到同一对象。
- 确认级别现状：`policy.js` 提交态只有 `none/simple/explicit_code/explicit_language`（simple 与 explicit_code 在编排器行为相同——`isRisky` 只看 requiresConfirmation）；**affirm_language（轻确认"回复确认"）来自 v0.7.3 设计 §3.3——调研末已见其 policy 条目落入未提交工作树，orchestrator 分支未见**（前言、4.1-D1）。v0.7.4 的建待办/完成/推迟依赖它。
- `handlePending` 让路守卫（v0.7.2 已落，shortcutBookkeepingRuntime.js:2253-2274）：guard1——存在非记账 pending 且未引用记账草稿 → return null 放行；guard2——无引用/无 pendingActionId/非记账语言/无媒体 → return null。"提醒我…""今天有什么待办""完成待办…"均非记账语言（`parseShortcutBookkeepingIntent` 的 CONFIRM/CANCEL/CORRECTION 词表不含），**即使记账草稿活跃也会被 guard2 放行到 router**；轻确认词"确认"依赖 guard1 先命中（与 v0.7.3 D2 同一合同，4.1-D1）。
- 事件链：worker → POST `/api/integrations/weixin-agent/events`（server.js:3209-3318）→ 机器鉴权 + 白名单 + `conversationScope`（绑定私聊时=记账会话 ID）→ `orchestrator.handle` 同步响应顶层 text 即回复。
- 审计：`insertAudit(db, {action, entityType, entityId, actor, requestId, before, after, entityVersion, metadata})`（`audit/auditRepository.js:51`），actor 必填非空。

---

## 一、意图设计

### 1.1 agent 与工具（零新 agent，复用 `action-risk`）

`action-risk` agent 的注册描述"查询行动和风险并给出处理建议；状态变更或删除必须先展示变更并确认"（agentRegistry.js:18）与待办语义完全吻合，复用之（对齐 v0.7.2 复用 customer、v0.7.3 复用 visit-capture 的先例）。新工具五个，全部确定性正则解析、不经模型，owner 由服务端上下文注入（contracts 层禁 owner/actor 键）：

| 工具 | 风险/确认 | 触发语式（示例） | 说明 |
|---|---|---|---|
| `action-risk.create` | **R1 / `affirm_language`（轻确认）** | `提醒我周五前给王工送方案`、`待办：下周三上午十点约张主任复访`（裸"待办"前缀必须带冒号）、`新建待办 …` | 解析时间/对象/优先级 → 预览卡 → 回复"确认"写入 |
| `action-risk.list` | R0 / none 免确认 | `今天有什么待办`、`本周待办`、`明天的待办`、`我的待办` | owner 限定 + 时间窗过滤，≤8 条卡片 |
| `action-risk.complete` | **R1 / `affirm_language`** | `完成待办 a1b2c3`、`待办 送方案 完成了`、`办完了待办 给王工送方案` | status→done |
| `action-risk.defer` | **R1 / `affirm_language`** | `把待办 a1b2c3 推迟到明天上午`、`待办 送方案 顺延到下周一` | remind_at/due 更新 + 清 reminded_at + status→pending（deferred 语义见 1.5） |
| `action-risk.delete` | **R2 / `explicit_code`（六位码）** | `删除待办 a1b2c3`、`取消待办 送方案` | 软删（deleted_at），复用 Web 同款语义 |
| 既有 `action-risk.summary` | R0 / none（不动） | `动作风险`、裸`待办`/`有什么待办` | 原样保留，避免回归（1.3 规则 3） |

**风险分级论证**（蓝图问句"建待办 R1? 完成 R1? 删除 R2?"）：

- **create=R1 轻确认**：追加型写入、不碰既有实体、错误可通过 defer/delete 全量修复——满足 R1 定义；但**不免确认**，因为中文时间解析是本版最大错误面（"周五前"解析成哪天必须让用户所见即所写地核对），预览卡展示解析结果正是确认的价值所在。与 v0.7.3 capture 的 R1/affirm 论证同构：更高风险的记账（R3 财务）确认词就是"确认"，待办要求六位码会出现风险倒挂。
- **complete/defer=R1 轻确认**：状态翻转/时间顺延均可逆（Web 可改回），风险低于 R2；但误标完成会让待办从列表消失且提醒停发（不可见化的轻度后果），且 defer 含二次时间解析——预览卡核对 + 轻确认是成本与安全的平衡点。**不免确认**的另一原因：完成/推迟的目标指代（ID 后缀/标题模糊）存在错配可能，确认卡展示目标标题是最后一道防线。
- **delete=R2 六位码**：不可见化一条业务记录（虽软删可恢复），语义等价 v0.7.2 客户删档降一级（客户档案是 R3，待办是轻实体取 R2）；与 `action.delete` Web 端 confirm 弹窗对齐但微信端不可见化风险更高，取 explicit_code。
- **list=R0**：与既有 `action-risk.summary`/`customer.search` 同级。

### 1.2 建待办的自然语言识别（时间/对象/优先级）

router 正则捕获强前缀，正文交给纯函数 `parseTodoCreateArgs(body, now)`（router.js 内，便于单测）：

```text
前缀： ^(?:提醒我|记待办|新建待办)\s*[:：]?\s*(.+)$ | ^待办\s*[:：]\s*(.+)$   [s 标志]
       （裸"待办"前缀**必须带冒号**才进 create——否则"待办清单""待办 xx 完成"会被误吞，
        无冒号的"待办…"留给 1.3 的 list/complete/defer 正则与既有 summary）
正文解析（顺序执行，全部可缺省）：
  1) 时间短语：spokenTime.extractInstant(body, now)（3.4）——扫描并**摘除**首个时间短语，
     得 { remindAtIso, dueText, deadline }；未命中 → remindAt=null（无提醒纯待办）
  2) 优先级：/(紧急|重要|优先|高优)/ → '高'（并从标题摘除该词）；默认 '中'
  3) 对象（客户消歧输入）：/(?:给|帮|约|拜访|联系|回复)([\u4e00-\u9fffA-Za-z0-9]{2,20}?)(?:送|发|做|出|打|去|约|汇报)?/
     捕获候选人名/机构名 → 仅用于**客户唯一命中挂接**（1.5 预览 provider 消歧），标题不摘除
  4) 剩余文本 = title（≤80 字截断；空 → block "请补充待办内容"）
```

示例：`提醒我周五前给王工送方案` → remindAt=本周五T09:00+08:00（deadline=true）、due="周五前"、title="给王工送方案"、客户候选"王工"（大概率零命中→不挂，仅正文保留）。

### 1.3 与记账/客户/快速记录 agent 的分流规则

**naturalPlan 插入位置总表**（自上而下；含 v0.7.3 计划插入项，二版并行的顺序合同见 4.1-D4）：

```
[v0.7.3] capture 前缀（记一下/记拜访…，含记账歧义门）    ← 最前
[本版]   todo-create 前缀（提醒我/待办：/记待办/新建待办）  ← 紧随其后
[本版]   todo-complete / todo-defer / todo-delete 正则      ← 同上（词干强，前置安全）
销售周报 → 报销周报 → 请款 → … → 战情 → 客户详情 → 商机详情 → 项目分析
动作风险等值(L384) → followUp 句式(L392)                    ← 不动
[本版]   todo-list 正则                                     ← 插在 followUp 之后、行程(L401)之前
行程 → 差旅 → 记账正则 /记账|支出|收入|借款到账/(L412)      ← 不动
知识检索 → "记录"/"录入" → [v0.7.3 search/update/void] → 客户写系列 → 拜访兜底(L501)
```

**歧义处理规则**：

1. **todo 前缀 vs 记账**（`提醒我报销打车费 50 元`）：前缀剥离后 body 命中 `/\d+(?:\.\d+)?\s*(?:元|块钱?)/` 且命中 `/记账|支出|收入|报销|借款/` → 不吞，照常建待办（**待办的语义是"提醒我去做"而非"现在记账"**，与 v0.7.3 capture 歧义门方向相反——capture 是正文即内容，todo 是正文即任务描述）；仅当 body **以**记账动词开头（`^(?:记账|记支出|记收入)`）时 clarify("你是要现在记账（直接发送「支出 …」），还是建一条待办提醒？")。
2. **todo 前缀 vs 拜访兜底**：`提醒我明天拜访日照医院` 含"拜访"，若无 todo 前缀在前会被 L501 兜底吃进 visit-capture.collect——**todo 前缀必须在拜访兜底之前**（表中已保证，且前缀是最强意图信号）。
3. **list vs 既有 summary**：带时间词（今天/明天/本周/下周/最近）或"我的"限定 → `action-risk.list`；裸`待办`/`有什么待办`/上下文跟进句式 → **维持现状走 summary**（不改 L384/L392 两条既有正则，零回归）。list 正则：`^(?:查?(?:一下)?)?(今天|今日|明天|本周|这周|下周|最近)?\s*(?:的)?(?:我的)?待办(?:清单|列表|事项)?\s*[?？]?$`，要求时间词或"我的"至少一个存在（否则不命中，落给 summary）。
4. **complete/defer/delete 的"待办"词干强制**：`完成了拜访张主任` 不含"待办"词干 → 不命中，照常走拜访兜底；语式要求 `待办` 字面或提醒卡引导语式（1.4）。与 v0.7.3 update/void 的"记录"词干策略同构，两组词干（待办/记录）互斥。
5. **群聊**：写类工具的预览 provider 统一 `chatType!=="direct"` → block（复用 v0.7.2 writeGate 模式）；list 查询也限私聊（待办含商务信息）。

**complete/defer/delete 解析正则**：

```text
complete：^(?:完成|办完|做完)(?:了)?待办\s*(.+)$ | ^待办\s*(.+?)\s*(?:完成|办完|做完)(?:了)?$
defer：   ^(?:把)?待办\s*(.+?)\s*(?:推迟|延期|顺延|改)(?:到|至|成)\s*(.+)$
          | ^(?:推迟|延期|顺延)待办\s*(.+?)\s*(?:到|至)\s*(.+)$
delete：  ^(?:删除|取消|删掉)待办\s*(.+)$
目标指代 (.+?)：① 6-64 位 [A-Za-z0-9-] → ID 后缀（owner 内 LIKE '%'||suffix 唯一命中）；
              ② 其他文本 → 标题模糊匹配（owner 内活跃待办 title LIKE，唯一命中才钉，
                多命中 clarify 列 ≤5 候选，零命中 not_found）；
              ③ 空 → clarify("请带上待办编号或标题，如「完成待办 a1b2c3」。")
```

### 1.4 到点提醒卡与回复闭环

**提醒卡**（outbox payload kind=`action_reminder`，渲染见 3.6）：

```
【小小提醒】待办到点：给王工送方案
时间：08-29（周五）09:00 ｜ 优先级：高
客户：日照中医医院（仅挂接时显示）
备注：来自快速记录确认（reason 截 60 字，可缺省）
——
回复"完成待办 a1b2c3"标记完成；
回复"待办 a1b2c3 推迟到明天上午"顺延提醒；
在系统"下一步动作"页可查看全部。
（迟到超过 24h 时首行改为【小小提醒·过期】并加注"该提醒因系统离线迟到"。）
```

回复闭环即 1.3 的 complete/defer 语式（ID 后缀在卡内给足），走全新事件 → router → 轻确认 → 执行，**不依赖任何跨消息会话状态**。用户置之不理 = 无后果（不重发，`reminded_at` 已标；晨报（H 阶段）负责逾期汇总，本版不做重复催办——开放问题 6.3）。

### 1.5 对话流样例（轻确认）

```
用户：提醒我周五前给王工送方案
小小：【新建待办】
      内容：给王工送方案
      提醒：2026-08-29（周五）09:00 ｜ 截止语义：周五前
      优先级：中 ｜ 客户：未挂接
      ——
      回复"确认"创建，回复"取消"放弃；10 分钟内有效。
用户：确认
小小：已创建待办（a1b2c3…）。周五 09:00 我会在这里提醒你；
      发送"本周待办"可随时查看。
```

- defer 预览卡展示 `原提醒时间 → 新提醒时间`（二次解析核对）；defer 后 status 若为 deferred/pending 均归一为 pending（deferred 状态保留给 Web 手工标记，微信顺延语义就是"改时间继续等"——开放问题 6.4）。
- complete 预览卡展示目标标题 + "完成后将不再提醒，周报推进项自动纳入"。
- 时间解析失败（前缀命中但无法解析时间短语且正文含时间样词）：不阻断，建"无提醒纯待办"并在预览卡提示 `提醒：未设置（未识别到明确时间，可回复"取消"后重试，或创建后在系统里补充）`。
- list 卡片：`今天的待办（2 条）：\n1. 给王工送方案 ｜ 09:00 ｜ 高 ｜ a1b2c3\n2. …\n发送"完成待办 <编号>"或"待办 <编号> 推迟到…"。`（每条含 ID 后缀 6 位；>8 条截断提示）

---

## 二、调度设计

### 2.1 方案裁定：新建轻量 reminder 循环，不复制招标三表状态机

| 维度 | 招标调度器 | 待办提醒需求 | 结论 |
|---|---|---|---|
| 触发模型 | 周期批处理（60min + 窗口 + 客户游标 + 快照） | 到点触发，分钟级 | 游标/快照/cycle 全不适用 |
| 待处理集合 | 需自建状态（cursor/snapshot 三表） | **action_items 表本身就是队列**（`remind_at<=now AND reminded_at IS NULL AND deleted_at IS NULL AND status IN ('pending','in_progress')`） | 零新状态表 |
| 幂等 | recordRun/updateRun | outbox `UNIQUE(owner, idempotency_key_hash)` + `reminded_at` 标记 | 双保险已够 |
| 重启恢复 | nextRunAt 持久化重排 | 表即队列，首 tick 自然补扫 | 免持久化 |
| 互斥 | 单行租约锁 | 生产单进程（systemd 单实例）；且 enqueue 幂等使并发扫描无害 | **不建锁表**（论证：即使双进程同时扫描同一批到期行，outbox 幂等键保证只入队一次，`reminded_at` 最后写者胜也只是重复 UPDATE 同值） |

**实现形态**（`backend/src/actionReminders/reminderScheduler.js`，~120 行）：

```js
export function createActionReminderScheduler({
  db, outboxRepository,
  resolveOwner,             // () => shortcutBookkeepingAssistantRuntime.owner（与招标 notifier 同源）
  resolveConversationId,    // () => runtime.conversationFor(owner)
  deliveryReady,            // () => weixinTenderDeliveryReady() 同款惰性判断
  clock = () => new Date(), pollMs = 60_000, batchLimit = 20,
}) => Object.freeze({ start, stop, runOnce, status })
```

- `start()`：`setTimeout` 链（照抄 scheduler.js:197-229 的 `scheduleNext→runOnce→finally scheduleNext` + `unref`），固定 `pollMs` 间隔（无 nextRunAt 持久化——间隔恒定，重启最多迟 1 个 tick）。
- `runOnce()`（可独立调用，测试/手动触发入口）：
  1. `deliveryReady()` 为 false → `{status:"skipped", reason:"delivery_not_ready"}`（不扫描不标记，**worker 离线期间到期的提醒留在队列，恢复后统一补发**——这是"未发提醒不丢"的第一机制）；
  2. `SELECT … FROM action_items WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND deleted_at IS NULL AND status IN ('pending','in_progress') AND remind_at <= $now AND owner = $owner ORDER BY remind_at ASC LIMIT $batchLimit`（LEFT JOIN customers 取名；**owner 限定**：只提醒绑定账号本人的待办，与投递范围一致）；
  3. 逐条：`outboxRepository.enqueue({owner, conversationId, idempotencyKey: \`action-reminder:${id}:${Date.parse(remind_at)}\`, payload: 3.6})` → 成功（含 replayed）后 `UPDATE action_items SET reminded_at=$now WHERE id=$id AND reminded_at IS NULL`（**enqueue 成功才标记**，顺序保证"标了必然已入队"；反向失败=重扫+replayed，无害）→ `insertAudit({action:"action.reminder.sent", entityType:"action", entityId:id, actor:"system:action-reminder", metadata:{remindAt, outboxId, late: now-remindAt>24h}})`；
  4. 返回 `{status:"success", enqueuedCount, lateCount}`；异常 catch 后记内存 lastError，timer 存活（fail-open，照抄招标 L221-226）。
- `status()`：内存态 `{running, lastTickAt, lastEnqueuedCount, lastError}` 供管理端点（3.2）。

### 2.2 轮询间隔与到点精度的权衡

端到端延迟 = tick 间隔（60s）+ outbox worker 轮询（5s）+ 投递 ≈ **最坏 ~70s，均值 ~35s**。对"到点小小提醒"场景（人对分钟级容忍度高，且时间多为 09:00/10:00 这类整点）足够；不做"到点精确 setTimeout 到下一条 remind_at"的优化（需要在建/改/删待办处全部挂 timer 重排钩子，复杂度 ×3，收益 <60s）。`pollMs` 经 `ACTION_REMINDER_POLL_MS` 环境变量可调（下限 5s、上限 10min，config.js 加键），生产默认 60s。**每 tick 成本**：单条部分索引扫描（3.5 的 idx_action_items_remind）+ 通常零行，可忽略。

### 2.3 与 9–20 免打扰窗口的关系（建议：不受窗约束）

**裁定：到点提醒不受 9–20 窗口约束，准点即发。** 论证：招标窗口（0026 迁移）解决的是"系统批量推送不要深夜打扰"；而待办提醒时间是**用户亲口指定的闹钟**（"提醒我晚上十点看标书"），窗口拦截反而违背意图；投递范围又仅限本人绑定私聊，深夜消息只影响本人。两道柔性兜底代替硬窗口：① create 预览卡在解析出的提醒时间落在 20:00-09:00 时追加提示行 `注意：提醒时间在夜间/清晨，如无必要建议调整`（不阻止）；② 未指定时刻的日期默认取 09:00（窗口起点，见 3.4）。若产品层后续要硬窗口，在 `runOnce` 步骤 2 的 SQL 外加窗口判断 + 顺延到窗口起点即可（一处改动，向后兼容）。

### 2.4 持久化与重启恢复汇总

| 场景 | 行为 | 机制 |
|---|---|---|
| 后端重启（提醒未到点） | 到点后首 tick 正常发 | 表即队列 |
| 后端重启（到点未扫描） | 重启后首 tick 补发 | `reminded_at IS NULL` 兜底 |
| 已 enqueue 未投递时重启 | worker 续投 | outbox queued 持久化 + 重试退避 |
| enqueue 成功但 reminded_at 写失败 | 下 tick 重扫 → enqueue replayed → 重试标记 | outbox 幂等键防重发 |
| weixin worker 掉线数小时 | 期间不标记不入队；恢复后按 remind_at 升序补发 | `deliveryReady()` 前置门 |
| 宕机跨越提醒点 >24h | 照发但卡片标注"过期提醒" | metadata.late + 渲染分支（1.4） |
| 待办在到点前被完成/删除/顺延 | 不发 | 扫描条件排除 done/deleted；defer 改了 remind_at |
| 到点后、投递前被完成 | 可能仍收到提醒（竞态窗口 ≤70s） | 接受（卡片语义是"到点了"，无害）；不做 closePending 级联（开放问题 6.5） |

---

## 三、技术方案

### 3.1 新增/修改文件清单（精确路径）

| 文件 | 新/改 | 内容 |
|---|---|---|
| `backend/src/db/migrations/0028_action_item_reminders.mjs` | **新** | owner/remind_at/reminded_at 三列 + 部分索引（3.5） |
| `backend/src/actionItems/actionItemStore.js` | **新**（~180 行） | owner 限定的建/查/完成/顺延/软删 SQL（3.3） |
| `backend/src/actionReminders/reminderScheduler.js` | **新**（~120 行） | 2.1 的轻量循环 |
| `backend/src/assistant/spokenTime.js` | **新**（~110 行） | 未来向日期+时刻+截止解析纯函数（3.4） |
| `backend/src/assistant/actionItemPendingPreviewProviders.js` | **新**（~140 行） | create/complete/defer/delete 四个预览 provider（3.7），工厂签名对齐 `createCustomerPendingPreviewProviders` |
| `backend/src/assistant/router.js` | 改 | 1.2/1.3 正则 + `parseTodoCreateArgs/parseTodoTargetArgs` 纯函数；插入位置见 1.3 |
| `backend/src/assistant/policy.js` | 改 | 5 条新 policy（1.1）；若 v0.7.3 未先落，补 `affirm_language` 常量（4.1-D1） |
| `backend/src/assistant/agentRegistry.js` | 改 | TOOL_DEFINITIONS +5（args schema：create={title required, remindAt?, due?, priority?, customerQuery?}; list={dateStart?, dateEnd?}; complete/delete={actionItemId?, query?}; defer={actionItemId?, query?, newTime required}） |
| `backend/src/assistant/agentManifest.js` | 改 | action-risk manifest：tools +5、taskTypes +`todo_create_preview/todo_list/todo_status_preview`、systemPrompt 补待办守则、confirmation.write 保持 explicit |
| `backend/src/assistant/capabilityCatalog.js` | 改 | action-risk 能力条目 mappings.tools +5、apis +`PATCH /api/actions/:id`、description 更新 |
| `backend/src/assistant/runtimeHandlers.js` | 改 | 5 个新 handler（3.8）+ `createAssistantToolHandlers` 增 `actionItemStore` 依赖注入 |
| `backend/src/assistant/orchestrator.js` | 改（条件） | v0.7.3 已落则**零改动**；未落则移植其 §3.3 affirm_language 分支（~35 行，4.1-D1） |
| `backend/src/server.js` | 改 | ① 迁移后 `actionFromRow` 增投影 owner/remindAt/remindedAt（L734-753）；② `upsertActionFromQuickRecord` INSERT/UPDATE 补 `owner=quickRecord.owner`（L1862-1931，深写回衔接）；③ 构建 store/scheduler 并 `start()`（`config.actionReminderAutoRun`，模式照抄 L2606-2629 招标段）+ `server.close` 时 `stop()`（L7285 旁）；④ `pendingPreviewProviders` 合并注入 `{...customerProviders, ...actionItemProviders}`（L2911-2915）；⑤ 管理端点 `GET /api/actions/reminders/status`（3.2）；⑥ `actionRows` owner 分支扩展在 businessSnapshotAdapter（下行） |
| `backend/src/assistant/businessSnapshotAdapter.js` | 改（~4 行） | `actionRows` WHERE 的 owner 括号组增 `OR action.owner = $owner`（L305-315）；投影补 due/remindAt |
| `backend/src/config.js` | 改 | `actionReminderAutoRun`（默认=生产 true，对齐 hospitalTenderAutoRun L300-304）、`actionReminderPollMs`（默认 60000，下限 5000） |
| `backend/src/validation/requests.js` | 不改 | actionPatch 不动（Web 合同零变化；remind_at 微信侧专写，Web 后续版本再开） |
| `CHANGELOG.md`、`docs/releases/v0.7.4.md`、`VERSION`、蓝图 F 行 | 改 | DoD 惯例 |

### 3.2 管理与可观测（最小面）

- `GET /api/actions/reminders/status`（user 鉴权，模式抄 L4029-4041）：`{item: scheduler.status(), pendingCount: SELECT COUNT(*) … remind_at IS NOT NULL AND reminded_at IS NULL, deliveredToday: outbox sent 计数}`。不做 PATCH 配置端点（间隔用环境变量，窗口不适用——比招标少一整块管理面，够用即止）。
- 审计动作命名：`action.create`（微信建待办，**新** action，Web 无创建端点故无同名冲突）、`action.update`（complete/defer 沿用 Web 同名聚合，metadata.source="weixin-assistant" 区分）、`action.delete`（沿用）、`action.reminder.sent`（**新**，actor=`system:action-reminder`）。v0.7.1 记账实时日志若按前缀过滤不受影响。

### 3.3 `actionItemStore.js`（共享读写模块，审计留在 handler 层——对齐 customerStore 决策）

```js
export function createActionItemStore(db, { clock } = {}) => Object.freeze({
  create({ owner, title, due, remindAt, priority, customerId, customerName, opportunityId, id }),
  //  INSERT（id=调用方传入的 actionId，幂等主键；status='pending'，assignee=owner 显示名沿用 owner 值，
  //  tone=priority==='高'?'red':'blue'，source_record_id=NULL）；owner 必填
  list({ owner, dateStart, dateEnd, statuses = ["pending","in_progress","deferred"], limit = 9 }),
  //  owner 三分支（own 列 OR 客户 owner OR 商机 owner，复用 actionRows 括号组）+
  //  remind_at 或 due 落窗（remind_at 非空用 remind_at 判窗；否则不过滤时间——无提醒待办只在无时间窗查询出现）
  //  ORDER BY remind_at IS NULL, remind_at ASC, priority → {items, truncated}
  findByIdSuffix({ owner, suffix }) / findByTitleQuery({ owner, query }),   // 唯一化指代（1.3）
  complete({ owner, id, expectedVersion, actor }),   // runVersionedUpdate 模式：status='done'，版本守卫
  defer({ owner, id, expectedVersion, remindAt, due, actor }),
  //  SET remind_at=$remindAt, due=$due, reminded_at=NULL, status='pending', version=version+1 WHERE version=$expected
  softDelete({ owner, id, expectedVersion, deletedBy }),
  dueReminders({ owner, now, limit }),               // 2.1 步骤 2 的扫描 SQL
  markReminded({ id, now }),                          // reminded_at 条件更新
});
```

版本冲突语义照抄 `itinerary/repository.js:92-98`（changes!==1 → 复查行 → NOT_FOUND / VERSION_CONFLICT 带 currentVersion）；写路径全部要求 `owner` 精确匹配（`WHERE owner=$owner`——**微信建的待办 owner 必非空；owner 为 NULL 的存量行（深写回历史数据）微信端不可完成/顺延/删除，只能查看**（经客户/商机 owner 分支可见），Web 端不受限。此边界避免"跨 owner 改写"，存量行的 owner 回填见 3.5）。

### 3.4 `spokenTime.js` 时间解析器

纯函数 `parseSpokenInstant(text, now)` → `{ matched, iso, displayText, deadline, hasTime, token }`（now 为 Date，内部一律以 Asia/Shanghai 口径计算，组装 `${date}T${hh}:${mm}:00+08:00` 再转 UTC ISO 存储）：

- **日期词**：今天/今晚/明天/明早/明晚/后天/大后天/周X/本周X/下周X/X月X日/X号/N天后/月底（→当月最后一天）；周X 语义＝**未来最近的那个周 X**（今天是周五说"周五"→今天，已过 20:00 则下周五——按 now 时刻判断）。
- **时刻词**：上午X点[半/X分]/下午X点…/晚上X点…/中午（12:00）/X点X分/HH:MM/X点半；下午/晚上 +12 换算；"今晚/明早"复合词内置时段默认（晚 20:00 / 早 09:00）。
- **截止词**：`(?:之?前|以前)$` 后缀 → deadline=true（"周五前"→周五）；"内"（"三天内"）→ 第 N 天。
- **缺省规则**：有日期无时刻 → 09:00（deadline 与否一致，宁早勿晚）；有时刻无日期 → 今天该时刻已过则明天，未过则今天。
- **拒绝面**：解析不到 → `matched:false`（create 走"无提醒纯待办"，1.5；defer 则 block "没听懂新的提醒时间"）。周界计算复用 `businessSnapshotAdapter` 的 Intl en-CA 模式（8-17,123-134）；**与 v0.7.3 spokenDate.js 的关系见 4.1-D2**。

### 3.5 迁移 0028（尽量少迁移的论证）

```js
// 0028_action_item_reminders.mjs（复用 0002 的 addColumnIfMissing）
addColumnIfMissing(db, "action_items", "owner", "TEXT");
addColumnIfMissing(db, "action_items", "remind_at", "TEXT");    // UTC ISO
addColumnIfMissing(db, "action_items", "reminded_at", "TEXT");  // UTC ISO
db.exec(`CREATE INDEX IF NOT EXISTS idx_action_items_remind
  ON action_items(remind_at) WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND deleted_at IS NULL;`);
// 存量回填：UPDATE action_items SET owner=(SELECT c.owner FROM customers c WHERE c.id=action_items.customer_id)
//   WHERE owner IS NULL AND customer_id IS NOT NULL;  —— 仅从挂接客户继承，商机路径经客户等价；无挂接行保持 NULL
```

**三列均必要，无一多余**：`owner`——蓝图明令的扩展；不加则独立待办对小小不可见（0.1 已证 actionRows 的 join 闭合），且调度扫描无法按绑定账号限定。`remind_at`——due 是"今天 18:00/待确认"级自由文本（0.1），不可解析为调度时间；复用 due 改存 ISO 会破坏 Web 展示与既有数据。`reminded_at`——去重标记；不加则每 tick 重扫全部已到期行空转 enqueue（虽 replayed 无害但状态不可观测、audit 重复）。**明确不加的列**：`snooze_until`（顺延=改 remind_at+清 reminded_at）、`reminder_count`（不做重复催办）、`remind_channel`（单通道）。风险：0002 模式的 `addColumnIfMissing` 幂等，回滚=忽略新列（旧代码不读不写，向后兼容）；彩排照 v0.7.2 迁移 0027 流程。

### 3.6 outbox 消息格式（kind=`action_reminder`）

```js
payload = {
  kind: "action_reminder",
  actionItemId, title,                 // ≤200 截断
  remindAtDisplay: "08-29（周五）09:00", // 预渲染展示串（含 Asia/Shanghai 换算，渲染函数免时区依赖）
  priority, customerName: null | "…",
  reasonExcerpt: null | "…60字",
  idSuffix: "a1b2c3",                  // 尾 6 位，回复闭环用
  late: false,                         // 迟到 >24h 标注
}
```

键名全部避开 outboxRepository 敏感键正则（0.2）；`enqueue` 幂等键 `action-reminder:{actionItemId}:{remindAtEpoch}`（顺延改时间后 epoch 变化=新键，**顺延后的新提醒不会被旧键挡住**）。渲染：`shortcutBookkeepingRuntime.renderOutboxMessage` L1220 旁加分支 `if (payload.kind === "action_reminder") return renderActionReminderMessage(payload);`，渲染函数放 `actionReminders/reminderMessage.js`（纯函数，模式抄 `hospitalTender/weixinNotifier.js:62-90` 的 fail-closed 校验）。**投递范围零改动**：owner/conversationId 与招标通知同源（绑定私聊），worker 的 authorizeDelivery 天然放行。

### 3.7 预览 providers（`actionItemPendingPreviewProviders.js`）

工厂 `createActionItemPendingPreviewProviders({ store, customerAdapter, resolveBusinessOwner, clock })`，返回四键，签名/返回结构对齐 v0.7.2（`{block,status,bodyStatus,text} | {arguments, previewText, previewSummary}`）：

- 公共门：`chatType!=="direct"` → block（`待办功能仅支持与小小的私聊。`）；`resolveBusinessOwner(owner)` 空 → block。
- **create**：`spokenTime` 已在 router 解析（arguments 携带 remindAt/due/priority/title/customerQuery）；provider 做：title 空 block；customerQuery 有值 → `customerAdapter.analyze(taskType:"detail"/search)` 唯一命中才钉 customerId（多命中**不 clarify、直接不挂**——待办挂接是增益不是必须，降摩擦；预览卡如实展示"客户：未挂接"）；夜间提示行（2.3）；产出钉死参数 `{title, remindAt, due, priority, customerId?, customerName?}`。
- **complete/delete**：目标唯一化（findByIdSuffix / findByTitleQuery→ 多命中 clarify 列候选、零命中 not_found）→ 预览卡（标题+当前状态+提醒时间）+ `arguments:{actionItemId, expectedVersion}`；已 done 再完成 → block(`该待办已是完成状态。`)。
- **defer**：目标唯一化 + `spokenTime` 解析 newTime（失败 block）→ 预览卡 `提醒：原 → 新` + `arguments:{actionItemId, expectedVersion, remindAt, due}`。

### 3.8 runtimeHandlers 五个 handler（模式与幂等）

- `action-risk.create`：`id = context.actionId`（affirm pending 必有）→ `store.create` 幂等（重放回执）；audit `action.create`（metadata: source/actionId/remindAt/via="weixin-assistant"）；回执 1.5。
- `action-risk.list`：`resolveBusinessOwner` 空 → 未绑定文案；`store.list` → 卡片；无 contextUpdate（待办不改会话客户上下文）。
- `action-risk.complete`/`defer`/`delete`：args 已被 provider 钉死（actionItemId+expectedVersion）；store 对应方法；VERSION_CONFLICT → `这条待办刚在其他端被修改，本次未写入，请重新发起。`；audit `action.update`（changedFields:[status] / [remind_at,due]）与 `action.delete`；执行重放由 claimExecution 租约兜底。

---

## 四、依赖漂移点（对 v0.7.3 实施结果的依赖清单）

**当前事实**：本工作树无任何 v0.7.3 代码（0 未提交改动，HEAD=668aa04）。以下按"v0.7.3 先合入"与"v0.7.4 先行"双轨写明。

| # | 依赖 | v0.7.3 先合入时 | v0.7.4 先行时 |
|---|---|---|---|
| D1 | **affirm_language 轻确认分支**（v0.7.3 设计 §3.3：`deriveAffirmCredential` + 创建/确认/防误锁三处 orchestrator 改动 + handlePending guard1 放行"确认"） | **调研末已观测到 policy.js 落入 `visit-capture.capture = {risk:"R1", confirmation:"affirm_language"}`（未提交 diff），确认级别按预期落地**；但 orchestrator 的 affirm 分支调研截稿时尚未出现在工作树——实施本版前核对其最终判定键名（`policy.confirmation === "affirm_language"`）、affirm 卡文案拼装函数名与"码类文本不计 attempt"分支是否齐备 | 本版自带移植该分支（设计已成稿，~35 行 + 常量），v0.7.3 后续合入时改为共用——两版实施方以"先落者拥有实现、后落者删重"为合同 |
| D2 | **spokenDate.js**（v0.7.3 §3.6，过去向日期/区间） | **调研末已存在**（未提交），实测导出面：`resolveSpokenDate(word, now)`/`resolveSpokenRange(word, now)`/`spokenDateToIso(date)`/`extractSpokenOccurredAt(text, now)`；词表确证纯过去向（今天/昨天/前天/上上周X/上周X/本周X/X月X日/N天前），**无 明天/下周X/时刻/截止**，与 0.3 预判一致。其 `businessDateOf/addDays/weekStartOf` 等工具是**模块内私有函数未导出**——v0.7.4 实施时二选一：把这些工具提升导出供 `spokenTime.js` 复用（推荐，+3 行 export），或 spokenTime 自带（注释互指）；`extractSpokenOccurredAt` 的"扫描-摘除"模式即 1.2 extractInstant 的同款范式，直接对齐 | `spokenTime.js` 自带全部工具函数；v0.7.3 落地时其 spokenDate 反向复用本版工具（其设计 §3.6 已预留"实施时评估共用"） |
| D3 | **handlePending 让路守卫**（v0.7.2 已落 guard1/guard2，0.5 已核对现状代码） | v0.7.3 若按其 §3.6 调整 guard 条件顺序或收窄 actionType 白名单，必须把 `action-risk.*` 与 `visit-capture.*` 一并纳入放行面 | 现状 guard1/guard2 已天然放行本版全部语式（0.5 已证），零改动；回归用例 5.2 T-BK 组固化 |
| D4 | **naturalPlan 插入顺序**（v0.7.3 把 capture 前缀放最前、search/update/void 插 L272/273 间） | 本版 todo 前缀插在 capture 前缀**之后**（1.3 总表）；`记待办：` 与 capture 的 `帮我记(一下|录)?` 前缀有词面交叠——本版正则用 `记待办` 全词干，v0.7.3 的 `帮我记` 不含"待办"后缀断言，实施时加联合用例互斥固化（5.2） | todo 前缀插在 naturalPlan 最前（销售周报之前）；v0.7.3 合入时把 capture 前缀插到 todo 之前即可（两者词干无歧义交集） |
| D5 | **quick_record confirm 深写回**（`upsertActionFromQuickRecord`） | v0.7.3 微信 capture 不做深写回（其 0.2 明示 writebackAllowed:false），无冲突；本版给该函数补 `owner=quickRecord.owner`（3.1-②）后，**Web 确认页深写回创建的待办自动获得 owner 与提醒能力（remind_at 仍 NULL，不自动提醒——开放问题 6.2）** | 同左，无差别 |
| D6 | **CONTROL_MESSAGES/“确认”消费**（runtimeHandlers.js:56-61 草稿控制词表含"确认"） | v0.7.3 若调整 visit 草稿控制词，与本版无交集（"待办/完成/推迟"不在表内，本版也不新增控制词） | 零改动 |

---

## 五、测试面（`backend/tests/`，node:test + assert/strict 惯例）

### 5.1 新增文件

| 文件 | 用例要点 |
|---|---|
| `action-item-store.test.js` | create 幂等（同 id 重放）；owner 三分支可见性（own 列/客户 owner/商机 owner/全空不可见→加 owner 后可见）；list 时间窗（remind_at 落窗、无提醒待办仅无窗查询出现、done 排除、truncated）；findByIdSuffix/TitleQuery 唯一/多命中/跨 owner 不命中/LIKE 转义；complete/defer/softDelete 版本冲突 409 语义与 currentVersion；defer 清 reminded_at；owner=NULL 存量行写保护 |
| `spoken-time.test.js` | 全词表 × 边界：明天/后天/下周X/周X 未来语义（含"今天是周五说周五"）/X月X日/月底/N天后；时刻（上午十点/下午3点半/14:30/中午/今晚）；截止（周五前/三天内）；缺省规则（无时刻→09:00、无日期→今明判定）；跨月/跨年/Asia/Shanghai 口径（UTC 时钟落在日界两侧）；非法→matched:false |
| `action-reminder-scheduler.test.js` | **时钟注入模式照抄 hospital-tender-scheduler.test.js**：固定 clock + `await scheduler.runOnce()` 手动 tick（不启 timer）+ tmpdir 真库 + 真 outboxRepository。用例：到期入队+reminded_at 标记+audit；未到期不动；done/deleted/deferred-改期 不提醒；worker 未就绪 skipped 且零标记（deliveryReady=false 注入）；重扫幂等（人为清 reminded_at 后 runOnce → enqueue replayed 不新增行）；重启恢复（新建 scheduler 实例再 runOnce 补发）；迟到 >24h payload.late=true；batchLimit 截断；enqueue 抛错时 reminded_at 不标记且 timer 语义存活（下次可重试）；owner 限定（他人待办不入队） |
| `action-reminder-message.test.js` | 渲染分支：全字段/缺省字段/late 标注/超长截断 fail-closed（模式抄 hospital-tender-weixin-notifier.test.js） |
| `assistant-action-item-http-integration.test.js`（模式抄 `assistant-customer-http-integration.test.js`，六位码用 `confirmationCodeFrom` L49-53） | 端到端：`提醒我周五前给王工送方案` → affirm 预览卡（断言无六位数字、含解析时间）→"确认"→ 建库+audit 链+回执；"取消"；TTL 过期；`今天有什么待办` 免确认含新建项；`完成待办 <suffix>` 轻确认全链→done→list 消失→调度不提醒；defer 全链→remind_at 变更+reminded_at 清空；delete 六位码全链（错码×5 锁定、重发确认码）；群聊拒绝；记账草稿并存时 todo 语式不被劫持（T-BK 组）；调度器 runOnce → 出箱路由 GET lease → message 断言（打通 events 与 outbox 双通道） |

### 5.2 扩展既有文件

| 文件 | 用例要点 |
|---|---|
| `assistant-router.test.js` | 1.2/1.3 全正反例：`提醒我明天拜访日照医院` →create 不落拜访兜底；`提醒我报销打车 50 元`→create；`记账支出 50`→仍记账；裸`待办`/`有什么待办`→仍 summary；`今天有什么待办`→list；`完成了拜访张主任`→仍拜访兜底（无"待办"词干）；complete/defer/delete 字段捕获断言；与 v0.7.3 capture 前缀互斥联合用例（D4） |
| `assistant-policy.test.js` / `assistant-registry.test.js` / `assistant-agent-manifest.test.js` / `capability-catalog.test.js` | 5 条新 policy 的 risk/confirmation；工具注册 args schema；manifest tools/taskTypes；能力目录断言 |
| `assistant-orchestrator.test.js` | （若本版自带 affirm 分支）创建无码/“确认”执行/码类文本不计 attempt/取消——用例表直接抄 v0.7.3 设计 5.2 该行 |
| `assistant-business-snapshot-adapter.test.js` | actionRows 增 `action.owner=$owner` 分支：独立待办可见、他人 owner 不可见、原 join 分支回归 |
| `migrations.test.js` | 0028 计数+列存在+部分索引+存量 owner 回填断言 |
| `api.test.js` | `GET /api/actions` 投影新字段回归；PATCH/DELETE 行为不变 |
| `shortcut-bookkeeping-assistant.test.js` | 记账草稿并存 + todo affirm pending：guard1 放行"确认"归 todo；引用记账草稿"确认"仍入账（D3 合同） |

门禁：后端全量 + 前端 qa:local + Chrome/WebKit 集成 + 密钥扫描 + 根 test:deploy（DoD 固定项）。

---

## 六、风险与开放问题

### 6.1 风险

1. **中文时间解析错误面大**（本版最大风险）：缓解＝轻确认卡强制回显解析结果 + 解析失败降级"无提醒纯待办"不瞎猜 + spoken-time 全词表单测；残余风险（用户不细看卡）由 defer 低成本纠正。
2. **affirm_language 与 v0.7.3 的实现竞态**（D1）：两版并行实施时以"先落者拥有、后落者删重"为合同，T-BK 与 orchestrator affirm 用例作为集成回归门。
3. **调度器与 `deliveryReady` 的耦合**：绑定私聊未配置（`weixinBookkeepingConfirmationEnabled=false`）时提醒永不发送——与招标微信通道同款现状（其时降级 PushPlus，本版不做降级通道）；release notes 写明"到点提醒依赖小小绑定私聊在线"。
4. **owner 回填的准确性**：存量待办从挂接客户继承 owner，客户 owner 本身可能 ≠ `WEIXIN_AGENT_OWNER`（生产已知一例）——继承后仍不可见属既有数据问题，不由本版修数据（与 v0.7.2 只读体检的处置一致，留用户 Web 端决定）。
5. **naturalPlan 头部前缀增多**（capture+todo 两组抢最前）：词干互斥已论证（D4），router 测试全反例固化；后续版本若前缀继续膨胀应重构为前缀表驱动（记入 v0.8.3 工程健康）。
6. **到点后完成的竞态提醒**（2.4 末行）：窗口 ≤70s，卡片语义无害，不做 outbox closePending 级联（复杂度不值）。

### 6.2-6.6 开放问题（默认保守，不阻塞实施）

2. **Web 确认页深写回的待办要不要自动提醒**：本版 remind_at=NULL 不提醒（due="待办确认"无可解析时间）；若产品要，需在 Web 确认流加时间输入（并入 J 阶段 Web 改版更合适）。
3. **逾期未完成要不要重复催办**：本版单次提醒；晨报（v0.7.6 H 阶段）天然承接"逾期待办汇总"，届时用 `remind_at < now AND status='pending'` 查询即可，无需本版加列。
4. **deferred 状态与微信"推迟"的关系**：本版顺延归一为 pending（deferred 留给 Web 手工语义）；若要区分"用户主动推迟"可后续把 defer 落 status='deferred' 并在 list 标注——一行改动。
5. **提醒是否要 closePending 式撤回**（待办完成时撤未投递提醒）：不做（2.4）；若真机反馈扰人，在 complete handler 加 `closePending` 同款 json_extract 收口（outboxRepository 已有先例 L276-304）。
6. **"明天上午十点提醒我"倒装句式**（时间在前缀后紧跟）：1.2 的 extractInstant 扫描全文，天然支持；但"上午十点提醒我开会"无前缀不命中 create——本版不做无前缀识别（误伤面大），记 v0.7.5+ 观察真实话术后再放宽。

---

## 附：实施顺序建议（单人 ~3 人日）

1. 迁移 0028 + actionItemStore + spokenTime + 单测（1d，无依赖可先行）
2. policy/registry/manifest/catalog + router 正则 + 单测（0.5d）
3. （视 D1 现状）orchestrator affirm 分支移植或核对 + providers + handlers（0.5d）
4. reminderScheduler + 渲染分支 + server.js 装配/端点 + snapshotAdapter owner 分支（0.5d）
5. http 集成（events+outbox 双通道）+ 记账并存回归 + 门禁全绿（0.5d）
