# v0.7.6 每日晨报 + 周五收尾包 实施设计（调研定稿）

> 产出：2026-08-28 上午（调研时刻 08:23 +08:00，**今晨 9:00 招标窗口首轮尚未发生**）· 只读调研，未改代码。实施对应总蓝图 H 阶段（`docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md`：每日 9:00 晨报（行程+待办+风险+新招标）+ 周五收尾包（周报草稿+凭证/发票缺失清单）），并**并入生产招标调度器 2026-08-20 陈账 `last_error="Internal hospital tender snapshot is invalid"` 的根因排查与修复**（蓝图"已知遗留登记"第 1 条）。
> 前置：v0.7.0/0.7.1/0.7.2 已上线；调研时本工作树 HEAD=668aa04，v0.7.3 以未提交改动落入中（`quickRecords/`、`spokenDate.js`、orchestrator affirm 分支已在工作树）；v0.7.4（F）/v0.7.5（G）仅有设计稿（`2026-08-28-v074-todo-agent-design.md`、`2026-08-28-v075-opportunity-agent-design.md`），未实施。本版是 v0.7 系列收官，实施前必须以 F/G 冻结提交重核第六章依赖清单。
> 行号声明：文中行号以调研时工作树为准，F/G 合入后 `server.js`/`runtimeHandlers.js`/`shortcutBookkeepingRuntime.js` 必然漂移，实施时以语义定位。

---

## 零、现状调研结论（全部来自源码，实施前必读）

### 0.1 晨报四件套数据源现状

**统一底座**：`backend/src/assistant/businessSnapshotAdapter.js` 是 owner 限定业务查询的枢纽，时区口径 `BUSINESS_TIME_ZONE="Asia/Shanghai"`（L5），业务日 = `Intl.DateTimeFormat("en-CA",{timeZone,calendar:"iso8601"})` 格式化（L8-17、L123-126），周一起算周（`currentWeekStart` L128-134）。owner 语义 = `resolveBusinessOwner`（`businessOwnerResolver.js:20-27`，精确闭合映射：绑定账号 ≠ 配置 owner 时返回 null，不退全量）。**晨报取数全部走该 adapter 既有函数 + 少量新查询，微信绑定账号与业务 owner 的映射与招标推送同源**。

| 数据源 | 现有查询 | 晨报可直接复用 | 缺口 |
|---|---|---|---|
| 当日行程 | `itinerarySummary({owner})`（L550-570）：`visit_itineraries WHERE created_by=$owner AND deleted_at IS NULL`，**无日期过滤**，全量 ≤100；`dashboardSummary` 内嵌"即将拜访"计数 `status='planned' AND visit_date >= $today`（L418-419） | 表结构齐备：`visit_date` 严格 `YYYY-MM-DD`（`itinerary/repository.js:33-42`）、status ∈ planned/completed/cancelled、部分索引 `idx_visit_itineraries_active_date`（迁移 0005）；`plan_json` 含 `{title, departureAt, stops:[{customerName, address, appointmentAt?, visitMinutes, priority}], orderedStopIds, schedule, totals}`（`planner.js:197-221`） | 无"某日行程"单日查询——晨报需新增 `visit_date = $today AND status='planned'` 过滤（一条 SQL，或复用 itinerarySummary 后 JS 过滤；取前者，避免全量拉取） |
| 今日/逾期待办 | `actionRows({owner})`（L295-333）：owner 经商机/客户 join 推导，status ∈ pending/in_progress/deferred，`due` 为**人读自由文本**（"今天 18:00"/"待确认"），**不可作时间判定** | v0.7.4 设计（F）迁移 0028 加 `owner/remind_at/reminded_at` 三列 + 部分索引，`actionItemStore.list/dueReminders` 提供机器时间查询；其 §6.3 已预留晨报口径："逾期待办用 `remind_at < now AND status='pending'` 查询" | **硬依赖 0028**：晨报"今日待办"= `remind_at ∈ [今日00:00, 明日00:00)+08`、"逾期"= `remind_at < 今日00:00+08 AND status IN ('pending','in_progress')`（无论 reminded_at 是否已标——提醒发过≠办完）。F 若延期，本段降级为 openActions 计数一行（见 6.1-D1） |
| 活跃风险 | `riskRows({owner})`（L335-374）：status ∈ open/accepted/in_progress/deferred，`ORDER BY score DESC`，投影 severity（'高'/'中'/'低'，schema.sql:139）+ score（0-100）+ due + title | 完全够用，零新查询 | 无 |
| 昨日以来新招标 | `hospitalTender/repository.js`：`listNotices` 过滤器仅 `publishedFrom/publishedTo`（按 `published_at`，L406-420）；`upsertNotice` 冲突时**保留 `first_seen_at`、仅刷 `last_seen_at`**（L617-618）——"我们何时首次见到"的判定字段就是 `first_seen_at`（UTC ISO） | `summary()` 的 `todayNewCount` 用 `published_at` + **服务器本地时区**（`localDateKey` L376-384 用本地 Date 方法）——依赖生产 TZ=Asia/Shanghai，**测试口径不稳，晨报不用它** | `listNotices` 需扩展 `firstSeenFrom` 过滤键（`normalizeListFilters` allowed 集合 + `noticeWhere` 一个条件，~10 行）。晨报"新"= `first_seen_at >= 昨日09:00+08 换算的 UTC ISO`（字符串比较成立：first_seen_at 由 `clock().toISOString()` 写入） |

**招标"新"与实时推送的关系**：调度器实时推送的判定是 `relevance==='high' && firstSeenAt===lastSeenAt && 命中本批客户`（`scheduler.js:454-458`）——只推"本批次刚插入且匹配到客户"的高相关。晨报是**兜底汇总**：列出过去 24h（锚定昨日 09:00）first_seen 的全部 high 公告（含未匹配客户的），medium 只计数。两者语义互补不重复（实时推送是"有匹配立刻知道"，晨报是"每天一屏扫读"）。

### 0.2 周五收尾包数据源现状

**周报草稿双路径**（本版只读复用，不新增写路径）：

1. **Web 持久化路径**：`POST /api/reports/weekly/draft`（server.js:6887-6985）：素材 = `manual_confirmations target='weekly'` 确认过的 quick_records（L6904-6920）→ `buildWeeklyDraft`（`weeklyDraft.js:12-60`，四段模板：本周重点进展/风险与需协调/知识库引用/下周动作）→ `enhanceWeeklyDraftWithModel`（模型增强，失败回退确定性草稿）→ INSERT `weekly_reports status='draft'` + 审计 `weekly_report.draft`。**有落库与模型副作用，且 knowledgeIds 选择属人工判断**。
2. **小小侧只读预览**：`salesReportSummary({owner, weekStart})`（businessSnapshotAdapter.js:719-842）：本周已存周报行（status ∈ draft/saved/ready，`statusCounts`）+ **ephemeral preview**（`persisted:false`）——素材 = `source_channel='微信助手'` **或** manual_confirmations weekly 确认的本周 analyzed 快速记录（L774-800，比 Web 路径素材面更宽），经 `buildWeeklyDraft` 产 content（≤20000 字）与 `preparation.blockers`（`no_weekly_report`/`no_confirmed_records`/`truncated`）。已由 `sales-report` agent 卡片消费（runtimeHandlers.js:389："销售周报预览（{weekStart}）：已保存周报 N 条（草稿 X、已保存 Y、就绪 Z）"）。

