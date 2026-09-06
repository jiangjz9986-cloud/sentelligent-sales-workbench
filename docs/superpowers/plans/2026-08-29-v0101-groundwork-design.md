# v0.10.1 工程铺路 · 实施级设计（实体列表页抽象 + App.jsx 状态下沉 + 路由级拆包）

日期：2026-08-29 · 作者：预研泳道 B · 状态：**定稿，可直接作为实施任务书**
基线：工作树 `.worktrees/integrate-v0626-candidate`（HEAD 系 v0.9.3 冻结；v0.10.0 实施工人并行中，**本文一律以文件名+函数名为锚点，不引行号**；前端根 `outputs/product-design-prototype/`）。
范围依据：总蓝图 v0.10.1 行；审计B §5 工程质量表（五页 ~60% 同构 / App.jsx state 群 prop drilling / 主 chunk 超 500KB 警告线）与 §8 建议 10。
**硬前置**：`2026-08-29-v0100-quickwins-design.md` 的改动视为已落地基线——五个实体页已有 ConfirmDialog 删除状态机（五套复制）、toast 接线（useToast）、待办行内快捷操作 + `ActionCreateForm` + `actions-create-detail` 入口、知识检索清空还原、`AvatarMenu`、假展开七基元已清除。实施时若 v0.10.0 未合入先 rebase，本文所有抽象契约按 v0.10.0 后的页面形态设计。

## 0. 结论先行

- **零后端改动**。三块全是前端结构性重构，对外承诺一条红线：**导出面、data-testid、DOM 结构、CSS 类名、文案、交互行为全部零变化**（唯一例外见 §2.2 chunk 加载失败兜底，属"以前不可能出现的状态"的新面）。
- 实施顺序裁定：**拆包 → 状态下沉 → 实体抽象**（任务建议序成立，理由见 §1）。三块各自独立提交点，任一块可单独回滚，块间无接口耦合。
- 源码实读修正三处审计口径：① `SalesWorkbenchApp` 现为 **26 useState + 8 useRef**（审计"~25+6"系 v0.8.4 时点；v0.8.x 后新增 `routeEntityId`/`selectedSolutionId` 等）；② `QuickRecord` 现收 **22 props**（审计 20，后增 `routeHistoryId`/`onHistoryRoute`）；③ 主 chunk 现为 **704KB（gzip 200KB）**，审计 683–698KB 系 v0.9.x 前测量。
- 守护测试是最大约束面：`scripts/pages-source.mjs` 把 `pages.jsx` + `pages/*.jsx` 拼接后供 8 个源断言组扫描，**新文件放进 `pages/` 目录即自动纳入**（沿用 v0.8.4 拆分验证过的机制）；所有会移动锚点的断言按"**改取源先行**"节奏处理（先让断言双接受新旧位置→迁移→收紧），清单见 §5.2。
- 关键技术裁定：状态下沉用**轻量 context + 自有 hook 文件**（不引第三方 store，复用 v0.10.0 `ToastProvider` 的 Provider+useXxx+缺省 no-op 先例）；选中态/viewMode/ref 群**原样搬家不改机制**（useReducer 化会动 `changeXxxViewMode` 同 tick 读 ref 的时序语义，违反零行为红线，记为后续可选演进）；vite **不加 manualChunks**（路由拆分已达标，留作主 chunk 超标时的后手）。

## 1. 顺序与切分（§设计范围 5）

**推荐顺序：A 拆包 → B 状态下沉 → C 实体抽象**。理由：
1. A 只动 App.jsx 的 import 区与页面分支包裹，不动任何页面内部，构建产物立即可量化验收（`dist/assets` 清单），是三块中最独立、回滚面最小的；
2. B 先于 C：下沉后五个实体页从 context 取 `apiClient`/`backendStatus`/集合/CRUD 处理器，**EntityWorkspace 的契约可以一次性按"context 世界"设计**，不必先设计一批 pass-through props 再在下一步删掉（若 C 先行，五页要被改两遍且抽象契约要返工）；
3. C 最后动五页大 diff 时，A/B 已各自全量门禁通过并独立提交，回归可精确二分。

**提交点设计**（每个 commit 跑全量 `qa:local`，可分段回滚）：

