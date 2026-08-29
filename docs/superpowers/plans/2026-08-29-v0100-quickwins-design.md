# v0.10.0 快赢包 · 实施级设计（审计B Q1 六项 + 全局反馈系统）

日期：2026-08-29 · 作者：预研泳道 B · 状态：**定稿，可直接作为实施任务书**
基线：工作树 `.worktrees/integrate-v0626-candidate`（实施工人并行中，**本文一律以文件名+函数名为锚点，不引行号**；页面均在 `outputs/product-design-prototype/src/features/salesWorkbench/pages/` 拆分后 13 文件）。
范围依据：总蓝图 v0.10.0 行；审计B §7 Q1 六项 + §3.3 反馈缺位 + §2 逐页出处（本版范围唯一来源）。
**硬前置**：v0.9.0–v0.9.3 已合入（users 表、displayName 入会话、owner 硬隔离、`owner ≡ request.authContext.account`、跨账号 404 防枚举）。实施时若未合入先 rebase，本文所有新端点按 v0.9.2 隔离语义设计。

## 0. 结论先行

- 七块改造全部为前端 + **两处后端**（比任务预估的"仅 remindAt schema 一处"多一处：Web 目前**不存在任何创建待办的端点**，`POST /api/actions` 必须新建，详见 §8——`requestSchemas` 无 actionCreate，`server.js` 全部 POST 路由清单中无 actions，创建能力只在微信侧 `actionItemStore.create`）。
- 源码实读修正两处审计口径：① `remind_at` 确认**不可写**——`requestSchemas.actionPatch` 无 remindAt 字段，`updateActionItem`（backend/src/server.js）的 setSql 不含 remind_at；② 快速记录同步键已有 `createExclusiveAsyncGate` 防重复（quickRecordModel.js），缺的只是 `confirmAnalysis` 一步的 in-flight 态与 IME 守卫，改造面比预想小。
- 交互三裁定：总览**桌面移动同步重排**（今日焦点全端置顶）；头像改**账号菜单**（非二次确认弹窗）；行程行内红条**保留**（删除确认收敛为"样式弹窗 + 行程行内条"两范式，window.confirm/alert 归零）。
- 全局 toast 自研（Provider + useToast + aria-live，约 120 行组件 + 80 行 CSS），不引第三方库；文案必须避开 `formal-ui-copy.test.mjs` 禁用词表（占位/演示/后端/抽屉/调试等）。

## 1. 总览移动端重排（审计B §2 总览①②③）

**改动文件**：`pages/OverviewPage.jsx`（`Overview` 函数）、`src/styles/global.css`（`.overview-*` 段 + 两处 `@media` 内 overview 规则）、`src/components/primitives.jsx`（`MetricCard`）。

**桌面取舍——推荐同步重排，不用仅移动端 CSS order**。依据：① 总蓝图 §8-1"把今天变成产品首屏"是全端产品承诺，桌面把今日焦点排第二屏同样不成立；② CSS order 造成 DOM 序≠视觉序，破坏键盘/读屏顺序（本项目有 test:forms/test:controls 可访问性门禁资产）；③ `.overview-grid` 是 `grid-auto-flow: dense` 12 列网格，order 补丁与 dense 流叠加后维护成本高。

**新 DOM 序**（`Overview` 返回的 JSX 子节点顺序）：`TodayFocusCard`（span 6）→ `WeeklyTrendCard`（span 6）→ 4×`MetricCard`（span 3，不变）→ 今日优先动作 → 客户温度 → 最近快速记录 → 重点商机列表 → 商机漏斗（span-full）。

**hero 撤下**：整段删除 `section.hero-card.overview-hero`（含三个写死假统计 `hero-stat-grid`："7 天记录视图 / 3 路业务同步 / 1 套销售数据"，及"新增快速记录/查看本周七天记录"两钮——topbar 与侧栏已有同语义入口，消除审计B §1.2-4 的入口冗余）。CSS 清理：`.hero-card`、`.overview-hero`（含 `::before`）、`.hero-actions`、`.hero-stat-grid` 全部规则删除，并从两个 `@media` 断点（`.overview-grid` 2 列断点与 760px 单列断点）的选择器列表中移除 `.overview-hero`。腾出的 span 5 分配：`.overview-priority` span 4→**7**、`.overview-health` span 3→**5**（一行占满 12）。

**KPI 可点击示能**：`MetricCard` 在 `onClick` 存在时渲染 `<ChevronRight className="metric-chevron" size={15} />`（对齐 `TodayFocusSection` 的 `today-focus-chevron` 语言）；新 CSS `.metric-card .metric-chevron { color: var(--muted); }`，hover 态复用既有 `.interactive-card:hover`。`detail` 展开路径不动（周报"真实来源"卡是真数据）。

