# 前端与用户体验审计报告（下一代大目标方案决策输入）

- 日期：2026-08-28 · 审计方式：**只读**静态代码审查 + v07 走查截图核对（41 张，`docs/superpowers/reports/assets/v07-walkthrough/`）
- 代码基线：worktree `integrate-v0626-candidate`，HEAD `34dc7d7`（**v0.8.4 的 pages.jsx 拆分已落地**，本文行号以拆分后的 `src/features/salesWorkbench/pages/*.jsx` 为准；截图摄于 v0.7 系列，仅用于版式结构佐证，视觉参数以代码为准）
- 用户画像：医疗行业销售，单人使用，经常出差，微信重度用户；目标形态="完美的智能 AI 销售助手"
- 上轮输入：`2026-08-27-visual-audit-v081.md`（视觉审查）、`2026-08-28-v084-engineering-health-inventory.md`（工程盘点）、releases v0.8.1–v0.8.3
- 文中前端路径均相对 `outputs/product-design-prototype/`

---

## 1. 信息架构与导航

### 1.1 站点地图（实测自 `src/data/salesWorkbenchData.js` L28–58、`src/app/navRoutes.js`）

```
主导航（9 项）              子页/子导航
├─ 战情总览
├─ 快速记录                 新建 / 历史（mode=history，URL 带记录 id）
├─ 客户画像                 客户档案（列表/详情/新增/编辑）｜招标监测
├─ 商机                     商机档案（列表/详情/新增/编辑）｜风险识别｜下一步动作｜看板
├─ 智能拜访行程             列表 / 详情 / 新建 / 编辑
├─ 差旅报销                 账本 tab ｜发票 tab（+打印预览/区域设置浮层/编辑抽屉）
├─ 周报与汇报               每日记录 tab ｜分析汇总 tab
├─ 知识库                   列表/详情/新增/编辑
└─ 系统配置                 安全与AI配置｜微信绑定｜通知服务｜招标调度｜记账日志
（隐藏路由）历史方案 solutions —— 无任何导航入口，仅 compatibilityRouteMeta 兜底（salesWorkbenchData.js L60–62）
```

- 路由为手写 pushState 方案（`src/app/routes.js`），URL 可收藏/分享/回退，滚动位置随历史恢复（`App.jsx` L615–646），实体不存在有守卫面板（`App.jsx` L359–368）。质量高于一般内部工具。
- 二级归属合理（招标挂客户、风险/待办/看板挂商机），子导航上下文胶囊（"当前商机：xxx"+清除）设计好（`App.jsx` L1289–1293）。

### 1.2 导航层级问题

1. **头像单击即退出登录、无确认无菜单**（`App.jsx` L1401–1403：`onClick={onLogout}`）。移动端头像紧邻"快速记录"主按钮（430px 断点下 topbar 四列，global.css L4867），出差单手误触即被登出，属 P0 交互缺陷。
2. **移动端主导航是 9 项横滚条**（global.css L4787–4825：sidebar 变 `flex-direction: row; overflow-x: auto`，每项 min-width 92px ≈ 总宽 900px+），"差旅报销/周报/知识库/系统配置"都在第二、三屏，无底部 tab 栏、无 FAB；子导航又是一条横条（截图 `mobile-travel-expenses.png` 顶部可见双横条叠加）。高频页的到达成本被横滚放大。
3. **"历史方案"成为孤岛页**：有路由有页面但无入口，页面内还直接显示裸 ID（`pages/SolutionPage.jsx` L46–47：`客户 ID：{currentSolution.customerId}`）。
4. topbar 全局入口只有"周报/快速记录"两枚，语义与侧栏重复；总览 hero 里又有第三处"新增快速记录"（`pages/OverviewPage.jsx` L260–263），入口冗余而"记一笔费用/新建行程"等出差高频入口没有全局位。

### 1.3 高频动线步数实测（点按次数，不含打字）

