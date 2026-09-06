# 战情总览升级 + 行程→差旅联动 —— 实施设计（调研定稿）

- **实施版本:v0.8.3**（总蓝图 K 行。原编号 v0.8.2 已让位给"差旅工作台整改"，本设计顺延为 v0.8.3，文件名保留 v082 前缀不改）。
- 调研基线:worktree `.worktrees/integrate-v0626-candidate`，`VERSION=0.8.0`。**v0.8.1 视觉统一正在并行施工**，本文引用的前端行号（尤其 `pages.jsx`、`global.css`）以 v0.8.0 为基线，实施时可能漂移，请以符号名（函数/类名）重新定位。视觉规范一律以 `docs/superpowers/research/2026-08-27-visual-audit-v081.md` 的基准 token 为准（卡片圆角 10 / 控件 8 / 胶囊 999、海军蓝灰文本系 `#1c2b3a/#5a6c7f/#8a97a6`、44px 触控、焦点环 `2px #2f6fed33`）。
- 结论速览:**零迁移、零新依赖、零新端点**。战情总览通过扩展 `GET /api/dashboard/summary` 响应字段实现（合同容忍新增字段，同仓同发）；行程→差旅联动通过既有 URL filters 机制传参预填，创建仍走既有 `POST /api/travel-expenses`。

---

## 1. 现状调研摘要（读码结论，非猜测）

### 1.1 战情总览现状

- **前端**:`Overview` 组件位于 `outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx` L116-L298（非独立文件）。当前渲染:hero 卡（`overview-hero`）、4 张 KPI `MetricCard`（`overview-kpi`，客户/商机/风险预警/周新增记录）、`StageStrip` 商机阶段分布（`overview-stage`）、健康度红黄绿（`overview-health`）、今日优先动作 `CompactList`（`overview-priority`，取 `summary.priorityActions` 前 4）、最近快速记录（`overview-records`）、本日推进节奏（`overview-rhythm`，**硬编码静态文案**"18:00 整理本周记录"等，无数据源）。
- **数据链路**:`App.jsx` 启动时 `loadBootstrap()`（`src/api/salesWorkbenchApi.js`）并行拉取 8 个端点，其中 `GET /api/dashboard/summary` 的 `item` 即 `summary`；另有 `refreshOverviewSummary()` 在写操作后静默刷新同一端点。`businessSnapshotAdapter` 是**微信机器人侧**的快照适配器（`backend/src/wechat/…`），与 web 总览无关，不要混用。
- **后端聚合**:`backend/src/server.js` 中 `dashboardSummaryFromDb(db)`（约 L1180-L1260 区域，以函数名定位）。现状是把 customers/opportunities/actions/risks/quick_records 全量读入内存后 JS 聚合:`totals`、`stageCounts`（**动态 distinct stage，非固定七阶段，且无金额**）、`highRisks`（`score>=80 || severity==='高'`）、`priorityActions`（P0/P1 未完成前 6）、`weeklyQuickRecordCount`（近 7 天滚动窗，**非自然周**）。**无"本周 vs 上周"对比、无今日行程/招标聚合**。
- **可复用四件套**:`backend/src/dailyDigest/digestContent.js`（v0.7.7 晨报）已实现今日行程（`visit_itineraries WHERE visit_date=$today AND status='planned' AND deleted_at IS NULL`）、到点待办（`action_items` 按 `remind_at` 窗口 + 逾期）、高风险（`risk_items score>=80 OR severity='高'`）、新招标（`tenderRepository.listNotices({ firstSeenFrom, relevance })`）。该文件**已导出** `shanghaiDateParts / addDays / weekStartOf / fridayOfWeek` 等上海时区周口径工具，server.js 可直接 import 复用。注意口径差异:digest 按 `resolveBusinessOwner` 做 owner 过滤（微信多租户防御），web 各列表端点（customers/actions/itineraries）均为全量口径——单用户部署下二者等价，本设计 web 侧沿用**全量口径**以与各工作台列表一致。