**验收标准**：
1. 390×844 视口打开总览，无滚动即见"今日焦点"卡头部；周趋势位于第二块。
2. 1440×900 视口第一行为今日焦点+周趋势，第二行为 4×KPI；无 hero 大卡，页面无"7 天记录视图/3 路业务同步/1 套销售数据"字样。
3. 四张 KPI 卡均显示 chevron，hover 有既有 interactive-card 提升效果，点击跳转行为与现状一致。
4. DOM 序=视觉序（不使用 CSS order），键盘 Tab 顺序为今日焦点→周趋势→KPI。

## 2. 待办零深度操作（审计B §1.3、§2 待办①②③）

**改动文件**：`pages/ActionsPage.jsx`、`src/App.jsx`（`changeActionViewMode`/`resolveHeadingContext`/新 `handleCreateAction`/ActionsPage 传参）、`src/api/salesWorkbenchApi.js`（新 `createAction`）、`pages/shared.jsx`（datetime 转换工具）、`global.css`；后端见 §8。

### 2.1 列表行内一键完成/延期

`ActionsPage` 列表 `article.customer-list-row` 增加快捷按钮组（`list-row-quick-actions`），乐观更新+失败回滚：

```jsx
const [optimisticStatus, setOptimisticStatus] = useState({});   // id -> status 覆盖层
const [pendingQuickIds, setPendingQuickIds] = useState(new Set());
async function quickPatch(item, status) {                        // status: "done" | "deferred"
  setOptimisticStatus((m) => ({ ...m, [item.id]: status }));     // 行内 pill 立即翻转
  markPending(item.id, true);
  try {
    await onUpdateActionStatus(item.id, { status, tone: status === "done" ? "green" : "amber" });
    toast({ tone: "success", title: status === "done" ? "待办已完成" : "待办已延期" });
  } catch (error) {
    toast({ tone: "error", title: "待办更新失败", description: error.message });
  } finally {                                                    // 成功由 mergeById 落真值，失败即回滚
    setOptimisticStatus((m) => omit(m, item.id));
    markPending(item.id, false);
  }
}
```

按钮：`完成`（`data-testid="action-quick-complete"`，`item.status !== "done"` 时显示）、`延期`（`data-testid="action-quick-defer"`，status ∈ pending/in_progress 时显示），复用 `.ghost-button.compact-icon`（430px 断点已有 44px 触控高度规则）；pending 期间两钮 disabled。PATCH 仅传 `{status, tone}`，`updateActionItem` 的 `patchValue` 回落保住 due/assignee。行内 pill 渲染取 `optimisticStatus[item.id] ?? item.status`。

### 2.2 "新增待办"入口

- 列表 Panel 加 `action` 插槽按钮（复制 `KnowledgePage` "新增知识"模式）：`data-testid="actions-create-detail"`，onClick=`setViewMode("create")`。
- `App.jsx`：`changeActionViewMode` 增 create 分支 → `navigateTo("actions", { mode: "new", filters: routeFilters })`（`editorModeFromRoute` 已把 new→create）；`resolveHeadingContext` actions 分支增 create → `{ title: "新增待办" }`；给 ActionsPage 传 `customersList` 与 `onCreateAction`。
- 新子组件 `ActionCreateForm`（ActionsPage.jsx 内，`editor-panel` 版式）最小字段：标题*（input，≤80 字）、客户（select，customersList 可空）、优先级（select 高/中/低，默认中）、截止说明 due（input 自由文本，可空——**词表化不做**）、提醒时间 remindAt（见 2.3 控件）。提交校验仅"标题非空"（对齐现有各编辑器口径），成功→`onSelect(saved.id)`+切 detail+toast(success)，失败→表单内 `editor-status` 行内文案。
- `App.handleCreateAction(draft)`：`ensureBackend("新增待办")` → `apiClient.createAction(draft)` → `setWorkbenchActions(mergeById)` → `selectAction` → `refreshOverviewSummary()`。
- `salesWorkbenchApi.createAction(draft)`：`POST /api/actions`，返回 `assertApiEntity("actionItem", created.item)`。

### 2.3 remind_at 编辑（详情编辑视图 + 新增表单共用）

实读结论：PATCH 不可写 remindAt（§0），需 §8 后端补齐。前端控件（编辑视图"动作落地处理" Panel 内新增一行）：

```jsx
<label className="form-field"><span>提醒时间</span>
  <span className="remind-field">
    <input type="datetime-local" data-testid="action-remind-input"
      value={remindLocal} onChange={(e) => setRemindLocal(e.target.value)} />
    {remindLocal ? (
      <button className="ghost-button" type="button" data-testid="action-remind-clear"
        onClick={() => setRemindLocal("")}>清除</button>
    ) : null}
  </span>
</label>
```

