# v0.10.2 移动形态+离线到达（合并版）· 实施级设计

日期：2026-08-29 · 作者：预研泳道 B · 状态：**定稿，可直接作为实施任务书**
基线：worktree `integrate-v0626-candidate`；前端根 `outputs/product-design-prototype/`；**本文以文件名+函数名为锚点，不引行号**。
范围依据：总蓝图 v0.10.2 合并版行；审计B §1.2/§4/§8 建议 5、6、8。
**硬前置**：`2026-08-29-v0100-quickwins-design.md`（今日焦点置顶、AvatarMenu、toast、待办零深度、datetimeLocal 工具）与 `2026-08-29-v0101-groundwork-design.md`（路由拆包、context 下沉、EntityWorkspace、`RouteChunkBoundary`）视为已落地。实施时未合入先 rebase。

## 0. 结论先行

- **两块改造、零后端**：移动壳（底部 4+1 FAB + 更多抽屉 + 下拉刷新 + 单手热区 + PWA/iOS 补全 + 周/日期降级）与离线只读到达（SW 壳 + bootstrap 快照 + 角标轮询）全部前端；**不做写队列、不做 Web Push**（取舍见 §6）。
- **断点裁定**：移动壳仅在 `max-width: 760px` 生效（与 `global.css` 既有 `@media (max-width: 760px)` 横滚侧栏断点一致）；桌面 ≥761px **零视觉/行为变化**。
- **导航映射**（审计B §8-8 / 蓝图 v0.10.2）：底栏 4 项 = 战情总览 / 智能拜访行程 / 差旅报销 / 更多；居中 FAB = 快速记录（新建）；9 项横滚侧栏在移动端 **display:none**，溢出项进「更多」抽屉（客户画像、商机域、周报、知识库、系统配置）。
- **离线模型**：SW 只 precache **应用壳**（index/manifest/icons/hashed assets）+ navigation fallback；bootstrap 八集合 + `dashboardSummary` 由 **应用层 IndexedDB 快照**（非 SW 写队列）在在线成功后写入；断网可读上次快照，写操作 `ensureBackend` 拦截并 toast。
- **部署红线**：SW `scope` 仅限销售工作台根路径；共享 Caddy **绝不**为 `/qingyang` 注册 SW；`static-server.mjs` 为 `sw.js`/`index.html` 单独 Cache-Control；release 切换靠 index no-cache + 旧 chunk 兜底复用 v0.10.1 `RouteChunkBoundary`。
- **kill-switch**：`localStorage.sentelligent_disable_sw=1` 跳过注册并卸载既有 SW；`localStorage.sentelligent_mobile_shell=0` 强制桌面侧栏布局（验收/回滚用）。

---

## 1. 移动形态（§A）

### 1.1 底部导航 4+1 FAB + 更多抽屉

**新增文件**：`src/components/MobileShell.jsx`（底栏 + FAB + 更多抽屉）、`src/components/MobileMoreDrawer.jsx`；**改动**：`App.jsx`（条件渲染）、`global.css`（`.mobile-shell-*` 段，≤760px）。

**底栏项**（`data-testid` 前缀 `mobile-nav-`）：

| id | 标签 | 图标 | 行为 |
| --- | --- | --- | --- |
| `overview` | 总览 | `Command` | `navigateTo("overview")` |
| `itinerary` | 行程 | `MapPinned` | `navigateTo("itinerary")` |
| `expense` | 差旅 | `ReceiptText` | `navigateTo("expense")` |
| `more` | 更多 | `PanelLeft` | 打开抽屉，不高亮为 active |

**FAB**（`data-testid="mobile-fab-quick-record"`）：固定 `bottom: calc(12px + env(safe-area-inset-bottom))`、水平居中偏右（`right: calc(16px + env(safe-area-inset-right))`），`min 56×56`，`Mic` 图标，`navigateTo("quick")` 且 `setRecordMode("voice")`（保持既有入页语义）。`z-index` 高于底栏、低于 toast/弹窗。

**更多抽屉**（`role="dialog"` `aria-modal`）：分组列表——①客户画像（含子入口招标监测）、②商机（含风险/待办/看板子导航胶囊复用 `moduleSubnavItems.opportunity`）、③周报与汇报、④知识库、⑤系统配置（含 settings 子项）。点项关闭抽屉并 `navigateTo`；子导航项走既有 `handleModuleSubnavNavigate` 逻辑。抽屉外点/Escape 关闭。