### 1.2 图表能力盘点

- **无任何图表库依赖**（`package.json` 仅 react/react-dom/vite 系 + lucide-react 图标）。既有自绘先例:
  - `StageStrip`（`src/components/primitives.jsx`）:固定七阶段卡片条（`fixedStages` 与后端 `backend/src/opportunities/stageVocabulary.js` 的 `KNOWN_STAGES` 一一对应:线索/初步沟通/调研机会/方案输出/方案交流/预算确认/暂停观察），**已支持 `item.amount` 金额文本渲染**（`stage-strip` 样式），未知阶段追加列。
  - `.progress-row i` 纯 CSS 渐变进度条（`global.css`，健康度/节奏卡在用）。
  - 差旅周记里的余额条、`summary-strip` 等均为纯 CSS。
- **结论**:趋势与漏斗全部走纯 CSS（span 宽度百分比 + token 色），不引入依赖，不用 SVG 也够（两组横向条即可表达周对比；漏斗用 StageStrip 增强表达，不做梯形图）。

### 1.3 行程与差旅实体、表单与路由机制

- **`visit_itineraries`**（migration `0005`，无新列需求）:`id/title/visit_date(YYYY-MM-DD)/status(planned|cancelled)/request_json/plan_json/created_by`。前端模型 `visitItineraryModel.js`:`item.request.departureAddress/departureCity`、`item.plan.stops[]`（经 `orderedVisitStops` 排序，含 `customerId/customerName/address/city`）。
- **`travel_expenses`**（migration `0007`）:**已有 `itinerary_id`、`customer_id`、`occurred_on`、`purpose` 列**——联动所需字段天然齐备，零迁移。创建走 `POST /api/travel-expenses`（server.js，payload 经 `backend/src/travelExpense/validation.js` 校验:`weekStart` 必须为周一、`occurredOn` 必须落在该周内、`purpose` 必填 ≤1000 字）。
- **新建费用入口**:`TravelExpensePage.jsx` "手工记一笔"按钮 → `setEditingExpense(null); setEditorOpen(true)` → `ExpenseEditorDrawer.jsx` 的 `createDraft(expense, weekStart)`:新建时 `occurredOn` 默认 `week.start`，`category` 默认 `breakfast`，`itineraryId/customerId` 空。抽屉内日期 input 有 `min={week.start} max={week.end}` 约束。周状态由 `naturalWeekFor(date)`（周一–周日）驱动，切周会重拉 `GET /api/travel-expense-workbench?weekStart=...`（含 `regionProfile`）。
- **路由传参机制**:`src/app/routes.js` 的 filters 是一等公民——`parseFilters` 从 query 解析（key 匹配 `FILTER_KEY_PATTERN`（字母开头字母数字），值非控制字符 ≤512，中文合法），`buildWorkbenchUrl(route)` 反向序列化；`App.jsx` 的 `navigateTo(active, { mode, entityId, filters })` 统一入口，`routeFilters` 状态随路由更新。已有先例:actions 页 `?opportunityId=`、customers 页 `?health=` 等。`travel-expenses` 页为 index-only 页（`PAGE_META`），**当前 `TravelExpensePage` 未接收 `routeFilters`**。`sessionStorage` 无跨页传参先例（storage 仅用于 legacy auth token 清理），不采用。
- **区域档案**:`regionProfile` 随 workbench 按周返回（`weekStart/cities/defaultCity/dateOverrides/version`），保存有 version 乐观锁（`TripRegionSettingsCard`，`regionSettingsOpen` 状态控制展开）。`responsibleRegionModel.js` 有 `normalizeResponsibleCity`、内部 `cityKey`（去"市/地区"后缀归一）。

### 1.4 周趋势数据源现状