转换工具入 `pages/shared.jsx`：`datetimeLocalFromIso(iso)`（ISO→本地 `YYYY-MM-DDTHH:mm`，空/非法返 ""）与 `isoFromDatetimeLocal(value)`（本地→ISO，空返 null），带单测。`updateAction()` 的 PATCH body 增 `remindAt: isoFromDatetimeLocal(remindLocal)`；详情只读视图"执行安排" InfoList 增一行 `提醒时间：{formatTodayFocusTime 同款格式 ?? "未设置"}`。**iOS `datetime-local` 兼容降级归 v0.10.2，本版桌面优先**（与差旅 week input 同批处理）。

**验收标准**：
1. 列表任一 pending 待办点"完成"：pill 立即变"已完成"，无需进详情；断网/后端 5xx 时 pill 回滚原态且出现 error toast。
2. 列表页有"新增待办"按钮；仅填标题即可创建成功，创建后进入详情、总览今日焦点计数随 `refreshOverviewSummary` 更新。
3. 编辑视图可设置提醒时间并保存，重进详情回显；点"清除"保存后 `remindAt=null`；设置了 remindAt 的 Web 待办到点后收到微信提醒（生产验收项，依赖 §8 reminded_at 重置）。
4. due 仍为自由文本，行为与现状一致。
5. 快捷完成/延期请求 pending 期间重复点击无第二次请求。

## 3. 头像登出确认（审计B §1.2-1）

**推荐：账号菜单**（非二次确认弹窗）。依据：v0.9.1 后 `authSession.displayName` 已入会话（`createDisplaySession`，sessionAuth.js），多账号时代"我是谁"需要常驻可查；菜单本身即误触缓冲（登出从 1 击变 2 击），且为后续改密/用户管理入口预留挂点；确认弹窗只解决误触、不提供身份信息。

**改动文件**：新 `src/components/AvatarMenu.jsx`、`src/App.jsx`（topbar 头像按钮替换为 AvatarMenu）、`global.css`。

```jsx
export function AvatarMenu({ initial, displayName, account, onLogout }) {
  const [open, setOpen] = useState(false);
  // 外点关闭：containerRef + document pointerdown 判 contains；Escape 关闭并回焦头像钮
  return (
    <div className="avatar-menu-wrap" ref={containerRef}>
      <button className="avatar avatar-button" type="button" data-testid="avatar-menu-trigger"
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{initial}</button>
      {open ? (
        <div className="avatar-menu" role="menu" data-testid="avatar-menu">
          <div className="avatar-menu-identity"><strong>{displayName}</strong><small>{account}</small></div>
          <button className="avatar-menu-item danger" type="button" role="menuitem"
            data-testid="avatar-menu-logout" onClick={onLogout}><LogOut size={15} />退出登录</button>
        </div>
      ) : null}
    </div>
  );
}
```

菜单点"退出登录"直接执行 `onLogout`（菜单已是缓冲层，不再嵌确认弹窗）。样式 token：`--radius-card`、`--surface`、`--line`、`--shadow`；菜单项 `min-height: 44px`、身份区与菜单项间距 ≥8px（430px 断点 `.avatar-button` 已是 44×44，触点间距达标）；`.avatar-menu-item:focus-visible` 用 `--focus-ring`。

**验收标准**：
1. 点头像不再直接登出，出现菜单显示 displayName 与 account。
2. 点"退出登录"回登录页；点菜单外/按 Escape 关闭菜单且不登出。
3. 430px 视口菜单项触控高度 ≥44px，菜单不溢出视口右缘。
4. `App.jsx` 中不存在 `onClick={onLogout}` 直挂头像的写法（守护断言）。

## 4. AI 分析 pending 态 + IME 守卫（审计B §2 快速记录①③）

**改动文件**：`pages/QuickRecordPage.jsx`（`QuickRecord` 函数）。同步按钮组"全部确认"**不做**（v0.11.1）。

- **pending 态**：新 state `analysisPending`；`confirmAnalysis` 用新 `analysisGateRef = createExclusiveAsyncGate()`（quickRecordModel.js 已导出，复用同步键既有模式）包裹，busy 时 `setSyncStatus("正在分析，请稍候")` 直接返回。in-flight：主按钮 `disabled` + 文案"分析中" + `<LoaderCircle className="state-spinner" size={16} />`（`.state-spinner` 旋转动画已存在，复用）；"新建记录/重新分析"两钮同期 disabled；finally 复位。
- **IME 守卫**：新 `composingRef`；textarea 增 `onCompositionStart={() => { composingRef.current = true; }}`、`onCompositionEnd={(e) => { composingRef.current = false; setRecordText(e.target.value); resetAnalysis("内容已变化，请重新确认分析"); }}`；`onChange` 改为组字中仅 `setRecordText` 不调 `resetAnalysis`：