**App.jsx 接线**：
- `const mobileShell = useMobileShellEnabled()`（`matchMedia("(max-width: 760px)")` + kill-switch）。
- `mobileShell` 时：`<aside className="sidebar">` 加 `hidden` 类；`content` 区外包 `<PullToRefresh>`（§1.2）；渲染 `<MobileShell activeParent={…} badges={…} onNavigate={navigateTo} onMoreSubnav={handleModuleSubnavNavigate} />`。
- **顶栏精简**（≤760px）：隐藏 `top-actions` 内「周报」「快速记录」两钮（与底栏/FAB 重复）；保留 `api-status` + `AvatarMenu`（v0.10.0 误触修复保留）。

**角标来源**（§4.6）：底栏「更多」显示 `badgeMore = tenderHigh + overdueTodos`；总览 Tab 显示 `todayTodos = overdueCount + todayCount`（来自 `overviewSummary.todayFocus`）。

**桌面不变**：侧栏 9 项 + 横滚 reveal（`workspaceRef` + `scrollIntoView`）原样。

### 1.2 下拉刷新

**新增**：`src/components/PullToRefresh.jsx`（touch `passive` 监听，阈值 72px，阻尼 0.45）。

**刷新策略**（按 `active`）：

| 页面族 | 动作 |
| --- | --- |
| `overview` | `getDashboardSummary()` → `setOverviewSummary` |
| 五实体页 + `quick` + `weekly` + `kanban` | 全量 `loadBootstrap()`（复用 bootstrap effect 的 generation guard） |
| `itinerary` / `expense` / `hospital-tenders` / `settings*` | 页面自有 refresh（行程列表重拉、差旅 `loadWeek`、招标 `listHospitalTenderPage`、设置区不变） |

进行中：顶部细条 + `aria-live="polite"`「正在刷新」；失败 toast(error)；**离线时**下拉仍可触发但仅重读 IndexedDB 快照并 toast(info「当前为离线快照」)。与 SW 无耦合。

### 1.3 单手热区

- 底栏 + FAB 落屏幕下 1/3（`padding-bottom: env(safe-area-inset-bottom)`）。
- 列表行快捷钮（v0.10.0 待办完成/延期）保持行尾，**不在**底栏上方 88px 区域放主操作。
- ≤430px 顶栏已是 44px 网格（`global.css` `.topbar`）；本版不新增顶部主按钮。
- 更多抽屉列表项 `min-height: 48px`；FAB 与底栏间距 ≥8px 防误触。

### 1.4 PWA maskable + iOS meta

**`public/sentelligent.webmanifest`**：icons 数组增两项 `{ src: "pwa-icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" }` 与 512 同名；保留现有 any 图标。

**`index.html`** `<head>` 增：

```html
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="森特智行" />
<link rel="apple-touch-icon" href="/sent-zhixing-favicon.png" />
```

（`apple-touch-icon` 已存在，不重复。）maskable 资产从现有 512 图标加 20% safe zone 导出，入 `public/`。

### 1.5 iOS week / datetime-local 降级

**检测**：`src/app/inputCapabilities.js` 导出 `supportsInputType(type)`——离屏 `input.type=type`，`value` 非法时 `validity.typeMismatch` 判不支持（Safari week 会退化为 text）。

**差旅自然周**（`TravelExpensePage.jsx` `isoWeekInput`/`weekFromInput` 不动）：

```jsx
{supportsInputType("week") ? (
  <input type="week" … />
) : (
  <IsoWeekFallback value={week.start} onChange={selectWeek} />
)}
```

`IsoWeekFallback`（同文件或 `travelExpense/IsoWeekFallback.jsx`）：`<input type="date">` 选周一 + 只读周次文案「第 N 周」；`onChange` 调 `naturalWeekFor`/`weekFromInput` 等价路径。testid `travel-week-fallback`。

**行程 datetime**（`VisitItineraryPage.jsx` L313/L339）与 **待办 remindAt**（`ActionsPage.jsx`）：不支持 `datetime-local` 时拆为 `type="date"` + `type="time"`，提交前拼 `YYYY-MM-DDTHH:mm` 走既有 `isoFromDatetimeLocal`/`datetimeLocalFromIso`（`datetimeLocal.js` 增 `splitDatetimeLocal`/`joinDatetimeLocal` 纯函数 + 单测）。