**发票缺失判定**（两处同构实现，收尾包直接复用 adapter 版）：`travelExpenseSummary({owner, weekStart})`（businessSnapshotAdapter.js:572-717）逐费用计算 `confirmedCoverageCents`（`invoice_matches state='confirmed'` join 未删发票求和）、`missingInvoiceCents = max(0, reimbursement - coverage)`、`noInvoiceConfirmedCents`（`travel_expense_no_invoice_confirmations revoked_at IS NULL`）、**`unacknowledgedMissingCents = missing - noInvoiceConfirmed`**；`derivedInvoiceStatus` 四态 covered/partial/missing/pending（L69-75）；周汇总含 `missingInvoiceCount` 与 `preparation.blockers` 含 `missing_invoice`（L705-708，判定条件 `unacknowledgedMissingCents > 0`）。`settlementSnapshotAdapter.js`（报销周报 agent 的确定性引擎）有同构 `invoiceCoverage.complete` 口径（L455-505）。**收尾包"发票缺失"取 `unacknowledgedMissingCents > 0` 的费用**——已确认"无票"的不再催（与 Web 合计条徽标口径的差异见 2.2）。

**凭证缺失判定**：后端**没有**现成查询——该口径目前只在前端：`travelExpenseModel.js:363-369` `paymentProofMissingCount` = 本周费用中**没有任何 `kind='payment_proof'` 附件**的费用数（附件三类 payment_proof/invoice/substitute，`travelExpense/repository.js:20`；payment_proof 强制关联 ≥1 笔付款，L743-744）；Web 合计条"凭证缺失"徽标即它（`ExpenseLedgerWorkbench.jsx:232`）。收尾包需新增一条对齐前端规则的 SQL（`NOT EXISTS (SELECT 1 FROM travel_expense_attachments WHERE expense_id=... AND kind='payment_proof')`，见 2.2）。

### 0.3 调度形态与消息通道现状

**招标调度器**（唯一已上线定时器，v0.7.0）：`setTimeout` 链 + `timer.unref()`（scheduler.js:197-229）；状态全量持久化单行表 `hospital_tender_scheduler_state`（迁移 0016+0026：enabled/interval/cursor/cycle 计数/last_* 全景/`next_run_at`/窗口 9-20），重启恢复 = `start()` 读 `nextRunAt` 重排；单行租约锁（15min lease）；窗口判定 `activeWindowWaitMs` 用**固定 UTC+8 偏移**（L50-72，中国无夏令时，fail-open）；管理面四端点（GET/POST run-next force/PATCH/GET runs，server.js:4055-4168，user 鉴权）；测试模式 = 固定 clock 注入 + `await scheduler.runNext({force:true})` 手动 tick 不启 timer + tmpdir 真库（`hospital-tender-scheduler.test.js:58-91`）。

**v0.7.4 设计的 60s 提醒循环**（F，未实施）：`actionReminders/reminderScheduler.js`，"表即队列"（`remind_at<=now AND reminded_at IS NULL` 扫描），无状态表无锁，幂等 = outbox 唯一键 + `reminded_at` 标记双保险，`deliveryReady()` 前置门（worker 离线不扫描不标记）。**与本版的协同裁定见第三章**。

**outbox 通道**（迁移 0019 + `weixin/outboxRepository.js`）：
- `enqueue({owner, conversationId, idempotencyKey, payload})`：`UNIQUE(owner, idempotency_key_hash)`——同键同内容 `replayed:true` 静默去重，**同键异内容 409**（L109-115）。这意味着"每 tick 无脑重 enqueue"不可行（当日数据变化后同键异内容会炸 409），必须先查"是否已发"（3.3 的 marker 机制）。
- payload ≤20KB（L6）；**禁键双正则**（L7、L52）：`confirmation/code/token/secret/credential/password/authorization`（下划线段精确匹配）+ `owner/actor/identity/account/source/idempotency`（**任意子串**！`sources`、`sourceRefs`、`identityKey` 均违禁）——payload 必须走招标通知的"预渲染 lines"模式规避（0.3 下条）。
- 渲染在服务端出箱时：GET 出箱路由（server.js:3163-3196）`leaseNext({renderMessage: shortcutBookkeepingAssistantRuntime.renderOutboxMessage})`，渲染上限 20000 字（outboxRepository.js:160）；`renderOutboxMessage` 按 **`payload.kind` 分发**（shortcutBookkeepingRuntime.js:1217-1223：`hospital_tender_notice` → 招标渲染；advance_allocation；默认记账草稿）——**晨报/收尾包 = 各加一个 kind 分支，零结构改动**。
- 投递：outboxWorker 5s 轮询（`config.weixinOutboxPollMs` 默认 5000）→ 绑定私聊 `bot.sendMessageTo`；worker 掉线时消息滞留 queued **离线不丢**；失败 2s 指数退避 ≤8 次。
- 就绪判定：`weixinTenderDeliveryReady()`（server.js:2574-2583）= `runtime.ready && runtime.isReadyFor(runtime.owner)`；owner/conversationId 解析 `runtime.owner` / `runtime.conversationFor(owner)`（L2589-2592）。**晨报接线照搬招标**。

**多段消息长度惯例**（`hospitalTender/weixinNotifier.js`）：单条消息目标 `MAX_MESSAGE_CHARS=3500` 字、头部预留 160、每条 ≤20 行公告（L3-6）；超限自动分块为多条 outbox 消息，头部标注 `（第 N 轮 i/n）`（L33-55、L80-85）；渲染函数 fail-closed（payload 异常/超长直接 throw，绝不发出空或超长消息，L62-90）；幂等键含内容摘要 `hospital-tender:cycle:{n}:chunk:{i}:{sha256前12}`（L146-150）。**晨报四段总量估算 ~600-1200 字（各段 ≤5-8 行），单条消息即可；收尾包 ~800-1500 字（缺失清单各 ≤8 行 + 周报摘要 3 行），也是单条**。设计上仍沿用 3500 上限 fail-closed + 段内行数硬顶，不做分块（内容有界，超限说明取数逻辑有 bug，宁可 fail-closed 报错）。

### 0.4 时区语义

服务器与业务时区均为 Asia/Shanghai（无夏令时）。库内两种惯例并存：① **Intl en-CA 格式化**（businessSnapshotAdapter/settlementSnapshotAdapter/spokenDate.js:15-36，业务日与周界的权威口径）；② **固定 +8 偏移毫秒运算**（scheduler.js:50-61，窗口小时判定）。反例：`hospitalTender/repository.js:376-384` `localDateKey` 用服务器本地时区（仅生产恰好正确，测试不稳）——**本版新代码禁用本地时区方法**，日期字符串用 Intl 口径、小时/星期判定用固定 +8 偏移（`shanghai = new Date(now.getTime() + 8*3600_000)` → `getUTCHours()/getUTCDay()/toISOString().slice(0,10)`），两者对 +8 恒等价。存储与比较一律 UTC ISO。