| 块 | commit | 内容 |
| --- | --- | --- |
| A | A1 | 新增 `scripts/bundle-budget.test.mjs` 守护（此时仅断言 chunk 清单存在，主 chunk 预算断言先注为 TODO 红线值）+ `PageHeading` 改直采 |
| A | A2 | 16 个页面组件懒化 + Suspense fallback + `RouteChunkBoundary` + 启用主 chunk <500KB 断言 |
| B | B1 | 改取源先行：`formal-ui-copy`/`module-coverage`/`customer-opportunity-contract` 的 App.jsx 锚点改为"文件列表 concat"（加入即将出现的 hook 文件路径，先对现状跑绿） |
| B | B2 | 路由与选中态搬入 `src/app/useWorkbenchNavigation.js`（原样搬家）+ `NavigationContext` |
| B | B3 | bootstrap 数据层搬入 `src/app/useWorkbenchData.js` + `WorkbenchDataContext`；复合处理器收进 `src/app/useWorkbenchHandlers.js` + `WorkbenchActionsContext` |
| B | B4 | quick/weekly 会话态下沉（`quickRecordSession` / `weeklySession`）+ Overview/QuickRecord/WeeklyPage/五实体页逐页收敛 props（每页一小步，可再细分 commit） |
| C | C1 | 改取源先行：`list-action-layout`/`customer-opportunity-contract`/`form-accessibility`/`readonly-detail-actions` 断言重写为"EntityWorkspace 模板 + 五页配置字面量"双接受 |
| C | C2 | `pages/EntityWorkspace.jsx` 骨架落地（自动进 pages-source 扫描面）+ 组件级源断言 |
| C | C3–C7 | 按 风险→待办→知识→商机→客户 逐页迁移，**迁一页跑一页全量门禁 + 该页走查**，五个独立 commit |
| C | C8 | 收紧断言（删双接受的旧分支）、清理五页残留死代码，最终 `rg` 归零核对 |

## 2. 路由级拆包（§设计范围 3）

### 2.1 现状与拆分单元

现状：`main.jsx` → `App.jsx` 静态 import 全部页面（经 `pages.jsx` barrel + 四个 feature 页），产出单一 `index-*.js` 704KB（gzip 200KB）+ CSS 201KB；仅 pdfjs 已动态 import（`AuthenticatedPdfFrame` 内 `import("pdfjs-dist")`，产出 `pdf-*.js` 453KB + worker 1.24MB）——**该现状保持不动**。

改造（全部在 `SalesWorkbenchApp` 所在的 App.jsx）：
- `PageHeading` 改为直采 `./features/salesWorkbench/pages/PageHeading.jsx`（39 行常驻组件，不能经 barrel 拖入全部页面）；`pages.jsx` barrel 文件**保留**（`pages-source.mjs` 与 `scripts/fixtures/solution-history-fixture.jsx` 依赖它），但运行时主图不再 import 它——rollup 会将其从主 chunk 摇掉。
- 15 个懒化单元，模式统一：`const CustomerPage = lazy(() => import("./features/salesWorkbench/pages/CustomerPage.jsx").then((m) => ({ default: m.CustomerPage })));`
- **Overview 例外，保持静态 import**：登录后落点与 PWA `start_url` 都是 overview，静态保留（预估仅 ~6KB）换取首屏永不出现二段加载；`TodayFocusCard`/`WeeklyTrendCard` 随之留在主 chunk。

懒化清单：QuickRecord、CustomerPage、OpportunityPage、ActionsPage、RiskPage、KanbanPage、KnowledgePage、WeeklyPage、SolutionPage、WeixinBindingPage（以上 salesWorkbench）+ VisitItineraryPage、TravelExpensePage、HospitalTenderPage、SystemSettingsPage、UserManagementPage。注意 `settings/notifications`/`tender-schedule`/`bookkeeping-log` 三个 active 与 `settings` 共用 SystemSettingsPage 懒单元（`SETTINGS_SECTION_BY_ACTIVE` 不动）。

### 2.2 Suspense 与加载态

- 挂点：`<Suspense>` 包住 `blockedByBootstrap` 三元的 **else 分支整体**（即全部页面分支 fragment）；`ModuleSubnav` 与 `PageHeading` 在外，切页时子导航/标题即刻更新，仅内容区短暂 fallback（每 chunk 仅首访一次）。
- fallback 复用 `workbench-state-panel` 既有样式，**零新增 CSS**：

```jsx
function RouteChunkFallback() {
  return (
    <section className="workbench-state-panel" data-testid="route-chunk-loading" role="status" aria-live="polite">
      <LoaderCircle className="state-spinner" size={28} />
      <strong>正在打开页面</strong>
    </section>
  );
}
```

文案已核对避开 `formal-ui-copy` 禁用词表（不得用"加载静态资源/占位"等）。
- **chunk 加载失败兜底**：新增全站唯一 class 组件 `RouteChunkBoundary`（componentDidCatch 仅捕获动态 import 失败场景），渲染 `workbench-state-panel error` + "重新加载"按钮（`window.location.reload()`）。这是"断网中切入未访问页"这一以前不可能出现的状态的新面，正常在线路径零行为变化；离线整页错误的既有口径（`createErrorWorkbenchState`）不受影响。
- 已知取舍（记录进 release）：刷新后按浏览器回退键回到本会话未访问过的页面时，会出现一次 fallback 且内容区滚动位置回顶（`restoreContentScrollPosition` 的双 rAF 早于 chunk 挂载）。会话内的正常回退不受影响——React lazy 对已加载模块同步渲染，无 fallback 闪烁。