**验收**：iOS Safari 实机差旅周切换、行程出发/预约时间、待办提醒时间可保存回读。

---

## 2. 离线到达（§B）

### 2.1 SW 只读壳（precache + SWR，无写队列）

**工具**：`vite-plugin-pwa`（`injectRegister: null`，改由 `src/app/registerServiceWorker.js` 显式注册，便于 kill-switch）。

**precache 清单**（build 时 Workbox 生成）：`index.html`、`sentelligent.webmanifest`、icons、maskable icons、`assets/index-*.js`（Overview 静态主 chunk）、`assets/index-*.css`、**不** precache 各懒路由 chunk（体积与 release 切换风险）；运行时 **StaleWhileRevalidate** 缓存首次访问的 lazy chunk。

**路由策略**：
- `navigate` 请求 → `NetworkFirst`，3s 超时 fallback `index.html`（SPA）。
- `request.destination === 'script'|'style'|'font'|'image'` 且同源 → `StaleWhileRevalidate`。
- **`/api/*`** → **不拦截**（交给应用层快照；避免 SW 缓存带 Cookie 的 401 响应）。

**应用层 bootstrap 快照**（`src/app/bootstrapCache.js`）：
- 在线 `loadBootstrap` 成功后 `putSnapshot(account, { data, savedAt })` 入 IndexedDB `sentelligent-bootstrap`。
- 启动/断网：`loadBootstrap` 失败且 `navigator.onLine === false` 或 `TypeError: Failed to fetch` → 读快照 hydrate `normalizeBootstrapData`，`backendStatus` 置 `offline-stale`，顶栏 `api-status` 文案「离线快照 · {相对时间}」。
- **不写队列**：一切 POST/PATCH/DELETE 仍走 `ensureBackend`；失败 toast「当前离线，无法保存」。

### 2.2 登录态 / 401 缓存边界

- 快照 key = `account`（`authSession.account`）；**登出** `clearSnapshot(account)` + 可选 `caches.keys()` 删运行时缓存（不删 precache 壳）。
- **401 会话失效**（`salesWorkbenchApi` 既有 session generation 通知）：`clearSnapshot` + `setWorkbenchState(createErrorWorkbenchState)` 回登录；**禁止**用 401 响应体写快照。
- **登录页 401**（错误密码）：不写快照（既有测试 `does not invalidate… login 401` 保持）。
- 快照 **TTL 7 天**；超期仅壳可用，内容区提示「快照已过期，请联网刷新」。

### 2.3 SW 更新策略

- `registerType: 'prompt'`：`skipWaiting: false`，新 SW `waiting` 时 `useServiceWorkerUpdate` 弹 toast(info)「新版本可用」+ 按钮「立即更新」→ `postMessage({ type: 'SKIP_WAITING' })` + `location.reload()`。
- `index.html` / `sw.js` **必须** `Cache-Control: no-cache`（§3）；hashed assets 仍 `immutable`。
- 用户忽略更新：旧 SW 继续服务直至下次主动刷新；可接受（内网单人工具）。

### 2.4 static-server 与共享 Caddy scope 安全

**`static-server.mjs` 改动**（仅销售工作台静态服务，**不碰** `/qingyang`）：

```js
// contentTypeFor 已有 .js；sw 路径显式：
const isServiceWorker = filePath.endsWith("/sw.js") || filePath.endsWith("/service-worker.js");
const cacheControl = filePath.endsWith("index.html") || isServiceWorker
  ? "no-cache"
  : "public, max-age=31536000, immutable";
```

**Caddyfile**（`scripts/deploy/server-config/caddy/Caddyfile`）：现有 `handle /qingyang/*` **不增加** SW 头或 try_files 改写；销售工作台走默认 `handle { reverse_proxy 127.0.0.1:8088 }`，SW 仅在同源根路径注册。文档注释：`# SW scope: workbench root only — never register under /qingyang`.

**manifest `scope: "./"`** 与 `start_url: "./overview"` 保持不变；子路径部署时 `vite base` 已 `normalizeBasePath`，SW 注册路径 = `{base}sw.js`。

### 2.5 Release 切换旧 chunk 兜底