- **现成周聚合 SQL 先例**:
  - 销售周报 `backend/src/salesReport/`（v0.7.5）:`quick_records` 按 `date(substr(COALESCE(occurred_at, created_at),1,10)) BETWEEN $start AND $end` 聚合，`voided_at IS NULL`（列由 migration `0002` 追加）。
  - 差旅周合计:`travel_expense_payments.reimbursement_cents` JOIN `travel_expenses` 按 `occurred_on BETWEEN` 聚合（`travelExpenseSummary` 一带）。
  - `action_items` 无按完成周聚合先例，需新查询（见 §3.3，用 `updated_at` 近似完成时间——`actionItemStore.complete/confirm` 均写 ISO `updated_at`）。
- **"本周 vs 上周"口径定义**:自然周（周一 00:00 上海时间起，`weekStartOf(shanghaiDateParts(now).date)`），上周 = `addDays(weekStart, -7)`。与差旅工作台 `naturalWeekFor`、晨报 `weekStartOf` 一致；**不沿用**现 KPI 的"近 7 天滚动窗"。

### 1.5 测试惯例

- 后端:`backend/tests/api.test.js`（node:test + 内存 SQLite + `startServer` 实测 HTTP），已有 dashboard summary 断言（totals/stageCounts 等）；合同校验在 `shared/salesWorkbenchApiContract.mjs`（`assertApiEntity` **容忍多余字段**，新增字段可先发后端不破前端）。
- 前端:`src/app/routes.test.js`（node:test，纯函数双向:`matchRoute`/`buildWorkbenchUrl`/`parseFilters`）；组件级无挂载测试（无 jsdom），惯例是 **`scripts/*.test.mjs` 源码断言 + Playwright 页面走查**（如 `scripts/travel-expense-page.test.mjs`、`scripts/stage-strip-data.test.mjs`、`scripts/module-coverage.test.mjs`）；纯函数模型层测试与被测文件同目录（如 `responsibleRegionModel.test.js`）。

---

## 2. 总览信息架构设计

### 2.1 今日焦点卡（与晨报同源、不同面）

新组件 `TodayFocusCard`（放 `pages.jsx` 内或抽 `src/features/salesWorkbench/TodayFocusCard.jsx`），**替换现"本日推进节奏"静态卡**（`overview-rhythm`，硬编码无价值），网格类名沿用位置或新增 `overview-today`。四段式紧凑布局（一个 Panel 内四行分区，非四张卡，控制视觉密度）:

| 分区 | 数据 | 明细行（≤2 条 + "共 N 条"） | 点击跳转（复用 `setActive` 即 `navigateTo`） |
|---|---|---|---|
| 今天的行程 | `todayFocus.itineraries` | 标题 + 首站客户 | `setActive("itinerary", { mode: "detail", entityId })` |
| 到点待办 | `todayFocus.todos`（逾期数红色 pill + 今日数） | 标题 + 提醒时间 | `openActionList()`（已有 prop） |
| 高风险 | `todayFocus.risks`（复用 highRisks 源） | 客户名 + score | `openRiskList()`（已有 prop） |
| 新招标 | `todayFocus.tenders`（昨日 09:00 以来 high） | 标题 + 来源 | `setActive("hospital-tenders")` |

空态:每分区显示"今日无行程"等短文案（对齐 audit P1-4 空态规范:图标 + 主文案 + 引导句式）。全部触控目标 ≥44px。

### 2.2 周趋势卡

新组件 `WeeklyTrendCard`（`overview-trend`）:三个指标行（快速记录数 / 差旅报销额 / 待办完成数），每行左侧指标名 + 右侧"本周值 vs 上周值 + Δ%"，下方两条纯 CSS 横向条（本周实色 `#2f6fed`、上周浅色 `#2f6fed33`，宽度 = 值/两周最大值，`border-radius: 999px`，高度 8px）。金额显示 `formatCurrencyFromCents` 复用（`travelExpenseModel.js` 已有 `formatMoney` 系）。Δ 为 0 或上周为 0 时显示"持平/新增"，不显示 `Infinity%`。

### 2.3 商机漏斗（七阶段计数 + 金额文本）