### 2.3 chunk 预算表（预估口径：源码字节 × 实测压缩比 ~0.45 + 各自 lucide 图标；实施后以 `dist/assets` 实测回填 release）

| chunk | 预估（min，非 gzip） | 构成 |
| --- | --- | --- |
| 主 chunk | **400±30KB（达标 <500KB）** | react+react-dom（~300KB，硬底）+ App 壳/routes/navRoutes/workbenchState/sessionAuth + salesWorkbenchApi + salesWorkbenchData + primitives/ModuleSubnav/toast/PageHeading + Overview |
| travelExpense | ~160KB | 页面+11 子组件+模型（拆包最大单笔收益） |
| settings 组 | ~22 + ~10KB | SystemSettingsPage / UserManagementPage 两单元 |
| itinerary / tender | 各 ~16KB | AMap 为运行时脚本注入，不占 bundle |
| quickRecord | ~15KB | 含 quickRecordModel 引用部分 |
| opportunity | ~13KB | 含 SalesDecisionPanel+viewModel+opportunityTimeline |
| 其余 9 页 | 1.5–8KB/个 | customer/knowledge/weekly/risk/actions/kanban/solution/weixin；`pages/shared.jsx` 被多页共享，rollup 自动落公共 chunk |
| pdf 双件 | 453KB+1.24MB | **不变**，既有动态导入路径原样保留 |

**manualChunks 取舍：本版不加。** 理由：①路由拆分已让主 chunk 落在 400KB 档，目标达成，无需再引配置复杂度；②手工 vendor 切分与 vite 的 modulepreload 注入/循环 chunk 存在踩坑面，收益仅剩"改业务码时 vendor hash 稳定"的缓存优化，对单人内网应用价值低。**后手预案**：若实测主 chunk >480KB，启用 `build.rollupOptions.output.manualChunks = { vendor: ["react", "react-dom"] }` 单键配置并复跑全量门禁。

### 2.4 验收标准

1. `dist/assets` 出现 ≥15 个页面 chunk；主 `index-*.js` < 500KB（新守护 `test:bundle` 机器断言，挂 `qa:local` 于 build 之后）；vite 构建输出无 500KB 警告。
2. 登录→总览无二段加载；首次点开客户/差旅等页出现至多一次"正在打开页面"面板后渲染完整页面；二次进入同页无 fallback。
3. 浏览器网络面板证明：登录首屏不下载 travelExpense/settings 等 chunk；进入差旅页才拉取对应 chunk；pdf 预览仍走既有 `pdf-*.js` 独立 chunk。
4. 断网状态点击未访问页出现错误面板与"重新加载"按钮，恢复网络后重载可用。
5. 14 页 × 6 视口 `test:visual` 全绿（等待机制核对过：`openPage` 的 `waitUntil` 轮询 testid 5s 超时 + 180ms 缓冲，本地静态服务 chunk 毫秒级返回；若出现 flake，预案是在 `openPage` 谓词追加"无 `route-chunk-loading` 元素"条件，属测试侧加固不动产品码）。

## 3. App.jsx 状态下沉（§设计范围 2）

### 3.1 现状 34 项逐一归类（26 useState + 8 useRef，`SalesWorkbenchApp` 内；`App()` 的 authPhase/authSession 属登录门，不动）

| 组 | 成员 | 去向 |
| --- | --- | --- |
| ① 路由态 | `active`、`routeFilters`、`routeEntityId` | `useWorkbenchNavigation`（B2） |
| ② 选中态 | `selectedCustomerId/OpportunityId/ActionId/RiskId/KnowledgeId/SolutionId/ItineraryId`（7）+ 对应 6 个 `selectedXxxIdRef` | 同上，**连 ref 机制原样搬家**（ref 解决 `openDetail` 内 onSelect→setViewMode 同 tick 时序，不可换实现） |
| ③ 视图模式 | `customerViewMode/opportunityViewMode/actionViewMode/riskViewMode/knowledgeViewMode/itineraryViewMode`（6） | 同上（与 `applyWorkbenchRoute`/popstate 强耦合，必须与①②同文件） |
| ④ bootstrap 数据 | `workbenchState`（8 集合+summary+status）、`backendStatus`、`bootstrapAttempt`、`bootstrapGenerationRef` | `useWorkbenchData`（B3），含 bootstrap effect、8 个 `setWorkbenchXxx`、`setOverviewSummary`、`refreshOverviewSummary`、总览切入即刷 effect（迁移时 effect 体与依赖数组**逐字符原样**） |
| ⑤ 快速记录会话 | `recordMode`、`recordText`、`analysisVisible`、`syncStatus` | `quickRecordSession`（B4）。此四项在 App 层的存在意义=跨页往返不丢草稿，Provider 挂 `SalesWorkbenchApp` 之上即保持该语义 |
| ⑥ 周报会话 | `weeklyView`、`weeklyDraft`、`weeklyDraftText` | `weeklySession`（B4）。跨域写入方=`handleCiteKnowledge`（知识页引用→写周报草稿→跳周报） |
| ⑦ 壳层杂项 | `workspaceRef`（移动端导航 reveal + 滚动容器定位） | 留在 App.jsx 壳 |