| 动线 | 步数 | 路径与绕点 |
| --- | --- | --- |
| 出差记账（Web 手工） | 4 | 横滚导航→差旅报销→"手工记一笔"→抽屉填 6+ 字段→保存；微信拍凭证=1 步，Web 只应承担核对 |
| 出差记账（从行程） | 3 | 行程详情→"记当日费用"→抽屉已预填日期/事由/关联（v0.8.3 联动，`App.jsx` L980–992），体验最好的一条动线 |
| 拜访记录全流程 | 5–7 | 快速记录→录入→"确认调用 AI 分析"→（改动需先"保存分析修改"）→逐个点"同步客户/商机/周报"3 次（`pages/QuickRecordPage.jsx` L813–829）。同步无"全部确认"批量键 |
| 周报 | 5 | topbar 周报→空态"生成本周周报"→切"汇总"tab→编辑→保存/定稿→导出 Word |
| 看商机 | 2 | 侧栏商机→列表"查看详情"；看板要再走子导航（3 步） |
| **完成一个待办** | **5** | 商机→子导航"下一步动作"→详情→"修改"→"标记完成"（`pages/ActionsPage.jsx` L176–214，状态按钮藏在编辑视图）。最高频操作动线最深，列表行无快捷完成 |

---

## 2. 逐页体验审计（评分 A–D）

> 通用底盘先记一笔：全站空态/加载态/错误态在 v0.8.1 后已有统一样式（`workbench-state-panel` 定义于 global.css L6738–6768；bootstrap loading/error/empty 齐备，`App.jsx` L317–357）；表单校验普遍为"提交时校验+行内 status 文本"，无字段级即时校验、无必填星标；文本输入均为受控组件，未见 IME composition 处理（中文输入下 onChange 逐字触发 `resetAnalysis` 等副作用，见 3.2/快速记录）。