- **前端近零改动**:`StageStrip` 已支持 `item.amount` 渲染且固定七阶段兜底。仅把面板标题从"商机阶段分布"改"商机漏斗"，并可选在每阶段卡内加一条宽度 = `count/maxCount` 的纯 CSS 底条增强漏斗感（复用 `.progress-row i` 渐变思路，新类 `.stage-strip__bar`）。
- **后端**:`stageCounts` 改为按 `stageVocabulary.KNOWN_STAGES` 全序输出（含 0 计数阶段），词表外阶段追加尾部；每项增加 `amount` 字段:对该阶段商机 `amount` TEXT 做 `numberFromText` 求和（server.js 已有该工具用于 KPI），输出 `"共 320 万"` 文本，无可解析金额时 `amount: ""`（StageStrip 对空值不渲染金额行）。

### 2.4 布局与移动端折叠策略

- 桌面（12 列 `overview-grid`，`grid-auto-flow: dense`）:hero（保留）+ KPI ×4 不动；第二行起:今日焦点 `span 6` | 周趋势 `span 6`；商机漏斗 `overview-stage` 保持 `span-full`;健康度/优先动作/最近记录顺延（dense flow 自动补位）。
- ≤980px（既有断点，`global.css` L4408 一带）:`overview-grid` 折叠为 2 列，今日焦点、周趋势各 `grid-column: 1 / -1`（加入既有 `overview-hero, overview-priority, overview-stage` 的通栏名单）。
- ≤760px（L4772 一带）:单列顺排，顺序即 DOM 序:hero → KPI → **今日焦点 → 周趋势** → 漏斗 → 其余。移动端今日焦点四分区改为可折叠 `<details>` 或直接保留紧凑列表（推荐后者，避免新交互模式）。
- 样式实施必须在 v0.8.1 合入后进行，全部使用 audit 定稿 token（`--radius-card:10px` 等变量名以 v0.8.1 实际落地为准）。

---

## 3. 数据接口设计

### 3.1 选型:扩展 `GET /api/dashboard/summary`，不开新端点

论证:① bootstrap 与 `refreshOverviewSummary` 已有该端点的拉取/刷新链路，新端点要动 `loadBootstrap` 并行组、api client、失败降级三处；② `assertApiEntity` 容忍新增字段，扩展无兼容断裂；③ 数据全部单库可得，一次响应体积增量 <2KB；④ 最小 API 面原则（蓝图工程健康线）。同仓同发，合同同步登记新字段即可。

### 3.2 响应新增字段 schema（`item` 上追加三键）

```jsonc
{
  "todayFocus": {
    "date": "2026-08-28",
    "itineraries": { "count": 2, "items": [{ "id", "title", "firstStop" }] },   // items ≤3
    "todos": { "overdueCount": 1, "todayCount": 3, "items": [{ "id", "title", "priority", "remindAt" }] }, // ≤4
    "risks": { "count": 2, "items": [{ "id", "customerName", "score", "severity" }] },  // ≤3，同 highRisks 源
    "tenders": { "highCount": 1, "items": [{ "id", "title", "sourceName" }] }   // ≤3
  },
  "weeklyTrend": {
    "weekStart": "2026-08-24", "previousWeekStart": "2026-08-17",
    "quickRecords": { "current": 12, "previous": 9 },
    "expenseCents": { "current": 45600, "previous": 61200 },
    "completedTodos": { "current": 5, "previous": 8 }
  }
  // stageCounts 原位增强: [{ "stage": "线索", "count": 3, "amount": "共 120 万" }, ...] 固定七阶段全序
}
```

### 3.3 每卡精确 SQL / 复用函数清单

`dashboardSummaryFromDb(db, { now = new Date(), tenderRepository } = {})` 扩参。时区/周口径复用 `dailyDigest/digestContent.js` 导出:`shanghaiDateParts(now).date` 得 `$today`，`weekStartOf($today)` 得 `$weekStart`，`addDays` 推导边界。

**今日焦点**（全量口径，理由见 §1.1）:

```sql
-- 今日行程（today-itineraries）
SELECT id, title, plan_json FROM visit_itineraries
WHERE deleted_at IS NULL AND status = 'planned' AND visit_date = $today
ORDER BY updated_at DESC, id LIMIT 4;
-- firstStop 从 plan_json.stops[0].customerName 解析（JS 侧，参照 digestContent 同款解析）

-- 到点待办：$todayStartIso = new Date(`${$today}T00:00:00+08:00`).toISOString()，$tomorrowStartIso 同理 +1 天
SELECT id, title, priority, remind_at FROM action_items
WHERE deleted_at IS NULL AND status IN ('pending','in_progress')
  AND remind_at IS NOT NULL AND remind_at < $tomorrowStartIso
ORDER BY remind_at ASC LIMIT 8;
-- JS 侧按 remind_at < $todayStartIso 切分 overdueCount / todayCount（与 digestContent 待办口径同源）

-- 高风险：直接复用现函数内 highRisks 计算（score>=80 OR severity='高'），仅补 items 截断

-- 新招标：复用 tenderRepository.listNotices({ firstSeenFrom: $anchorIso, relevance: "high", limit: 3 })
-- 与 countNotices 同参取 highCount；$anchorIso = new Date(`${addDays($today,-1)}T09:00:00+08:00`).toISOString()（与晨报"昨日 09:00 以来"同源）
-- 需在 server.js 把已实例化的 tenderRepository 传入 dashboardSummaryFromDb（当前该函数只收 db）
```

**周趋势**（每条 SQL 以 `$weekStart` 参数各跑两次:本周 `weekStartOf($today)`、上周 `addDays(weekStart,-7)`）:

```sql
-- 快速记录数（沿 salesReport 口径）
SELECT COUNT(*) AS count FROM quick_records
WHERE voided_at IS NULL
  AND date(substr(COALESCE(occurred_at, created_at), 1, 10))
      BETWEEN $weekStart AND date($weekStart, '+6 days');

-- 差旅报销额（沿差旅周合计口径；分为方便全量，单用户下与 owner 口径等价）
SELECT COALESCE(SUM(p.reimbursement_cents), 0) AS cents
FROM travel_expenses e JOIN travel_expense_payments p ON p.expense_id = e.id
WHERE e.deleted_at IS NULL
  AND e.occurred_on BETWEEN $weekStart AND date($weekStart, '+6 days');

-- 待办完成数（updated_at 近似完成时间；ISO 与 "YYYY-MM-DD HH:MM:SS" 两种历史格式前 10 位均为日期，substr 兼容）
SELECT COUNT(*) AS count FROM action_items
WHERE deleted_at IS NULL AND status = 'done'
  AND date(substr(updated_at, 1, 10))
      BETWEEN $weekStart AND date($weekStart, '+6 days');
```

**商机漏斗**:在现有内存聚合处改写——`KNOWN_STAGES.map(stage => ({ stage, count, amount }))`（import `backend/src/opportunities/stageVocabulary.js`），`amount` = 该阶段 `opportunities.amount` 逐条 `numberFromText` 求和后 `sum > 0 ? \`共 ${sum} 万\` : ""`（现 KPI 已按"万"口径解析，保持一致）；词表外 stage 追加尾部。

### 3.4 合同变更

`shared/salesWorkbenchApiContract.mjs` 的 `dashboardSummary` schema 增加 `todayFocus`、`weeklyTrend` 必需键，`stageCounts` item 增加可选 `amount`。前后端同仓同发无兼容窗口问题；微信侧不消费此合同条目（用 businessSnapshotAdapter），无涟漪。

---

## 4. 行程→差旅联动设计

### 4.1 交互流