---

## 一、晨报内容设计

### 1.1 取数规则（owner = `resolveBusinessOwner(runtime.owner)`，非空才生效）

| 段 | 取数 | 排序与截断 | 空集处理 |
|---|---|---|---|
| ① 今日行程 | `visit_itineraries WHERE created_by=$owner AND deleted_at IS NULL AND status='planned' AND visit_date=$today`（$today=上海业务日） | visit_date 单值，按 updated_at DESC；≤3 条；每条解析 plan_json 取 `stops.length` 与首站 `customerName`（按 orderedStopIds[0] 定位，解析失败仅显示 title——fail-open） | 整段省略 |
| ② 待办 | 逾期：`actionItemStore` 查询 `owner=$owner AND deleted_at IS NULL AND status IN ('pending','in_progress') AND remind_at IS NOT NULL AND remind_at < $todayStartUtc`；今日：同条件但 `remind_at ∈ [$todayStartUtc, $tomorrowStartUtc)`。**不看 reminded_at**（到点提醒发过 ≠ 办完，晨报是第二道汇总，正是 v0.7.4 §6.3"不做重复催办、晨报承接逾期汇总"的落点） | 逾期按 remind_at ASC ≤5 条（越久越前），今日按 remind_at ASC ≤5 条；行含 优先级 + ID 尾 6 位（回复闭环沿用 F 的 `完成待办 <尾码>` 语式） | 两类均空则整段省略；只有一类空则只省该小节 |
| ③ 活跃风险 | `riskRows({owner})` 后过滤 `severity==='高' OR score>=80` 取前 3（riskRows 已按 score DESC）；同时统计活跃总数 N | ≤3 条，行含 score/severity/due 文本 | 无高危但 N>0 → 一行"活跃风险 N 条，无高危"；N=0 → 整段省略 |
| ④ 新招标 | `listNotices({firstSeenFrom: 昨日09:00+08 的 UTC ISO, relevance:'high', limit:6})`（0.1 的过滤器扩展）；medium 同窗口仅 `countNotices` 计数 | ≤5 条（第 6 条触发"另有 N 条"提示行）；行 = 标题（≤60 截断）+ 来源 + 截止文本（deadlineText 有值时）；**不含 URL**（与实时推送卡不同——晨报重扫读，链接在系统招标页；开放问题 7.5） | high=0 且 medium=0 → 整段省略；high=0 但 medium>0 → 一行计数 |

待办段对存量数据的边界：`remind_at IS NULL` 的行（深写回历史待办、Web 手工建的）不进时间判定——追加一行计数"另有未排期待办 N 条"（`remind_at IS NULL AND status IN ('pending','in_progress')` 且 owner 三分支可见，复用 `actionRows` 的 join 口径），提示去系统或用"提醒我…"补时间。

### 1.2 "今日焦点"排序逻辑

晨报首行（问候语后）给 1 条焦点，按以下优先级取第一个命中（确定性规则，不经模型）：

1. 逾期高优待办（priority='高' 且逾期，取 remind_at 最早一条）→ `焦点：逾期待办「{title}」已过期 {n} 天，建议今天处理`
2. 今日行程（有）→ `焦点：今天有 {N} 站拜访，首站 {customerName}`
3. score≥80 风险（取分最高）→ `焦点：风险「{title}」（{score} 分）待处理`
4. 昨日以来新高相关招标（取最新）→ `焦点：新招标「{title 截30}」值得关注`
5. 均无 → 省略焦点行

论证：焦点是"睁眼第一件事"，逾期高优是唯一带"欠账"性质的信号故居首；行程是当天时间刚性最强的事项；风险与招标是关注型信号殿后。全部来自已取数据，零额外查询。

### 1.3 排版模板（微信纯文本，扫读友好）

```
【小小晨报】08-28 周五
焦点：今天有 2 站拜访，首站 日照中医医院

■ 今日行程（2 站）
· 日照两院拜访 ｜ 2 站 ｜ 首站 日照中医医院
· （≤3 条）

■ 待办（逾期 1 ｜ 今日 2）
逾期：
· [高] 给王工送方案 ｜ 昨天 09:00 ｜ a1b2c3
今日：
· [中] 回访张主任 ｜ 14:00 ｜ d4e5f6
另有未排期待办 3 条。

■ 活跃风险（共 4 条，高危 1）
· [高·82分] 移动云数据自主权分歧 ｜ 截止 本周五

■ 新招标（昨日以来 高相关 2 条）
· 日照市中医医院信息化设备采购 ｜ 山东政采 ｜ 截止 09-05
· （≤5 条，另有 N 条见系统招标页）
——
回复"完成待办 <编号>"处理待办；发送"行程"/"动作风险"/"招标"查看详情。
```

规则：段落标题带计数；空段整段消失（含分隔）；全部四段皆空 → **不发送**（跳过并记内存标记，见 3.3——宁静优先，避免"无信息打扰"；心跳需求见开放问题 7.2）；每行 ≤50 字（title 截断）；尾部引导行固定（引用既有 router 别名：行程 L511、动作风险 L384、"招标"走招标页——若该别名不存在则文案改"在系统招标监测页查看"，实施时核对 router）。日期行"08-28 周五"由 digestDate 派生（+8 口径）。

### 1.4 payload 与渲染（预渲染 lines 模式，规避禁键）

```js
payload = {
  kind: "daily_digest",
  digestDate: "2026-08-28",          // 幂等锚，也是标题日期
  headline: "焦点：…" | null,
  sections: [                         // 预渲染行，键名避开 0.3 禁键（禁: source*/owner/identity/account/code…）
    { heading: "今日行程（2 站）", lines: ["· …", "· …"] },
    { heading: "待办（逾期 1 ｜ 今日 2）", lines: ["逾期：", "· …", "今日：", "· …"] },
    …
  ],
  footer: "回复…",
}
```

渲染函数 `renderDailyDigestMessage(payload)`（新模块 `dailyDigest/digestMessage.js`）：校验 kind/digestDate/sections 形状，拼装 `【小小晨报】{MM-DD 周X}` + headline + 各段 + footer；任一段 lines 为空数组则跳过该段；总长 >3500 throw（fail-closed，模式抄 `renderHospitalTenderNoticeMessage` L62-90）。**渲染纯函数、不读库**——与招标通知同款"入队即定稿"语义（晨报是时点快照，出箱时不需要 stale 校验；对比记账草稿渲染需查库验版本，L1275-1296——那是"可变草稿"语义，晨报不适用）。

---

## 二、周五收尾包设计

### 2.1 周报草稿：只读引用 + 引导，不自动落库（裁定）

