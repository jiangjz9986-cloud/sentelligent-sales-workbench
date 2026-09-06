# 全站视觉一致性审查报告（v0.8.1「全站视觉统一」设计输入）

- 日期：2026-08-27
- 审查对象：`outputs/product-design-prototype/`（package.json 版本 0.7.0）
- 视觉基准：差旅报销模块 v0.6.28（`src/features/travelExpense/travelExpense.css`，辅以 `expenseLedgerWorkbench.css`、`tripRegionSettingsCard.css`）
- 审查方式：纯静态代码审查（未运行构建/测试）。所有行号以当前 worktree 文件为准。
- 文中路径均相对 `outputs/product-design-prototype/`。

---

## 目录

1. [基准视觉语言提炼（travelExpense.css）](#1-基准视觉语言提炼)
2. [全局层现状与共享组件（global.css / index.html）](#2-全局层现状与共享组件)
3. [逐页审查](#3-逐页审查)
4. [PWA 支持现状与最小补集](#4-pwa-支持现状与最小补集)
5. [字体 / 背景 / 滚动条统一性检查](#5-字体--背景--滚动条统一性检查)
6. [v0.8.1 实施建议（按高收益低风险排序）](#6-v081-实施建议)
7. [波及面与回归风险清单](#7-波及面与回归风险清单)

---

## 1. 基准视觉语言提炼

### 1.1 设计 Token（基准数值）

差旅模块用**模块级 CSS 变量 + 硬编码色值**的混合方式。核心 token 定义在 `.expense-page` 上：

```1:14:src/features/travelExpense/travelExpense.css
.expense-page {
  --expense-ink: #10234b;
  --expense-subtle: #66738e;
  --expense-line: rgba(16, 35, 75, 0.1);
  --expense-soft-line: rgba(16, 35, 75, 0.06);
  width: 100%;
  max-width: 1360px;
  min-width: 0;
  margin-inline: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  color: var(--expense-ink);
}
```

台账工作台又定义了一套更完整的局部 token（`expenseLedgerWorkbench.css` 第 1–16 行）：`--ledger-ink:#0d1b3e`、`--ledger-body:#4b5871`、`--ledger-muted:#78849b`、`--ledger-line:#e4e9f1`、`--ledger-soft-line:#edf0f5`、`--ledger-blue:#2f6bff`、`--ledger-blue-soft:#eef3ff`、`--ledger-green:#168648`、`--ledger-green-soft:#eaf8ef`、`--ledger-orange:#dd6b20`、`--ledger-orange-soft:#fff7e9`。

汇总后的**基准 token 表**：

| 类别 | 数值 | 出处（travelExpense.css 行号） |
| --- | --- | --- |
| 主墨色 ink | `#10234b`（标题深一档 `#0b1d43`/`#0d1f45`，正文 `#243655`/`#33486d` 系） | L2、L66、L482、L722 |
| 次级文本 | `#66738e` / `#7b879d` / `#748098` / `#7c879e`（灰蓝系，不用纯灰） | L3、L389、L758、L475 |
| 描边 line | `rgba(16,35,75,0.1)`；软分隔 `rgba(16,35,75,0.06)`；表格行线 `rgba(16,35,75,0.07)` | L4–L5、L729 |
| 品牌蓝 | 引用全局 `var(--blue)`=#2f6bff；深蓝文字 `#245ed5`/`#315fbd`/`#1760ee` | L110、L399、L2795、L564 |
| 状态色（文字/底） | 成功 `#138342`/`#e9f7ee`；警告 `#c65d00`/`#fff1df`；危险 `#c63d3d`/`#fff0f0`；进行中/紫 `#6b58bd`/`#f1edff` | L792–L797 |
| 状态点 | `#16a34a` / `#d97706` / `#dc2626` / `#7656ca`（8px 圆点） | L910–L913 |
| 卡片圆角 | **9–10px**（面板 9px、大卡 10px）；内嵌卡 8px；控件 6–8px；小徽标 4–5px；胶囊 999px | L145、L317、L346、L437、L511、L1024、L778 |
| 卡片阴影 | 微阴影 `0 1px 3px rgba(16,35,75,0.04)`；浮起 `0 3px 14px rgba(16,35,75,0.035~0.05)`；纸张 `0 8px 28px rgba(16,35,75,0.12)`；抽屉 `-20px 0 60px rgba(10,22,48,0.2)` | L147、L634、L1975、L1624 |
| 字号阶梯 | 页 h1 25px；抽屉 h2 21px；数字大值 19–24px；卡标题 13–15px；正文 12–12.5px；辅助 10.5–11.5px；微标注 9–10px | L67、L1655、L483/L1289、L383、L723、L481 |
| 字重 | 600（标题）/ 650–680（正文强调）/ 700–760（标签、表头）/ 780–800（kicker、微标题），大量非整百「精细字重」 | L89、L169、L738、L1648 |
| 间距 | 页级 gap 16px；卡内 12–14px；表格 cell `10px 11px`；卡 padding `12–18px`；header 高 48–58/60px | L12、L429、L728、L359、L1491 |
| 数字排版 | 全面 `font-variant-numeric: tabular-nums`；等宽 `ui-monospace` 用于单号 | L207、L289、L766 |
| 触控目标 | **44px 最小高/宽**（按钮、icon-button、select、上传、链接钮全面遵守） | L134、L263–266、L2755、L3730、L4544–4556 |
| 焦点环 | `box-shadow: 0 0 0 3px rgba(47,107,255,0.22)`；tab 内嵌式 `inset 0 0 0 2px rgba(47,107,255,0.38)` | L4332–4344、L124–131 |
| 选中态 | 左插销 `inset 3px 0 0 var(--blue)` + 浅蓝底 `#eef3ff/#f1f5ff` + 蓝描边 | L3126–3130、L3557–3561 |
| 动效 | 抽屉滑入 0.2s ease-out；tab 下划线 0.18s；`prefers-reduced-motion` 全量降级 | L1625–1631、L111、L4734–4738 |
| 响应式断点 | 1180 / 980 / 760 / 430 / 390 / 横屏 ≤500 高 | L4558、L4579、L4620、L4692、L4717、L4723 |

**已发现的基准自身缺陷**：`var(--expense-muted)` 在 L3830、L3889（认证图/PDF 帧状态文字）被引用但**从未定义**（全仓 grep 无定义），实际回退为继承色。v0.8.1 应顺手补上。

### 1.2 组件形态词典（类名 + 关键数值）

| 组件 | 类名 | 形态要点 | 行号 |
| --- | --- | --- | --- |
| 页工具栏 | `.expense-page-toolbar` | 52px 高、无底色、标题 25px + tab + 右侧主按钮 | L47–70、L133–136 |
| 页内 Tab | `.expense-tabs` | 无底色下划线式；按钮 13px/680；active 3px 圆角下划线动画伸展；按钮间 1px 竖分隔 | L72–122 |
| 周带（筛选条） | `.expense-week-strip` | 64px 白卡 10px 圆角；label+input(44px, 8px 圆角, #fbfcff)+统计列（竖分隔） | L138–220 |
| 提示条 | `.expense-page-alert`(+`.is-error`)、`.expense-recent-receipt` | ≥42px、9px 圆角、浅底+同色系边框+图标+行内 ghost 按钮 | L222–261、L268–272 |
| 虚线便签 | `.expense-overview-note`、`.expense-company-direct-note` | `1px dashed rgba(47,107,255,0.25)`、8px 圆角、#f7f9ff 底 | L570–577、L1315–1323 |
| 合计条 | `.expense-summary-strip` | 单张白卡 98px、内部 4 列竖分隔（非 4 张散卡）；tint 图标 38px/10px 圆角；数值 19px tabular | L432–495 |
| 合计条（表尾） | `.expense-organizer-total` | 48px、#f5f7fb 底、行内多组数值 | L1592–1606 |
| 类目卡 | `.expense-category-card` | 8px 圆角、44px 圆形 tint 图标、2 行文案+数值 | L497–553 |
| 面板卡 | `.expense-ledger-panel` 等 | 9px 圆角、`0 3px 14px` 阴影、白底 | L626–635 |
| 卡头 | `.expense-ledger-child-card > header` | 48–58px、**#fbfcfe/#fbfcff 浅底**、strong 14px/600 + 12px 副文案 + 999px 计数徽标 | L352–405、L879–902 |
| 工具行 | `.expense-toolbar` | 60px、#fbfcff、底部 soft-line；搜索 38px/7px 圆角、select 38px/7px、checkbox 同规格 | L637–711 |
| 数据表 | `.expense-data-table` | 12px 字号；th 11.5px/760、#52607a、**#f5f7fb 底**；td `10px 11px`；hover #fbfcff；`min-width` + 外层 `.expense-table-scroll` 横滚 | L713–761 |
| 金额 | `.expense-money` | 760 字重、tabular、#111f3e | L763–768 |
| 胶囊 pill | `.expense-category-pill/.expense-status/.expense-review-state/.expense-invoice-state` | 999px、≥24px 高、`3px 8px`、10.5px/740、语义色票 | L770–797、L2333–2347 |
| 空状态（区内） | `.expense-empty-state` | ≥160px 居中；灰蓝 #8090a8；strong #314464 + 12px 说明 | L818–836 |
| 空状态（卡片式） | `.expense-proof-empty`、`.invoice-print-empty`、`.ledger-workbench-empty` | 白卡+边框+居中（220–320px） | L3346–3357、L4524–4542；expenseLedgerWorkbench.css L603–626 |
| 加载态 | `.expense-loading` | 300px 白卡居中 | L310–329 |
| 状态面板（整页） | `.ledger-workbench-state-panel` | 360px、12px 圆角白卡、图标+strong 15px+p 12px+按钮 | expenseLedgerWorkbench.css L760–791 |
| 上传位 | `.expense-upload-tile` | 虚线 `rgba(47,107,255,0.35)`、7px 圆角、#f7f9ff | L1141–1172 |
| 抽屉 | `.expense-drawer-backdrop/-drawer/-drawer-head/-drawer-actions` | 遮罩 `rgba(10,22,48,0.48)`；宽 `min(760px, 100vw-24px)`；#f6f8fc 底；头部白底 h2 21px + kicker（10px/800/0.08em 字距）；底部操作条 sticky + `rgba(255,255,255,0.96)`+`blur(10px)` | L1608–1662、L1804–1826 |
| 浮层设置卡 | `.trip-region-settings-card` | 16px 圆角、`0 24px 70px` 阴影、sticky header/footer + blur(12px) | tripRegionSettingsCard.css L8–48、L158–167 |
| 灯箱 | `.expense-lightbox` | `rgba(5,13,30,0.9)` 全屏、圆形导航钮 | L1207–1256 |
| 表单 | `.expense-fieldset/.expense-form-grid` | fieldset 白卡 8px 圆角、legend 12px/780；输入 44px/6px 圆角/11px 字号（invoice 系） | L1687–1707、L4001–4016 |
| 结算公式 | `.expense-settlement-formula` | 一体卡 9px 圆角、3 值 2 符号网格、数值 24px | L1258–1313 |
| 选中行 | `.invoice-repository-list > button.active`、`.expense-proof-payments label:has(:checked)` | 浅蓝底 + `inset 3px 0 0 var(--blue)` 左插销 | L3557–3561、L3126–3130 |
| 打印纸张 | `.expense-print-sheet/.expense-list-print-sheet/.invoice-print-sheet` | A4 比例白纸、`0 8px 28px` 阴影、宋体、`@page` 规则 | L1965–1976、L2141–2153、L4740–4748 |

### 1.3 类名惯例

- 模块前缀 + BEM 弱化版：`expense-`、`invoice-`、`weixin-review-`、`ledger-workbench-`、`trip-region-`；子元素多用**语义标签选择器**（`> header strong`、`dl div`）而非新类名。
- 状态用 `is-*`（`is-error/is-ready/is-missing/is-selected/is-pending/is-highlighted`）与 `data-*` 属性（`data-enabled`、`data-region-unset`、`data-count-zero`）。
- 色调枚举类：`tone-0..3`、`.blue/.teal/.green/.amber`（summary icon）、语义类 `.covered/.partial/.missing/.pending`。
- 复用全局原子：`.ghost-button/.primary-button/.icon-button/.form-field/.sr-only`，仅在模块内做尺寸覆盖（如 L133、L263–266 把 icon-button 提到 44px）。

---

## 2. 全局层现状与共享组件

### 2.1 全局 token（`src/styles/global.css` L1–35）

```1:29:src/styles/global.css
:root {
  --app-shell-inset: 0px;
  --bg: #f3f5fa;
  --surface: #ffffff;
  --surface-solid: #ffffff;
  --subtle: #f7f9fc;
  --line: rgba(13, 27, 62, 0.08);
  --line-soft: rgba(13, 27, 62, 0.05);
  --text: #0d1b3e;
  --body: #45536e;
  --muted: #8a94ab;
  --blue: #2f6bff;
  --blue-deep: #1e56e0;
  --blue-soft: #ebf1ff;
  --teal: #0ea5b7;
  --teal-soft: #e2f6f8;
  --green: #16a34a;
  --green-soft: #e6f7ec;
  --amber: #d97706;
  --amber-soft: #fdf1de;
  --red: #dc2626;
  --red-soft: #fdeaea;
  --gray-soft: #eef1f6;
  --navy-1: #0a1735;
  --navy-2: #102a5c;
  --shadow: 0 6px 20px -6px rgba(13, 27, 62, 0.1);
  --shadow-sm: 0 1px 2px rgba(13, 27, 62, 0.04);
  --shadow-blue: 0 6px 16px -4px rgba(47, 107, 255, 0.45);
  --panel-shadow: 0 1px 2px rgba(13, 27, 62, 0.04);
```

全局 token 本身与差旅**并不冲突**（`--text:#0d1b3e` ≈ `--expense-ink:#10234b`、`--line` ≈ `--expense-line`），问题在于**旧页面大量绕过 token 直接写 Untitled UI 灰阶**：`#101828/#1d2939/#344054/#475467/#667085/#98a2b3`（如 L958、L1201、L2538、L3024、L2006、L1020），与差旅的海军蓝灰（`#10234b/#33486d/#66738e/#7b879d`）形成**两套文本色系**。

### 2.2 共享组件现状

| 组件 | 位置 | 现状 vs 基准 |
| --- | --- | --- |
| `.ghost-button/.primary-button` | global.css L268–309、L387–392 | 44px 高、10px 圆角、13px/650；primary 为**渐变**`linear-gradient(135deg,#3d78ff,var(--blue-deep))`+`--shadow-blue` 蓝晕。差旅页面（工具栏 L133、抽屉操作 L4637–4640、organizer L4637 等）**直接使用**这两个类 ⇒ 它们已经是全站含差旅的既成标准，**不在改造对象内**（详见 §7）。 |
| `.icon-button` | L627–648 | 38×38、8px 圆角。差旅内被覆盖为 44×44（travelExpense.css L263–266）⇒ 全局默认值应提为 44。 |
| `.pill` + `.tone-*` | L1423–1464 | 999px、≥24px、`3px 9px`、11.5px/700。与基准 pill（10.5px/740、`3px 8px`）只差 1px 字号与字重，**极易拉平**。 |
| `.panel` 家族 | L1487–1508 | `border-radius: 14px` + `--panel-shadow`，padding 18px。**14px 是旧风格最显著签名**，基准是 9–10px。 |
| `.panel-title` | L1622–1661 | strong 14.5px/650 + 11.5px meta，无底色。基准卡头是「浅底色条 + 14px/600 + 12px 副文案」。 |
| `.form-field` | L1552–1588 | 输入 38px 高、8px 圆角、13px/650；焦点 `0 0 0 4px rgba(47,107,255,0.1)`。基准表单输入 44px、6–8px 圆角、焦点 3px/0.22。仅 430px 断点才提到 44px（L4922–4933）。 |
| `.confirm-dialog` | L322–385 | 8px 圆角、44px 图标位；**L362 使用了未定义的 `var(--ink)`**。 |
| `.empty-list` | L2052–2060 | 左对齐灰底一行字（16px padding、8px 圆角、700 字重），与基准 `.expense-empty-state`（居中、strong+说明两级）完全是两种范式。 |
| `.module-subnav` | L5016–5120 | 14px 圆角 + 渐变 tint 底 + active 渐变蓝钮。基准语言是「白卡 + 细线 + 下划线 tab」。 |
| `.segmented` | L2497–2527 | 8px 圆角、#eef2f7 槽、按钮 40px/800 字重。基准无同类组件（用下划线 tab），可保留但字重/高度需归一（700、44px）。 |
| `.interactive-card` | L61–82 | hover 上浮 -1px + 阴影加深；焦点 `0 0 0 4px rgba(47,107,255,0.12)`。基准 hover 通常只变底色（表格行 hover #fbfcff）。 |

### 2.3 【严重】使用中但**完全没有样式定义**的类

以下类名在 JSX 中使用，但在 `src/**/*.css` 与构建产物 `dist/assets/index-C4srtDxj.css` 中**均无定义**（已用 ripgrep 双向确认）：

| 类名 | 使用处 | 影响 |
| --- | --- | --- |
| `.workbench-state-panel`（含 `.error`） | `src/App.jsx` L316、L326、L340、L357；`src/features/salesWorkbench/pages.jsx` L2776、L2843 | **全站 bootstrap 的加载/错误/空数据面板、路由实体不可用面板、周报空状态**全部是无样式裸 HTML（左对齐堆叠的图标/文字/按钮）。 |
| `.state-spinner` | `src/App.jsx` L317 | 加载图标无旋转动画、无颜色。 |
| `.kanban-page` | `pages.jsx` L3637 | 看板页容器无间距定义（依赖子元素 margin）。 |
| `.detail-scroll-view` | `pages.jsx` L1944、L2199、L2470、L3057、L3316 | 无效类（无副作用，但属于遗留噪音）。 |
| `.settings-section-view` / `.settings-section-*` | `App.jsx` L1483 | 同上，仅作 hook 存在。 |
| `.analysis-save-actions`、`.action-status-toolbar`、`.risk-owner-grid`（有定义 L4056 但仅 margin）等 | pages.jsx 多处 | hook 类，无风险。 |

其中 `.workbench-state-panel` 是**用户第一屏就会看到的组件**（每次进入应用都经过 loading 态），优先级应排在所有「风格统一」之前。修复模板可直接借用基准的 `.ledger-workbench-state-panel`（expenseLedgerWorkbench.css L760–791：360px 高、12px 圆角白卡、居中、图标着色、`.is-error` 红图标）。

### 2.4 未定义变量汇总

| 变量 | 引用处 | 建议 |
| --- | --- | --- |
| `var(--ink)` | global.css L362（confirm-dialog h2）、L5137、L5209、L5268、L5284、L5322（settings 系列） | 在 `:root` 补 `--ink: var(--text)`，或全部替换为 `var(--text)` |
| `var(--expense-muted)` | travelExpense.css L3830、L3889 | 在 `.expense-page` 补 `--expense-muted: #7b879d`（与既有辅助文本色一致） |
| `var(--ink-secondary, #51607a)` | global.css L2668 | 带 fallback，可保留；建议正式定义 |

---

## 3. 逐页审查

页面代码位置：战情总览/快速记录/客户/商机/动作/风险/知识库/周报/看板/微信绑定在 `src/features/salesWorkbench/pages.jsx`；登录与全局壳在 `src/App.jsx`；行程 `src/features/visitItinerary/VisitItineraryPage.jsx`；系统配置 `src/features/settings/SystemSettingsPage.jsx`；招标监测 `src/features/hospitalTender/HospitalTenderPage.jsx`。样式集中在 `src/styles/global.css`。

### 3.0 应用壳（Topbar / Sidebar / Content）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 0-1 | 侧栏为深海军渐变 + 径向光斑，nav 激活项渐变蓝钮带重阴影 | global.css L688–736 | 品牌区域可保留深色，但 `box-shadow: 0 8px 18px -6px rgba(47,107,255,0.6)`（L733）比基准所有阴影都重，建议减到 `-8px …0.4` 档 |
| 0-2 | topbar 60px、search-box 44px/10px 圆角 | L108–117、L192–228 | 与基准兼容，保留 |
| 0-3 | `.content` padding `clamp(18px,1.5vw,28px)` | L763–769 | 与基准页 `gap:16px` 节奏兼容，保留 |
| 0-4 | 全站 bootstrap 状态面板无样式 | 见 §2.3 | **P0 修复** |

### 3.1 登录页（`App.jsx` L208–311；global.css L439–678）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1-1 | 输入框 48px 高、11px 圆角（`.login-input` L589–604）；提交钮 52px（L672–678）；lock 图标位 13px 圆角（L564–574） | global.css | 基准控件是 44px 高、6–8px 圆角。登录页可容许「放大一档」，但圆角应并入 10px 卡/8px 控件梯级 |
| 1-2 | `.login-error`、`.remember-row` 字重 800（L650–670） | global.css | 基准错误文案 11.5–12px/普通字重（`.expense-form-error` L1673–1685 用颜色而非 800 字重表达） |
| 1-3 | 焦点态 `0 0 0 4px rgba(47,107,255,0.12)`（L606–610） | global.css | 应统一为基准焦点环 3px/0.22 |
| 1-4 | 品牌面渐变 + 网格纹理（L454–479） | global.css | 登录页营销面，**建议保留**（与总览 hero 是全站仅有的两处渐变叙事） |
| 1-5 | `.eyebrow` 13px/800（L1383–1389）与基准 kicker（10px/800/0.08em 字距，travelExpense.css L1645–1650）双规格 | global.css | 统一为一种 eyebrow 规格（建议 11px/800/0.06em） |

工作量：小。

### 3.2 战情总览 Overview（`pages.jsx` L116–298）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 2-1 | KPI 用 4 张分离 `.metric-card`（14px 圆角、118px 高、icon 42px/11px、数值 28px/750，global.css L1663–1708；`overview-kpi` L1685–1688） | pages.jsx L148–151 | 基准 KPI 是**一体化合计条** `.expense-summary-strip`（单卡 98px、竖分隔、icon 38px/10px、数值 19px，travelExpense.css L432–495）。结构性差异，两种收敛方案见 §6 P2-9 |
| 2-2 | `.overview-hero` 渐变海军大卡 + 网格纹理 + 玻璃徽章（global.css L1710–1832） | pages.jsx L153–173 | 建议保留形态（品牌位），仅圆角 14→10、阴影 `0 14px 34px -10px`（L1730）降一档 |
| 2-3 | `.progress-row/.rhythm-row` 11px 圆角（L1861–1906） | pages.jsx L195–218、L266–291 | → 8px（基准列表行是 7–8px 或无圆角+分隔线） |
| 2-4 | `.stage-card` 数值 22px/750、10px 圆角（L2322–2346） | pages.jsx L293–295 | 最接近基准的组件，仅 hover 对齐（interactive-card 上浮 → 底色变化） |
| 2-5 | 记录行 `.record-row` `date-chip` 9px 圆角（L2260–2286） | pages.jsx L222–241 | 可保留，选中/hover 语义统一见 §6 P2-11 |
| 2-6 | Panel 标题排版（14.5px/650，无底条）vs 基准卡头浅底条 | global.css L1622–1661 | 建议 Panel 增加 `panel--flush-head` 变体（浅底 #fbfcff + 分隔线），逐页替换 |

工作量：中。

### 3.3 快速记录 QuickRecord（`pages.jsx` L354–1181）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 3-1 | `.record-composer` 顶部 3px 渐变彩条（blue→teal）+ 渐变白底（global.css L2368–2383） | pages.jsx L875 | 基准卡片无渐变装饰，建议去彩条改浅底卡头 |
| 3-2 | `.record-flow` 步骤胶囊自带 `0 4px 10px` 阴影、序号 840 字重（L2436–2466） | pages.jsx L907–911 | 阴影去掉（基准胶囊无阴影）、字重 ≤800 |
| 3-3 | `.segmented` 按钮 40px/800（L2497–2527） | pages.jsx L882–904 | 40→44px、800→700 |
| 3-4 | `.voice-box` 虚线 `rgba(47,107,255,0.32)`/8px 圆角（L2556–2583） | pages.jsx L913–952 | 与基准 `.expense-upload-tile`（0.35/7px，travelExpense.css L1141–1155）参数拉平即可 |
| 3-5 | 语音/流程状态色 `#34c759`、`#ff9500`（L2488、L2570、L2621、L2637） | global.css | iOS 色票，应替换为 `var(--green)/var(--amber)` |
| 3-6 | `.analysis-panel/.analysis-empty` 渐变底 + `ai-ring` 渐变描边环（L2717–2814） | pages.jsx L1002–1146 | 空态可保留 ai-ring 作点睛，面板底改纯白 |
| 3-7 | `.sync-log` 内嵌卡 `rgba(248,251,255,0.84)`（L3006–3086） | pages.jsx L1105–1126 | 改基准的 `#f5f7fb`/`#fbfcff` 实底 |
| 3-8 | 历史记录 `.record-note` 左彩条 3px + 选中蓝底（L2134–2199） | pages.jsx L1154–1175 | 形态可保留；选中态统一为「左插销 + 浅蓝底」（见 §6 P2-11） |

工作量：中（装饰元素多，结构不动）。

### 3.4 客户（列表 + 详情，`pages.jsx` L1822–2088）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 4-1 | 列表容器 `.panel` 14px 圆角 + `.list-button` 11px 圆角 64px 行（global.css L1487–1503、L2207–2258） | pages.jsx L1879–1941 | 圆角梯级统一（14→10、11→8）后形态即接近基准 |
| 4-2 | 选中态 `.list-button.selected` 全底变蓝（L2230–2233） | pages.jsx L1911 | 基准选中语义是「左插销 inset 3px + 浅蓝底」（travelExpense.css L3557–3561）；建议统一 |
| 4-3 | 空态 `.empty-list` 一行字（L2052–2060） | pages.jsx L1932–1936 | → 基准 `.expense-empty-state` 范式（居中 strong+说明；≥160px） |
| 4-4 | 详情 `.detail-surface` 22px padding/14px 圆角 + `.metric-inline` 8px 圆角 18px 数值（L3108–3131） | pages.jsx L1974–1995 | metric-inline 与基准 summary-strip 单元几乎同构，统一字号（18→19px tabular）与边框色即可 |
| 4-5 | `.stakeholder-card` 头像点用银灰渐变 `linear-gradient(145deg,#d8dde8,#aab4c4)`（L3185–3192） | pages.jsx L1207–1235 | 基准无渐变小部件；改 tint 单色（#eef1f6 + 描边） |
| 4-6 | 编辑表单 `.editor-panel/.form-field` 输入 38px（L1510–1601） | pages.jsx L1556–1619 | → 44px（对齐基准与 430 断点既有规则） |
| 4-7 | 详情内 `.insight/.insight-card` 左彩条形态（L3294–3341） | pages.jsx L2263–2292 | 与基准语义兼容，仅圆角/底色微调 |
| 4-8 | `.sticky-subview-toolbar` 渐变底 blur（L2011–2018） | pages.jsx L1945 | 参数向基准抽屉操作条（白 0.96 + blur10，travelExpense.css L1804–1815）靠拢 |

工作量：中（含删除确认弹窗已达标：`.confirm-dialog` 只需圆角/变量修正）。

### 3.5 商机（+ 动作 / 风险 / 看板子页）

商机列表/详情与客户同构（`pages.jsx` L2090–2345），复用 4-1…4-8 全部结论。追加：

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 5-1 | `SalesDecisionPanel` 色票 `#0a84ff/#34c759/#f5a623/#ff3b30`（global.css L3489–3492） | SalesDecisionPanel.jsx | iOS 色票→`var(--blue)/var(--green)/var(--amber)/var(--red)` |
| 5-2 | `.sales-decision-empty` 虚线空态（L3540–3561） | 同上 | 与 `.settings-empty-state`（L5491–5497）合并为全站「虚线空态」变体，参数统一（1px dashed var(--line)、10px 圆角） |
| 5-3 | 动作/风险详情 `.risk-status-toolbar` ghost 按钮组（L4049–4063） | pages.jsx L2517–2543、L3109–3124 | 已达标，无需改 |
| 5-4 | `.risk-meter` 999px 渐变条 amber→red（L4034–4047） | pages.jsx L3094–3096 | 可保留（数据可视化），或改双色分段 |
| 5-5 | 看板 `.kanban-page` 无样式；`.deal-card` 阴影 `0 8px 20px rgba(16,24,40,0.04)`（L4283–4293）；`.kanban-status` 提示条不带图标与边框（L4244–4253） | pages.jsx L3636–3702 | 容器补 `display:grid;gap:12px`；卡片阴影降为基准微阴影；状态条对齐 `.expense-page-alert` 形态 |
| 5-6 | 看板列横滚无滚动条美化（L4235–4242） | 同上 | 并入全局滚动条方案（§5.3） |

工作量：商机中；动作/风险小；看板小。

### 3.6 知识库（`pages.jsx` L3168–3418）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 6-1 | `.citation-panel` 渐变底 + `0 18px 42px rgba(47,107,255,0.08)` 大阴影（global.css L3618–3631） | pages.jsx L3367–3384 | 改为基准「虚线蓝便签」`.expense-overview-note` 形态（travelExpense.css L570–577） |
| 6-2 | 列表/空态/选中态 | 同客户 4-1/4-2/4-3 | 同步处理 |
| 6-3 | 知识检索行 `.knowledge-search` + `search-box.compact` 38px（L217–222、L1603–1613） | pages.jsx L3264–3278 | 输入高度并入 44px 触控目标 |
| 6-4 | 详情「引用口径」用 `.insight` 蓝底块（L3294–3302） | pages.jsx L3386 | 可保留 |

工作量：小–中。

### 3.7 周报（`pages.jsx` L2665–2909）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 7-1 | 空状态用**无样式**的 `.workbench-state-panel`（§2.3） | pages.jsx L2774–2786、L2843–2848 | P0 修复后自动解决 |
| 7-2 | `.day-card` 14px 圆角、300px 高、h3 21px（global.css L3969–3988） | pages.jsx L2814–2849 | 圆角 10px；h3 与基准卡标题（14–15px）拉近或保留 21px 作日期数字 |
| 7-3 | `.paper` 26px padding、h2 27px（L4012–4032） | （由 solution/weekly 共用） | 对齐基准打印纸张语言：加 `0 8px 28px rgba(16,35,75,0.12)` 阴影、边框 `rgba(16,35,75,0.12)`（travelExpense.css L1965–1976） |
| 7-4 | `.generated-draft/.weekly-editor` 阴影 `0 18px 45px`（L3852–3858、L3919–3926） | pages.jsx L2851–2903 | 降为 `0 3px 14px rgba(16,35,75,0.05)` 档 |
| 7-5 | `.weekly-control` 14px 圆角 + `.segmented.large`（L3946–3960、L2518–2521） | pages.jsx L2790–2812 | 圆角与 segmented 高度统一 |
| 7-6 | `.draft-source-strip span` 999px 胶囊但 800 字重、`8px 10px` padding（L3735–3750） | pages.jsx L2639–2643 | 对齐基准 pill 参数（≥24px 高、`3px 9px`、700） |

工作量：中。

### 3.8 行程（`VisitItineraryPage.jsx`；global.css L775–1348）

行程是旧页里**最接近基准**的一页（网格表格行、日期瓦片、44px 过滤器），主要是参数级修正：

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 8-1 | 表头 `.itinerary-table-head` 11px/800、`rgba(246,248,251,0.88)` 半透明底（L846–854） | VisitItineraryPage.jsx L110–112 | → 基准表头 11.5px/760、实底 #f5f7fb（travelExpense.css L734–740） |
| 8-2 | `.itinerary-date-tile` 12px 圆角 + `inset 0 3px 0 #2f6bff` 顶条 + `0 5px 14px` 阴影（L896–913） | 同上 L119–127 | 特色组件建议保留，圆角 12→10、阴影降档 |
| 8-3 | 半透明行底 `rgba(255,255,255,0.72)`（L862–867） | — | 基准行是实底白+hover #fbfcff；改实底 |
| 8-4 | 850/800 字重散布（date-day L926–932、stop-number L1181–1192、facts dt L1038–1042） | — | 归一到 ≤800 |
| 8-5 | `.itinerary-ai-summary` teal 左彩条（L1085–1106） | — | 保留（与 insight 同族） |
| 8-6 | 删除确认 `.itinerary-delete-confirmation` 行内红条（L979–998） | VisitItineraryPage.jsx L176–183 | 与其他页的 `.confirm-dialog` 弹窗**交互形态不一致**；建议统一走 confirm-dialog（结构小调） |
| 8-7 | 编辑器 `.itinerary-stop-editor` 半透明白底（L1269–1278） | — | 改实底白 |

工作量：小–中。

### 3.9 系统配置（+微信绑定/通知/招标调度；`SystemSettingsPage.jsx`；global.css L5122–5529、L4076–4233）

| # | 不一致点 | 位置 | 说明 |
| --- | --- | --- | --- |
| 9-1 | `.settings-intro` **18px 圆角**（全站最大）+ 渐变底（L5128–5138） | SystemSettingsPage.jsx | → 10–12px、实底或极淡 tint |
| 9-2 | `var(--ink)` 未定义 ×5（L5137、L5209、L5268、L5284、L5322） | 同上 | P0 补变量 |
| 9-3 | `.settings-status-list/.settings-run-list/.settings-scheduler-progress` 12px 圆角（L5240–5246、L5423–5428、L5378–5385） | 同上 | 12→10（与基准 `.ledger-workbench` 12px 卡对齐亦可，见 §6 圆角梯级） |
| 9-4 | `.settings-key-form input` 44px/10px 圆角（L5315–5323） | 同上 | 高度已达标，圆角 10→8 |
| 9-5 | `.one-time-secret` 黄卡 12px 圆角（L5513–5529） | 同上 | 对齐 `.expense-page-alert` 形态（9px 圆角+图标） |
| 9-6 | 微信绑定 `.weixin-binding-main/-side` 渐变浅底（L4091–4103）、`.weixin-qr-frame` 渐变虚线框（L4115–4128） | pages.jsx L3530–3601 | 渐变→实底；虚线参数对齐 upload-tile |
| 9-7 | `.settings-feedback` 10px 圆角无图标（L5499–5511） | — | 对齐 `.expense-page-alert`（图标+边框） |

工作量：小。

### 3.10 医院招标监测（参照系，global.css L5595–6592）

该页在近期已按新语言重构：10px 圆角面板覆盖（L6339–6349）、44px 控件（L6008、L6378–6420）、tabular 数字、甚至**直接复用差旅的 `.expense-page-alert`**（L6175–6178）。剩余偏差仅 `.hospital-tender-priority-strip` 14px 圆角（L5679–5688）。**建议在 v0.8.1 中作为「已对齐范例」参照，不列入改造对象。**

---

## 4. PWA 支持现状与最小补集

### 4.1 现状（预期「没有」，实测确认）

`index.html` 全文仅 15 行：

```1:15:index.html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="apple-touch-icon" href="/sent-zhixing-favicon.png" />
    <meta name="theme-color" content="#f6f8fb" />
    <title>&#x68EE;&#x7279;&#x667A;&#x884C; AI &#x9500;&#x552E;&#x4F5C;&#x6218;&#x53F0;</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- **有**：favicon.ico、`apple-touch-icon`（/sent-zhixing-favicon.png）、`theme-color`（#f6f8fb）。
- **无**：`<link rel="manifest">`、manifest 文件（public/ 目录仅 favicon.ico + 4 张 logo/icon png）、192/512 规格图标、maskable 图标、Service Worker、iOS `apple-mobile-web-app-*` meta、`description` meta。
- 构建层：`vite.config.mjs` 无 PWA 插件；`package.json` 依赖仅 react/vite/lucide/pdfjs。
- **theme-color 值 `#f6f8fb` 与全局背景 `--bg:#f3f5fa` 不一致**（还有第三个近似值：抽屉底 `#f6f8fc`，travelExpense.css L1623）。

### 4.2 v0.8.1 最小补集（建议，不含 Service Worker）

单人内部工具、强依赖后端 API，离线缓存收益低、风险高 ⇒ **只做「可安装」三件套**：

1. `public/manifest.webmanifest`：
   - `name`: "森特智行销售工作台"，`short_name`: "森特智行"
   - `start_url`: `"./"`、`scope`: `"./"`（**必须用相对路径**：`vite.config.mjs` 的 `base` 由 `VITE_PUBLIC_BASE_PATH` 动态决定，绝对路径会在子路径部署时失效）
   - `display`: `"standalone"`，`background_color`: `#f3f5fa`，`theme_color`: `#f3f5fa`
   - `icons`: 由 `public/sent-zhixing-icon.png` 重新导出 `192×192`、`512×512` 两档 PNG，另加一张 `purpose: "maskable"` 512（图形留 20% 安全边距）
2. `index.html`：
   - 加 `<link rel="manifest" href="manifest.webmanifest" />`
   - `theme-color` 改为 `#f3f5fa` 与 `--bg` 对齐（如需深色状态栏可用两条带 `media` 的 theme-color）
   - 顺手补 `<meta name="description">`
3. 资产核对：确认导出的 192/512 PNG 实际尺寸（现有 `sent-zhixing-icon.png` 未验证尺寸）；已有 `scripts/favicon-asset.test.mjs` 先例，后续可加 manifest 资产测试。

---

## 5. 字体 / 背景 / 滚动条统一性检查

### 5.1 字体：统一 ✓（有一处隐患）

- 全站唯一字体栈定义在 `:root`（global.css L31–34）：`-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif` + `font-synthesis: none` + `text-rendering: geometricPrecision`；`body` 开 antialiased（L48）。差旅未覆盖字体 ⇒ 一致。
- 打印单据特例使用宋体 `"Songti SC","SimSun",serif`（travelExpense.css L1981、L2020、L4351 等），属公文仿真，合理保留。
- 等宽 `ui-monospace, "Cascadia Mono", …` 用于单号/原始记账文本（travelExpense.css L289、L1010、L2856），一致。
- **隐患**：两侧都大量使用非整百字重（550/620/640/650/680/720/730/740/750/760/780/790/820/840/850）。PingFang SC / Microsoft YaHei **不是可变字体**，这些值会被浏览器四舍五入到 400/500/600/700/900，跨平台渲染不可控。v0.8.1 可选做字重归一（见 §6 P3-17）。

### 5.2 背景：三个近似值并存

| 值 | 用途 | 位置 |
| --- | --- | --- |
| `#f3f5fa` | `--bg`，body/product-window 底 | global.css L3、L47、L105 |
| `#f6f8fb` | `theme-color` | index.html L8 |
| `#f6f8fc` | 抽屉底 | travelExpense.css L1623 |
| `#f5f7fb/#fbfcff/#fbfcfe/#f7f9fc` | 表头/卡头/浅底族 | 多处 |

建议：`--bg` 保持 `#f3f5fa` 并让 theme-color 跟随；浅底族收敛为两个 token（`--surface-muted: #f5f7fb`、`--surface-raised: #fbfcff`），替换散值。

### 5.3 滚动条：未统一

- 无任何全局 `::-webkit-scrollbar` / `scrollbar-color` 定制。
- 零星处理：`.content` 用 `scrollbar-gutter: stable`（L768）；`.analysis-panel`（L2726）、`.sales-decision-history`（L3385）、`.module-subnav-list`（L5555）、行程三处列表（L859、L1168、L1266）用 `scrollbar-width: thin`；移动端 sidebar 直接隐藏（L4655–4662）。
- 差旅的横向滚动区（`.expense-table-scroll` L713–716、`.organizer-table-scroll` L1501–1504、`.invoice-repository-list` L3528–3532）**没有** thin 处理。
- 结果：macOS 覆盖式滚动条下无感，**Windows/Linux Chrome 会出现默认粗滚动条**，且不同区域粗细不一。
- 建议（全局一段即可）：`* { scrollbar-width: thin; scrollbar-color: rgba(13,27,62,0.18) transparent; }` + `::-webkit-scrollbar { width:8px; height:8px } ::-webkit-scrollbar-thumb { border-radius:999px; background: rgba(13,27,62,0.18) }`。低风险高一致性收益。

---

## 6. v0.8.1 实施建议

### 6.0 统一后的目标 token（建议新增到 `:root`）

```css
:root {
  --ink: var(--text);                       /* 修复未定义引用 */
  --radius-card: 10px;                      /* 卡片/面板 */
  --radius-control: 8px;                    /* 输入/select/小按钮 */
  --radius-chip: 999px;                     /* 胶囊 */
  --focus-ring: 0 0 0 3px rgba(47, 107, 255, 0.22);
  --surface-muted: #f5f7fb;                 /* 表头/合计条底 */
  --surface-raised: #fbfcff;                /* 卡头/工具行底 */
  --shadow-card: 0 3px 14px rgba(16, 35, 75, 0.05);
}
.expense-page { --expense-muted: #7b879d; } /* 修复未定义引用 */
```

### 6.1 P0 —— 纯补齐，零回归风险（先做，半天级）

| # | 事项 | 做法 | 工作量 |
| --- | --- | --- | --- |
| P0-1 | 补 `.workbench-state-panel`（含 `.error`）与 `.state-spinner` 样式 | 新增 CSS（建议放 global.css 末尾），参数照抄 `.ledger-workbench-state-panel`（expenseLedgerWorkbench.css L760–791）：`min-height:360px; display:grid; place-items:center; gap:9px; padding:36px; border:1px solid var(--line); border-radius: 12px; background:#fff; text-align:center`；`.error > svg` 红色；`.state-spinner` 加旋转动画（参照 `settings-status-spin` L5309–5313） | 小 |
| P0-2 | 补 `.kanban-page { display:grid; gap:12px; min-width:0 }` | 新增一条规则 | 极小 |
| P0-3 | 定义 `--ink`、`--expense-muted`（§2.4） | `:root` 与 `.expense-page` 各一行 | 极小 |
| P0-4 | `index.html` theme-color 校准为 `#f3f5fa` | 改一个属性值 | 极小 |
| P0-5 | 全局细滚动条（§5.3） | 新增 5 行规则 | 极小 |
| P0-6 | PWA 三件套（§4.2：manifest + 192/512 图标 + link） | 新文件 + index.html 两行；注意相对 `start_url` | 小 |

### 6.2 P1 —— Token 级机械替换（波及广但可控，1–2 天级）

| # | 事项 | 直接替换点 | 工作量 / 风险 |
| --- | --- | --- | --- |
| P1-1 | **圆角梯级统一**：14px→10px、18px→12px、11–13px→10px、保留 999px | `.panel` 家族 L1500；`.module-subnav` L5023；`.settings-intro` L5136；`.hero-card`（跟随 panel）；`.list-button/.record-row/.compact-item…` L2216（11→8）；`.progress-row/.rhythm-row` L1867/L1904（11→8）；`.metric-icon` L1678（11→10）；login 系 L491/L527/L570/L597（11–13→10）；`.settings-*` 12px 可保留或统一 10 | 中 / 低（纯视觉）。改完可删除 hospital-tender 的覆盖 L6339–6349 |
| P1-2 | **焦点环统一**为 `var(--focus-ring)` | global.css L78–82、L394–402、L434–437、L606–610、L645–648、L1578–1583、L3411–3415、L5115–5120、L6019–6022 等（`0 0 0 4px rgba(47,107,255,0.1~0.16)` 全部替换） | 小–中 / 低 |
| P1-3 | **iOS 色票归一**：`#0a84ff/#34c759/#f5a623/#ff3b30/#ff9500` → `var(--blue)/--green/--amber/--red` | L3489–3492（sales-decision-block）、L2481–2489（record-flow done）、L2620–2638（voice-dot）、L3046–3052（sync-dot） | 小 / 低 |
| P1-4 | **文本色系归一**：把旧页 `#101828/#1d2939/#344054/#475467/#667085/#98a2b3` 分别映射到 `var(--text)/var(--text)/var(--body)/var(--body)/var(--muted)±/var(--muted)` | global.css 全文约 150+ 处，建议按「先标题色、后正文色」分两批查替 | 中 / 低（色差细微，逐批肉眼验收） |
| P1-5 | **触控目标 44px 全端化**：`.form-field input/select` 38→44（L1567）；`.icon-button` 38→44（L628–629，注意登录密码眼睛钮布局）；`.segmented button` 40→44（L2507）；`.search-box.compact` 38→44（L218） | 相应删除 430 断点里的重复规则 L4913–4957 | 小–中 / 中（表单纵向变高，需过一遍编辑器页） |
| P1-6 | **pill 参数拉平**：`.pill` 11.5px/700 → 与基准 10.5–11px/700–740 取中（建议 11px/700，padding `3px 9px` 保持） | L1423–1434 | 极小 / 低 |
| P1-7 | **阴影梯级**：`0 8px 20px`（deal-card L4292）、`0 18px 42px/45px`（citation L3630、draft L3858、weekly-editor L3924）、`0 22px 60px`（confirm L343 保留——弹窗允许最重档）统一收敛到 `--shadow-card` 或 `0 8px 28px` 档 | 见左 | 小 / 低 |

### 6.3 P2 —— 页面级小结构调整（按页排期，合计 3–5 天级）

| # | 页面 | 事项 | 工作量 |
| --- | --- | --- | --- |
| P2-8 | 全站 | **空状态组件化**：新增 `.empty-state`（参数=`.expense-empty-state`）与 `.empty-state--dashed`（虚线变体，合并 `.sales-decision-empty` L3540–3561 与 `.settings-empty-state` L5491–5497）；替换 `.empty-list` 的 11 处使用（pages.jsx L1176/L1932/L2187/L2458/L2621/L2649/L2658/L3046/L3304 + VisitItineraryPage L146/L158）。`empty-list` 类名保留为别名过渡，不删（测试兼容） | 中 |
| P2-9 | 战情总览 | KPI 收敛：方案 A（低风险）——4 张 `.overview-kpi` 只改 token（圆角 10、数值 28→24、icon 42→38、阴影 `--shadow-card`）；方案 B（推荐、中风险）——新增 `.overview-summary-strip` 按 `.expense-summary-strip`（L432–495）实现一体条，JSX 改为单容器 4 格。hero 降噪（圆角/阴影） | 中 |
| P2-10 | 快速记录 | 去 composer 渐变彩条与渐变底（L2368–2383）；record-flow 去阴影；voice-box 参数对齐 upload-tile；sync-log 实底化 | 中 |
| P2-11 | 客户/商机/知识/动作/风险 | 列表选中态统一为「左插销 + 浅蓝底」：`.list-button.selected`（L2230–2233）、`.record-note.selected`（L2165–2169）、`.related-docs button.selected`（L3827–3831）加 `box-shadow: inset 3px 0 0 var(--blue)`、底色 `#eef3ff` | 小 |
| P2-12 | 行程 | 表头实底 #f5f7fb + 11.5px/760；行实底白；date-tile 圆角/阴影降档；850 字重归一；删除确认改 confirm-dialog（结构小调，注意保留 data-testid=`itinerary-delete-confirmation` 或同步改测试） | 小–中 |
| P2-13 | 周报 | paper 对齐打印纸张语言；day-card/weekly-editor/generated-draft 圆角与阴影；draft-source-strip 胶囊参数 | 小–中 |
| P2-14 | 知识库 | citation-panel → 虚线便签形态（去渐变去大阴影） | 小 |
| P2-15 | 系统配置+微信 | settings-intro 圆角与渐变；weixin 渐变实底化；one-time-secret/settings-feedback 对齐 alert 形态 | 小 |
| P2-16 | 登录 | 输入圆角 10、焦点环、错误文案字重；品牌面保留 | 小 |
| P2-17 | 看板 | kanban-status 对齐 alert 形态；deal-card 阴影降档 | 小 |
| P2-18 | 全站卡头 | `.panel` 增加浅底卡头变体（`--surface-raised` 底 + 分隔线），总览/列表页逐个启用 | 中（可切分到各页） |

### 6.4 P3 —— 可选 / 放量最后

| # | 事项 | 说明 | 风险 |
| --- | --- | --- | --- |
| P3-19 | 字重梯度归一（550–850 → 500/600/700/800 四档） | 全局约 200+ 处；建议脚本批量替换 + 全页截图对比 | 中（大面积视觉回归） |
| P3-20 | eyebrow/kicker 双规格合并 | global L1383–1389 vs travelExpense L1645–1650 | 低 |
| P3-21 | `.module-subnav` 改「白卡+下划线 tab」形态（对齐 `.expense-tabs`） | 涉及交互样式重写，且该组件全站每页可见 | 中 |
| P3-22 | 差旅内部微修：补 `--expense-muted`（已在 P0）、`.expense-tabs` 提炼为全局 tab 组件供其他页复用 | 为后续页面提供 tab 原子 | 低 |

### 6.5 分页工作量汇总

| 页面 | 量级 | 主要内容 |
| --- | --- | --- |
| 医院招标监测 | 极小 | priority-strip 圆角（P1-1 顺带） |
| 登录 | 小 | P2-16 |
| 系统配置（含微信/通知/调度） | 小 | P2-15 + P0-3 |
| 动作 / 风险 / 看板 | 小 | P2-11 / P2-17 |
| 知识库 | 小–中 | P2-14 + 列表族 |
| 行程 | 小–中 | P2-12 |
| 周报 | 中 | P0-1（空态）+ P2-13 |
| 客户 / 商机 | 中 | P2-11 + P1-5 表单 + 详情卡 |
| 快速记录 | 中 | P2-10 |
| 战情总览 | 中 | P2-9 |
| 全局（P0+P1） | 中 | token/圆角/焦点/色票/滚动条/PWA |

---

## 7. 波及面与回归风险清单

1. **`.ghost-button/.primary-button` 不要动**（除焦点环）。它们被差旅基准直接复用（travelExpense.css L133–136、L255–261、L4621、L4636–4640、L4657–4658、L4687–4689 等 20+ 处引用），是「基准认可」的既成标准；改 min-height/padding/圆角会同时回归全站与差旅。基准内部本就存在「按钮 10px 圆角 vs 输入 6–8px 圆角」的双梯级，属有意设计。
2. **`.pill` 改动波及全站**：客户/商机/动作/风险/看板/行程/微信/周报草稿全在用（pages.jsx 30+ 处）。P1-6 只改字号字重，不改盒模型。
3. **测试脚本对类名/结构有断言**（改类名比改数值危险得多，原则「只增不删、改值不改名」）：
   - `scripts/list-action-layout.test.mjs`：断言 `Panel` 的 `action` 插槽、`panel-title-action` 类名、`itinerary-date-tile/-month/-day/-weekday` 类名、创建按钮 testid 必须在 `<Panel>` 内。
   - `scripts/visual-rhythm.test.mjs`：按 `data-testid="page-*"` 遍历 14 页 × 6 视口截图，是改版后的主要验收工具（改动 testid 即断）。
   - `scripts/interaction-polish.test.mjs`、`scripts/integration-qa.mjs`、`scripts/webkit-qa.mjs`、`scripts/customer-opportunity-contract.test.mjs`、`scripts/authenticated-pdf-browser.test.mjs` 含 `ghost-button/primary-button` 等类名选择器（约 9+2 处）。
   - `scripts/formal-ui-copy.test.mjs` 断言文案：视觉改造不要顺手改文案。
4. **`data-testid` 一律不动**；空状态替换 `.empty-list` 时保留原类名作别名（`class="empty-state empty-list"`）。
5. **响应式双源**：断点规则在 global.css（L4344–4994、L5531–5593、L6180–6592）与 travelExpense.css（L4558–4738）各自维护。P1-5 触控目标全端化后，记得删 430 断点重复规则，避免双改漏改。
6. **动态 base path**：PWA manifest 与图标引用必须相对路径（`vite.config.mjs` 的 `resolvePublicBasePath`），否则子路径部署（`VITE_PUBLIC_BASE_PATH`）会 404。
7. **`prefers-reduced-motion` 已全局覆盖**（global.css L4996–5014），新增动画（如 state-spinner 旋转）会被 L5000 的 `animation-duration: 0ms !important` 自动降级——符合预期，无需特判；但若用 `animation-iteration-count: infinite` 需确认降级后不残留中间帧。
8. **建议验收流程**：每完成一个 P 级批次，跑 `npm run build` + `test:visual`（需 CHROME_PATH）+ `test:list-actions` + `test:copy`；P1-4 色值替换建议分「标题批/正文批」两次提交，便于回滚。

---

## 附：十条关键发现（摘要）

1. `.workbench-state-panel/.state-spinner/.kanban-page` 在 JSX 使用但**任何 CSS（含 dist 产物）都没有定义**——全站首屏 loading/错误/空数据面板与周报空状态处于无样式裸奔状态，优先级高于一切风格统一（P0-1/P0-2）。
2. 圆角存在三套体系：差旅 6–10px、旧页 11–14px、系统配置 18px；建议 `--radius-card:10 / --radius-control:8 / 999` 三档归一（P1-1）。
3. 文本色双色系并存：旧页 Untitled UI 灰（#101828/#667085/#98a2b3）vs 基准海军蓝灰（#10234b/#66738e/#7b879d）；另有 iOS 色票（#34c759/#0a84ff/#f5a623/#ff3b30/#ff9500）散落在决策面板、流程条、语音点、同步日志（P1-3/P1-4）。
4. `var(--ink)`（settings 5 处 + confirm-dialog 1 处）与 `var(--expense-muted)`（差旅 2 处）被引用但从未定义（P0-3）。
5. 空状态有四种形态并存：`.empty-list` 一行字、基准 `.expense-empty-state` 居中式、虚线 `.sales-decision-empty/.settings-empty-state`、无样式 `.workbench-state-panel`；需收敛为「居中式 + 虚线变体」两种（P2-8）。
6. 焦点环两套（4px/0.12–0.16 vs 基准 3px/0.22）、触控目标不齐（全局输入 38px、icon-button 38px、segmented 40px vs 基准全面 44px，仅 430px 断点拉平）（P1-2/P1-5）。
7. `.ghost-button/.primary-button/.pill` 已是全站共享原子且被差旅基准直接使用——**它们不是问题源，不要动结构**，只统一焦点环；多份自动化测试以类名断言，改造原则是「改值不改名、只增不删」。
8. PWA 为零：无 manifest、无 192/512 图标、无 SW；index.html 已有 apple-touch-icon 与 theme-color，但 theme-color `#f6f8fb` 与 `--bg #f3f5fa` 不一致；最小补集为 manifest+两档图标+theme-color 校准，注意动态 base path 需用相对 start_url（P0-4/P0-6）。
9. 滚动条未统一：仅 4 处 `scrollbar-width: thin`，差旅横滚表格区反而没有处理，Windows 上默认粗滚动条不一致；一段全局细滚动条规则即可解决（P0-5）。
10. 医院招标监测页已基本对齐基准（10px 圆角、44px 控件、复用 `.expense-page-alert`），行程页次之——可作为其余页面改造的中间范例与工作量校准样本。