1. 行程详情页（`VisitItineraryPage.jsx` `DetailView` 工具栏）新增"记当日费用"ghost 按钮（lucide `ReceiptText`，44px；列表行不加，避免宽表拥挤）。
2. 点击 → `onRecordExpense(item)` 回调（由 `App.jsx` 注入）→ `navigateTo("expense", { filters: expenseDraftFiltersFromItinerary(item) })` → URL 形如 `/workbench/travel-expenses?draftDate=2026-08-28&draftItinerary=itn_xxx&draftCustomer=cus_xxx&draftPurpose=拜访%20济宁一院&draftRegion=济宁`。
3. `TravelExpensePage` 挂载时消费 draft:周状态初始化为 `naturalWeekFor(draftDate)`（而非本周），自动 `setEditorOpen(true)` 打开新建抽屉并带预填；随即回调 `onExpenseDraftConsumed()` 清掉 URL 参数（replace，防刷新/回退重复弹窗）。
4. 用户补金额/类目后保存，走既有 `POST /api/travel-expenses`（payload 天然带 `itineraryId/customerId`，列已存在）。

### 4.2 参数传递机制

选 **URL filters**（弃 sessionStorage）:routes.js 一等机制、已有 `?opportunityId=` 先例、可测（routes.test.js 纯函数双向）、无隐藏状态、刷新前已消费即无副作用。中文值经 `encodeURIComponent` 合法（`isLegalFilterValue` 允许 ≤512 非控制字符）。具体改动:

- 新纯函数模块 `src/features/visitItinerary/itineraryExpenseLink.js`:
  - `expenseDraftFiltersFromItinerary(item)` → `{ draftDate, draftItinerary, draftCustomer?, draftPurpose, draftRegion? }`（filters 值为单元素数组，符合 parseFilters 结构）。
  - `expenseDraftFromFilters(filters)` → `{ occurredOn, itineraryId, customerId, purpose, region } | null`。**fail-closed**:`draftDate` 不匹配 `/^\d{4}-\d{2}-\d{2}$/` 或缺失即返回 null，整体忽略。
- `App.jsx`:`active === "expense"` 分支给 `TravelExpensePage` 增传 `expenseDraft={expenseDraftFromFilters(routeFilters)}` 与 `onExpenseDraftConsumed`（内部用 `writeBrowserRoute(route, { replace: true })` 清 filters，参照 `initialRoute.replace` 既有用法，不新增历史条目）。
- `TravelExpensePage.jsx`:`useState(() => expenseDraft ? naturalWeekFor(new Date(\`${expenseDraft.occurredOn}T12:00:00\`)) : naturalWeekFor(new Date()))` 初始化周；`useEffect` 首帧若有 draft 则开抽屉并消费（一次性 ref 防重入）。
- `ExpenseEditorDrawer.jsx`:新增 `prefill` prop，仅 `expense == null` 时生效——`createDraft(null, weekStart, prefill)`:`occurredOn = prefill?.occurredOn ?? weekStart`、`purpose = prefill?.purpose ?? ""`、`itineraryId/customerId` 同理、`category` 预填时默认 `"transport"`（拜访场景交通最常见；无预填维持 `"breakfast"` 现状）。

### 4.3 预填规则

- `occurredOn` = `item.visitDate`（抽屉日期约束 `min/max` 因周已切至该周而天然满足）。
- `purpose` = `拜访 ${前两站 customerName 顿号连接}${超两站加"等"}`，截断至 100 字（URL 512 与后端 1000 上限内）。无站点时用行程 `title`。
- `itineraryId` = 行程 id（抽屉既有"关联行程"select 命中显示）；`customerId` = 首个有 `customerId` 的站点。
- `region` = 首站 `city`（`orderedVisitStops(item)[0]?.city`），空则依次取后续站点 city，均空则不带该参。

### 4.4 区域档案联动（提示，不自动写入）

workbench 周数据加载完成后，若 `expenseDraft.region` 存在且不在 `regionProfile.cities` 中，在页面顶部显示既有样式 `expense-page-alert is-warning` 提示条:"本周区域档案未包含「{city}」，如当日在该市出差请先补充区域设置" + "打开区域设置"按钮（`setRegionSettingsOpen(true)`）。**不自动写 regionProfile**:区域保存有 version 乐观锁与整改期（v0.8.2 差旅整改）不确定性，自动写风险大于收益。城市比较用归一口径:`responsibleRegionModel.js` 新增导出 `hasResponsibleCity(cities, city)`（内部复用现有 `cityKey` 去"市/地区"后缀逻辑，解决"济宁"vs"济宁市"）。