| 方案 | 结论 |
|---|---|
| A. 周五自动调 `POST /api/reports/weekly/draft` 落一份 draft | **否**。三个理由：① 该路径有模型调用与 `weekly_reports` 落库副作用，每周五自动累积一行草稿（用户未必要）；② knowledgeIds 挑选是人工判断（Web 表单如此设计）；③ 审计语义污染——`weekly_report.draft` 现在等价"用户动作"，系统代发会混淆 v0.7.1 实时日志的记账口径。 |
| B. 收尾包内嵌 `salesReportSummary().preview.content` 全文 | **否**。preview 可达 20000 字，超出单条消息预算；且草稿全文在手机上不可编辑，价值低。 |
| C. **引用统计 + 状态分支文案 + 引导指令**（采纳） | `salesReportSummary({owner})` 一次调用拿全：`statusCounts`（本周已存草稿/已保存/就绪）、`preview.sourceRecordCount`（已确认素材数）、`preparation.blockers`。三分支文案见 2.3。用户要看全文发"销售周报"（既有 R0 工具），要落库去 Web 周报页（既有一键生成）。 |

### 2.2 凭证/发票缺失清单：判定规则与文案

- **发票缺失**（费用粒度）：`travelExpenseSummary({owner, weekStart: 本周一})` 的 items 中 `unacknowledgedMissingCents > 0` 者。**口径说明**：取"未确认的缺口"而非 Web 徽标的 `invoice_pending` 状态数（`expenseLedgerWorkbenchModel.js:491-493`）——已走"确认无票"流程（`travel_expense_no_invoice_confirmations`）的费用不该周五再催；两口径差异写入 release notes。行文案：`· {occurredOn MM-DD} {categoryLabel} {purpose 截16} ｜ 可报销 {reimbursement} ｜ 缺票 {unacknowledgedMissing}`（金额 `formatMoney` cents→"X.XX 元" 惯例，shortcutBookkeepingRuntime.js:63-65）。
- **凭证缺失**（对齐前端 `paymentProofMissingCount` 规则，0.2）：新增只读 SQL（digestContent 内 prepared statement）：

```sql
SELECT expense.id, expense.reference_code, expense.occurred_on, expense.category, expense.purpose
FROM travel_expenses expense
WHERE expense.owner = $owner AND expense.deleted_at IS NULL
  AND expense.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days')
  AND NOT EXISTS (
    SELECT 1 FROM travel_expense_attachments attachment
    WHERE attachment.expense_id = expense.id AND attachment.kind = 'payment_proof'
  )
ORDER BY expense.occurred_on, expense.id LIMIT 9
```

- 两清单各 ≤8 行，第 9 行触发"另有 N 笔请在差旅页处理"提示；金额合计行（发票缺失合计 = summary.unacknowledgedMissingCents）。
- 空集处理：两清单皆空 → 该段换成一行正向确认 `本周凭证与发票已齐 ✓`（收尾包与晨报不同：**全空也发**——"确认无欠账"本身是周五收尾的核心信息）。

### 2.3 排版模板与触发时刻

```
【小小周五收尾】本周 08-24 ~ 08-30
■ 周报
（分支一）本周周报已有草稿 1 份（最新：已保存）。发送"销售周报"可查看预览。
（分支二）本周还没有周报。已确认素材 5 条，Web 周报页可一键生成草稿，或发送"销售周报"先看预览。
（分支三）本周暂无已确认的周报素材——快速记录确认后会自动进入周报。
■ 凭证缺失（2 笔）
· 08-26 交通 打车去日照 ｜ 缺支付凭证
■ 发票缺失（1 笔 ｜ 合计 120.00 元）
· 08-25 住宿 如家日照店 ｜ 可报销 120.00 元 ｜ 缺票 120.00 元
——
补传凭证/发票请在系统差旅页操作；发送"报销周报"查看本周报销全景。
```

**触发时刻建议：周五 16:30（Asia/Shanghai），可经 `WEEKLY_WRAPUP_TIME`（HH:MM）配置**。论证：收尾包的两类内容都要求"当天还有行动窗口"——补凭证/发票要在下班前找票、贴票、传照片，周报草稿要在下班前过一眼；17:00 后发等于让动作顺延到下周一；再早（如 15:00）则周五下午的拜访支出还没记完。16:30 给约 1.5-2 小时处理窗，且与 9:00 晨报间隔充分。周五晨报照常发（两者内容不重叠：晨报是"今天做什么"，收尾包是"本周欠什么"）。payload kind=`weekly_wrapup`，结构同 1.4（digestDate 换 `weekStart`）。

---

## 三、调度设计

### 3.1 与 F 提醒循环的关系：**独立模块、同款模式，不共用 tick**（裁定）

| 维度 | 共用 F 的 60s tick（在 reminderScheduler.runOnce 里加晨报检查） | 独立 `digestScheduler`（采纳） |
|---|---|---|
| 实施依赖 | H 依赖 F 先合入且模块 API 稳定；F 延期则 H 无宿主（F 现仅设计稿） | 零依赖，F/H 可任意顺序上线（仅待办**取数**依赖 0028，与调度器无关） |
| 开关语义 | 蓝图要求晨报"可开关（默认开）"，F 提醒默认开且无独立开关诉求——共用 tick 得在循环里塞两套 enable 判定 | `DAILY_DIGEST_AUTO_RUN` 独立生效，关晨报不影响到点提醒 |
| 职责语义 | F 是**数据驱动**（remind_at 扫描，任何一分钟都可能有活干）；H 是**时刻驱动**（每天最多 1+1 次发送，其余 tick 是廉价判定）。塞进同一 runOnce 让两种失败面（扫描 SQL vs 构建四件套）互相污染，fail-open 粒度变粗 | 各自 runOnce 单一职责，测试面独立（F 的调度测试不用 mock 四件套，H 的不用 mock action_items） |
| 资源成本 | 省一个 timer | 多一个 unref 的 setTimeout 链 + 每分钟一次索引点查（marker 命中即返回），可忽略 |
| 代码复用 | 运行实例复用 | **复用的是"构造模式"**：setTimeout 链/clock 注入/`runOnce` 手动 tick/`deliveryReady` 门/status() 内存态，全部照抄 F 设计 §2.1（其又抄招标 scheduler.js:197-229）——三个调度器同构不同容 |

结论：独立循环。若 v0.8.x 定时任务继续增多（I 阶段备份是 systemd timer 不算），再抽象统一 heartbeat 注册器，记入 v0.8.3 工程健康观察项。

### 3.2 实现形态（`backend/src/dailyDigest/digestScheduler.js`，~160 行）

```js
export function createDailyDigestScheduler({
  db, outboxRepository,
  buildDailyDigest,        // async ({ now }) => { payload, empty, stats } —— digestContent 纯函数注入
  buildWeeklyWrapup,       // 同上
  resolveOwner,            // () => shortcutBookkeepingAssistantRuntime.owner（与招标 notifier 同源，server.js:2589）
  resolveConversationId,   // () => runtime.conversationFor(owner)
  deliveryReady,           // () => weixinTenderDeliveryReady() 同款惰性判断
  audit,                   // ({action, entityId, metadata}) => insertAudit(...)
  clock = () => new Date(), pollMs = 60_000,
  dailyHour = 9, wrapupTime = { hour: 16, minute: 30 },
}) => Object.freeze({ start, stop, runOnce, status })
```

`runOnce()` 每 tick（固定 pollMs 间隔，无 nextRunAt 持久化——触发判定本身幂等，重启最多迟一个 tick）：