### 3.2 架构：4 个 hook 文件 + 3 个新 context（+既有 ToastProvider 先例）

**取舍**：按域 context + `useState` 群下沉到自有 hook 文件（推荐）vs context+useReducer。选前者——本版红线是零行为变化，`applyWorkbenchRoute` 的条件多字段写入、`navigateTo` 在事件内同步 pushState、ref 同 tick 读取三处语义在 useState+ref 原样搬家下**逐字符保真**；useReducer 能消灭 6 个 ref 但要求把"选中+切视图"合并成复合 action，会改变页面回调契约（onSelect/setViewMode 两回调），reducer 化记为 v0.11+ 可选演进。不引第三方 store（任务红线，且 toast 先例已证明自研 Provider 足够）。

结构（Provider 值全部 `useMemo` 稳定引用；每个 context 提供缺省 no-op，沿用 `useToast` 的 `?? (() => {})` 先例）：

```jsx
// SalesWorkbenchApp 内部：自己持有 hook API，向下 provide，页面用 useXxx() 消费
const nav = useWorkbenchNavigation({ initialRoute });   // ①②③⑦：navigateTo/applyWorkbenchRoute/selectXxx/changeXxxViewMode/openXxxDetail/openQuickHistoryRoute...
const data = useWorkbenchData({ apiClient });           // ④：collections/status/summary/backendStatus/setters/refreshOverviewSummary
const handlers = useWorkbenchHandlers({ nav, data, apiClient });  // 12 个 handleXxx 复合编排（数据+选中+导航+refresh 的既有调用顺序逐字保留）
return (
  <NavigationContext.Provider value={nav}>
    <WorkbenchDataContext.Provider value={data}>
      <WorkbenchActionsContext.Provider value={handlers}>
        <ToastProvider>…topbar/sidebar/页面分支…</ToastProvider>
```

- **复合处理器归属裁定**：`handleSaveCustomer`/`handleDelete*`/`handleBusinessSync`/`handleCiteKnowledge` 等 12 个函数跨数据层（merge/remove）、选中层（`selectCustomer`）、导航层（`navigateTo`），**不塞进 data hook**，收进独立 `useWorkbenchHandlers`——它同时拿 nav 与 data 两个 API，函数体从 App.jsx 原样剪切，调用顺序（如 `handleDeleteAction` 的 删→merge→选中清理→setViewMode→navigateTo→refresh）不动。
- `navigateTo("quick")` 内的 `setRecordMode("voice")` 重置：`quickRecordSession` hook 由 `SalesWorkbenchApp` 持有并传给 `nav`（或 nav 暴露 `onEnterQuick` 回调），保持"push 进快速记录才重置、popstate 回退不重置"的现语义——**禁止**改成对 `active` 的 effect（无法区分 push/popstate）。
- 页面分支 switch（15 个 `active === "…"` 渲染分支 + settingsSection 条件）、`ModuleSubnav` 接线、`resolveHeadingContext` 调用、`EntityUnavailablePanel` 守卫、topbar/sidebar **全部留在 App.jsx**——它就是壳。预估 App.jsx 1721 → **≤800 行**，四个 hook 文件合计 ~750 行。

### 3.3 props 收敛目标（任务红线 ≤6）

| 组件 | 现 props | 收敛后 | 说明 |
| --- | --- | --- | --- |
| `QuickRecord` | 22 | **0** | ⑤入 `useQuickRecordSession()`；apiClient/backendStatus/三集合入 `useWorkbenchData()`；onBusinessSync/onQuickRecordSaved/onConfirmationRefresh 入 `useWorkbenchActions()`；setActive/两 setSelected/openOpportunityDetail/routeHistoryId/onHistoryRoute 入 `useNavigation()`（routeHistoryId=nav 的 `routeEntityId`） |
| `Overview` | 14 | **0** | summary/三集合从 data；9 个导航回调从 nav |
| `WeeklyPage` | 8 | **0** | ⑥入 `useWeeklySession()`（其内部 `externalWeeklyDraft ?? local` 双轨兜底逻辑随之删除——context 恒有值）；apiClient/backendStatus 从 data |
| 五实体页 | 8–13 | **≤5** | 保留 `items`（含 scopedActions/scopedRisks 的商机过滤，App 分支处计算）、`selected`、`onSelect`、`viewMode`、`setViewMode`；其余（onSaveXxx/onDeleteXxx/customersList/apiClient/backendStatus/onCiteKnowledge…）全走三 context |