### 4.5 边界条件

| 边界 | 行为 |
|---|---|
| 跨周/未来周行程 | 周状态直接初始化为 `visitDate` 所在自然周，工作台整体展示该周（与手动切周同效），无特殊处理 |
| 行程无城市 | 不带 `draftRegion`，不出提示条 |
| 行程站点无 customerId（手填客户名） | `customerId` 空，`purpose` 仍带客户名文本 |
| `draftDate` 非法/缺失（手改 URL） | `expenseDraftFromFilters` 返回 null，整组参数忽略，页面按常规打开 |
| `draftItinerary` 指向已删行程 | 抽屉 select 无匹配项回落"不关联"，其余预填不受影响 |
| 后端离线（backendStatus≠connected） | 抽屉照常打开预填，保存时走既有失败提示路径，不新增逻辑 |
| 回退键回到带参 URL | 已用 replace 清参，回退不会重触发 |

---

## 5. 文件清单（精确路径，均相对 worktree 根）

**后端（2 改 + 测试）**
- `backend/src/server.js` — `dashboardSummaryFromDb` 扩展（todayFocus/weeklyTrend/stageCounts 金额），调用处传入 `tenderRepository`；import `dailyDigest/digestContent.js` 周口径工具与 `opportunities/stageVocabulary.js`。
- `shared/salesWorkbenchApiContract.mjs` — `dashboardSummary` schema 增字段。
- `backend/tests/api.test.js` — dashboard summary 新字段断言。

**前端（9 改/增 + 测试）**
- `outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx` — `Overview`:新增今日焦点卡、周趋势卡，移除静态节奏卡，漏斗标题/底条。
- `outputs/product-design-prototype/src/components/primitives.jsx` — `StageStrip` 可选底条（amount 渲染已支持，可能零改动）。
- `outputs/product-design-prototype/src/styles/global.css` — `overview-today/overview-trend/stage-strip__bar` 样式与 980/760 断点折叠（v0.8.1 token）。
- `outputs/product-design-prototype/src/App.jsx` — expense 分支传 `expenseDraft`/`onExpenseDraftConsumed`；itinerary 分支传 `onRecordExpense`。
- `outputs/product-design-prototype/src/features/visitItinerary/VisitItineraryPage.jsx` — 详情工具栏"记当日费用"按钮。
- `outputs/product-design-prototype/src/features/visitItinerary/itineraryExpenseLink.js` — **新文件**，双向纯函数。
- `outputs/product-design-prototype/src/features/travelExpense/TravelExpensePage.jsx` — draft 消费、周初始化、区域提示条。
- `outputs/product-design-prototype/src/features/travelExpense/ExpenseEditorDrawer.jsx` — `prefill` prop。
- `outputs/product-design-prototype/src/features/travelExpense/responsibleRegionModel.js` — 导出 `hasResponsibleCity`。

**测试新增/扩展**
- `outputs/product-design-prototype/src/features/visitItinerary/itineraryExpenseLink.test.js` — **新文件**。
- `outputs/product-design-prototype/src/app/routes.test.js` — travel-expenses 带 draft filters 双向用例。
- `outputs/product-design-prototype/scripts/stage-strip-data.test.mjs`、`scripts/travel-expense-page.test.mjs`、`scripts/module-coverage.test.mjs` — 源码断言扩展。

## 6. 零迁移论证

所有读写均命中现有表列:`visit_itineraries`（0005）、`travel_expenses.itinerary_id/customer_id/occurred_on/purpose`（0007 原生）、`quick_records.voided_at`（0002）、`action_items`（0001/0006）、`risk_items`、`hospital_tender_notices`（0009/0010）。dashboard 扩展是只读聚合；联动是前端传参 + 既有创建端点。**无新表、无新列、无回填 → 零迁移**。若实施中发现需持久化"焦点卡已读"之类状态，一律砍掉（YAGNI）。