- v0.10.1 已有 `RouteChunkBoundary`：动态 `import()` 失败 → error 面板 +「重新加载」。
- 本版增补：捕获 `ChunkLoadError` / `Failed to fetch dynamically imported module` 时 **先** `caches.match` 失败 URL，若无则 **一次** `location.reload()`（`sessionStorage.chunk_reload_guard` 防循环）；仍失败保留 error 面板。
- 新 release 部署后用户首访拉新 `index.html`（no-cache）→ 新 SW → 新 chunk 清单；旧 tab 未刷新时靠上述兜底。

### 2.6 站内角标（轮询最小方案）

**不做 Web Push**（§6）；用 **`getDashboardSummary` 轻量轮询**：

- `useNotificationBadges`（挂 `App.jsx`）：`document.visibilityState === 'visible'` 且 `backendStatus === 'connected'` 时每 **60s** 拉 summary；切回总览仍保留既有 `useEffect` 即时刷新。
- 派生：`badges.overviewTodos`、`badges.tenderHigh`（`todayFocus.tenders.highCount`）、`badges.morning`（`todayFocus.date !== lastSeenFocusDate` 且本地 `localStorage.sentelligent_last_focus_date` 未记今日 → 晨报红点，进入总览清除）。
- 渲染：MobileShell 底栏项 `.mobile-nav-badge`（CSS 红点 8px）；桌面侧栏 **不** 显示角标（移动专属）。
- 待办逾期计数亦在总览 `TodayFocusCard` 已有展示，角标与之对齐，不新增 API。

### 2.7 离线时序（启动）

```
在线：壳(SW) → bootstrap 网络 → 写快照 → 正常 UI
离线：壳(SW) → bootstrap 失败 → 读快照 → offline-stale 条 + 只读
半在线：壳新/数据旧 → 下拉刷新或恢复网络后自动 loadBootstrap
```

---

## 3. SW 部署安全（专节）

| 风险 | 缓解 |
| --- | --- |
| SW 劫持 `/qingyang` | 不在 qingyang dist 部署 sw.js；Caddy 不改 qingyang 块；工作台 SW `scope` 限制在工作台 base |
| 跨账号快照泄露 | IndexedDB key 含 `account`；登出/401 清除 |
| 缓存凭证响应 | SW **不**缓存 `/api/*`；仅应用层在 200 后写快照 |
| CSP 阻断 SW | 现有 `worker-src 'self' blob:` 已满足；不增 `importScripts` 外域 |
| 旧 SW 永不清 | kill-switch 卸载 + `skipWaiting` 用户确认更新 |
| precache 过大 | 不 precache lazy chunks；首屏主 chunk + CSS + icons < ~1.5MB |
| 开发环境 SW 干扰 | `import.meta.env.DEV` 不注册；`qa:local` 构建产物测试 SW |

**生产检查清单**：①`curl -I /sw.js` → `no-cache`；②`curl -I /assets/index-*.js` → `immutable`；③DevTools Application → SW scope 为工作台源；④`/qingyang/` 无 SW；⑤登出后 IndexedDB 快照为空。

---

## 4. kill-switch 与回滚

| 开关 | 效果 |
| --- | --- |
| `localStorage.sentelligent_disable_sw=1` | 跳过 `registerSW`；若已注册则 `unregister()` + `caches.delete` 运行时项 |
| `localStorage.sentelligent_mobile_shell=0` | 强制隐藏底栏/FAB/抽屉，恢复横滚侧栏（CSS 类 `mobile-shell-off`） |
| 运维紧急回滚 | 部署上一 release 制品 + 上表两键写运维 runbook；无需清 DB |

回滚验证：置 `disable_sw=1` → 硬刷新 → Application 无 SW → 在线行为与 v0.10.1 一致。

---

## 5. 真机验收脚本（iPhone 添加主屏）

**前置**：生产或 staging HTTPS；测试账号已登录；清空 Safari 网站数据后执行。