```jsx
onChange={(event) => {
  if (!event.target.value.trim()) voiceCapturedRef.current = false;
  setRecordText(event.target.value);
  if (composingRef.current) return;          // 组字过程不清空已生成分析
  resetAnalysis("内容已变化，请重新确认分析");
}}
```

**验收标准**：
1. 点"确认调用 AI 分析"后按钮立即 disabled 并显示"分析中"+spinner，完成或失败后恢复。
2. 慢网下连点 N 次只发出 1 个 `POST /api/quick-records` + analyze 请求（gate 断言）。
3. 中文 IME 组字（compositionstart 到 end 之间）不触发 `resetAnalysis`，已生成的分析面板不消失；组字提交（compositionend）后按现状清空并提示重新分析。
4. 分析 pending 期间"新建记录/重新分析"不可点。

## 5. 知识检索清空还原 + 周报 tab 名实相符（审计B §2 知识①、周报①）

**改动文件**：`pages/KnowledgePage.jsx`、`pages/WeeklyPage.jsx`、`src/App.jsx`（WeeklyPage 传参）。

- **知识**：搜索 input 的 onChange 增加空值还原——`if (!value.trim()) { setVisibleItems(items); setSearchStatus("按客户、场景或标签检索销售材料。"); }`；`submitSearch` 开头同判：空关键词不再请求后端，直接还原全量并 `setSearchStatus("已还原全部材料")`。
- **周报**：裁定**改渲染真实每日记录**（保留 tab 名"本周每日记录"，让名实相符），最小方案基于实读——现渲染遍历 `weeklyDraft.sourceRefs` 输出模板句"来源已纳入…周报草稿"，而 App 的 `workbenchQuickRecords` 已含本周记录全量，无需新端点：
  - App 给 WeeklyPage 增传 `quickRecords={workbenchQuickRecords}`、`onOpenQuickRecord={openQuickHistoryRoute}`。
  - WeeklyPage 内新纯函数 `groupRecordsByWeekday(quickRecords, weekRange)`：按 `occurredAt ?? createdAt` ∈ `getCurrentWeekRange()` 过滤，按周一…周日分组，返回 7 组（含空组），带单测。
  - daily 视图改渲染 7 张 `day-card`（保持 `<button>` + `aria-expanded`，`interactive-controls` 的 day-card 断言语义不变）：卡头=周几+月日，正文=当日记录列表（时间、客户、标题、状态 pill——复用 `quickRecordHistoryView` 的状态映射口径）；展开态显示当日记录明细并提供"在快速记录中打开"（调 `onOpenQuickRecord(id)`）——展开有真数据，不属 §6 清除对象；无记录的天显示"当日无记录"。`weekly-source-empty` 空态与 sourceRefs 模板句渲染删除（来源追溯保留在汇总 tab 的"真实来源" MetricCard，detail=真数据不动）。
  - 未生成周报时的整页空态（"生成本周周报"）**保持现状**，本版不动周报生命周期与周期选择（补写上周/历史周报归后续版本）。

**验收标准**：
1. 知识页检索出子集后清空输入框，列表立即恢复全量，无需再点"检索"；空关键词点"检索"不发后端请求。
2. 周报 daily tab 渲染 7 天分组，当天有 N 条已确认快速记录则对应天显示 N 条真实记录（标题/客户可核对），不再出现"来源已纳入…周报草稿"模板句。
3. day-card 展开显示记录明细，可跳转到快速记录历史视图（URL 带记录 id）。
4. `weekly-daily-tab` / `weekly-summary-tab` testid 与 tab 文案不变。

## 6. 假展开七基元清除 + 客户页去重（审计B §3.3-2、§2 客户①）

**改动文件**：`src/components/primitives.jsx`、`pages/shared.jsx`、调用点五页（`CustomerPage.jsx`/`OpportunityPage.jsx`/`ActionsPage.jsx`/`RiskPage.jsx`/`KnowledgePage.jsx`）、`global.css`（`.item-detail` 等孤规则清理）。

逐基元裁定（原则：有真数据可填的填、无的去掉可点击态——去 `interactive-card` 类、去 button/cursor 语义、删占位句）：