| 页面 | 评分 | 前三改进点（含出处） |
| --- | --- | --- |
| 战情总览 | B | ① 移动端"今日焦点"排 DOM 第 8 块（4×KPI+hero+优先动作+客户温度之后，`pages/OverviewPage.jsx` L243–322；760px 断点单列按 DOM 序，global.css L4918–4931），出差早上看"今天干嘛"要滑 3–4 屏——应置顶；② hero 大卡占黄金位且展示三个写死的假统计"7 天记录视图/3 路业务同步/1 套销售数据"（OverviewPage.jsx L254–258），对单人日用工具是营销噪音；③ KPI 卡点击可跳转但无任何可点击示能（无 chevron/hover 文案），与"客户温度"行可点击的样式语言不一致 |
| 快速记录 | B+ | ① "确认调用 AI 分析"无 pending 态：按钮不 disabled、无 spinner（QuickRecordPage.jsx L706–714；`confirmAnalysis` L357–399 无 in-flight 状态），慢网下可重复提交，且分析等待期只有一行 status 文本反馈；② 语音转写依赖浏览器 Web Speech API（L49–58），Chrome 国内不可用、iOS Safari 支持不稳，无服务端 ASR 兜底——"语音"作为门面能力实际经常降级为"改用文本"；③ 每次 textarea onChange 都 `resetAnalysis`（L691–695），中文 IME 组字过程中已生成的分析会被立即清空提示"内容已变化"，体验粗糙 |
| 客户画像 | B | ① "组织架构与决策链"与"关键联系人"两个 Panel 渲染同一份 stakeholders（`pages/CustomerPage.jsx` L383–389，后者只是 slice(0,4)），信息重复占一屏；② 假展开交互：干系人/决策链/标签点开只显示占位句"已展开：适合补充最近沟通…"（`pages/shared.jsx` L37–41、L62、L84），零信息量还伤 AI 可信度；③ 编辑表单 13 个字段无必填标识，校验仅提交时查 name（CustomerPage.jsx L92–96），aliases/tags 字段 API 已支持但表单没有（工程盘点债 #13） |
| 商机 | B | ① SalesDecisionPanel 是全站最佳 AI 呈现（见 §6），但入口埋在详情页底部第 4 屏（`pages/OpportunityPage.jsx` L394–400）；② 阶段 stage 是自由文本输入（L150–152），与看板七阶段词表、后端 stageVocabulary 三处并存（盘点债 #1），手输错词商机会掉出漏斗统计；③ 来源记录/风险说明/下一步动作三卡全是假展开（L363–392） |
| 待办(动作) | C+ | ① 完成待办要 5 步（见 1.3），列表行无快捷完成/延期；② 截止时间是自由文本（"今天 18:00/周一上午"，ActionsPage.jsx L184–186 普通 input），remind_at 无 Web 编辑（盘点债 #4），Web 建的待办永远不会提醒；③ 页面无"新增待办"入口，只能靠快速记录 AI 或微信生成——补录一条口头答应的事在 Web 端无路可走 |
| 风险 | B- | ① 同 due 自由文本问题（RiskPage.jsx L213–216）；② 证据/建议处理也是假展开（L252–271）；③ 状态流转按钮在编辑视图内（L206–238），确认一个风险也要先点"修改" |
| 看板 | B- | ① 按钮式回退/推进适配移动端（KanbanPage.jsx L71–94，无拖拽是合理取舍），但七列横滚（760px 下每列 72vw，global.css L4979–4981）在手机上找一个商机要滑 5 屏；② 数据只来自 bootstrap，页面无刷新手段；③ 阶段词表硬编码于前端 `kanbanStages`（salesWorkbenchData.js L473–481） |
| 行程 | A- | 全站表单标杆：date/datetime-local 原生控件、8 站上限、地理编码+AMAP 导航深链、"记当日费用"联动（VisitItineraryPage.jsx L296–345、L232–234）。改进：① 删除确认是行内红条（L182–189），与客户的样式弹窗、其余页的 window.confirm 三范式并存；② 表单校验全靠浏览器 required 默认气泡，风格与站内 status 文本不一致；③ 列表空态是一行灰字（截图 `mobile-itineraries.png`），未引导"从客户档案带出地址" |
| 差旅报销 | A- | 功能密度全站最高且工程最扎实（focus/visibility 自动刷新 + 12s 轮询仅在有待确认项时启用，TravelExpensePage.jsx L219–236；主数据失败整页错、辅数据失败降级黄条 L192–203；aria 密度最高）。改进：① 只有"自然周"视角，无月度/多周汇总，报销通常按出差趟次或月申报；② 账本+发票+打印+凭证+区域设置全部塞在一页两 tab，纵深过长（源文件 729 行 + 12 个子组件）；③ 周切换用原生 week input（isoWeekInput L33–41），iOS Safari 对 `<input type="week">` 不支持，出差主力机型上会退化为文本框 |
| 周报 | C+ | ① tab 名"本周每日记录"名实不符：渲染的是来源引用卡片而非每日记录（WeeklyPage.jsx L163–198，卡片正文是"来源已纳入…周报草稿"的模板句）；② 周期固定 `getCurrentWeekRange()`（L50、L117），不能补写上周/查历史周报，重新生成即覆盖当前草稿；③ 正文是纯 textarea（L226–231），九段结构（拜访时间/客户/目的…）只在提示文案里存在，无结构化编辑或分段回填 |
| 知识库 | B- | ① 检索是后端搜索，但清空关键词不会还原全量列表（KnowledgePage.jsx L154–170：visibleItems 只在 items 变化或再次提交时重置），用户会以为库里只剩检索结果；② "引用场景"是写死四条通用文案（L352–357）；③ 引用动作只有"引用到周报"，知识→方案的动线断头（handleCiteKnowledge 仅支持 weekly，`App.jsx` L1224–1249） |
| 招标监测 | B | ① 公告无处理动作（已读/收藏/忽略/转商机），信息流看完即沉底（HospitalTenderPage.jsx 全文无状态写操作，页面 readOnly=true，routes.js L27）；② 初显 8 条+200 条分页合理，但相关度只有高/中/低标签，无"为什么相关"证据；③ 健康状态条设计好（HEALTH_LABELS L43–52） |
| 系统配置 | B | 五分区+密钥一次性显示+调度可视化，超出内部工具水准（SystemSettingsPage.jsx L535–784）；记账日志 10s 轮询（L311）无手动刷新键；分区靠子导航切换，无锚点概览 |
| 微信绑定 | B | 轮询收敛好（仅 starting/waiting_scan 时 1.8s，WeixinBindingPage.jsx L45–75）；改进：绑定成功后无"接下来去微信里做什么"的能力清单（现只有一句"微信消息会进入快速记录流程"L169），这是双端认知的关键接缝 |
| 登录 | B+ | 品牌面+表单结构清晰，401 与网络错误分辨（App.jsx L206），autoComplete 正确；密码眼睛按钮 icon-button 在表单内，Enter 提交正常 |
| 历史方案 | C- | 无导航入口+裸 ID 展示+只读（见 1.2），实质是遗留页，下一代方案应决定去留 |