### 3.4 验收标准

1. `rg "apiClient=|backendStatus=" src/App.jsx` 页面分支传参归零（TravelExpensePage/SystemSettingsPage 等 feature 页本版**不强制**收敛，保留直传，记为 v0.10.2+ 顺手项——差旅域文件所有权独立，避免与其潜在并行改动冲突）；QuickRecord/Overview/WeeklyPage JSX 调用零业务 props。
2. 行为走查（§5.4 清单)全绿：跨页往返快速记录草稿保留、知识引用→周报草稿携带、popstate 回退滚动位置恢复、总览切入即刷、删除后回列表、URL 深链直开 detail/edit。
3. `module-coverage` 的"re-fetches the dashboard summary"断言在新文件锚点下全绿（effect 逐字符未变）。
4. App.jsx ≤800 行；四 hook 文件均有专属单测挂链（见 §5.3）。

## 4. 实体列表页抽象 EntityWorkspace（§设计范围 1）

### 4.1 契约（新文件 `src/features/salesWorkbench/pages/EntityWorkspace.jsx`，自动进 pages-source 扫描面）

抽象边界裁定：**列表视图全量收编 + 详情视图只收"壳"**（sticky 工具栏/删除状态机/detail-surface 容器），详情面板体与编辑器留在各页（客户/商机/知识是"编辑器替换详情体"，待办/风险是"metrics 常驻+中段按模式切换"，两种拓扑强行统一必伤 DOM 结构）。这就是五页 ~60% 同构面的诚实切法。

```jsx
export function EntityWorkspace({
  items, selected, activeRowId, onSelect, viewMode, setViewMode,   // 来自 App 分支的既有五件套 + activeRowId
  config,        // 页面级静态配置（见下表）
  onDelete,      // 既有 onDeleteXxx 直传
  renderDetail,  // ({ viewMode, isCreateView, isEditView }) => 详情面/编辑器 JSX（页面自有）
})
```

`config` 字段与五页差异点枚举（**全部字面量写在各页文件内**——testid/aria-label/文案保持可 grep，是守护断言零改乃至少改的关键）：

| config 键 | customer | opportunity | actions | risk | knowledge |
| --- | --- | --- | --- | --- | --- |
| `listViewTestId`/`detailViewTestId`/类名 | customer-list-view / customer-detail-view | opportunity-* | **action-list-view / action-detail-view**（列表 testid 前缀 actions-、详情 action-，单复数差异照抄现状） | risk-* | knowledge-* |
| `panelTitle`/`listMeta(v,t)` | 客户列表 / "v / t 家客户" | 商机列表 / "v / t 个商机" | 动作列表 / "v / t 个动作" | 风险列表 / "v / t 个风险" | 知识列表 / "v 条" |
| 搜索 | 本地过滤：fields=[name,region,type,level,contact,summary,owner]，placeholder/aria-label/testid 照抄 | 本地：[name,customer,stage,risk,next,owner] | 本地：[title,customer,reason,due,priority,status,assignee] | 本地：[title,target,evidence,action,severity,status,assignee] | **`renderSearch` 自定义槽**（后端检索 form + `searchStatus` 提示行 + v0.10.0 清空还原；`visibleItems` 由页面算好传入，EntityWorkspace 跳过本地过滤） |
| 行渲染 `rowPrimary/rowSecondary/renderRowBadge` | name / region/type/contact / `pill tone-blue` level | name / customer/stage / pill probability% | title / customer/due/状态label / pill priority | title / target/状态label / **score-chip** score | title / category/tags / pill 已入库 |
| 行操作槽 `renderRowActions(item)` | — | — | **v0.10.0 行内"完成/延期"按钮组**（optimisticStatus/pendingQuickIds 状态与 `quickPatch` 留在 ActionsPage，经槽注入） | — | — |
| 建卡按钮 `createAction` 槽 | 新增客户 `customer-create-detail` | 新增商机 | **新增待办 `actions-create-detail`（v0.10.0）** | **无**（工具栏与 Panel action 均不渲染建卡位） | 新增知识 |
| 工具栏 | edit/delete testid=customer-* | opportunity-* | action-* | risk-* | knowledge-* |
| 删除确认 `deleteDialog` | title/description/entityName/`testIdPrefix="customer-delete"`/成功 toast 文案 | opportunity-delete | action-delete | risk-delete | knowledge-delete |
| 空态两句 | "暂无客户，可点击"新增客户"开始录入。"/无匹配句 | 照抄各页 | 照抄 | 照抄 | 照抄 |
| 详情体（留在页面，`renderDetail`） | metrics+three-col+profile-grid(4 Panel，v0.10.0 已去重)+ManualConfirmBox+CustomerEditor | metrics+两列六 Panel+Timeline+SalesDecisionPanel+detail-actions+OpportunityEditor | metrics+编辑 Panel（含 v0.10.0 remindAt 控件）/只读两 Panel+ActionCreateForm | metrics+risk-meter+状态流转/处理状态+证据+建议处理 | tag-row+citation-panel+引用口径/场景+ManualConfirmBox+KnowledgeEditor |
| 子导航差异 | 无页内子导航 | 同左 | items 已被 App 按 `scopedOpportunityId` 过滤，抽象无感知 | 同 actions | 无 |