| 基元（锚点） | 裁定 | 处理 |
| --- | --- | --- |
| `MatchCard`（primitives） | 无增量数据可填（value/meta/置信度已全显） | 改纯 `<section className="match-card">`，删 expanded/onClick/`interactive-card`；结构化升级归 v0.11.1 AI 卡片契约 |
| `ExpandableInsight`（primitives） | children 即全文，无截断 | 改纯 `<div className="insight insight-card {tone}">`，删 chevron/expanded/detail；调用点（动作说明、风险证据、建议处理、商机来源/风险/下一步）删 detail 与 expandedTestId props，保留正文与空值兜底文案 |
| `InfoList`（primitives） | 条目即全文 | 行改非交互 `<span className="info-item">`，删 expandedItem 与占位句 |
| `Timeline`（primitives） | date/title/description 已全显 | 行改非交互，删"已展开：可回看来源记录…"；来源跳转归 v0.11.0 联动补链 |
| `StakeholderGrid`（shared） | influence 已显示，无沟通记录数据源 | 卡改非交互 `<article className="stakeholder-card">`，删"已展开：适合补充最近沟通…" |
| `FieldTags`（shared） | 纯标签 | 改非交互 chip `<span className="field-tag …">`，删"可用于复盘…" |
| `DecisionChain`（shared） | 步骤即全文 | 行改非交互，删"已展开：需要记录责任人…" |

配套：删除七处 `data-testid="*-expanded"`（stakeholder-expanded / field-tag-expanded / chain-expanded / timeline-expanded / action-reason-expanded / risk-evidence-expanded / risk-action-expanded / opportunity-*-expanded 等）及其展开分支；`MetricCard` 的 `detail` 真数据展开（`metric-expanded`）与 WeeklyPage day-card 新真展开**保留**。CSS：`.item-detail` 若无引用则删；`.match-card`/`.insight-card`/`.info-item`/`.stakeholder-card`/`.field-tag`/`.chain-step`/`.time-row` 的 hover/cursor 依赖 `interactive-card` 组合类，摘除类名即失效，无需删底层规则。

**客户页去重**：`CustomerPage` 详情删除"关键联系人" Panel（`selected.stakeholders.slice(0, 4)` 的重复渲染），保留"组织架构与决策链" Panel（StakeholderGrid + DecisionChain）；`customer-profile-grid` 剩 4 张 Panel，two-col 布局不变。

**验收标准**：
1. 全站 rg 断言：七句占位文案（"已展开：适合补充最近沟通"/"可用于复盘、方案材料"/"已展开：需要记录责任人"/"已展开：可回看来源记录"/"匹配依据已展开"/"可关联客户、商机、周报或方案继续处理"/"已展开动作说明"等）零命中。
2. 上述七基元渲染结果无 `interactive-card` 类、无 cursor:pointer、无 aria-expanded；键盘 Tab 不再停留在这些纯展示元素上。
3. 客户详情页 stakeholders 只渲染一份；`customer-profile-grid` 无空档。
4. 快速记录分析三卡、商机六 Panel、风险证据/建议、动作说明、客户干系人/决策链/历史项目内容与现状一致（只减交互不减信息）。

## 7. 全局反馈系统（审计B §3.3-3/4、§8-9）

**改动文件**：新 `src/components/toast.jsx`；`pages/shared.jsx`（`DeleteConfirmationDialog` 泛化为 `ConfirmDialog`，删除 `confirmDelete`/`showOperationError`）；`src/App.jsx`（挂 Provider）；调用点六页 + `KanbanPage.jsx` + `VisitItineraryPage.jsx`；`global.css`（toast + confirm-dialog 增量）。

### 7.1 toast 系统（自研，不引库）

```jsx
// src/components/toast.jsx
const ToastContext = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);       // { id, tone, title, description }
  const toast = useCallback(({ tone = "info", title, description = "" , duration }) => {
    const id = crypto.randomUUID();
    const ttl = duration ?? (tone === "error" ? 6000 : 4000);
    setToasts((cur) => [...cur.slice(-2), { id, tone, title, description }]);  // 最多同存 3 条
    timersRef.current.set(id, setTimeout(() => dismiss(id), ttl));             // 卸载时统一 clearTimeout
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast tone-${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            {/* CircleCheck / CircleAlert / Info 按 tone */}
            <div><strong>{t.title}</strong>{t.description ? <small>{t.description}</small> : null}</div>
            <button className="icon-button" type="button" aria-label="关闭提示" onClick={() => dismiss(t.id)}>…</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export function useToast() { return useContext(ToastContext) ?? (() => {}); }
```