1. `now` → 固定 +8 换算 `{ date, hour, minute, weekday }`（0.4 口径）。
2. **晨报判定**：`hour >= dailyHour` 且 `!sentMarker("daily-digest:" + date)` 且 `!memorySkip.daily[date]` → `deliveryReady()` 否则本 tick 跳过（下 tick 重试，当日内自然补发）→ `buildDailyDigest({now})` → `empty` 则 `memorySkip.daily[date]=true` + audit `digest.daily.skipped`（metadata.reason="empty"）；否则 `renderDailyDigestMessage(payload)` 预验（fail-closed 提前于入队）→ `outboxRepository.enqueue({owner, conversationId, idempotencyKey: "daily-digest:" + date, payload})` → audit `digest.daily.sent`（metadata: {digestDate, outboxId, lateMinutes, 各段条数}）。
3. **收尾包判定**：`weekday === 5`（周五）且 `hour*60+minute >= wrapupTime` 且 `!sentMarker("weekly-wrapup:" + weekStart)` → 同上流程（kind/audit 换 weekly_wrapup；**空集也发**，见 2.2）。
4. 异常 catch 记内存 lastError，timer 存活（fail-open，照抄 scheduler.js:221-226）。

### 3.3 幂等键与状态：**outbox 行即持久化 marker，零状态表**（裁定）

- 幂等键：晨报 `daily-digest:{digestDate}`、收尾包 `weekly-wrapup:{weekStart}`（owner 已在唯一约束里，键内不重复；键名不带敏感词）。**一天一键、一周一键**——与招标"每 cycle+chunk+内容哈希一键"不同，晨报键**不含内容哈希**，因为同一天不允许第二条（内容随时间漂移，含哈希会重发）。
- `sentMarker` 实现：`outboxRepository` 新增只读方法 `hasKey({owner, idempotencyKey})`（`SELECT 1 … WHERE owner=$owner AND idempotency_key_hash=$hash`，键哈希封装在 repository 内部，~8 行；迁移 0019 的 UNIQUE 约束即索引，点查 O(logN)）。**enqueue 成功的那一行就是持久化的"今日已发"标记**：重启后 marker 仍在（0.3 已证同键异内容会 409，所以必须查了再发——这个约束反过来保证了 marker 的强一致：查到 = 一定发过，没查到 = enqueue 必然成功或抛错重试）。
- **重启后不重发**：marker 在库。**错过窗口的补发语义**：
  - 当日 9:00 宕机、14:00 恢复 → 首 tick 判定 `hour>=9 && !marker` → **当日补发**（metadata.lateMinutes 标注；消息内容按补发时刻现算，行程/待办仍是"今天"的，语义无损）。
  - 跨日宕机（周三 9:00 断到周四 10:00）→ 周三的晨报**不补**（键含日期，周四 tick 只判周四）——过期晨报没有行动价值，周四的新晨报自然覆盖。
  - 周五收尾包错过整个周五 → **不补到周末**（周六 weekday≠5 不触发）；下周五新键。理由：周末补发打扰 > 价值，且周一晨报会把逾期待办再次拉起；若真机反馈需要，改为"weekday>=5 且 weekStart 同周"一行条件（开放问题 7.3）。
  - `deliveryReady=false`（worker 离线）→ 不 enqueue 不标记，当日内每 tick 重试，恢复即发；整日离线则同"跨日宕机"。（对比方案"先 enqueue 靠 outbox 滞留"被否：绑定未配置时消息会永久滞留 queued，且 runtime.owner 可能为空导致 enqueue 参数不合法。）
- **可开关（默认开）**：`config.dailyDigestAutoRun`（env `DAILY_DIGEST_AUTO_RUN`，默认 = 生产 true / 非生产 false，模式照抄 `hospitalTenderAutoRun` config.js:300-304）；装配 `if (dailyDigestAutoRun && options.dailyDigestSchedulerEnabled !== false) digestScheduler.start()`；测试经 options 注入 clock 与禁启（照抄 server.js:2625-2633）。运行时开关不做（零迁移无处持久化；env 改 + 重启生效；Web 管理面记开放问题 7.4）。

### 3.4 管理与可观测（最小面）

- `GET /api/assistant/digest/status`（user 鉴权，模式抄 L4059）：`{ item: scheduler.status(), markers: { daily: { date, sent }, wrapup: { weekStart, sent } } }`（markers 现查 hasKey）。
- `POST /api/assistant/digest/run`（user 鉴权）body `{ kind: "daily"|"wrapup", dryRun?: true }`：`dryRun` → 构建 + 渲染，**返回消息文本不入队**（生产验收的核心工具：发布当晚就能看到"明早会发什么"）；非 dryRun → 绕过时刻门但**不绕 marker**（已发过则 409 语义返回 `{status:"already_sent"}`，防误操作重发）。
- 审计：`digest.daily.sent` / `digest.daily.skipped` / `digest.weekly_wrapup.sent`（entityType `assistant_digest`，entityId = digestDate/weekStart，actor `system:daily-digest`，`insertAudit` 签名 auditRepository.js:51-91）。skipped 仅空集时记（memorySkip 保证每进程每日至多一次，重启重复可容忍）。v0.7.1 记账实时日志按记账前缀过滤不受影响。

---

## 四、招标陈账修复（`last_error="Internal hospital tender snapshot is invalid"`）

### 4.1 git 考古结论（陈账文本从哪来、为何现在"不可能再现原文"）

| 时点 | 事实（git 实证） |
|---|---|
| 08-16 `09c16ec`（内化采集器） | `internalRunner.js` 引入该英文文案，且**语义模糊**：`readFile+JSON.parse` 失败与 `normalizeHospitalTenderSyncPayload` 失败共用同一条 "Internal hospital tender snapshot is invalid"；exit code ≠0 则是另一条 "monitor failed"。当时 cli `run-and-export` 已是原子写（tmp+replace）+ run 失败不写文件退出码 1 |
| 08-17 `faf147d`（v0.6.11，partial-safe） | vendor runner `success = failed==0 or successful>0`——只要有一个来源成功即导出快照；来源页变化/单源失败从此**不再**导致 exit 1，而是快照 sources[].status='error' → 主系统记 partial |
| **08-20 生产陈账** | 生产运行 v0.6.11+ 代码。综合上两行：exit 0 ⇒ 文件已原子写完整 ⇒ readFile/JSON.parse 几乎不可能失败 ⇒ **陈账几乎必然 = Node 侧 `normalizeHospitalTenderSyncPayload` 抛错（快照结构级校验拒绝）** |
| 08-27 `5fd82b5`（v0.6.26，硬化） | ① internalRunner 错误**分阶段拆分**（snapshot_read/parse/normalize 各自独立文案）；② vendor 加单源 45s 请求预算、批量原子入库；③ scheduler `safeError`（scheduler.js:106-124）把阶段映射为中文：snapshot_parse→"医院招标快照解析失败"、snapshot_normalize→"医院招标快照校验失败" |
| 08-27 22:44 v0.7.0 上线 | 窗口 9-20 生效；当晚 runNext → waiting（**waiting 分支只更新 lastStatus/nextRunAt，不清 lastError**，scheduler.js:248-252——陈账英文文本因此存活至今）；nextRunAt=08-28T01:00Z（今晨 9:00） |