EntityWorkspace 本体收编的同构块：列表 section+Panel+search-box+`list-stack`（`article.list-button.customer-list-row` + `list-row-main` 选中钮 + `查看详情` 钮）+两态空文案 + `sticky-subview-toolbar`（返回/修改/删除）+ `detail-surface` 容器 + **五套 v0.10.0 复制的删除状态机收敛为一**（deleteDialogOpen/deleteBusy/deleteError + `ConfirmDialog` + 成功 toast + `setViewMode("list")`，调用顺序照抄 CustomerPage 的 `confirmDeleteCurrentCustomer`）。选中行高亮用 `activeRowId`（客户/商机传 `selected?.id`，待办/风险/知识传各自 `current?.id`——`current = selected ?? items[0]` 回退派生留在页面，照抄现状）。

### 4.2 迁移顺序与"迁一页跑一页"

顺序按风险升序、契约覆盖度递增：**风险（最简：无建卡无编辑器）→ 待办（验证行操作槽+建卡+create 表单）→ 知识（验证自定义搜索槽）→ 商机 → 客户**（面板最多、原生弹窗基线，放最后收口）。每页迁移 = 该页改为 `EntityWorkspace` 调用 + 全量 `qa:local` + 该页人工走查（列表搜索/选中/查看详情/修改/删除弹窗/建卡/URL 深链）+ 独立 commit。任一页出问题单独 revert 该 commit，其余四页不受影响。

### 4.3 预估删除重复代码

五页现状（v0.9.3）1789 行，v0.10.0 落地后预估 ~2050 行。毛删同构面 ~700 行（列表视图 5×60 + 工具栏 5×30 + 删除状态机 5×35 + 本地搜索 4×12 + openDetail 胶水 5×8），新增 EntityWorkspace 本体 ~250 行 + 五页 config ~125 行，**净删 ≥300 行，五页文件合计降约 20%**；后续每新增一个实体域（如 v0.11.0 招标转线索）边际成本从"复制 400 行"降为"~30 行 config + 详情体"。

### 4.4 导出面与断言零变化承诺

- `pages.jsx` barrel 12 个导出**一个不动**；五页导出函数名/props 签名（§3.3 收敛后的终态）不变；全部 data-testid、CSS 类名（含 `customer-list-row` 历史通用类）、aria-label、文案、`ConfirmDialog` 的 `testIdPrefix` 零变化——DOM 序列化输出与迁移前逐字节一致（走查方法见 §5.4）。
- 源断言层面做不到"零改"的（拼接源里 `<Panel` 与 testid 的相对距离、`<article` 出现次数等），全部走 §5.2 改取源先行清单，**运行时行为与 DOM 仍是零变化**——这正是 v0.8.4 pages 拆分验证过的方法论：测试改的是"从哪里读源码"，不是"断言什么行为"。

## 5. 回归保障（§设计范围 4）

### 5.1 测试组受影响面（qa:local 全链 27 组 + build + scan:secrets；任务书口径存量 456 项 = v0.10.0 落地后全量）