挂载点：`SalesWorkbenchApp` 返回的 `<main className="app-shell">` 内层包 `ToastProvider`（登录页不接 toast，登录错误保留 `login-error` 行内）。页面组件经 `useToast()` 取用，零 prop drilling。样式 token：容器 `position: fixed`，桌面右上（top: 16px; right: 16px）、≤760px 顶部居中且避开 topbar；单条用 `--surface`/`--line`/`--radius-card`/`--shadow`，tone 左边条与图标用 `--green`/`--red`/`--blue` + 对应 `*-soft` 背景；进场 transform 动画受既有 `prefers-reduced-motion: reduce` 全局覆盖（interaction-polish 断言不变）；文案避开禁用词表（§0）。

### 7.2 确认弹窗统一（以客户页样式弹窗为基准）

`shared.jsx`：`DeleteConfirmationDialog` 参数化为 `ConfirmDialog({ open, title, description, confirmLabel = "确认删除", busy, errorMessage, onCancel, onConfirm, testIdPrefix })`——现组件标题"确认删除客户"与描述模板写死，抽为 props；焦点管理/Escape/`role="alertdialog"`/`aria-modal`/`confirm-dialog-*` 样式全保留。`CustomerPage` 改用新签名（`testIdPrefix="customer-delete"` 等 testid 不变，传 `title="确认删除客户"` 等原文案，零回归）。

**window.confirm 五处替换**（商机/待办/风险/知识各自的 `deleteCurrent*` 函数 + `shared.confirmDelete` 本体删除）：每页复制 CustomerPage 既有状态机——`deleteDialogOpen/deleteBusy/deleteError` 三 state，删除钮改 `setDeleteDialogOpen(true)`，`ConfirmDialog` 的 onConfirm 内 await 删除：成功→关弹窗+回列表+`toast({ tone: "success", title: "已删除…" })`；失败→`deleteError` 留在弹窗内（不 toast，弹窗未关时行内优先）。testIdPrefix：`opportunity-delete`/`action-delete`/`risk-delete`/`knowledge-delete`。

**行程行内红条——保留本地风格**。取舍：`itinerary-delete-confirmation` 已具 `role="alertdialog"` 语义与独立测试面，行内确认不打断行程详情上下文，且行程页是 A- 标杆；三范式收敛为两范式（样式弹窗 + 行程行内条），v0.10.1 实体列表页抽象时再评估并入。行程删除**成功**接 toast。

**window.alert 退役**：`showOperationError` 从 shared.jsx 删除，全部调用点（各页删除 catch 分支）改走 ConfirmDialog 的 errorMessage 或 toast(error)。

### 7.3 写操作成功反馈接线清单

**原则：表单内联留、跨页/列表操作走 toast**。

| 接 toast | 保留行内 status |
| --- | --- |
| 待办快捷完成/延期（§2）、新增待办成功 | 各编辑器 `editor-status`（客户/商机/知识/新增待办表单） |
| 五域删除成功（客户/商机/待办/风险/知识）+ 行程删除成功 | 快速记录 `syncStatus` 流程条（页面核心流程） |
| 看板推进/回退成功与失败（写商机档案属跨页效果；`kanban-status` 孤行小字删除，`moveOpportunity` 改调 toast） | 动作/风险编辑视图 `risk-status-message`（表单内） |
| 知识"引用到周报"成功（跨页跳转后可见结果确认） | 周报 `draftStatus`（编辑器内）、登录 `login-error` |
| 周报"导出 Word"成功（结果在浏览器下载条，页面无变化） | 知识检索 `searchStatus`/`citationStatus`（检索表单内） |

**验收标准**：
1. 全站 rg：`window.confirm`、`window.alert`、`confirmDelete(`、`showOperationError` 零命中（`outputs/product-design-prototype/src` 范围）。
2. 五域删除均弹样式弹窗（Escape 可取消、busy 态按钮 disabled、失败文案留在弹窗内），确认后出现成功 toast。
3. toast：4 秒自动消失（error 6 秒）、可手动关闭、并发第 4 条时最旧一条让位、`toast-region` 具 aria-live="polite"、error 条 role="alert"。
4. 看板推进出现成功 toast，页面不再有 `kanban-status` 顶部小字；推进失败出现 error toast 且卡片停留原列。
5. 390px 视口 toast 不遮挡 topbar 主按钮，可单手点到关闭钮。

## 8. 后端改动面（单列；预估两处，超出任务预估的"仅 remindAt 一处"）