---

## 3. 视觉一致性复查（对照 v0.8.1 落地后）

### 3.1 上轮 P0–P2 已确认落地

- 设计 token 已入 `:root`（`--radius-card/--radius-control/--radius-chip/--focus-ring/--surface-muted`，global.css L31–35）并被广泛引用（L1508、L3771、L5829 等）；`workbench-state-panel` 已有完整样式（L6738–6768）；PWA 三件套已上线（见 §4）；全局细滚动条、iOS 色票清理在 CHANGELOG [0.8.1] 记录并抽查属实。

### 3.2 P3 残留（上轮明确"未做"，现状复核仍在）

| 项 | 现状证据 |
| --- | --- |
| 非整百字重 550–850 | global.css 仍有 **36 处**（rg `font-weight: (55|62|…|85)0` 计数）；PingFang/雅黑非可变字体，跨端渲染仍不可控（上轮 §5.1） |
| `.module-subnav` 渐变 tint 形态 | 仍是 `linear-gradient(135deg, rgba(47,107,255,.055)…)`（L5167），与"白卡+下划线 tab"基准并存，每页可见 |
| eyebrow/kicker 双规格 | `.eyebrow` 与差旅 kicker 仍两套（上轮 P3-20 未动） |

### 3.3 新引入面与新发现

1. **总览三新卡与 token 一致**（today-focus-row 44px 触控/12.5px 字号，global.css L1906–1938；趋势条用 CSS 变量驱动宽度）——v0.8.3 新面未引入回归。
2. **"假展开"是新的最大一致性问题**：`MatchCard/ExpandableInsight/InfoList/Timeline/StakeholderGrid/FieldTags/DecisionChain` 七个基元的 expanded 态全部输出固定占位句（primitives.jsx L155、L177、L220、L316；shared.jsx L39、L62、L84）。它们视觉上做成可点卡片、语义上是 `interactive-card`，点开却无信息，属于"装饰性交互"，与差旅模块"点开必有真数据"的语言相悖。
3. **删除确认三范式**：样式弹窗（仅客户，shared.jsx L153–221）/原生 `window.confirm`（商机/待办/风险/知识，shared.jsx L142–151）/行内红条（行程）。`window.alert` 仍是操作失败的兜底（showOperationError）。
4. **反馈系统缺位**：全站无 toast/snackbar，写操作结果散落在各处行内 status 文本（editor-status/risk-status-message/syncStatus…），跨页操作（如看板推进）成功与否要靠眼睛找一行小字。
5. 与现代 SaaS 对标的缺失面：无骨架屏（loading 为整页面板替换）、无页面/列表过渡动效（仅抽屉滑入与 tab 下划线）、无暗色模式、无键盘快捷键、无全局搜索/命令面板。间距与层级系统在 v0.8.1 后已达标，成熟度短板集中在**微交互与反馈**层。

---

## 4. PWA 与移动深化空间

### 4.1 现状（实测文件）

- `public/sentelligent.webmanifest`：name/short_name/standalone/192+512 图标/`start_url=./overview` 齐备（v0.8.1 撞路由避让后 v0.8.2 验证 200，release v0.8.2 PWA 复验行）。
- **无 maskable 图标**（manifest icons 无 `purpose: maskable`），Android 添加主屏后图标会被白圈裁切；**无 iOS `apple-mobile-web-app-capable`/status-bar meta**（index.html 仅 11 行），iOS 添加主屏依赖 Safari 对 manifest 的部分支持，状态栏样式不可控。
- **无 Service Worker**（全仓 rg `serviceWorker` 零命中）：离线打开=浏览器错误页；弱网打开=白屏等 bootstrap；断网中操作=`createErrorWorkbenchState` 整页错误（workbenchState.js L74–82），已输入未保存内容无任何本地暂存。

### 4.2 出差路上单手场景痛点推演（结合代码事实）