| 组 | 影响 | 说明 |
| --- | --- | --- |
| test:auth/download/quick/week/state/api/sales-decision(+page)/itinerary(+page)/travel-expense/stage-strip/favicon/static/settings/user-management/tender/polish | **零影响** | 纯模型/API/差旅域/CSS 断言，三块重构不触碰 |
| test:routes（routes.test.js，~999 行） | **零影响** | routes.js/navRoutes.js 本版一行不动（vite.config.mjs 依赖 `normalizeBasePath`，继续成立） |
| **test:modules**（module-coverage） | B 改取源 | "re-fetches the dashboard summary" 三条正则改读 `useWorkbenchData.js`；"wires grouped subnavigation" 中 `setSelectedOpportunityId(route.entityId)`/`route.filters?.opportunityId`/popstate 三锚点改读 `useWorkbenchNavigation.js`；"renders a page branch"（`active === "…"` 留 App.jsx）与 sidebar/solution 断言不动 |
| **test:copy**（formal-ui-copy） | A/B/C 均涉 | `useState("voice")` 锚点改读 `quickRecordSession` 文件；`uiFiles` 追加 4 个 hook 文件 + RouteChunkBoundary/fallback 所在文件（EntityWorkspace 经 pages-source 自动纳入）；新文案过禁用词表 |
| **test:contract**（customer-opportunity-contract） | B/C 改取源 | 源文件列表追加 hook 文件；`listRowContainers >= 5` 改为"EntityWorkspace 含唯一 `<article` 模板 + 五页 config 各含 rowPrimary"双断言；`list-row-main` 计数随之调整；`recordText useState("")` 锚点随 B4 移动；`create-detail…setViewMode?.("create")` ×3 与 `initialMode={isCreateView…}` ×3 的字面量保留在页面 config/renderDetail 内，断言不动 |
| **test:list-actions**（list-action-layout） | C 改取源 | `<Panel…data-testid="xxx-create-detail"` 500 字符窗口断言重写为：①EntityWorkspace 源含 `action={config.createAction}`；②三（v0.10.0 后四）个 create testid 存在于 pages 拼接源 |
| **test:forms**（form-accessibility） | C 改取源 | `tagByTestId("customer-local-search")` 就近找 `<input` 的机制失效（testid 字面量在 config、`<input` 在 EntityWorkspace），改为：①EntityWorkspace 搜索 input 模板必含 `aria-label={config.searchAriaLabel}`；②五页 config 各含 searchAriaLabel 字面量；知识页自定义搜索槽断言照旧 |
| **test:readonly**（readonly-detail-actions） | C 少量 | edit/delete/cancel testid 字面量保留在 config/编辑器内 → 断言**不动**；`viewMode === "edit"` 匹配 EntityWorkspace 源仍命中 |
| **test:controls**（interactive-controls） | 自动扩面 | EntityWorkspace/新 hook 文件（无 JSX 的也挂入 controlFiles 防未来长 UI）；所有模板按钮带 `type="button"`+onClick；day-card/manual-sync 断言不动 |
| **test:visual**（visual-rhythm） | A 涉 | pages 14 页清单/testid/密度选择器（`.customer-list-panel` 等五类名保留）全部不动；懒加载等待机制见 §2.4-5 |
| **新增 test:bundle**（bundle-budget） | A 新守护 | 主 chunk <500KB、页面 chunk ≥15、pdf chunk 独立存在 |
| qa:integration / qa:webkit | **零改动预期** | 均为 waitUntil/waitFor 轮询（5–8s 超时），本地静态服务 chunk 毫秒级；`customer-list-row` 行结构校验（1 主钮+1 详情钮）在抽象后 DOM 不变 |
| 后端 `npm test` | **零影响** | 本版零后端改动，仅例行全量回归 |

### 5.2 "改取源先行"清单（B1/C1 两个 commit 的全部内容，先对现状跑绿再迁移）

1. `formal-ui-copy`：recordMode 断言改双文件 concat；uiFiles 扩列。
2. `module-coverage`：overview-refresh 三正则与 subnav 两锚点改"App.jsx + src/app hook 文件"concat 读取（效仿 pages-source 聚合器，可新建 `scripts/app-source.mjs`）。
3. `customer-opportunity-contract`：文件列表扩容；`<article` 计数断言按 §5.1 重写为双接受（旧五页形态 or 新模板+config 形态），C8 收紧为仅新形态。
4. `list-action-layout`/`form-accessibility`：按 §5.1 重写为双接受，C8 收紧。
5. 新增组件级断言（随 C2）：EntityWorkspace 源含 sticky-subview-toolbar/ConfirmDialog/detail-surface/空态双句模板；五页各含 `<EntityWorkspace` 调用与自身 config 字面量。

### 5.3 新增守护测试（预估 ~32 条）