**推论 A（文本层）**：v0.6.26 起代码里已无该英文文案（全库 grep 仅剩蓝图引用）。今晨 9:00 首轮之后，`lastError` 只有三种可能：`null`（成功，运行成功路径显式置 null，scheduler.js:269/349/516）、新中文文案（失败）、**原封不动的英文陈账 ⇒ 首轮根本没跑**（enabled=false / nextRunAt 被改 / 锁滞留 / 进程未启动），这是最重要的判别式。

**推论 B（根因层）**：normalize 抛错的机制是**全有全无**——`sync.js:212` `input.notices.map(normalizeIncomingNotice)` 中**任一**公告字段违规即拒绝整个快照（≤500 条全部陪葬）；而 `ingestHospitalTenderSnapshot` 的逐条容错 try/catch（L308-315）只包住 match/upsert，**不包 normalize**。字段边界两侧不对称是引爆条件：Python 侧 `TenderNotice` 只做空白归一**不限长**（vendor models.py:30-31），Node 侧 `NOTICE_FIELD_LIMITS` 硬限（repository.js:31-54：title≤2000/url≤2048/identityKey≤500/contentText≤20000/purchaser≤500/budgetText·deadlineText≤500/city≤100/hospitalNames≤50 项×200/sourceItemId≤300）。

### 4.2 根因排查方向（按概率排序）

1. **单条公告字段越界（最可能）**：来源页面变化（政采网列表页/详情页选择器漂移）导致某字段抓进整段页面文本——title 吞正文、URL 带超长跟踪参数、purchaser 吞落款段；或宽泛公告命中过多客户医院名（hospitalNames>50 项）。触发即整快照拒绝、且**每 2h 重轮巡都从来源重新抓到同一条**（vendor SQLite 在 tmpdir、每轮全新，`internalRunner.js:99-101`），失败持续到来源翻页把该条挤出列表——与"08-20 起持续报错"的观测吻合。
2. **run 条目时间倒挂**：`normalizeRun` 拒绝 `finishedAt < startedAt`（sync.js:172）——vendor 导出 runs ≤20 条，时钟回拨可触发。低概率。
3. **snapshot_read/parse**（旧文案的另一半语义）：原子写 + 退出码检查已排除常规路径；仅剩磁盘满导致 tmp 写残（Python 会异常退出非 0，仍到不了 read）→ 基本排除。
4. **环境问题**（python3 缺失/代理劫持）→ 旧文案是 "monitor failed"/"could not be started"，**文本不符，排除**；且 5fd82b5 已加 NO_PROXY 隔离（internalRunner.js:40-44）。

### 4.3 修复方案（本版并入，零迁移）

1. **normalize 单条容错（结构修复，核心）**：`normalizeHospitalTenderSyncPayload(input, { lenientNotices = false })`——lenient 模式下逐条 try/catch：先**钳制可截断字段**（title/contentText/purchaser/budgetText/deadlineText/city 超长截到限值——截断无业务损失），再校验；仍失败（url/identityKey/publishedAt 等不可截断字段违规）则剔除该条并收集 `rejectedNotices: [{ index, reason }]`（reason=TypeError message，形如 "notice.title is too long"，**不含内容**）。仅 `internalRunner.js` 走 lenient（自家采集器，稳定性优先）；**HTTP sync 路由保持严格 422**（外部推送接口，契约不放松）。scheduler 消费：`collected.rejectedNotices.length > 0` → 该 cycle 记 partial（`lastError = "快照剔除 N 条异常公告"`、run.errorText 附 ≤3 条 reason 摘要 ≤500 字）——**其余公告照常入库与推送，单条坏数据不再阻塞全链路**。~35 行 + internalRunner ~10 行 + scheduler ~15 行。
2. **诊断留痕**：上一条的 rejected reasons 进 `hospital_tender_runs.error_text`（有界、无内容、可经 GET runs 查看）——弥补"tmpdir 快照阅后即焚、失败现场无法复盘"的观测空洞（这正是 08-20 陈账两周查不了根因的原因）。
3. **不做**：不改 vendor Python 限长（Node 侧钳制已闭环，vendor 保持上游原样最小 diff）；不加重试语义（调度器 2h 自然重试已够，lenient 后"同一坏条反复失败"退化为"反复剔除"，无害）。

### 4.4 今晨 9:00 首轮验证清单（无论自愈与否都执行，结果记入 v0.7.6 release notes）

1. `GET /api/hospital-tenders/scheduler`：`lastStartedAt/lastFinishedAt ≥ 2026-08-28T01:00:00Z`？`lastStatus ∈ success/partial`？**`lastError` 是否已从英文陈账变为 null/新中文**？`cycleNumber` 递增？`nextRunAt ≈ lastFinishedAt + intervalMinutes`（生产 state 持久值为准，蓝图 B 阶段口径 120min）？
2. `GET …/scheduler/runs`：今晨批次逐条 status/errorText（游标分批，一轮多条 run）。
3. `GET /api/hospital-tenders/sources`：各来源 status/lastSuccessAt/lastError 今晨刷新情况——区分"来源采集失败（partial，预期内）"与"快照校验失败（本修复目标）"。
4. 若有新高相关：`notificationCount` >0 且用户微信收到推送卡（provider=weixin）。
5. **若 lastError 仍是英文原文** ⇒ 按推论 A 走"没跑"排查：state.enabled、nextRunAt 值、`lock` 的 lockedUntil 是否滞留未来、systemd 服务日志确认进程活着、必要时 `POST …/scheduler/run-next`（force）手动触发观察。
6. **若报新中文"医院招标快照校验失败"** ⇒ 根因即 4.2-1 且**仍在发生**：本版修复上线后经 runs.errorText 的 rejected reason 直接定位字段，再决定是否需要修来源适配器。
7. **若已自愈**（success/partial 且新公告入库）⇒ 修复第 1、2 条**仍然实施**（结构性韧性：下一次来源页变化不再全链路熄火），验证清单结果归档。

---

## 五、技术方案

### 5.1 文件清单（精确路径）