1. **PATCH /api/actions/:id 支持 remindAt**（`backend/src/validation/requests.js` + `backend/src/server.js`）：
   - `requestSchemas.actionPatch` 增 `remindAt: text(50, { nullable: true })`。
   - PATCH handler 在 `readValidatedJson` 后，若 `body.remindAt` 为非空字符串则 `assertDateTime(body.remindAt, "remindAt")`（复用既有校验函数），并归一为 `new Date(...).toISOString()`。
   - `updateActionItem` setSql 增 `remind_at = $remindAt, reminded_at = $remindedAt`：`$remindAt = patchValue(body, "remindAt", current.remindAt)`；**reminded_at 重置规则**——body 携带 remindAt 且值与 current 不同（含置 null）时 `$remindedAt = null`（重新武装提醒，语义对齐 `actionItemStore.defer`），否则保留 `current.remindedAt`。审计日志沿用该路由既有 insertAudit，metadata.changedFields 增 remind_at。
2. **新端点 POST /api/actions**（Web 目前无任何创建待办路径，§0 实读结论）：
   - `requestSchemas` 新增 `actionCreate: { title: text(80, { required: true }), reason: text(500, { nullable: true }), due: text(50, { nullable: true }), remindAt: text(50, { nullable: true }), priority: { type: "enum", values: ["高", "中", "低"] }, customerId: text(200, { nullable: true, nonEmpty: true }) }`（长度上限对齐 `actionItemStore.create` 的校验；**owner 不入 schema**，服务端注入）。
   - handler：`requireUser` → 校验/归一 remindAt → `withImmediateTransaction` 内复用 `createActionItemStore(db).create({ owner: request.authContext.account, id: randomUUID(), customerName: 按 customerId 查 owner 名下 customers（查无=422 customerId invalid，防跨账号挂接）, ...body })` → `insertAudit({ action: "action.create", entityType: "action", ... , metadata: { source: "web", remindAt, priority } })`（对齐 runtimeHandlers 微信建待办分支的审计口径）→ `201 { item }`。
   - 隔离语义（v0.9.2 规约）：owner ≡ authContext.account；store.create 的 `getVisible` 回读天然按 owner；assignee 由 store 置为 owner。
   - 后端测试：挂 `backend/tests/`（`npm test` 全量入口），断言见 §9。

无其他后端改动：待办快捷完成/延期、toast、总览重排、周报每日记录、知识还原全部复用既有端点与 bootstrap 数据。

## 9. 测试与验收清单

### 9.1 qa:local 新增断言（预估 58 条：前端 ≥46 + 后端 ≥12）

| 断言组（挂点） | 预估 | 要点 |
| --- | --- | --- |
| 总览重排（新 `scripts/overview-layout.test.mjs` 或并入 module-coverage） | 6 | 页面源 today-focus 先于 MetricCard；`hero-card`/`hero-stat-grid`/三假统计文案 doesNotMatch；CSS 无 `.overview-hero`；`metric-chevron` 存在 |
| 待办快捷操作（`ActionsPage` 源断言 + quickRecordModel 式单测） | 7 | 两 testid 存在；optimisticStatus 覆盖层渲染；pending disabled；PATCH body 仅 status/tone；失败回滚路径 |
| 新增待办（list-action-layout 扩展 + 源断言） | 6 | `actions-create-detail` 入 Panel；create 视图字段清单；标题必填校验；`createAction` 接线；heading"新增待办" |
| remindAt 编辑（shared 单测 + 源断言） | 5 | `datetimeLocalFromIso`/`isoFromDatetimeLocal` 双向含空值/非法值；datetime-local 控件 + 清除钮 testid；PATCH body 含 remindAt |
| 头像菜单（源断言） | 4 | `avatar-menu-trigger`/`avatar-menu-logout` testid；`aria-expanded`；App 无头像直挂 onLogout；displayName 渲染 |
| 快速记录 pending + IME（源断言 + gate 单测） | 6 | `analysisGateRef` 存在；按钮 disabled 表达式；"分析中"文案；composition 三事件接线；组字期不调 resetAnalysis |
| 知识清空还原（源断言） | 2 | onChange 空值还原分支；submitSearch 空词短路 |
| 周报每日记录（`groupRecordsByWeekday` 单测 + 源断言） | 6 | 7 组分组含跨周排除/空天；day-card 渲染真实记录字段；模板句 doesNotMatch；`onOpenQuickRecord` 接线 |
| 假展开清除（formal-ui-copy 或新 `scripts/no-fake-expand.test.mjs`） | 8 | 七句占位文案逐句 doesNotMatch；七基元源码无 `interactive-card`；客户页 stakeholders 单份渲染 |
| toast 系统（`src/components/toast.test.js` 单测） | 6 | 自动消失时长按 tone；最多 3 条；手动关闭；aria-live/role；Provider 缺省 no-op |
| 确认弹窗统一（源断言） | 4 | 四新 testIdPrefix 存在；pages 源 `window.confirm`/`window.alert` doesNotMatch；ConfirmDialog 参数化后 customer-delete testid 不变 |
| 后端 remindAt（backend/tests） | 6 | schema 收 remindAt/拒非法日期；PATCH 写入回读；reminded_at 重置于变更/置 null；未带 remindAt 不动 reminded_at；跨账号 404 |
| 后端 POST /api/actions（backend/tests） | 6 | 201 回读 owner=会话账号；body 带 owner 422 unknown；title 必填/超长 422；customerId 跨账号 422；audit 落 action.create；remindAt 归一 ISO |