1. **高铁隧道/医院地下机房**：无 SW+无缓存 ⇒ 掏出手机什么都看不到。上轮"离线收益低"的判断基于"内部工具"，但对"经常出差"的目标用户，**只读缓存最近一次 bootstrap + 总览摘要**是低风险高收益的中间态（不做写队列）。
2. **单手可达性**：全局主操作（快速记录/周报）都在 topbar 顶部，430px 下拇指热区（屏幕下半）没有任何操作位；9 项导航横滚也在顶部。无 FAB、无底部导航。
3. **语音入口不可靠**：见 §2 快速记录——移动 PWA 场景里"按住说话"才是符合肌肉记忆的形态，当前依赖 Web Speech 且 standalone WebView 下兼容性更差。
4. **刷新语义**：无下拉刷新；除差旅页有 focus/visibility 自动重拉外，客户/商机/待办列表自 bootstrap 后不再更新，微信侧小小写入的新数据要整页刷新才可见（总览已在 v0.8.3 修复为切页即刷，其余页没有）。
5. `<input type="week">`（差旅）与 `datetime-local`（行程）在 iOS 的支持差异未做降级，真机表单体验有硬伤。

---

## 5. 前端工程质量

| 维度 | 事实与证据 | 评价 |
| --- | --- | --- |
| 规模 | 前端共 ~1.7 万行：global.css 6824 行单文件、App.jsx 1698、api 1442、差旅域 12 组件；pages.jsx 已拆为 13 文件（HEAD `34dc7d7`） | 拆分方向正确；CSS 单文件是下一个应拆对象 |
| 组件复用 | primitives 11 个 + pages/shared 10 个；但"列表 Panel+搜索框+list-button 行+sticky 工具栏+detail-surface"的整套版式在客户/商机/待办/风险/知识五页各复制一份（五个文件同构 ~60%，如 CustomerPage L233–295 vs OpportunityPage L234–296），改一处要改五处 | 复制型复用，缺"实体列表页"抽象 |
| 状态管理 | 全部状态集中 App.jsx useState 群（~25 个 state + 6 个 ref），prop drilling：QuickRecord 收 20 个 props、Overview 收 14 个（App.jsx L1483–1524）；无 context/store/查询缓存 | 单人应用尚可运转，但每加一页 App.jsx 线性膨胀，是拆分后的最大剩余债 |
| 数据获取 | bootstrap 一次拉全部 8 类集合（loadBootstrap，App.jsx L736–794）；轮询三处：差旅 12s（仅待确认>0）/记账日志 10s/微信绑定 1.8s（仅扫码期），无 SSE/WebSocket；总览切入即刷（v0.8.3） | 轮询收敛纪律好；代价是"非当前页数据陈旧"与首屏随数据量线性变慢 |
| Bundle | dist：主 JS 698KB（超 vite 500KB 警告线）+ CSS 200KB 单 chunk 全量加载；pdfjs 已动态 import（AuthenticatedPdfFrame.jsx L15–16 等）拆出 453KB+1.2MB worker | 无路由级 code-splitting；对 4G 首开有感 |
| 可访问性 | 有专门门禁 `test:forms/test:controls/test:polish`（package.json L26–28）；差旅域 aria 密度高（TravelExpensePage 6 处+子组件 30 处），salesWorkbench 各页仅 1–4 处；假展开卡片无 `aria-expanded`（MatchCard/InfoList 等）；对比度未见自动检查 | 底线有门禁，页面间水位差大 |
| i18n | 无 i18n 框架，全部文案硬编码中文（含 `formal-ui-copy.test.mjs` 直接断言中文文案）；日期格式硬编码 zh-CN | 单人中文工具可接受，列为"永不做也行"的已知取舍 |
| 测试 | qa:local 434 项 + Chrome/WebKit 真浏览器集成 + 视觉节奏截图 ×6 视口；孤儿测试已修（`test:tender` 已挂链，commit `752a793`） | 工程门禁是本项目最强资产 |

---

## 6. AI 能力的界面呈现

### 6.1 呈现质量分级（Web 端现状）