| 文件 | 新/改 | 内容 |
|---|---|---|
| `backend/src/dailyDigest/digestContent.js` | **新**（~260 行） | `createDigestContentBuilder({db, snapshotAdapter, actionItemStore?, tenderRepository, clock})` → `buildDailyDigest`/`buildWeeklyWrapup` 纯组装：四件套取数（1.1）+ 焦点（1.2）+ 收尾包取数（2.1/2.2，含凭证缺失 SQL）+ payload 组装（1.4）。行程单日 SQL 与凭证 SQL 为模块内 prepared statement |
| `backend/src/dailyDigest/digestMessage.js` | **新**（~120 行） | `renderDailyDigestMessage`/`renderWeeklyWrapupMessage` fail-closed 渲染（1.3/2.3 模板，3500 上限） |
| `backend/src/dailyDigest/digestScheduler.js` | **新**（~160 行） | 3.2 的 60s 循环 + marker + audit + status |
| `backend/src/weixin/outboxRepository.js` | 改（+~8 行） | `hasKey({owner, idempotencyKey})` 只读点查（3.3） |
| `backend/src/assistant/shortcutBookkeepingRuntime.js` | 改（+4 行） | `renderOutboxMessage` L1220 旁加 `daily_digest`/`weekly_wrapup` 两分支 → import digestMessage（依赖方向 assistant→dailyDigest，与 hospitalTender/weixinNotifier 同向，无环） |
| `backend/src/hospitalTender/sync.js` | 改（~35 行） | lenient normalize（4.3-1：钳制 + 逐条剔除 + rejectedNotices） |
| `backend/src/hospitalTender/internalRunner.js` | 改（~10 行） | snapshot_normalize 段改走 lenient，`{payload, rejectedNotices}` 上抛 |
| `backend/src/hospitalTender/scheduler.js` | 改（~15 行） | 采集段消费 rejectedNotices → partial 记账 + run.errorText 摘要（4.3-2） |
| `backend/src/hospitalTender/repository.js` | 改（~12 行） | `normalizeListFilters`/`noticeWhere` 增 `firstSeenFrom`（iso 校验 + `first_seen_at >= $firstSeenFrom`）（0.1） |
| `backend/src/server.js` | 改 | ① 构建 digestContent/digestScheduler 并按 config `start()`（模式照抄招标段 L2610-2633：options 注入 clock/`dailyDigestSchedulerEnabled`）+ `server.close` 时 `stop()`（L7269 旁）；② `GET /api/assistant/digest/status` + `POST /api/assistant/digest/run`（3.4，user 鉴权）；③ audit 闭包注入 |
| `backend/src/config.js` | 改 | `dailyDigestAutoRun`（默认=生产 true）、`dailyDigestHour`（默认 9，0-23 钳制）、`weeklyWrapupTime`（默认 "16:30"，HH:MM 解析失败回默认）、`dailyDigestPollMs`（默认 60000，钳 [5000, 600000]） |
| `backend/src/db/migrations/` | **不改** | 零迁移（5.2） |
| `CHANGELOG.md`、`docs/releases/v0.7.6.md`、`VERSION`、蓝图 H 行 + 遗留登记第 1 条 | 改 | DoD 惯例 + 陈账核销记录（4.4 清单结果） |

### 5.2 迁移必要性论证：零迁移

- **无新表**：调度状态 = outbox 行（marker，3.3）+ 内存态（status 观测）；触发时刻 = env 配置。对比招标三表（0016）：招标有游标/快照/周期计数等**必须跨重启的业务进度**，晨报的"进度"只有"今天发没发"一比特，outbox 唯一键天然承载。若未来要"每 owner 独立晨报时刻"再议状态表（多用户是 v0.9+ 命题）。
- **无新列**：四件套与收尾包全部现有列可判定；待办段的 owner/remind_at 由 F 的 0028 提供（属 F 的迁移，非本版）。
- **招标修复零迁移**：lenient normalize 是纯代码路径，runs.error_text 列现成。

### 5.3 装配与依赖注入（server.js 内）

```js
const digestContentBuilder = createDigestContentBuilder({
  db,
  snapshotAdapter: assistantBusinessSnapshotAdapter,     // itinerary/risk/travelExpense/salesReport 四查询现成
  actionItemStore,                                       // F 已合入时注入；未合入传 null → 待办段降级（6.1-D1）
  tenderRepository: hospitalTenderRepository,
  resolveBusinessOwner,
  clock: options.dailyDigestClock ?? (() => new Date()),
});
const dailyDigestScheduler = createDailyDigestScheduler({
  db, outboxRepository: weixinConfirmationOutboxRepository,
  buildDailyDigest: digestContentBuilder.buildDailyDigest,
  buildWeeklyWrapup: digestContentBuilder.buildWeeklyWrapup,
  resolveOwner: () => shortcutBookkeepingAssistantRuntime.owner,
  resolveConversationId: () => shortcutBookkeepingAssistantRuntime.conversationFor(shortcutBookkeepingAssistantRuntime.owner),
  deliveryReady: weixinTenderDeliveryReady,              // L2574 同一闭包
  audit: ({ action, entityId, metadata }) => insertAudit(db, { action, entityType: "assistant_digest", entityId, actor: "system:daily-digest", metadata }),
  clock: options.dailyDigestClock ?? (() => new Date()),
  pollMs: config.dailyDigestPollMs, dailyHour: config.dailyDigestHour, wrapupTime: config.weeklyWrapupTime,
});
```

注意 `snapshotAdapter` 的构建时钟：既有装配里 adapter 有自己的 clock 注入（server.js 构建处）——晨报测试若要冻结"业务日"，需把同一注入时钟同时传给 adapter 与 digest（集成测试经 `options.assistantSnapshotClock` 同源注入，实施时核对该 options 键名）。

### 5.4 测试面（`backend/tests/`，node:test + tmpdir 真库惯例）

| 文件 | 用例要点 |
|---|---|
| `daily-digest-content.test.js`（新） | 四件套各态：行程今日命中/明日不进/cancelled 不进/plan_json 损坏 fail-open；待办逾期与今日窗口边界（**UTC 时钟落在上海日界两侧**：23:59Z vs 16:00Z 前后）、reminded_at 已标仍列、未排期计数、store=null 降级路径；风险高危过滤与仅计数行；招标 firstSeenFrom 锚点、high 列表 + medium 计数、第 6 条截断；焦点排序五分支；全空 → empty:true；收尾包三分支文案、凭证 SQL 正反例（有 payment_proof/仅 invoice 附件/无附件）、发票 unacknowledged 口径（已确认无票不列）、全齐正向行 |
| `daily-digest-message.test.js`（新） | 模板拼装/段落省略/周X 换算/超长 fail-closed throw/payload 经 `inspectPayload` 不触禁键（直接调用 outboxRepository 内部校验或 enqueue 冒烟） |
| `daily-digest-scheduler.test.js`（新） | **时钟注入照抄 hospital-tender-scheduler.test.js:69-91**（固定 clock + `await runOnce()` 手动 tick + 真 outboxRepository）：08:59 不发/09:00 发/同日再 tick 不重发（marker）/**新建 scheduler 实例（模拟重启）不重发**/14:00 当日补发 + lateMinutes/次日新键再发/跨日不补/全空 skip + audit + 同日不重算/deliveryReady=false 顺延后补发/周五 16:29 不发 16:30 发/非周五不发/周五晨报收尾包同日两条各自幂等/enqueue 抛错不写 marker 下 tick 重试 |
| `hospital-tender-sync.test.js`（扩展） | lenient：超长 title 钳制入选/超长 identityKey 剔除其余保留/rejectedNotices reason 断言/严格模式行为不变（HTTP sync 路由回归） |
| `hospital-tender-scheduler.test.js`（扩展） | 快照含 1 条坏公告 → partial + lastError "快照剔除 1 条异常公告" + 其余入库推送照常 + run.errorText 摘要 |
| `hospital-tender-repository.test.js`（扩展） | firstSeenFrom 过滤正反例 + 与 relevance 组合 |
| `weixin-outbox-repository.test.js`（扩展） | hasKey 正反例（同 owner 命中/异 owner 不命中/未入队 false） |
| `api.test.js` 或新 http 集成 | digest status 端点鉴权与形状；run dryRun 返回渲染文本且不入队；run 非 dryRun 触发后 already_sent；**出箱链路打通**：runOnce → GET 出箱路由 lease → message 断言含"【小小晨报】"（renderOutboxMessage 分支生效） |