### 9.2 既有测试受影响面与更新点

- `scripts/module-coverage.test.mjs`：`requiredApiMethods` 增 `createAction`；"re-fetches the dashboard summary" 断言**不许动**（overview 重排不得触碰该 effect）。
- `scripts/list-action-layout.test.mjs`：create 按钮 testId 循环增 `actions-create-detail`。
- `scripts/formal-ui-copy.test.mjs`：新增 UI 文案（toast/菜单/表单）不得含禁用词表；文件本身仅在把"假展开句清除"断言并入时扩展。
- `scripts/interactive-controls.test.mjs`：MatchCard 等由 button 改 section 后自动缩小按钮扫描面（断言通过口径不变）；新按钮（快捷完成/延期、菜单、toast 关闭、清除钮）自动纳入 type=/onClick 扫描——实现必须带齐；day-card 保持 button+aria-expanded。
- `scripts/interaction-polish.test.mjs`：无更新（toast 动画走全局 reduced-motion 覆盖即可）。
- `scripts/readonly-detail-actions.test.mjs`：无更新（action/knowledge 等 edit/delete testid 全保留）。
- `scripts/form-accessibility.test.mjs`：新增待办表单/remind 控件必须走 `FormField`/`form-field` label 包装以通过既有扫描。
- 后端既有 actions 路由与 assistant 测试：`actionPatch` 是加列不影响存量；`updateActionItem` 新 setSql 需过既有 PATCH 用例。

### 9.3 视觉节奏截图对照（`test:visual` 六视口）

- `pages` 清单不变（14 页 × 6 视口全绿是门禁）；hero 删除后 overview 各视口截图基线更新。
- 实施后人工对照归档至 `docs/superpowers/reports/assets/v0100-quickwins/`：overview（重排前后 desktop/mobile 各 1）、actions 列表（行内按钮 + 新增入口）、actions 创建视图、weekly daily（真实每日记录）、任一删除确认弹窗、toast 成功/失败态、头像菜单展开——mobile(390) 与 desktop(1440) 双视口，≥14 张，回填 release 文档。

## 10. 本版不做（边界）

- 底部导航 + FAB + 下拉刷新 + 单手热区、PWA maskable/iOS meta、iOS `datetime-local`/week 降级 → v0.10.2；SW 离线壳与 Web 通知 → v0.10.3；Web 对话面板 → v0.10.4；语音服务端 ASR → v0.10.5。
- 实体列表页抽象、App.jsx 状态下沉、code-splitting → v0.10.1（本版五页确认弹窗状态机允许小幅复制，收敛留给下一版）。
- 快速记录"全部确认"批量键、同步 diff 预览、ManualConfirmBox 升级、AI 卡片统一契约 → v0.11.1；Timeline 来源跳转、招标转商机 → v0.11.0。
- due 词表化/结构化、周报历史周期与结构化编辑、stage 词表收敛（盘点债 #1）、行程行内红条并入弹窗 → 后续版本。
- i18n、暗色模式、看板拖拽 → 永不做（D6）。

## 11. v0.10.0 门禁清单

1. 前端 `npm run qa:local` 全绿（434 项存量 + §9.1 新增 ≥46，含 build/copy/controls/forms/polish/readonly/visual/modules/秘密扫描）。
2. 后端 `npm test`（backend/，1276 项存量 + §9.1 新增 ≥12）全绿；v0.9.2 隔离矩阵回归含 POST /api/actions 跨账号用例。
3. `npm run qa:integration` + `npm run qa:webkit` 真浏览器链路全绿。
4. 全站守护 rg 归零：`window.confirm`/`window.alert`/`showOperationError`/`confirmDelete(`/七句假展开占位文案/hero 三假统计文案。
5. 视觉节奏 14 页 × 6 视口截图全过 + §9.3 对照图归档。
6. 生产四关部署 + 真机验收：iPhone 视口今日焦点首屏、行内完成待办、Web 设 remindAt 到点收微信提醒、头像菜单登出、删除弹窗 + toast 全链走查。
7. release 文档记录：后端两处改动面（§8）、假展开清除的信息无损核对、CHANGELOG [0.10.0]。