| AI 面 | 呈现 | 评价 |
| --- | --- | --- |
| 销售决策诊断 | 决策标签+**置信度%**+评分/建议阶段/待验证数/合规四指标+未知/风险/动作/提问四象限+合规边界声明+历史列表不重跑模型（SalesDecisionPanel.jsx L163–223） | **全站标杆**，可作为统一 AI 卡片规范的母版 |
| 快速记录分析 | 三张 MatchCard（匹配客户/建议商机/周报日期，meta 内含置信度文本，见截图 `desktop-quick-records-analysis.png` 的"置信度 91%/84%"）+四段可编辑摘要+知识引用可跳转（QuickRecordPage.jsx L748–797）+同步日志留痕（L839–860） | 结构好；缺流式输出、缺"同步会改哪些字段"的 diff 预览（客户档案里的 syncPreview 是静态字段而非本次分析差异）、无撤销 |
| 周报草稿 | 来源引用计数+知识引用胶囊+可编辑+定稿导出（shared.jsx DraftPreview L92–114） | 来源可追溯性好；正文内无行内引用标注，无法从句子回溯到具体记录 |
| 生成建议（客户补全/商机推进/知识话术） | ManualConfirmBox 单块纯文本 content（primitives.jsx L228–292） | 最弱面：无结构、无置信度、无来源、不可采纳落库（生成即阅后即焚） |
| 行程 AI 摘要 | 路线摘要+建议列表（VisitItineraryPage.jsx L209–213） | 够用 |
| 假展开占位句 | 见 §3.3 | **负资产**：让用户学会"这个产品的展开不用点" |

### 6.2 Web 与微信双端能力对齐差距表

| 能力 | 微信(小小) | Web | 差距判定 |
| --- | --- | --- | --- |
| 拍照记账（凭证→账本） | ✅ 主通道 | ⚠️ 仅手工表单+上传 | 合理分工，Web 承担核对 |
| 语音→拜访记录 | ✅ 语音消息 | ⚠️ Web Speech 不可靠 | Web 需服务端 ASR 兜底 |
| 待办提醒 remind_at | ✅ 专写 | ❌ 无编辑（盘点债 #4） | **Web 建待办=永不提醒**，需补 |
| 自然语言改客户/待办 | ✅ naturalPlan 前缀 | ❌ 无对话入口 | Web 全站没有小小对话面板，最大结构性差距 |
| 晨报/招标推送 | ✅ 推送 | ❌ 无通知（总览今日焦点为拉取式） | Web 可用角标/Web Push 补 |
| 记账确认 | ✅ 唯一确认端 | ⚠️ 只读"微信中确认"指引（v0.8.2 裁定） | 已知取舍，可接受 |
| 差旅打印/XLSX/发票管理 | ❌ | ✅ | Web 独占，合理 |
| 行程规划（地图/导航） | ❌ | ✅ | Web 独占，合理 |
| 销售决策诊断/周报导出/看板/系统配置 | ❌ | ✅ | Web 独占，合理 |

结论：分工框架健康（微信=采集+提醒，Web=核对+深度作业），但"对话能力只存在于微信"造成 Web 端 AI 是**按钮式一问一答**，没有连续上下文；且 Web 侧写入的待办脱离提醒闭环。

---

## 7. "完美 AI 销售助手"体验差距 Top15（价值×成本四象限）

**Q1 高价值·低成本（先做）**
1. 总览移动端重排：今日焦点/周趋势置顶，hero 撤下或缩为一行（OverviewPage.jsx L241–268 调 DOM 序即可）
2. 待办列表行内一键完成/延期 + "新增待办"入口（ActionsPage.jsx）
3. 头像登出加确认菜单（App.jsx L1401）
4. "确认调用 AI 分析"pending 态 + 防重复提交（QuickRecordPage.jsx L706）
5. 知识检索清空即还原 + 周报 tab 改名与真实每日记录（KnowledgePage L154 / WeeklyPage L163）
6. 假展开七基元：删掉占位句或填真数据（primitives/shared）

**Q2 高价值·高成本（下一代主战场）**
7. Web 端小小对话面板（复用 assistant runtime，全站右下角常驻，承接自然语言查改）
8. 录音上传+服务端 ASR 兜底（快速记录语音真可用）
9. SW 离线壳：缓存 shell+最近 bootstrap+今日焦点只读（不做写队列）
10. 推送/角标体系（Web Push 或 SSE 替代 12s/10s 轮询，晨报/招标/提醒到达 Web）
11. 移动端底部导航（4+1 FAB：总览/记录/行程/差旅+快速记录），9 项横滚降为溢出菜单