门禁：后端全量 + 前端 qa:local + Chrome/WebKit 集成 + 密钥扫描 + 根 test:deploy（DoD 固定项）。前端零改动。

---

## 六、依赖漂移点（对 v0.7.3/0.7.4/0.7.5 实施结果）

| # | 依赖 | 现状（调研实测） | 实施前核对动作 |
|---|---|---|---|
| D1 | **v0.7.4 迁移 0028（owner/remind_at/reminded_at）+ actionItemStore** | 仅设计稿；工作树无 0028 | 晨报待办段的硬依赖。**F 先合入（蓝图顺序）**：注入 store、按 1.1 取数，核对 store 导出面（`list/dueReminders` 签名、owner 三分支 SQL）。**F 延期而 H 先行**：`actionItemStore: null` → 待办段降级为一行 `未完成待办 N 条`（复用 dashboardSummary openActions 口径），degraded 事实写 release notes，F 上线后一行注入即升级 |
| D2 | **v0.7.4 提醒循环并存行为** | 60s 循环设计稿 | 9:00 整点的待办若恰有 remind_at=09:00，用户将**先后收到提醒卡与晨报两条**（提醒是精确闹钟、晨报是汇总，语义不同**不去重**）；两调度器互不感知（3.1 已论证不共用 tick）。联调用例：同一分钟双消息各自幂等 |
| D3 | **v0.7.3 快速记录 agent** | 未提交改动落入中（spokenDate.js/quickRecords/ 已在） | 零代码依赖（`salesReportSummary` 的 `source_channel='微信助手'` 分支是**已上线代码**）；v0.7.3 上线后微信快速记录使周五收尾包的周报素材计数自然变多，属预期增益。`spokenDate.js` 的 `businessDateOf/addDays/weekStartOf` 为模块私有（L30-48）——本版**不复用**（digest 自带 +8 换算 4 行，避免对未冻结模块的导出面依赖；若 F 实施时已将其导出，实施者可改为复用） |
| D4 | **v0.7.5 商机 agent** | 仅设计稿 | 零交集（晨报无商机段，蓝图四件套即边界）；其对 `server.js` 的 opportunityStore 迁出会使本版 server.js 改动行号漂移，语义定位不受影响 |
| D5 | **renderOutboxMessage kind 分发点** | L1217-1223 现有三分支 | v0.7.4 也要在同处加 `action_reminder` 分支——**三版（F/H）并行实施时该 if 链是唯一共享改点**，合同：各自新增互斥 kind、先落者在前追加，冲突为相邻行级 |
| D6 | **outboxRepository.hasKey 新增** | 本版新增 | 与 F 的 enqueue 用法无交集；若 F 实施者也需要类似查询（其设计未用），共用本方法 |
| D7 | **router/policy/registry** | 本版**零改动**（晨报是纯推送，无新意图/工具/确认级） | 唯一例外：若采纳开放问题 7.1 的"晨报"手动意图，才触碰 router——默认不做，与 F/G 的 naturalPlan 顺序合同零交集 |

---

## 七、风险与开放问题

### 7.1 风险

1. **9:00 消息拥挤**：晨报、招标窗口首轮推送（如有新高相关）、到点提醒（如有 9:00 待办）可能同分钟三条。可接受（三者语义不同、频率低——招标仅新高相关才发）；若真机反馈嘈杂，把 `dailyDigestHour` 调 8 或招标窗口起点调 10（均为现成配置/PATCH，零代码）。
2. **marker 对 outbox 语义的寄生**：`hasKey` 假设"入队过 = 发过"。终态 failed（8 次重试耗尽）的晨报不会重发——接受（当日重发窗口内 outbox 自身在退避重试；整日失败说明通道故障，晨报重发无济于事）。运维手册注明：手工 `requeueFailed` 可恢复投递（outboxRepository.js:250-269 仅限 retryable 错误码）。
3. **待办口径漂移**：晨报"逾期"含 reminded_at 已标的行（1.1 论证），与 F 提醒的"单次提醒"形成"提醒一次 + 每日晨报追账"的组合催办——若用户觉得重复，F 的 defer（顺延）即消除（remind_at 后移出窗口）。
4. **收尾包发票口径与 Web 徽标不一致**（unacknowledged vs invoice_pending，2.2 已论证）：release notes 写明两口径定义，避免"微信说 1 笔、Web 徽标 2 笔"的疑惑。
5. **周五 16:30 时点的数据时效**：16:30 后新增的当周费用不在当次收尾包——周一晨报不覆盖费用域。接受（下周五兜底；发票补齐本就有跨周窗口）。
6. **招标 lenient 的过度宽容**：钳制/剔除可能掩盖来源适配器退化（数据静默变少）。对冲：rejected>0 必记 partial + errorText 摘要（4.3-2），管理页 runs 列表可见，不会静默。

### 7.2-7.6 开放问题（默认保守，不阻塞实施）

2. **全空晨报是否发"心跳版"**：当前裁定不发（1.3）。若用户希望"每天 9 点必有一条以确认系统活着"，改 empty 分支为单行极简版（一处 if）。真机验收时问询。
3. **错过周五的收尾包周末补发**：当前不补（3.3）。若财务流程要求周内必达，放宽 weekday 判定至周六 12:00 前。
4. **运行时开关/时刻调整的 Web 管理面**：本版 env-only；若需要，做法同招标 PATCH（需状态表承载，破坏零迁移）——并入 v0.8.x 与 J 阶段设置页统一。
5. **晨报招标行是否带 URL**：当前不带（1.1）。实时推送卡已带 URL；晨报带链接会显著拉长消息。真机反馈决定。
6. **"晨报"手动拉取意图**（微信发"晨报"即时获取当日版）：D7 已述，本版用 `POST /api/assistant/digest/run` dryRun 覆盖验收需求；真机若高频需要，加 R0 工具 `dashboard.dailyDigest`（复用 digestContent + 直接回复不走 outbox，~40 行）。

---

## 附：实施顺序建议（单人 ~2.5 人日）

1. 招标修复三件（sync lenient + internalRunner + scheduler 消费）+ repository firstSeenFrom + 单测（0.5d，独立可先行，**并在当天生产热修窗口先行验证 4.4 清单**）
2. digestContent 四件套 + 收尾包取数 + 单测（0.5d；D1 现状决定待办段走 store 还是降级）
3. digestMessage 渲染 + outboxRepository.hasKey + runtime kind 分支 + 单测（0.5d）
4. digestScheduler + server.js 装配/端点/config + 调度单测（0.5d）
5. http 集成（status/run/出箱 lease 链路）+ 门禁全绿 + release notes（含 4.4 验证结果与口径说明）（0.5d）