## 7. 测试面

- **后端聚合**:api.test.js 内存库 seed（今日行程 ×1、逾期/今日待办、跨周 quick_records/expenses/done actions、七阶段商机含金额文本）→ 断言 `todayFocus` 计数切分、`weeklyTrend` 本/上周口径（周一边界日各放一条验证 BETWEEN 含端点）、`stageCounts` 全序七阶段 + `amount` 文本 + 未知阶段追加;合同 assert 通过。
- **前端纯函数**:`itineraryExpenseLink.test.js`（正常/无站点/无城市/非法日期 fail-closed/超长 purpose 截断）；`routes.test.js` 双向（parse `?draftDate=...` → filters；buildWorkbenchUrl 反向含中文转义）；`responsibleRegionModel.test.js` 补 `hasResponsibleCity`（"济宁"≡"济宁市"）。
- **脚本走查**:`stage-strip-data.test.mjs` 断言后端词表与前端 `fixedStages` 仍同序;`travel-expense-page.test.mjs` 断言 `prefill`/`expenseDraft` 接线存在。
- **集成走查点**（上线前手工/Playwright）:① 总览三新卡在桌面/980/760 三档布局与空态;② 行程详情点"记当日费用"→ 差旅页落在行程周、抽屉预填齐、URL 已清参、回退不复弹;③ 目的地不在区域档案时提示条出现并可打开区域设置;④ 保存后费用出现在该周列表且带行程关联。

## 8. 与 v0.8.1 的依赖漂移点

- **必须后置于 v0.8.1 合入**:新卡样式直接以 audit 定稿 token 书写；若 v0.8.1 按 P2-9 把 KPI `MetricCard` 改为 `summary-strip` 一体条，今日焦点/周趋势的网格 span 需按其落地后的行数重排（本文 §2.4 的 span 6/6 为默认方案）。
- 行号漂移:`pages.jsx` Overview L116-298、`global.css` L1480/L4408/L4772 等均会因 v0.8.1 变动，实施时以类名/函数名定位。
- v0.8.2 差旅工作台整改可能改动 `TravelExpensePage/ExpenseEditorDrawer` 内部结构:联动实施前需 rebase 后复核 §4.2 的接线点（`createDraft` 签名、`regionSettingsOpen`、`expense-page-alert` 类名）是否仍在。**这是本设计最大的顺序依赖**。

## 9. 风险与开放问题

1. `action_items.updated_at` 存在 ISO 与 `CURRENT_TIMESTAMP` 两种历史格式且为 UTC，"待办完成数"按 substr 日期近似会有 ±8h 边界误差——量级小（口径展示用），接受；若要精确可改 `date(substr(updated_at,1,10))` 为 `date(datetime(replace(updated_at,'T',' ')), '+8 hours')`，实施时二选一并在测试固化。
2. dashboard 端点全量口径（无 owner 过滤）是单用户现状的延续;若未来多账号，todayFocus/weeklyTrend 需与差旅一样按 `request.authContext.account` 收敛——在代码注释中留标记。
3. 漏斗金额依赖 `numberFromText` 解析 TEXT 金额（"300 万"）,非标准写法记 0，金额文本可能低估——与现 KPI"预计签单额"同瑕疵，不新增风险。
4. 新招标 anchor 采用"昨日 09:00 上海"与晨报同源;若产品希望"今日新增"口径需改 `$today T00:00+08:00`——开放给验收决策，默认同晨报。
5. `refreshOverviewSummary` 在每次写操作后刷新，扩展后响应聚合量增加（多 6 条 SQL + tender 两查），单库单用户下可忽略;如 api.test.js 观察到明显变慢再考虑给 todayFocus 加 LIMIT 已含的轻量化。
6. 开放问题:今日焦点是否需要"新招标"分区取决于租户是否启用 tender 采集（`hospital_tender_notices` 可能为空表）——设计为空态友好（0 条显示"暂无新招标"），无开关逻辑。