| # | 场景 | 步骤 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 安装 | Safari 分享 → 添加到主屏幕 | 图标非白圈裁切（maskable）；standalone 无地址栏；状态栏 default |
| 2 | 冷启动在线 | 主屏图标打开 | 总览今日焦点首屏；底栏 4+1 可见；FAB 进快速记录 |
| 3 | 断网只读 | 加载完成后开飞行模式 → 杀进程重开 | 壳秒开；总览/行程/待办列表显示上次快照；顶栏「离线快照」；保存 toast 失败 |
| 4 | 弱网 | Chrome Remote / Safari 网络链路 3G | 首访懒页 fallback「正在打开页面」≤3s；下拉刷新可完成 |
| 5 | 单手 | 右手单手持机 | FAB 可触；底栏切换无需顶栏；头像菜单登出需 2 击 |
| 6 | 周切换降级 | 差旅页切换自然周 | iOS 上 ISO 周正确；fallback 控件无 `type=week` 裸文本框 |
| 7 | 角标 | 有待办逾期 + 招标高相关 | 60s 内底栏红点出现；进总览晨报红点清除 |
| 8 | 更新 | 部署新 build 不杀进程 | toast「新版本可用」；点更新后功能正常 |
| 9 | kill-switch | 控制台设 `disable_sw=1` 刷新 | SW 消失；在线功能正常 |

证据归档：`docs/superpowers/reports/assets/v0102-mobile-offline/` ≥9 张截图 + 1 段录屏。

---

## 6. 本版不做

- **Web Push / 系统通知权限**：依赖微信晨报/提醒；Web 仅站内角标 + 轮询（审计B §8-6 的 Push 方案推迟）。
- **离线写队列 / 草稿同步**：写操作一律要求在线；快速记录草稿仍靠内存 session（v0.10.1 `quickRecordSession`），不持久化到 SW。
- **语音按住说话 / 服务端 ASR**：v0.10.4。
- **Web 对话面板**：v0.10.3。
- **全局 CSS 拆分、暗色模式、i18n**：D6 永不做或后续。

---

## 7. 测试与门禁

### 7.1 新增守护（预估 ~38 条）

| 组 | 条数 | 要点 |
| --- | --- | --- |
| `scripts/mobile-shell.test.mjs` | 10 | 底栏 4 testid + FAB；760px 侧栏 hidden；更多抽屉 role；顶栏快捷钮隐藏 |
| `scripts/pwa-manifest.test.mjs` | 4 | maskable purpose；iOS meta 三行；apple-touch-icon |
| `scripts/input-capabilities.test.mjs` + `datetimeLocal` 扩展 | 6 | split/join；TravelExpense fallback testid |
| `scripts/bootstrap-cache.test.mjs` | 8 | put/get/clear/TTL/account key；401 不清 login |
| `scripts/service-worker.test.mjs` | 6 | DEV 不注册；kill-switch；build 产出 sw.js |
| `scripts/static-server.test.mjs` 扩展 | 2 | sw.js no-cache |
| `PullToRefresh` 源断言 | 2 | overscroll 类名；offline toast 分支 |

### 7.2 受影响回归

- `test:visual` 14 页×6 视口：新增 mobile-shell 视口断言底栏不遮内容（`padding-bottom` ≥72px）。
- `test:modules`：`loadBootstrap` 快照分支不破坏 generation guard。
- `test:copy`：新文案过禁用词表。
- `qa:integration` / `qa:webkit`：断网快照场景 1 条。

### 7.3 v0.10.2 门禁清单

1. 前端 `qa:local` 全绿（v0.10.1 存量 ~488 + 新增 ~38）。
2. 后端 `npm test` 全量回归（零改动确认）。
3. `rg serviceWorker` 仅命中注册/测试；`rg /api/` `sw.js` 无 fetch 拦截 API。
4. §3 生产 SW 安全检查 6 项全过。
5. §5 真机验收 9 项全过，证据归档。
6. 桌面 1440 截图对比 v0.10.1 **零 diff**（mobile-shell-off）。
7. kill-switch 回滚演练通过；release 文档回填 SW 与角标取舍。

---

## 8. 实施顺序（建议提交点）

| commit | 内容 |
| --- | --- |
| M1 | `inputCapabilities` + iOS week/datetime 降级 + 单测 |
| M2 | PWA maskable 资产 + manifest + index.html meta |
| M3 | `MobileShell` + `MobileMoreDrawer` + CSS + App 接线（无 SW） |
| M4 | `PullToRefresh` + 顶栏精简 + 角标 `useNotificationBadges` |
| M5 | `bootstrapCache.js` + 离线 hydrate + 401/登出清除 |
| M6 | `vite-plugin-pwa` + `registerServiceWorker` + static-server no-cache |
| M7 | chunk  reload 兜底 + 测试 + 真机验收证据 |

每 commit 跑 `qa:local`；M6 起加 SW 专项测试。M3 完成后即可并行真机移动壳走查（不依赖 SW）。