| 挂点 | 条数 | 要点 |
| --- | --- | --- |
| `scripts/bundle-budget.test.mjs`（新 test:bundle，qa:local 排 build 后） | 5 | 主 chunk 字节上限 500_000；页面 chunk 计数；pdf/worker 独立；CSS 单文件不膨胀（<210KB）；index.html 含 modulepreload |
| App.jsx 源断言（并入 module-coverage） | 4 | 15 个 `active===` 渲染分支仍在 App.jsx；`lazy(() => import(` 计数 ≥15；Overview 为静态 import；Suspense fallback testid 存在 |
| 4 个 hook 文件单测（`src/app/*.test.js`，挂新 test:app-state 或并入 test:state） | 12 | navigation：applyWorkbenchRoute 各分支/ref 同步/navigateTo 重置 quick；data：bootstrap 竞态（generation guard）/集合 setter normalize；handlers：删除后选中清理顺序；session：缺省 no-op |
| EntityWorkspace 源断言 + 五页 config 断言（§5.2-5） | 8 | 模板结构/五页字面量/风险页无建卡位/待办行操作槽存在 |
| RouteChunkBoundary | 3 | 捕获后渲染 error 面板/重载按钮 type/正常子树透传 |

### 5.4 "重构版零行为变化"验收红线：逐页走查清单与对照方法

**机器对照（部署前，两轮跑）**：①重构前基线：在 A2 前的 commit 上跑 `test:visual` 留存全部量化指标输出（topInset/titleToFirst/headingToFirst/firstViewportRatio/列表密度 fillRatio，14 页×6 视口）；②C8 后同参数复跑，**两份指标逐项相等**（数值 diff 为空即"零视觉 diff"的结构化证明）；③CSS 层 `git diff --stat src/styles/global.css` 预期为 0 行（本版零 CSS 改动承诺）。
**截图对照**：CDP 截图归档 `docs/superpowers/reports/assets/v0101-groundwork/`——14 页 × mobile(390)/desktop(1440) 重构前后 side-by-side ≥28 组，重点五实体页补 detail/edit/删除弹窗三态，回填 release。
**人工逐页走查（生产验收，对照 v0.10.0 已验收行为）**：

| 页 | 必走动作 |
| --- | --- |
| 五实体页逐页 | 搜索过滤→清空、行选中高亮、查看详情、URL 深链直开 detail/edit 并刷新、修改→保存（editor-status 文案）、删除弹窗 Escape 取消/确认 + 成功 toast、返回列表；待办页另走行内完成/延期（乐观回滚）与新增待办；知识页另走后端检索/清空还原/引用到周报 |
| 快速记录 | 录入→切走→切回草稿保留、分析 pending 态、三路同步、历史深链 `mode=history` |
| 总览 | 切入即刷（网络面板见 summary 请求）、KPI/今日焦点跳转 |
| 周报/看板/行程/差旅 | 知识引用带草稿跳周报、看板推进 toast、行程"记当日费用"预填、差旅 tab/打印 |
| 壳层 | 9 项导航+子导航上下文胶囊、浏览器前进后退滚动恢复、头像菜单登出、移动端 390px 横滚导航 reveal |

## 6. 本版不做（边界）

- 选中态 useReducer 化、feature 页（差旅/设置/招标/行程）props 上下文化、行程行内红条并入 ConfirmDialog → 顺延后续版本。
- global.css 拆分（审计指出的下一个单文件对象）、骨架屏、页面过渡动效 → 不属"铺路"，归 v0.10.2+。
- manualChunks/vendor 拆分 → 仅作 §2.3 后手预案。
- SSE/查询缓存/数据层轮询改造 → 明确不做，bootstrap 一次拉全模式保持。

## 7. v0.10.1 门禁清单与部署验收

**门禁（全部机器化）**：
1. 前端 `qa:local` 全绿：存量 456 项（v0.10.0 落地后口径）+ §5.3 新增 ~32 条，含新挂链的 test:bundle 与 hook 单测；`qa:integration` + `qa:webkit` 真浏览器链路全绿。
2. 后端 `npm test` 全量回归（零改动确认）。
3. 守护 rg 归零（C8 后）：五页内 `sticky-subview-toolbar` 模板串、`deleteDialogOpen` 状态机、`search-box page-search` 重复实现零命中（全部只在 EntityWorkspace）；App.jsx 内 `useState(` 计数 ≤5。
4. §5.4 机器对照三件套：visual 指标两轮相等、CSS diff 0 行、截图 ≥28 组归档。
5. `dist/assets` 实测回填 §2.3 预算表进 release 文档；主 chunk 实测值必须 <500KB。

**部署验收（纯重构版 = 零视觉/行为 diff 证明）**：生产四关部署后，①§5.4 人工走查清单全项通过并录屏/截图存证；②真机 iPhone：首开 overview 无二段加载、弱网（3G 节流）首访差旅页 fallback→内容完整、v0.10.0 全部新交互（行内完成/toast/弹窗/头像菜单）复走一遍无差异；③网络面板存证首屏传输量对比（预期主 JS 传输 gzip ~200KB→~120KB，写入 release）；④CHANGELOG [0.10.1] 明确记录"用户可感知变化=仅首访各页多一次瞬时加载态 + 首屏更快"，其余零变化。