**Q3 低价值·低成本（顺手清账）**
12. 删除确认三范式统一到样式弹窗；window.alert→行内错误
13. maskable 图标+iOS meta 补全；`<input type="week">` iOS 降级
14. SolutionPage 裸 ID→名称，或直接裁撤该页

**Q4 低价值·高成本（明确不做）**
15. 全面 i18n、暗色模式、看板拖拽——单人中文工具收益不成比例，记录为有意取舍

---

## 8. 给下一代方案的十大体验建议

1. **把"今天"变成产品首屏**：总览以今日焦点为第一信息（行程/到点待办/高风险/新招标），hero 与假统计退场；这是"主动洞察"最便宜的兑现（§2 总览、§7-1）。
2. **Web 端引入小小对话面板**：assistant runtime 已在后端统一，Web 缺的只是入口；对话面板同时解决"少输入多产出"与双端能力割裂（§6.2）。
3. **零深度操作原则**：待办完成、风险确认、看板推进等高频轻操作必须在列表行一步完成；"修改视图才能改状态"的模式全部退役（§1.3、§2 待办/风险）。
4. **语音链路服务端化**：录音→上传→ASR→分析一条链，Web Speech 只作增强；出差车上"按住说话记一条"是本产品的核心承诺（§2 快速记录、§4.2）。
5. **离线只读壳**：SW 缓存应用壳+最近一次数据快照，断网可看今日行程/客户电话/待办清单；写操作仍要求在线（§4.1–4.2）。
6. **通知到达 Web**：晨报/招标/提醒通过 Web Push 或站内角标闭环，Web 建的待办补 remind_at 编辑，消灭"Web 待办永不提醒"（§6.2）。
7. **AI 呈现统一规范**：以 SalesDecisionPanel 为母版定义"AI 卡片"契约——置信度+证据来源+可编辑+写回需确认+历史不重跑；ManualConfirmBox 类纯文本产出全部升级或下线；删除一切假展开（§6.1、§3.3）。
8. **移动形态重构**：底部导航+FAB+下拉刷新+单手热区；PWA 补 maskable/iOS meta；周/日期控件做 iOS 降级（§4）。
9. **统一反馈系统**：全局 toast+统一确认弹窗，替换 window.confirm/alert 与散落的行内 status 文本；写操作有成功/失败/可撤销三态（§3.3）。
10. **工程铺路三件事**：实体列表页抽象（五页同构收敛为一）、App.jsx 状态下沉（按域 context 或轻量 store）、路由级 code-splitting（698KB 主 chunk 拆页）——它们决定上述体验改造的边际成本（§5）。

---

## 附：审计证据索引

- 导航/路由：`src/data/salesWorkbenchData.js`、`src/app/navRoutes.js`、`src/app/routes.js`、`src/App.jsx`
- 页面：`src/features/salesWorkbench/pages/*.jsx`（拆分后 13 文件）、`src/features/visitItinerary/VisitItineraryPage.jsx`、`src/features/travelExpense/TravelExpensePage.jsx`（+11 子组件）、`src/features/settings/SystemSettingsPage.jsx`、`src/features/hospitalTender/HospitalTenderPage.jsx`
- 基元与共享：`src/components/primitives.jsx`、`src/components/ModuleSubnav.jsx`、`src/features/salesWorkbench/pages/shared.jsx`
- 样式：`src/styles/global.css`（6824 行）；PWA：`index.html`、`public/sentelligent.webmanifest`
- 截图：`docs/superpowers/reports/assets/v07-walkthrough/`（mobile-overview / mobile-nav-customers / mobile-quick-records / mobile-travel-expenses / mobile-itineraries / desktop-overview / desktop-quick-records-analysis 等 41 张）
- 上游文档：`2026-08-27-visual-audit-v081.md`、`2026-08-28-v084-engineering-health-inventory.md`、`docs/releases/v0.8.1–v0.8.3.md`
