# 变更日志

本项目按语义化版本记录代码变更。版本条目表示对应代码已经冻结，不自动表示标签、制品封存或生产部署已经完成。条目时间使用 ISO 8601 和 `Asia/Shanghai` 时区；常规发布以 GitHub Release 为准。经项目所有者明确授权的直接生产发布，必须以本地注释标签、exact-commit 不可变归档、manifest、SHA-256 和服务器 evidence 共同确认身份。

## [Unreleased]

## [0.8.4] - 2026-08-28

### 工程健康收官（总蓝图 L 阶段）

- **P0 孤儿测试挂门禁**：全仓唯一孤儿 `src/features/hospitalTender/HospitalTenderPage.test.mjs`（v0.6.26 招标 UI 合入后从未执行）修复后挂入门禁——组件自测试编写后演进为 `customerId ?? ""` 防御写法，两条断言同步该语义（守护意图不变）；新增 `test:tender` 脚本并插入 `qa:local` 链（`test:settings` 之后），4 项全绿。
- **worktree/分支大清理（主仓库）**：先为 45 个待删分支逐一打本地 archive tag（`archive/<原名>-20260828`，不推远端，可随时 `git branch <名> archive/…` 复活）；A 类 28 个（已被主线包含，实证 `merge-base --is-ancestor` 复核）在主线工作树内 `git branch -d`（git 自身二次校验包含性；其中两个 expense-ledger 分支被脏 worktree 占用，先 `switch --detach` 摘 HEAD——同 commit、工作区文件一字未动——再删）；B 类 17 个（`git cherry` unique=0 内容等价）`-D`。移除 67 个干净 worktree（含 `/private/var` v0.6.25 发布临时 checkout 与 tmp/ 事务副本），保留主 checkout、活动工作树与 8 个脏 worktree（待人工过目）；`ls .worktrees` 与注册表清理后完全一致，无孤儿目录残留。`git worktree prune` + `git gc --prune=now` 收尾。**磁盘回收 ≈8.9 GB**（.worktrees 8.35 GB + 外部 worktree 450 MB + tmp 副本 61 MB + .git 44 MB），分支 78 → 33（主线 + main + 31 个"需确认"，后者仅列清单未删）。
- **pages.jsx 按域拆分（3887 行 → 13 个域文件 + 桶文件）**：先行单独提交守护测试取源改造——`workbenchState.test.js` 的 `pagesSource` 改为聚合读取 `pages.jsx` + `pages/` 目录全部 `.jsx`（断言一字不动，`salesDataImports` 升级为全局匹配防聚合漏检），另外 8 个读源文本的 scripts 测试统一改走新 helper `scripts/pages-source.mjs`；再做纯剪切搬移：`pages/shared.jsx`（FormField/确认删除/DeleteConfirmationDialog/StakeholderGrid/FieldTags/DecisionChain/DraftPreview/joinedList/sourceRefText/generateBusinessSuggestion 等 14 个跨域符号）+ PageHeading/Overview/QuickRecord/Customer/Opportunity/Actions/Solution/Weekly/Risk/Knowledge/WeixinBinding/Kanban 十二个域文件，`pages.jsx` 原地改为纯桶文件（15 个导出符号面零变化，`App.jsx` 与 fixture 导入语句零改动）；每个域文件 import 集合按引用实证计算，顺带清掉 6 个死 import。类名与测试断言零变化，本地合成栈 14 页真浏览器走查零运行时错误。
- **差旅账本行删除入口（两轮深测缺口 + `deleteExpense` 死代码清账）**：v0.8.2 账本重设计时旧 `ExpenseLedger` 的行删除按钮未迁入 `ExpenseLedgerWorkbench`，`TravelExpensePage.deleteExpense`（confirm + If-Match 版本头）成为死代码。本版在工作台账本行（桌面表格"操作"列 + 移动卡片 footer）为正式费用行补回删除按钮（`data-testid="expense-delete-ledger"`，红色描边样式、打印隐藏），接回既有 `deleteExpense`（`globalThis.confirm` 弹窗 + `deleteTravelExpense(id, version)` If-Match 乐观锁，语义对齐动作页删除）；待确认行与借款行不出删除入口。新增源级守护断言（组件/接线/CSS/If-Match 四点）。
- **技术债清账**：v0.7.5 测试基线口径笔误核销（交付报告 §3-8 标记已解决：冻结基线 1148、净增 41）；`.production-cutover.lock` 残留说明写入 `docs/部署记录.md` 运维注意事项（flock 锚点属正常现象，判断切换状态以 `.maintenance-lock` 与进程为准）；生产 outbox 4 条 08-22/25 历史 failed 按部署窗口"只读确认 → SQL 清理 + audit_logs 留痕"处置（仓库无删除合同，`failed` 即终态语义）。阶段词表下沉、naturalPlan 前缀表驱动等其余登记项维持开放并在清册注明去向。
- **docs 全面回填至 v0.8.x 现状**：README（能力总览 12 业务域、生产状态、质量门口径、文档地图四类入口）、开发进度与路线图（改薄壳：现行路线指蓝图 + v0.1–v0.8.4 历史里程碑表）、开发日志（7-29 之后版本级摘要表）、部署记录（v0.3.0–v0.8.4 部署索引表 + 运维注意事项含全部血泪坑）、需求与验收矩阵（按 12 业务域重列 + 交互/安全运行三表）、项目架构与模块说明（backend 22 子域 + 前端 features + 三调度器 + 迁移 0001–0028 索引 + 审计脱敏与 outbox 终态边界）、新增《森特智行-v0.8.x-交接说明》（本机仓库为唯一主线来源的恢复路径、服务器事实、部署 runbook 十条要点、备份系统、退役记录；v0.4.4 原件保留）。
- 零数据库迁移、零新依赖、零后端代码改动（后端全量 1276 项基线复验全绿）；前端 qa:local 439 项（较 v0.8.3 基线 434 净增 5：招标页守护 4 + 账本删除接线守护 1）；Chrome/WebKit 集成、根发布测试 249 项与密钥扫描全部通过。本地合成栈深测 17/17（14 页走查 + 建费→行内删除全流程）。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.8.3] - 2026-08-28

### 战情总览升级 + 行程→差旅联动（总蓝图 K 阶段）

- **今日焦点卡**（替换总览"本日推进节奏"静态卡）：一张 Panel 四分区——今天的行程（当日 planned 行程，标题+首站客户，点击进行程详情）、到点待办（逾期红胶囊/今日黄胶囊分计，复用 `remind_at` 上海时区判窗，与 v0.7.7 晨报同源口径）、高风险（沿用 `score>=80 OR severity=高` 源，客户名+分数）、新招标（"昨日 09:00 上海"锚点以来 high 相关，与晨报同锚）。每分区明细 ≤2 条 + "共 N 条"、空态短文案、44px 触控、分区头可点跳对应工作台。
- **周趋势卡**：快速记录数 / 差旅报销额 / 待办完成数三行，本周 vs 上周（自然周周一起、Asia/Shanghai，复用 `weekStartOf/addDays`；**非**旧 KPI 的滚动 7 天窗）+ Δ%（上周为 0 显示"新增"、相等显示"持平"），纯 CSS 双横条（本周实色/上周浅色，宽度=值/两周最大值）。快速记录沿销售周报 `voided_at IS NULL` 口径；报销额沿差旅周合计 `reimbursement_cents` JOIN 口径；待办完成以 `updated_at` 前 10 位近似完成日（±8h 边界误差按设计接受并在测试固化）。
- **商机漏斗**：`stageCounts` 改为按后端 `stageVocabulary.KNOWN_STAGES` 七阶段全序输出（含 0 计数），词表外阶段追加尾部；每阶段新增 `amount` 文本（`numberFromText` 求和 >0 时输出 `共 N 万`，与 KPI"万"口径一致）；前端 `StageStrip` 新增 `stage-strip__bar` 纯 CSS 底条（宽度=count/max），面板标题改"商机漏斗"。新增 stage-strip 词表同序源码断言（后端词表 ↔ 前端 fixedStages）。
- **行程→差旅联动**：行程详情工具栏新增"记当日费用"（`ReceiptText`，44px）→ `navigateTo("expense", { filters })` 传 `draftDate/draftItinerary/draftCustomer/draftPurpose/draftRegion`（新纯函数模块 `itineraryExpenseLink.js` 双向映射：purpose=`拜访 前两站顿号连接[等]` 截断 100 字、region=首个非空站点 city、`draftDate` 非真实日历日期整组 fail-closed）→ 差旅页挂载即切至行程所在自然周并自动开新建抽屉预填（日期/事由/关联行程/关联客户，联动场景类目默认交通）→ 消费后 `replace` 清 URL 参数（刷新/回退不复弹）；指向已删行程/客户的参数回落"不关联"。抽屉 `createDraft` 增 `prefill` 参数（仅新建生效），"手工记一笔"与关闭/保存均清预填。
- **区域档案联动（提示不自动写）**：目的地城市不在当周区域档案时显示警示条 + "打开区域设置"按钮（`regionProfile` 保存有 version 乐观锁，自动写风险大于收益）；城市比较走 `hasResponsibleCity` 后缀归一（济宁 ≡ 济宁市），非法输入不抛错按未命中处理；仅在差旅页仍停留在行程自然周时显示。
- **接口与合同**：零新端点——扩展 `GET /api/dashboard/summary` 响应（`todayFocus`/`weeklyTrend` 新必需键 + `stageCounts[].amount`），`dashboardSummaryFromDb` 扩参接入已实例化的 `hospitalTenderRepository` 与上海时区周口径工具；`rhythm` 字段保留输出（合同兼容），web 端不再渲染。总览网格：今日焦点/周趋势各 span 6，最近记录/重点商机 span 4→6 补位，980/760 断点通栏名单同步；移除 `overview-rhythm`/`rhythm-*` 死样式。
- **部署工具对齐金库退役现场**：CodexAccountVault 家族（`codex-account-vault-cloud.service`、`codex-vault-mihomo.service`、监听 4876）已于 2026-08-28 经项目所有者授权手术退役（unit 文件已删、端口无监听），`production-service-plan.mjs`/`production-preflight.mjs`/`production-cutover.sh` 的受保护清单同步收敛为共享 Caddy + 轻氧（8797），三套测试 fixture 与验收手册示例同步。首次 v0.8.3 preflight 因旧清单无法采集已退役服务而 fail-closed，属预期防护行为。
- **总览进入即刷新（生产深测发现）**：行程/差旅写路径不经过 `refreshOverviewSummary`（该刷新只挂在客户/商机/动作/风险/快速记录写操作后），新建行程后站内切回总览时今日焦点/周趋势仍显示 bootstrap 时刻快照、需整页刷新才更新。修复为 `active` 切到 overview 时静默重拉 `GET /api/dashboard/summary`（失败保留旧值），顺带覆盖微信侧写入后的回站场景；新增 module-coverage 源码断言。
- 零数据库迁移（读写全部命中现有表列）；零新依赖（趋势/漏斗全部纯 CSS）；模型路由不变。后端全量 1276 项（较 v0.8.2 基线 1275 净增 1 项：受控种子的 todayFocus/weeklyTrend/七阶段全序聚合断言，覆盖周一/周日 BETWEEN 双端点与两种历史 `updated_at` 格式）；前端 qa:local 434 项（净增 12 项：联动纯函数 8、区域归一 1、页面接线合同 1、词表同序 1、总览进入即刷新 1）；Chrome 集成（rhythm 卡断言随卡移除改指今日焦点到点待办分区）、WebKit、根发布测试 249 项与密钥扫描全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.8.2] - 2026-08-28

### 差旅工作台整改（用户真机反馈驱动）

- **区域弹窗"无法添加城市"高优 bug 修复**：差旅页在存在小小待确认记录时每 12 秒轮询工作台，每次轮询都会以新对象身份重置 `regionProfile`，而区域设置卡的 `useEffect([open, profile])` 随之重建草稿——用户刚添加的城市几秒内被清空。改为"每次打开只初始化一次草稿"（open 转真且 profile 首次可用时初始化，ref 防重入、关闭时复位并清空草稿），后台轮询与服务端版本变化都不再打扰编辑中的草稿；保存冲突仍走既有 409 文案。新增 WebKit 真浏览器组件回归测试 `scripts/trip-region-settings-browser.test.mjs`（模拟 profile 身份变化/版本变化不重置草稿、关闭重开按最新 profile 重建）。
- **移除"小小待确认"只读卡**：微信是唯一确认端，网页不再渲染 `WeixinBookkeepingReviewCenter`（组件文件与 `weixin-review-*` 样式族一并删除，Chrome/WebKit 集成合同改为账本仅保留付款凭证与借款到账两张子卡）；账本内待确认行保留并继续 12 秒轮询同步，其行内动作由"核对入账"改为"微信中确认"指引；后端微信确认合同不动。
- **账本表格改版**：删除"来源"列（微信小小/个人垫付标签整列去掉，桌面表格与移动卡片同步）；"凭证"列缩略图从 48×54 放大到 104×117（超过翻倍，解码尺寸 180→360），列宽重排后凭证列 26% 成为最宽列之一，点击"查看"看大图能力保留。
- **账本/打印/XLSX 对齐用户手工费用清单版式（7 列）**：`序号|日期|用途|金额|付款记录|发票|备注`。① 标题统一为 `M.D-M.D<城市顿号列表>出差费用清单`（日期范围取清单内费用实际发生日，空清单回落自然周；城市取本周负责区域 profile，如 `8.24-8.26济宁、东营出差费用清单`），打印页眉与 XLSX 首行（A1:G1 合并、加粗 14pt、冻结窗格顺移）同源渲染；② 备注列改为 purpose+notes 现有字段拼装（顿号语义"；"连接、去重），用途列保持类别词；③ 发票列沿用系统既有状态词表（已匹配电子发票→"电子"、规则候选匹配→"替票"、无票确认→"无票确认"、待补→"待补"——"替票"为系统既有概念 `substitute_invoice`，无新造词）；④ 底部合计保留"费用合计"+"替票合计金额"两行（替票合计=确认的 rule_candidate 匹配分摊额），账本合计条的可报销/垫付合计不变；⑤ 一笔多凭证时序号/日期/用途/金额/发票/备注跨行合并、每行一图的既有行为保持并纳入断言；⑥ 打印页凭证图放大至与 XLSX 内嵌图同物理尺寸（约 2 英寸宽，A4 纵向每页 6 个凭证行），XLSX 内嵌图片继续使用无依赖手工 OOXML zip 组装方案（非降级文字）。
- 随车上线 `7c83da5` PWA 撞路由避让修复（v0.8.1 部署核验发现共享 Caddy 占用 `/manifest.webmanifest` 与移动 UA 裸根路径：manifest 改名 `/sentelligent.webmanifest`、`start_url=./overview`），部署后需复验 manifest/图标经 HTTPS 可达。
- 零后端与数据库改动（后端全量 1275 项基线复验全绿）；前端 qa:local 422 项（净增 4 项：区域草稿浏览器回归、清单标题两处、页面合同扩充）；Chrome/WebKit 集成、根发布测试 249 项与密钥扫描全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.8.1] - 2026-08-28

### 全站视觉统一与 PWA（视觉审查报告 P0–P2 落地）

- **P0 真缺陷修复**：全站首屏加载/错误/空数据面板的 `.workbench-state-panel`/`.state-spinner`/`.kanban-page` 三组类此前在任何样式表都没有定义（裸 HTML 渲染），按差旅基准模板补齐；6 处 `var(--ink)` 与 2 处 `var(--expense-muted)` 未定义变量修复。
- **token 归一**：圆角三套体系收敛为卡片 10 / 控件 8 / 胶囊 999；文本色双色系（Untitled UI 灰系 111 处）统一到海军蓝灰基准；散落 iOS 色票收敛；焦点环统一 3px/0.22；触控目标对齐 44px；全局滚动条一段规则统一。客户/商机/知识/周报/行程/总览的列表、pill、合计条、提示条、空态对齐差旅基准（空态收敛为居中式+虚线两种）。改造遵循"改值不改名、只增不删"，全部既有类名断言测试保持绿。
- **PWA 最小集**：新增 `manifest.webmanifest`（相对 start_url，适配动态 base）+ 192/512 图标（由森特透明底 LOGO 生成）+ theme-color 校准为全局背景 `#f3f5fa`；静态服务器补 manifest/图标伺服与测试。手机浏览器可"添加到主屏幕"以近原生方式使用。
- 顺带修复两项走查发现：医院招标页 React `select value null` 警告（受控值兜底空串）；快速记录语音模式下手动输入被误标"语音转写"（改为仅真实发生转写才标记，来源通道语义修正）。
- 后端全量 1275 项不变全绿；前端 qa:local 418 项（净增 2 项 PWA 资产测试）；Chrome/WebKit 集成、根发布测试与密钥扫描全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.8.0] - 2026-08-28

### 生产数据安全：每日自动数据库备份 + 发布制品服务器归档

- 新增 `scripts/deploy/daily-db-backup.sh`：每日 02:30（Asia/Shanghai，systemd timer `Persistent=true` 补跑）对生产 SQLite 做在线快照（只读 `node:sqlite` 连接 + `busy_timeout` + `VACUUM INTO`，与 cutover 迁移彩排同款、对运行中后端零干扰）→ `quick_check`+外键校验 → fsync → SHA-256 sidecar → 原子重建 `manifest.json` → 按文件名日期清理 14 天前旧份。fail-closed：发布维护锁在位、磁盘余量不足、完整性不过均非零退出且清理半成品；已验证备份绝不误删。
- 新增 `scripts/deploy/archive-release-artifacts.sh`：发布 bundle 与 evidence 归档到服务器 `backups/releases/<version>/`（staging 内 cmp/diff 校验复制 → 全量 SHA256SUMS + manifest → 原子 mv，已存在即失败不可覆盖 → root:root 0700/0600 冻结；证据内符号链接与 secret 疑似文件名直接拒绝），解除"发布制品仅存开发机"单点。
- systemd 单元 `sentelligent-daily-backup.service/.timer` 落库并安装到生产（CentOS 7 / systemd 219：OnCalendar 用无时区写法，本地时区 Asia/Shanghai 已实测核对；单元引用 releases 之外的稳定路径 `tools/`，不进入 preflight 固定四项服务白名单，发布门禁零影响）。
- 服务器实况核查报告（`docs/superpowers/research/2026-08-28-v080-server-facts.md`）12 项 TODO 全部核销或预记裁定：磁盘 22G 对约 50MB 备份总量、journald 已持久化、无单元/crontab 撞名；维护窗口撞 02:30 当晚 fail-closed 跳过（cutover 自带备份兜底）。
- 无应用代码改动；后端/前端/发布门禁全绿基线不变。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.7] - 2026-08-28

### 每日晨报 + 周五收尾包（v0.7 系列收官）

- 每日 09:00（Asia/Shanghai，`DAILY_DIGEST_TIME` 可调）小小微信晨报四件套（新模块 `backend/src/dailyDigest/`）：① 今日行程（`visit_itineraries` 当日 planned 单日 SQL，≤3 条，解析 plan_json 取站数与首站客户名，plan 形状异常 fail-open 仅显示标题）；② 待办（迁移 0028 的 `remind_at` 判窗——逾期 = 上海今日 00:00 之前且 pending/in_progress，今日 = 当日窗口内，各 ≤5 条按 remind_at 升序，**不看 reminded_at**（到点提醒发过 ≠ 办完，与 v0.7.5 单次提醒构成"提醒一次 + 晨报追账"组合）；另有未排期待办计数走三分支可见域）；③ 活跃风险（severity=高或 score≥80 取前 3，无高危降一行计数）；④ 昨日以来新招标（`listNotices` 扩 `firstSeenFrom` 过滤器按 `first_seen_at` 判"我们何时首见"，high 列表 ≤5 + 超出计数、medium 仅计数，与实时推送卡互补不重复、不带 URL）。首行"焦点"按 逾期高优待办 > 今日行程 > 高分风险 > 新招标 确定性排序，全空段省略、四段全空当日不发（audit `digest.daily.skipped`）。
- 周五 16:30（`DAILY_DIGEST_FRIDAY_TIME` 可调）收尾包（kind=`friday_closeout`）：周报段只读引用 `salesReportSummary` 三分支（已有周报 N 份（最新状态）/已确认素材 N 条引导一键生成/暂无素材），**不自动落库不调模型**；凭证缺失 = 本周费用无任何 `payment_proof` 附件（NOT EXISTS SQL，对齐 Web 合计条 `paymentProofMissingCount` 口径）；发票缺失 = `unacknowledgedMissingCents > 0`（已走"确认无票"的不再催——与 Web 徽标 `invoice_pending` 口径的差异见 release notes）；两清单各 ≤8 行 + 超出计数 + 缺票合计；两清单皆空时改发一行"本周凭证与发票已齐 ✓"（收尾包全空也发，确认无欠账本身是核心信息）。
- 调度与幂等（`digestScheduler.js`，独立 60s setTimeout 链、与 v0.7.5 待办提醒循环不共用 tick）：零迁移零状态表——outbox 行即持久 marker，幂等键 `daily-digest:{date}` / `friday-closeout:{date}`（`outboxRepository` 新增只读点查 `hasKey`，同键异内容 409 反向保证 marker 强一致）；重启不重发、当日错过补发（audit 记 lateMinutes）、跨日不补（过期晨报无行动价值）、周五收尾包错过不补到周末；worker 离线（`deliveryReady` 门同招标）不入队不标记、恢复即补。消息经 `digestMessage.js` fail-closed 渲染（3500 字上限、段/行数硬顶、payload 走预渲染 lines 规避 outbox 禁键），出箱走既有 `renderOutboxMessage` kind 分发（`daily_digest`/`friday_closeout` 两分支紧邻 `action_reminder` 追加）。
- 管理面：`GET /api/digest/status`（user 鉴权：调度器状态含 daily/friday 两段 + 今日两枚幂等键是否已投）、`POST /api/digest/run?kind=daily|friday&dryRun=1`（user 鉴权：dryRun 只构建渲染返回文本不入队不审计，供发布当晚预览"明早会发什么"；真发绕时刻门不绕 marker，重复调用返回 `already_sent`）。审计三 action：`digest.daily.sent` / `digest.daily.skipped` / `digest.friday.sent`（entityType `assistant_digest`，actor `system:daily-digest`，metadata 含各段条数与 outboxId）。配置 `DAILY_DIGEST_AUTO_RUN`（生产默认开）/`DAILY_DIGEST_TIME`/`DAILY_DIGEST_FRIDAY_TIME`/`DAILY_DIGEST_POLL_MS`（默认 60s，钳 [5s, 600s]）。
- 招标采集 2026-08-20 陈账（`last_error` 英文快照校验文案）已于 v0.7.6 部署核验确认自愈（scheduler success、last_error=null、连续正常轮巡），设计中的 lenient 单条容错加固按现场裁定降级为不做，登记观察项：如未来再现"单条坏公告拒绝整批快照"，按施工图第四章方案加固。
- 零数据库迁移（schema_migrations 保持 27 项 last=0028）；模型路由不变；本版无新增小小意图/工具（纯推送）。后端全量 1275 项（较 v0.7.6 冻结基线 1239 净增 36 项：内容四件套与收尾包口径/渲染 fail-closed/调度幂等与补发语义/HTTP 端点与出箱链路/firstSeenFrom/hasKey）；前端 qa:local 416 项、Chrome/WebKit 集成、根发布测试 249 项与密钥扫描（603 文件零发现）全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.6] - 2026-08-28

### 小小·商机 agent：查/改阶段、金额、下一步，阶段升级联动销售决策

- 六个商机工具挂入既有 `opportunity` agent（全部确定性解析、不经模型；owner 服务端解析）：`opportunity.list`（R0 免确认，"日照医院有哪些商机/商机列表"，≤8 条候选带阶段/金额/编号后 6 位）、`opportunity.update-stage`（R1 轻确认，"把日照的商机推进到方案交流/回退到调研机会"，语气词与句读归一）、`opportunity.update-next`（R1 轻确认，"下一步改成…/下一步：…"）、`opportunity.update`（R2 六位码，白名单金额/名称/风险逐字段 before→after 预览）、`opportunity.create`（R2 六位码，客户唯一命中必填 + 同客户同名查重）、`opportunity.delete`（R3 六位码软删除，预览卡强提示行动/风险/快速记录/方案草稿关联计数）。既有 `opportunity.detail` 保持 R0，详情卡增补编号/客户/风险/更新时间。
- 阶段升级联动销售决策 agent：确认执行成功且方向为前进（词表内、非"暂停观察"）时，同步调 `previewSalesDecision`（opportunity_diagnosis）并包 8 秒 race 预算（`OPPORTUNITY_STAGE_REVIEW_BUDGET_MS`，钳 1–30 秒），回执卡尾部追加 ≤4 行"阶段升级检查"（判断/阶段门槛/评分/下一步）；超时或失败提示"发送「项目分析 …」可查看完整分析"，不静默不推独立消息；回退/词表外/暂停目标回执附一行手动提示。分析在业务写事务提交后执行，失败不回滚业务写；`assistant_agent_runs` 以 `assistant-action:{actionId}:stage-review` 事件唯一索引挡重。
- 阶段词表后端镜像：新增 `backend/src/opportunities/stageVocabulary.js`（线索→初步沟通→调研机会→方案输出→方案交流→预算确认→暂停观察，与 Web 看板 `kanbanStages` 注释互指），方向判定 forward/backward/same/unknown 全 fail-closed；词表外阶段预览卡提示"看板将新增该列，不触发升级检查"但不阻断（与看板 extraStages 兼容）；"推进到下一阶段"相对语式 clarify 列已知序列。
- 两级消歧坍缩与钉版：`opportunitySearch` 一次 LIKE 商机名 OR 客户名覆盖"客户名→商机列表"；候选卡升级为带阶段/金额/编号后 6 位（detail/项目分析消歧同步升级）；编号后 6 位回指走 owner 可见域内 LIKE 唯一命中（含转义）；商机快照与适配器投影补 `version`，providers 把 `expectedVersion` 钉进持久化参数，服务端 `runVersionedUpdate` 等价版本守卫拒绝并发写。建商机复用 v0.7.2 客户消歧器（clarify/未命中一律 block，不默认取第一个）。
- 商机写路径抽取为共享模块 `backend/src/opportunities/opportunityStore.js`（`opportunityFromRow`/`createOpportunity`/`updateOpportunity`/`activeOpportunityEntityRow` 自 server.js 迁出非复制，Web 与微信同一份 SQL/审计/版本冲突语义；新增软删/尾码检索/同名查重/关联计数/owner 列表）。审计零新词：`opportunity.create/update/delete` 沿用 Web 同名 + `metadata.source="weixin-assistant"` + `metadata.actionId`；改阶段审计增 `metadata.stageReview`（triggered/skipped_backward/skipped_unknown_stage/skipped_pause，与写同事务原子记录；attached/timeout/failed 结果记录在工具运行输出与回执文本）。建档以 actionId 作实体主键重放安全；群聊拒绝 HTTP 边界先行 403 + provider 写门纵深防御。
- 技术债核销（v0.7.2 登记）：router 画像句式排除名单重排——商机意图组前置截获（G-W 写组锚定"商机详情"别名后、G-Q 查组锚定客户检索前），名单中"项目|商机"主语从"排除落 unknown"改为转发 `opportunity.detail`（"XX项目什么情况"可查）；与记账/客户/快速记录/待办四组词干的分流回归全部固化（"记一下：黄岛商机推进到投标了"仍是拜访记录、"提醒我跟进黄岛商机"仍是待办、"日照的商机记录"仍是记录检索、金额句式不落记账）。行为变更：宽"推进到"语式使"会议推进到下周"这类非商机主语从拜访兜底改为商机未找到的自澄清卡。
- 零数据库迁移（opportunities 表 version/deleted_at/next 全现成）；模型路由不变；Web 商机 CRUD 合同零变化。后端全量 1239 项（较 v0.7.5 冻结基线 1189 净增 50 项：阶段词表/store 等价性/六 handler 直测含联动三态/HTTP 全链路 11 用例/路由分流回归/快照 version/eventId 幂等/记账让路合同）；前端 qa:local 414 项、Chrome/WebKit 集成、根发布测试 249 项与密钥扫描（594 文件零发现）全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.5] - 2026-08-28

### 智能待办：自然语言建待办，到点小小提醒

- 五个待办工具挂入既有 `action-risk` agent：`action-risk.create`（R1 轻确认，"提醒我…/待办：…/记待办/新建待办"）、`action-risk.list`（R0 免确认，"今天/本周/我的待办"）、`action-risk.complete`/`action-risk.defer`（R1 轻确认）、`action-risk.delete`（R2 六位码，软删除）。裸"待办/有什么待办"维持既有动作风险摘要不变；"完成了拜访…"等无"待办"词干句式不受影响。
- 自然语言解析全部确定性、不经模型：新增 `backend/src/assistant/spokenTime.js` 未来向时间解析（明天/后天/下周X/周X 最近未来语义/X月X日/N天后/月底/X号 + 上午十点/下午3点半/14:30/中午/今晚/明早 + "周五前/3天内"截止语义；有日期无时刻默认 09:00，有时刻无日期按今明判定）；优先级词（紧急/重要/优先/高优 → 高）；"给/约/联系 X"人名候选仅在唯一命中时挂接客户，不唯一时静默不挂。预览卡回显解析结果，解析失败降级"无提醒纯待办"，不瞎猜。
- 迁移 `0028_action_item_reminders`：action_items 加 `owner`/`remind_at`/`reminded_at` 三列 + 到期部分索引，存量行 owner 自挂接客户回填；快速记录确认深写回同步继承记录 owner。小小侧待办可见域扩展 `action.owner = $owner` 分支——不挂客户/商机的独立待办首次对小小可见；owner 为空的存量行微信端只读保护。
- 新增 `backend/src/actionItems/actionItemStore.js`（owner 限定建/查/完成/顺延/软删，乐观锁版本守卫）与 `backend/src/actionReminders/reminderScheduler.js`（60 秒 setTimeout 轻循环：`remind_at<=now AND reminded_at IS NULL` 表即队列，outbox 幂等键 + reminded_at 双幂等防重复轰炸，worker 离线跳过不标记、恢复补发，迟到 >24h 标注"过期待办"）。到点提醒为闹钟语义、不受招标 9–20 窗口约束；夜间/清晨提醒时刻在预览卡提示。提醒卡走既有微信 outbox 绑定私聊投递（新 payload kind=`action_reminder`），回复"完成待办 <编号>/待办 <编号> 推迟到…"闭环。
- 管理面：`GET /api/actions/reminders/status`（调度器状态 + 待发计数）；配置 `ACTION_REMINDER_AUTO_RUN`（生产默认开）与 `ACTION_REMINDER_POLL_MS`（默认 60s，下限 5s）。审计：`action.create`（微信建待办新 action）、`action.update`/`action.delete` 沿用 Web 同名 + `metadata.source` 区分、`action.reminder.sent`（actor=system:action-reminder）。
- 后端全量 1189 项（较 v0.7.4 冻结基线 1148 净增 41 项，其中 10 项为迁移清单动态子用例：store/时间解析/调度器/提醒渲染/HTTP 全链路/路由分流回归）；前端 qa:local 414 项、Chrome/WebKit 集成、根发布测试与密钥扫描全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.4] - 2026-08-28

### 小小微信回复卡片统一（用户真机反馈驱动）

- 新增共享渲染器 `backend/src/assistant/weixinCard.js`：所有小小回复对齐记账消息的既有版式——`【标题】` + 每行一个 `标签：值` 字段 + 空行 + 一句操作提示；空值统一显示"待确认"，列表用顿号连接，长文本按上限截断加省略号。
- 覆盖改造的回复面：拜访记录（新增/修改/作废三张预览卡、录入/更新/作废三张回执卡、记录列表与空态）、客户（画像卡、建档/改档/删档预览卡、建档/更新/归档回执卡、候选消歧卡）、商机详情卡、战情总览卡、客户检索列表；旧三步拜访流的预览卡同步换版式并保留"回复录入"指引。
- 确认提示语简化：六位码卡收敛为"确认码：XXXXXX ＋ 请回复这六位数字，或回复“取消”"两行；轻确认收敛为"请回复“确认”或“取消”"一句。TTL/取消/重发确认码语义与安全不变量（明文码不落库、存档占位）完全不变。
- 去技术细节：回复中不再出现 UUID、乐观锁版本号、运行记录 ID；单据引用统一为尾 6 位短码；摘要截断从 160 收紧到 80 字符。
- 零数据库迁移、零 API 合同变化（仅 text 文案）；模型路由不变。后端全量 1148 项（净增 3 项卡片渲染测试），前端 qa:local 414 项、Chrome/WebKit 集成、根发布测试 249 项与密钥扫描全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.3] - 2026-08-28

### 小小·拜访与快速记录 agent：一句话记录，查、改、作废全链

- 微信端新增四个快速记录工具并注册进确定性编排器：`visit-capture.capture`（R1 轻确认）、`visit-capture.search`（R0 免确认）、`visit-capture.update`（R2 六位码）、`visit-capture.void`（R3 六位码）。`记一下：/记录一下/快速记录/记拜访` 一步式捕获：同步 AI 分析（沿用 30s 超时静默降级的确定性 fallback）生成摘要卡（要点/客户匹配/待办建议），回复"确认"即写回——复用 quick_record 确认深写回链路（客户/商机/待办/风险），`source_channel='微信助手'` 直通周报素材路径不变。
- R1 轻确认复用记账"确认"交互的内部派生凭据模式，`pendingActionRepository` 零改动；编排器新增 `affirm_language` 确认分支，与六位码链共享 TTL/取消/重发语义。与记账的歧义分流：金额与记账词（元/块/记账/报销/发票等）强信号让路记账链路，`记拜访：` 为绕开歧义的逃生门；记账草稿并存场景的让路合同用例（T-BK-1/2/3）在单元与 HTTP 两层固化。
- `查/查一下 …（上周/本月/今天…）…的记录` 免确认检索：中文口语时间窗解析（新增 `spokenDate.js`，过去向）+ 客户主语模糊匹配（复用 v0.7.2 消歧器）；候选卡带记录短码。`把（那条/记录X）的字段改成…` 走 R2 预览卡（before/after + 乐观锁钉版）；`作废/删除记录` 走 R3——补齐 `voided_at` 自迁移 0002 建列以来从未有写路径的缺口，软作废可审计、读路径自动隐藏。
- 快速记录写路径抽取为共享模块 `backend/src/quickRecords/quickRecordStore.js`（Web 与微信同一份 SQL/审计/版本冲突语义）；新增 `quickRecordPendingPreviewProviders.js` 预览提供者。既有微信三步式 visit-capture 暂存流原样保留。
- 零数据库迁移；模型路由不变。后端全量 1145 项（较 v0.7.2 净增 73 项：store 写路径/口语日期/路由语式/预览提供者/HTTP 全链路 10 用例/记账并存合同用例）；前端 qa:local 414 项、Chrome/WebKit 集成、根发布测试 249 项与密钥扫描全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.2] - 2026-08-28

### 小小·客户画像 agent：查免确认、增改删六位码确认

- 微信端新增三个客户写工具并注册进确定性编排器：`customer.create`（R2）、`customer.update`（R2）、`customer.delete`（R3，软删除），全部走既有六位码确认链（10 分钟 TTL、错码 5 次锁定、明文码不落库）；查询类（`customer.search`/`customer.detail`）保持 R0 免确认。写操作仅限与小小绑定的私聊（群聊 fail-closed 拒绝），owner 一律由服务端机器身份解析，模型与用户均不能指定归属。
- 编排器新增可选 `pendingPreviewProviders` 钩子：建 pending action 之前先做客户消歧（唯一命中出预览卡、多命中列候选澄清、零命中引导建档）、建档重名保护、逐字段 before/after 变更预览，并把规范化参数与乐观锁版本钉进持久化计划；预览摘要随"重发确认码"一并重发；事件存档仍整体替换为占位文本，确认码与预览卡都不进 `assistant_inbound_events`。provider 抛错走既有安全失败响应，未注册 provider 的确认流字节级不变。
- 修复记账运行时 `handlePending` 的两处让路缺陷：主会话存在非记账 pending action（如客户写操作）且未引用记账草稿时，六位码/取消/重发确认码/普通文本一律交回通用确认边界（此前六位码会被"小小记账不使用六位确认码"吞掉）；无引用、无 pendingActionId 时，非记账语言不再被隐式草稿绑定劫持（客户画像问答、建/改/删档指令在草稿活跃期正常工作）。引用草稿的确认/修改/取消、隐式"确认"、借款/区域意图与财务范围门全部保持不变。
- 新增前向迁移 `0027_customer_profile_aliases`：customers 表加 `aliases`/`tags`（JSON 文本数组，默认 `[]`）；小小快照投影扩展 `version/contact/budget/summary/aliases/tags`，客户检索的 LIKE 条件加 `aliases`（"日照中医院"等俗称可查）；画像卡展示联系人/预算/别名/标签/摘要/在办商机数。Web `POST/PATCH /api/customers` 同步接受 `aliases`/`tags`（≤20 项、每项 ≤120 字），响应与审计快照新增这两个字段。
- `server.js` 客户写路径抽取为共享模块 `backend/src/customers/customerStore.js`（create/update/softDelete/重名检查/在办商机计数），微信与 Web 走同一份 SQL 与审计快照；Web 端客户 CRUD 行为、审计 action（`customer.create/update/delete`）与乐观锁语义不变。微信来源审计以 `metadata.source="weixin-assistant"` + `metadata.actionId` 区分；`customer.create` 以 actionId 作实体主键实现重放安全，update/delete 以 `expectedVersion` 兜底防止二次写；`contact` 字段仍被审计脱敏器按键名剔除（预期行为，changedFields 可证明改动）。
- 路由器新增确定性语式：建档（`新建客户/新增客户/建档：…` 键值段解析）、改档（`修改客户 X，级别A`、`把X的区域改成日照`、`给X加别名Y`、上下文代词`它/这个客户`回退）、删档（`删除客户/删档`）、`查询 X` 与画像句式（`X什么情况/近况/画像/资料/档案`，显式排除以项目/商机/报销等结尾的主语）；未知字段澄清提示可改字段清单。
- 测试：后端全量 1072 项（较 v0.7.1 净增 42 项：路由语式、策略/manifest、变更预览与预览提供者、写 handler 幂等与版本冲突、HTTP 全链路建/改/删/锁定/换码/过期/群聊拒绝、记账草稿共存回归）；前端 qa:local 414 项、Chrome/WebKit 集成、根发布测试与密钥扫描全部通过。按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.1] - 2026-08-27

### 记账确认唯一化与系统配置记账实时日志

- 记账确认收敛为微信单一入口：差旅工作台"小小待确认记账"改为只读复核卡（识别摘要 dl 展示 + 微信引用回复引导），删除确认入账/重新识别/拒绝按钮与可编辑表单；同步移除跨周账目提示横幅及其数据链（`selectCrossWeekLedgerReceipts`/`locateRecentReceipt`/`refreshWeixinBookkeepingReviews`），周切换与保存费用的定位机制不变。
- 前端 API 客户端裁撤 `confirmWeixinBookkeepingReview`/`rejectWeixinBookkeepingReview`/`retryWeixinBookkeepingReview`；微信 worker 使用的后端确认合同保持不变。
- 后端 `GET /api/audit-logs` 新增 `scope=bookkeeping`：服务端常量前缀白名单（travel_expense/travel_expense_advance/travel_expense_document_inbox/invoice/shortcut_bookkeeping/bookkeeping_client），SQLite `GLOB` 前缀匹配避免 LIKE 下划线通配，未知 scope 422 fail-closed。
- 新增 `POST /api/bookkeeping/client-events`（仅登录用户）：事件白名单 `print_expense_list`/`print_invoices`/`export_expense_xlsx`，`weekStart` 须 `YYYY-MM-DD`、`itemCount` 须 0–10000 安全整数、`context` ≤200 字符，非法值与未知字段丢弃 fail-closed，写入 `audit_logs`（`bookkeeping_client.*`）。
- 差旅工作台三处埋点 fire-and-forget：打印费用清单、打印发票、导出费用 Excel；埋点失败静默，不阻塞主交互。
- 系统配置新增"记账日志"子页（`/settings/bookkeeping-log`，子导航第 5 项）：每 10 秒轮询 scope 过滤的审计流水并支持手动刷新，动作中文标签映射、HH:mm:ss 时间、单据短标识与金额/摘要提取，空态/加载态/错误态齐全。
- 修复上一候选遗留的 `setRecentLedgerReceipts` 残留调用导致差旅页运行时崩溃的问题；无数据库迁移；模型路由不变；后端全量 1030 项、前端 qa:local、Chrome/WebKit 集成、根发布测试与密钥扫描全部通过；按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.7.0] - 2026-08-27

### 小小助手：医院招标微信推送与白天轮巡窗口

- 医院招标监测通知改为经微信助手"小小"主动推送：复用既有微信确认 outbox（幂等键 `hospital-tender:cycle:{n}:chunk:{i}:{内容哈希}`、租约重试、单实例投递、绑定本人私聊），有新的高相关公告才推送、无新公告不打扰；PushPlus 仅在微信投递未绑定时作为兜底通道保留。
- 新增前向迁移 `0026_hospital_tender_active_window`：轮巡调度器增加 Asia/Shanghai 活动窗口（默认 9–20 点），窗口外不采集不推送，`next_run_at` 自动跳到下一窗口起点；`--force` 手动运行不受窗口限制。调度器 PATCH API 支持 `activeStartHour`/`activeEndHour`（0–23/1–24，start<end fail-closed），窗口或间隔变更即时生效。
- 推送文案为有界纯文本分片（每条最多 20 条公告），payload 不含 token/密钥/正文以外内容；渲染 fail-closed，未知 outbox kind 行为不变，快捷记账链路不受影响。
- 后端全量 1029 项、迁移与调度窗口回归、根发布测试全部通过；生产切换后需用 PATCH 将 `intervalMinutes` 设为 `120` 以启用"每 2 小时"节奏；按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.6.28] - 2026-08-27

### 差旅报销界面重设计

- 基于浏览器全覆盖走查（桌面 1440×900 与移动 390×844 双视口、真实前后端联动数据）重做差旅费用账本工作台视觉：宽屏内容居中自适应、顶部统计条与自然周条重排（城市 chip、待办徽标）、提示条收敛为细条样式、账目表状态统一浅底 pill、底部合计条按"金额组/待办组/操作组"分区。
- 小小待确认卡重排：微信原始文字默认三行折叠可展开、表单字段两列网格对齐、`missing_date`/`invalid_model_response` 等英文错误码映射为中文状态标签、确认/重新识别/拒绝按钮组统一。
- 付款凭证区紧凑化：去除重复标题、费用块头一行化、上传控件收窄；收款方缺失时回落显示费用商户。发票页仓库列宽、状态标签与原件预览容器统一。
- 纯前端展示层变更：无 API、数据库、业务逻辑或 data-testid 契约变化；后端全量、qa:local、Chrome 集成、WebKit 与根发布测试全部通过；按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.6.27] - 2026-08-27

### 功能收尾：录音裁撤、知识引用与全站路由

- 按产品决策彻底移除快速记录的录音长期保存/回放遗留链路：MediaRecorder 录音兜底、本地音频回放卡、"上传录音"控件及相关样式与 QA 注入全部删除；浏览器不支持语音识别时引导改用文本录入，实时语音转写保持不变。
- 知识库接入两条 AI 分析链路：快速记录 preview/analyze 使用确定性中文友好检索（标题/分类/标签整词 + 中文 4 字滑窗、得分阈值）注入 prompt，并由服务端把 `knowledgeRefs` 出处挂载到分析结果与 `ai_insights` 持久化 JSON，人工修改摘要不丢引用；销售决策上下文知识条目带 id，提示词要求 facts 以 `sourceType="knowledge"` 引用真实 id。前端分析面板新增"参考知识"区并可跳转知识详情。
- 补全浏览器历史（UX-08）：知识库、拜访行程、快速记录历史与方案辅助详情写入真实 URL，深链/刷新/前进后退恢复视图与选中记录，bootstrap 不再覆盖深链选中，深链失效显示"记录不可用"；新增内容区滚动位置随浏览器历史保存与恢复。
- 本版无数据库迁移；模型路由不变（文本 `deepseek-v4-flash`，图片/PDF `deepseek-v4-flash-vision-exp`）；后端全量 1022 项、前端 qa:local/qa:integration/qa:webkit、根发布测试与密钥扫描全部通过；按项目所有者授权走本地 exact-commit 生产发布，不同步 GitHub。

## [0.6.26] - 2026-08-27

### 差旅账本与客户画像/招标监测整合

- 差旅费用账本继续保留账本、发票两个工作区，付款凭证、整理报销、借款/请款作为账本内子功能；补齐跨周账目精确定位、付款凭证定位、打印预览状态保留、区域设置焦点恢复与发票候选覆盖校验。
- 客户画像、商机和系统配置按新的信息架构接入真实路由与上下文；医院招标监测接入客户上下文、调度控制与 PushPlus 配置，保留人工确认和只读边界。
- 强化医院招标官方来源采集、批次租约、部分快照、通知重试与生产预检；本版无数据库迁移。
- 本地候选已完成前端、后端、Chrome/WebKit、secret scan、发布前置和回滚门禁；生产切换需以本候选的不可变制品、预检报告和服务器证据为准。


## [0.6.23] - 2026-08-25

### 小小餐饮时段自动分类

- 本人微信付款凭证在上海时间 `04:00–10:59`、`11:00–15:59`、`17:00–23:59` 且单笔不超过 40 元时，自动归入餐饮的早餐、午餐或晚餐子类；同一截图的多笔付款仍逐笔生成独立草稿。
- 固定确认消息只显示父类“餐饮”，内部继续保留早餐/午餐/晚餐子类，并自动生成“月.日 + owner/date 行程区域 + 餐次”备注；区域不唯一或缺失时不猜测并保留复核提示。
- 大额付款仅在餐饮商户或多人出差语义成立时按付款时段推断餐次；明确的招待、住宿、交通或汽车维保语义优先于餐饮时钟，避免低额非餐饮误分类。
- 支付时间只使用付款/交易语义时刻并忽略手机状态栏；视觉模型可返回最多 20 个严格多笔交易，重复附件复用首次内容寻址结果；自动备注带来源元数据，金额、时间、商户、用途、日期、餐次或父类修改后按人工优先级重算或清空。
- 零金额修改保持澄清且不改变草稿；行程区域只接受明确字段或有边界的移动短语，普通叙述失败关闭到同 owner/date 唯一行程城市。
- 修复“修改费用类别为……”被短标签“费用”误解析为金额修改的问题；确认、取消、owner 隔离、引用版本门禁和消费金额等于可报销金额的合同保持不变。
- 本版没有数据库迁移；图片/PDF 继续使用 `deepseek-v4-flash-vision-exp`，其他模型任务继续使用 `deepseek-v4-flash`；按项目所有者授权直接发布生产，不同步 GitHub。

## [0.6.22] - 2026-08-25

### 微信单次回执兼容热修

- 生产安全遥测确认发送接口会以 HTTP 200 和仅含正整数 `message_id` 的 JSON 对象表示成功；vendored SDK 现在只接受这一精确形状、空/空白正文、空对象或全零状态字段。
- 缺失、空值、非正整数、混合未知字段、畸形 JSON 和任一显式非零状态继续失败关闭；响应正文和值不写入应用日志。
- 继续保留 v0.6.21 的空备注、自然语言修改、引用身份和受限 409 修复；无数据库迁移，不改变视觉/文字模型路由，不同步 GitHub。

## [0.6.21] - 2026-08-25

### 小小备注与微信引用回执热修

- 新付款凭证的备注默认留空并显示“无”；商户和用途继续保存在各自字段，不再把商户名称回填为备注。
- 自然语言备注修改同步数据库行、分析快照和后续确认消息；兼容“修改备注8.18晚餐：……”这类紧凑表达。
- 微信发送接口的 HTTP 2xx 空正文按成功回执处理，结束“消息实际可见但 outbox 误判失败并反复发送”的循环；引用消息优先匹配稳定的 Sentelligent 客户端标识。
- 后端的受限 409 业务说明不再被包装成“处理消息失败”；当 provider 没有传递引用元数据时，只对唯一草稿或与其他草稿有明确时间间隔的最新草稿提供状态兜底，最终确认仍要求该最新草稿已有成功送达证据。
- 隐式选择草稿后再次执行绑定 owner、精确发送者与本人私聊门禁，其他 allowlist 发送者和群聊不能修改、确认或取消财务草稿；旧版引用不能确认已修订的新版本。
- 本版不修改既有待确认记录的历史备注，无数据库迁移，不改变图片/PDF 使用 `deepseek-v4-flash-vision-exp`、其他任务使用 `deepseek-v4-flash` 的模型路由；按项目所有者授权直接发布生产，不同步 GitHub。

## [0.6.20] - 2026-08-25

### 生产 PDF 视觉渲染兼容热修

- 保留图片与 PDF 使用 `deepseek-v4-flash-vision-exp`、纯文字继续使用 `deepseek-v4-flash` 的模型路由合同。
- 移除生产 Poppler 0.26.5 不支持的 `pdftoppm -jpegopt` 参数；PDF 仍先有界渲染最多四页 JPEG，再交给视觉模型。
- 新增精确参数回归，禁止重新引入旧版生产命令不支持的 JPEG 质量参数；本版无数据库迁移，不同步 GitHub。

## [0.6.19] - 2026-08-25

### 小小视觉记账与单次投递热修

- 图片付款凭证、图片发票和 PDF 发票改用 `deepseek-v4-flash-vision-exp`；其他模型任务继续使用 `deepseek-v4-flash`。
- 微信 provider 的空成功回执和零状态回执按成功处理，同一 outbox 重试复用稳定客户端幂等标识，终止重复确认消息。
- 本版无数据库迁移；按项目所有者授权使用本地 exact-commit 生产发布，不同步 GitHub。

## [0.6.18] - 2026-08-25

### 微信远程媒体类型热修

- 修复微信远程 Agent 将已规范化图片提交到事件 API 时遗漏必需 `media.type` 的问题；严格从 SDK 请求映射且仅转发精确的 `image` 或 `file`，服务端媒体白名单和魔数校验保持不变。
- 新增真实 JPEG 文件路径到远程 HTTP 请求体、再到 `validateWeixinAssistantEvent` 与无损 `contentBase64` 的闭环回归，并用真实本地 HTTP server 验证图片能生成记账草稿；同时覆盖 `image`/`file` 精确映射及近似、大小写和不支持类型拒绝。
- 本版没有数据库迁移，不清理微信 session、游标、历史消息、待确认草稿或 outbox；按项目所有者授权直接发布生产，不同步 GitHub。

## [0.6.17] - 2026-08-25

### 微信付款图片尾部规范化热修

- 微信图片解密或下载后、落盘和计算 SHA-256 前，只在 JPEG 起始标记、固定位置结束标记、provider trailer 零字段和 MD5 摘要四项同时匹配时剥离已验证的 24 字节 provider trailer。
- trailer 任一条件不匹配时保持原字节，继续交由现有严格图片检查 fail-closed；不扩展格式白名单，也不放宽发票或付款凭证校验。
- 新增真实结构 JPEG 的正例、任意前四字节兼容及摘要、零字段、SOI/EOI 位置负例，并验证剥离后能通过生产 `readWeixinDocument` 规范化。
- 本版没有数据库迁移，不删除微信 session、游标或历史消息；按项目所有者授权直接发布生产，不同步 GitHub。

## [0.6.16] - 2026-08-25

### 微信入站游标阻塞热修

- 将微信助手的后端处理阶段与微信回复投递阶段拆开：只有后端/Agent 瞬态失败才保留旧游标重试；后端已经成功时，单次回复投递失败不再重放业务事件或阻塞同批后续图片。
- 新增同批两条消息回归门禁，证明第一条回复失败后第二条仍只处理一次、游标推进且不会产生 `updates error` 毒消息循环；原有“真正处理失败必须重试”门禁保持不变。
- 不删除微信登录会话、持久游标、记账草稿、outbox 或报销数据；本版没有数据库迁移，也不改变“小小”记账的人工确认合同。
- 按项目所有者授权直接发布生产，不同步 GitHub；“整理报销”会话及其数据结构不在本热修范围内。

## [0.6.15] - 2026-08-25

### 小小微信图片记账与发票自动匹配

- 将记账入口统一为本人向“小小”微信助手发送付款凭证图片或收入、支出、借款到账文字；OCR/AI 只生成固定格式待确认草稿，必须引用消息并用自然语言确认、修改或取消后才写入账务。
- 支持单图多笔交易拆分、内容寻址去重、压缩付款凭证附件，以及按金额优先当前自然周、最多跨 31 天的发票自动匹配；同额歧义、超窗或识别不完整时转人工复核。
- 支出的可报销金额等于消费金额；无借款时按个人垫付，借款仅在确认到账后作为收入入账，并沿用自然周追溯分配和余额展示。
- 退役 iOS 快捷指令与 iCost 写入链路，删除 handler、Token、配对、签名工具和前端入口；旧 URL 只保留无副作用的 HTTP 410 墓碑，生产环境拒绝旧变量。
- 本版没有数据库迁移，不重构普通手工报销数据结构；按项目所有者授权使用本地 exact-commit 生产发布，不同步 GitHub。

## [0.6.14] - 2026-08-24

### 快捷指令记账、自然语言确认与借款归属

- 将 V8 全屏 OCR 快捷指令接入统一的快捷记账待确认链路；快捷指令只提交纯文本和结构化字段，不保存账号密码，也不绕过人工确认。
- 固定微信草稿格式，要求绑定本人直聊、发送者、引用消息和最新版本全部通过后，才接受明确的“确认/取消/修改”自然语言；单独的“好的/好/行”和疑问句保持拒绝执行。
- 支出可报销金额固定等于消费金额并自动按个人垫付；“出差-借款”只在到账确认后作为收入入账，支持本周、指定费用和到账后追溯分配。
- 新增不可变记账修订、借款来源、分配计划和分配流水；分配结果显示已用、剩余、个人垫付和未覆盖金额，并通过幂等和快照门禁防止重复或错账。
- 提供独立的官方 iCost URL 可选桥接：森特成功生成待复核草稿后，用户可选择打开 `iCost://expense`/`iCost://income` 预填页面；公开协议没有查询或保存回执，系统不会把打开页面误报为 iCost 已记账。
- 新增前向迁移 `0024_shortcut_advance_allocation`；不修改“整理报销”会话的标准报销费用、付款凭证、发票或周汇总边界。
- 本候选按项目所有者授权走本地 exact-commit 生产路径，不同步 GitHub；真实设备绑定 V8 签名副本需在可信 macOS 注入设备凭据后生成。

## [0.6.13] - 2026-08-24

### 小小结算预览与全屏 OCR 快捷指令

- 延续 `v0.6.12` 的小小请款结算只读预览、owner/财务发送者私聊边界、快照哈希、fail-closed 和禁止确认写回合同。
- 修复旧 iCost V7 转换器只提交裁剪 OCR 的缺口：新增对原始截屏的第二次 OCR，并将裁剪 OCR 与全屏 OCR 通过显式文本动作合并后再发送金额预览。
- 新签名安装副本命名为“智能截图记账（三级菜单待确认版V8·全屏OCR）”，避免继续导入旧 V7；快捷指令仍只创建小小待确认草稿，不绕过人工确认。
- 无数据库迁移、无前端业务改动；不改“整理报销”或快捷记账确认/回执/outbox 运行时逻辑，GitHub 不同步。

## [0.6.12] - 2026-08-23

### 小小请款结算预览

- 单独启用“请款结算与多退少补”确定性预览，仅在已绑定 owner 与财务微信发送者完全匹配的本人私聊中读取同一自然周的请款、到账、费用、付款资金来源和票据覆盖事实。
- 结算公式固定为“非公司直付的可报销金额 - 已收到请款金额”，仅展示公司应补、个人应退或平衡方向；异常字段、记录截断、资金来源不明、票据未覆盖或缺少显式请款事实都会 fail-closed，不推断方向和金额。
- 输出携带服务端证据快照哈希，只供人工核对；本版不接受“确认”写入，不创建退款或补款流水，不修改费用、请款金额或状态，也不调用模型猜测财务事实。成功事件原样重放，失败或运行中的事件不会重新读取财务数据。
- 群聊、第二个普通 allowlist 发送者和未完成财务身份绑定的请求会在结算读取与 tool/agent run 创建之前拒绝，不泄露金额或记录是否存在；运行记录不保存原始 owner 身份。

### 隔离与发布边界

- 本版以生产 `v0.6.11` 精确提交为基线，不接入差旅、付款凭证、发票或报销周汇总的版本化 Agent，不改快捷记账确认链路，也不包含“整理报销”会话的未提交文件。
- 无数据库迁移、无前端业务改动；版本统一为 `0.6.12`，只允许通过新的不可变制品切换 backend、frontend 和 weixin-agent 三个项目服务。
- 按项目所有者要求不写入 GitHub；本地 exact-commit、注释标签、归档、manifest、SHA-256、生产预检、备份和切换后 smoke 共同组成发布身份。

## [0.6.11] - 2026-08-23

### 安全系统配置与通知

- 将 DeepSeek、地图及 PushPlus 等运行凭据收口到服务端安全配置，普通查询、审计和前端状态不返回密钥明文。
- 系统设置页新增 PushPlus 配置与投递健康状态；医院招标通知从加密配置解析凭据，并保持有界响应、失败重试和现有 SSRF 防护。

### 小小非财务 Agent

- 新增固定版本的 Agent 合同、可重放运行记录和销售业务上下文，接入销售决策、客户、商机、拜访采集、销售周报、动作风险、知识、行程和战情看板能力。
- 读取严格按业务 owner 隔离；销售、行程和看板输出保持只读预览，拜访写入仍需既有人工确认流程，模型不得自主写业务或财务记录。
- 本版不启用差旅、报销周报、发票、付款凭证和请款结算 Agent；这些财务能力继续沿用现网路径，不因本次统一运行时而改变。

### 智能截图记账

- 强制 OCR 以纯文本传输，增强人民币符号、全角字符和跨行金额识别，并降低时间、还款等非消费数字的误判。
- 自动识别失败时允许进入人工填写金额的安全兜底；提交仍只形成待确认草稿，最终记账继续受绑定会话与人工确认约束。

### 数据库与发布边界

- 保留生产已使用的 `0019`、`0020` 校验和，新增 `0021_secure_settings_pushplus`、`0022_assistant_agent_runs` 和 `0023_assistant_business_context` 三个只前向迁移。
- 根目录、后端和前端版本统一为 `0.6.11`。本版由项目所有者明确授权不写入 GitHub，以本地 exact-commit、不可变归档、manifest、SHA-256 和生产 evidence 组成发布身份。
- 只有生产备份副本迁移演练、切换前后预检、HTTPS smoke 和清理检查全部通过后，才视为已部署；仅允许切换 backend、frontend 和 weixin-agent，共享 Caddy 不得重启。

## [0.6.5] - 2026-08-22

### 小小与快捷记账可靠闭环

- 正式路径使用可撤销的 V7 设备配对凭据；保留既有 V9 真机的限界迁移兼容，不保存账号密码。
- 收入和支出均先形成 owner-scoped 草稿；只有绑定微信私聊中的最新六位 ASCII 确认码可以入账，“确认”等自然语言只返回安全提示。
- 微信 context token、确认 outbox、delivery scope 和 accepted/rejected 回执均持久化；重启、租约丢失和“财务成功但回执中断”可对账恢复，固定幂等键避免重复回执。
- Web 人工确认/拒绝与微信处理使用终态守卫和 lease fencing，旧草稿会 terminal 化，不阻塞下一笔快捷记账。

### 差旅报销与医院招标

- 恢复六字段费用账本、替票组合、认证图片/PDF 预览、分辨率门禁、费用清单打印和多页发票固定槽位打印。
- 恢复医院公告分页、搜索、客户/类型/相关性筛选、重点机会、新鲜度、运行反馈、来源健康和 PushPlus 状态；移动端筛选与搜索控件保持至少 44px 触控目标。

### 小小销售上下文与安全边界

- 恢复持久化客户/商机上下文、拜访实体关联、限界项目卡、票据覆盖、报销阻塞、真实来源周报状态和已确认拜访预览。
- 保持 owner/sender/conversation 隔离、人工确认和只读预览边界；不允许模型自主写业务或财务记录。

### 发布边界

- 项目所有者因 GitHub Actions 用量上限明确授权本版本不再同步 GitHub，改由本地完整门禁、注释标签、exact-commit 归档、manifest 和 SHA-256 直接交付生产。
- 本条目只冻结候选范围；只有 fresh 生产备份、迁移演练、切换前后预检、受保护服务不变性检查和 HTTPS smoke 全部通过后，才可标记为已部署。
- 仅允许切换 backend、frontend 和 weixin-agent；Caddy、轻氧、账户保险库和 Mihomo 不得重启或改写。

### 医院招标真实来源采集

- 加固东营、济宁及医院公开页面采集器，兼容真实来源的响应包裹、日期格式和单条坏行；单源失败不会丢弃同批可用公告。
- 保留每小时/每批 10 客户的持久化轮巡、稳定游标、来源快照复用、去重和 PushPlus 聚合通知语义；本机受限 DNS 只作为失败诊断，不放宽 SSRF 防护。

### 小小统一助手运行时

- 将小小能力目录、项目分析和现有业务工具接入统一只读/确认边界；执行真源仍是 registry、policy 和 router。
- 微信机器必须显式绑定业务 owner，缺失或不匹配时 fail-closed；机器客户读取和周报草稿按 owner 隔离，保留 `sales-decision.preview` 的 `partial` 状态。

## [0.6.1] - 2026-08-17

### iOS 快捷指令 Token 验证

- 新增账号级快捷指令 Token 管理页：Token 由后端生成，只保存 SHA-256 哈希，完整值仅在创建成功时显示一次；列表只显示前缀，支持撤销。
- 新增公开账本目录和 `GET /api/integrations/shortcut/verify` 验证接口，验证请求按 IP 限流并使用 `Cache-Control: no-store`；Token 会映射到所属账号，不接受客户端传入账号。
- 当前版本只发布身份验证和 fail-closed 提示；跨森特智行/轻氧的记账写入路由尚未开放，验证成功不会创建账目、差旅费用或支付记录，也不会继续快捷指令的截图上传步骤。
- 迁移编号顺延为 `0017`，保留 v0.6.0 的医院招标、系统配置和安全设置迁移不变。

### 发布边界

- tag：`v0.6.1`，合并提交：`c461d6a60253d9a59cd8b187edec57e47a480e94`；GitHub Release workflow `32035210686` 已成功，Release 已发布。
- 已完成受控生产切换，当前 release 为 `/opt/sentelligent-sales-workbench/releases/v0.6.1-20260817T134944Z_c461d6a60253`，`0017` 已应用，回滚目标保留为 v0.6.0。
- 切换前后预检均为 `25/25`；正式 HTTPS smoke run `0a00efbc-f349-424f-9700-0f3f08cda157` 为 `25/25`、`cleanup=clean`，所有合成业务记录、会话和幂等键残留均为 `0`。
- 生产登录凭据已受控轮换：随机密码只进入 macOS 钥匙串，服务器只保存 canonical scrypt 哈希；轮换后只重启后端服务，未修改共享服务或业务数据。

## [0.6.0] - 2026-08-17

### 系统配置与安全密钥

- 新增独立系统配置页：可生成或轮换 iCost 记账 Token，并以 AES-256-GCM 加密保存 DeepSeek API Key；密钥明文不进入普通查询响应、日志、审计、浏览器存储或 Git。
- 浏览器、微信和持久化助手统一通过服务端运行时密钥提供器调用模型，配置页保存的 DeepSeek Key 可覆盖旧环境配置；缺失配置时继续 fail-closed 或使用既有受控兼容路径。

### 医院招标自动轮巡

- 内置公开来源采集器覆盖采购意向、招标/采购、变更、中标/成交、废标/终止和合同公示等类型，不要求使用者再接入第三方招标 API。
- 生产默认每 60 分钟处理一批 10 个客户；一个轮次只采集一次公开来源快照，再按稳定客户 ID 分批匹配并合并结果。
- SQLite 持久化启停、间隔、批量、游标、轮次、最近/下次运行、错误、快照和运行记录；数据库租约与进程定时器共同防止重叠，服务重启后继续。
- 只有整批成功才推进游标；部分入库或采集失败会保留批次。客户新增、删除和全部清空均有确定恢复行为，跨轮次会重新计算匹配，避免保留过期客户关联。
- 医院招标页面新增当前轮次、批次进度、最近/下次运行和本批新增高相关公告汇总；公告仍为只读情报，不自动修改客户、商机或销售阶段。

### 候选边界

- `v0.6.0` 已从 `main` 创建不可移动 tag 并发布 GitHub Release；Release workflow `31998568637` 成功，归档 SHA-256 为 `3b4f747384ecd594aa9db0a337aee3d3f239432e89a13c14cb63678e69c5f371`。
- 已完成生产服务器的 Python 3.12.14 运行时准备、`SETTINGS_ENCRYPTION_KEY` 注入、`0014`/`0015`/`0016` 迁移、不可变 release 切换和页面回归。当前生产 release 为 `/opt/sentelligent-sales-workbench/releases/v0.6.0-20260817T124347Z_4c45656647f5`。
- 切换前后生产预检均为 `25/25`，后端/前端健康检查为 `200`，SQLite `quick_check=ok`、外键违规为 `0`；只重启三个项目服务，共享 Caddy、轻氧、账户保险库和 Mihomo 未重启。
- HTTPS smoke 已完成：run ID `f19df464-c651-4378-ae06-d46fa198897b`，`25/25`，`failed=0`，`blocked=0`，`cleanup=clean`；报告为 `/opt/sentelligent-sales-workbench/evidence/v0.6.0-20260817T124347Z/smoke/production-https-smoke-20260817T140107Z.json`，SHA-256 为 `45de5d14e8f732d9c162f62e79ebea61d2f5080deb03a31b52620f3cd795a150`。
- 清理后 customers、opportunities、quick records、AI insights、sales decisions、itineraries、weekly reports、audit logs、sessions 和 idempotency keys 残留均为 `0`；SQLite `quick_check=ok`、外键违规 `0`。
- 发布合同保持现有 25 项预检数量；会同时校验密钥独立性、固定 `60/10` 调度、非符号链接 Python 路径以及后端服务账号实际运行身份。

## [0.5.7] - 2026-08-16

### WeChat direct-message compatibility

- Accept the provider's empty `group_id`, `room_id`, or `chat_type` placeholders on a direct message while continuing to reject any non-empty unrecognized group signal.
- Keep the v0.5.6 exact 64-bit numeric `message_id` preservation and bounded delivery-identity validation unchanged.
- Add a real-shape regression for a direct update carrying `group_id: ""`, which previously caused the worker to retry the same update forever before replying.

### Production acceptance

- Published from `main` as the immutable `v0.5.7` GitHub Release and deployed to a new release directory, with fresh pre-cutover and post-cutover `25/25` preflight reports and `rollbackStatus=not-required`.
- The first HTTPS smoke retained a clean database after a transient model-preview failure; a second independent run passed `25/25` with `cleanup=clean`, `quick_check=ok`, zero foreign-key violations, and zero smoke-marker residuals.
- The bound real WeChat device successfully completed a `/clear` round trip; the worker advanced its cursor without update or message failures. No sender ID, password, token, cookie, private key, database content, or business message is recorded in Git or release evidence.

## [0.5.6] - 2026-08-16

### WeChat 64-bit inbound IDs

- Preserve the exact JSON numeric source for provider `message_id`, `msg_id`, and `client_id` fields before JavaScript number rounding can occur.
- Accept canonical 64-bit decimal IDs through the same bounded identifier and delivery-key validation; reject negative numeric identifiers.
- Add a real-shape worker regression covering a 19-digit provider message ID and its stable delivery identity.

### Release boundary

- This patch supersedes v0.5.5, which normalized safe integer IDs but was insufficient for the provider's 19-digit numeric form observed in production.
- Production acceptance remains pending until the new immutable release, 25/25 preflight, controlled cutover, HTTPS smoke, and a real WeChat `/clear` reply all pass.
- No sender ID, password, token, cookie, private key, database content, or business message is recorded in Git or release evidence.

## [0.5.5] - 2026-08-16

### WeChat inbound compatibility

- Normalize safe-integer provider `message_id` values before deriving the delivery identity used by the WeChat worker.
- Prefer the provider's canonical `message_id` over lower-priority `msg_id` and `client_id` aliases; retain fail-closed ambiguity checks when no canonical ID is present.
- Preserve sender, timestamp, item, control-character, length, and delivery-key validation boundaries.

### Release boundary

- This patch addresses the production-observed case where real WeChat updates were received but failed during inbound normalization before the reply path.
- The candidate must pass the complete local quality gate, immutable release verification, fresh 25/25 production preflight, controlled cutover, HTTPS smoke, and a real `/clear` round trip before production status is updated.
- No sender ID, password, token, cookie, private key, database content, or business message is recorded in Git or release evidence.

## [0.5.4] - 2026-08-16

### Production configuration compatibility

- Allow an intentionally unbound production WeChat installation to start with an empty `WEIXIN_ALLOWED_SENDER_IDS` list.
- Keep the event boundary fail-closed: every inbound sender is rejected until a real sender ID is configured.
- Preserve the v0.5.3 tag and publish this behavior as a separate hotfix release after the full release gates pass.

### Release boundary

- This patch supersedes the v0.5.3 deployment attempt. It was published as `v0.5.4`, passed the fresh backup, 25/25 preflight, controlled cutover, 25/25 HTTPS smoke, and cleanup gates, and is now the production baseline.
- Real WeChat sender binding remains intentionally absent; the empty allowlist keeps inbound messages fail-closed until a sender is explicitly configured.

## [0.5.3] - 2026-08-16

### WeChat confirmation closure

- Complete the private-chat confirmation boundary for assistant writes: confirmations are scoped to the persisted plan, owner, sender, channel, and conversation; the user replies with exactly six ASCII digits, while exact `取消` and `重发确认码` commands cancel or rotate a code.
- Show each confirmation code once, persist only its HMAC, lock actions after five incorrect attempts, and retain one-time execution leases and durable tool-run identities for replay and crash recovery.
- Bind delivery identity to the reviewed vendored `weixin-agent-sdk` metadata and the machine token; production remains private-chat only and rejects group traffic. Token rotation must drain and seal the old cursor before enabling the new token.

### Capability metadata and project analysis

- Add a pure, descriptive capability catalog exposing readiness, tool/API mappings, dependencies, integration points, confirmation level, and source references without changing executable agent or router ownership.
- Add bounded, deterministic project-analysis helpers that distinguish open/closed actions and risks, preserve source references, and return safe summaries for assistant-facing analysis.

### QA and release-boundary hardening

- Harden browser/integration QA process ownership and cleanup with bounded waits, verified child identities, explicit already-closed terminal states, and fail-closed cleanup reporting.
- Keep release and secret-scan fixtures portable on macOS and scoped to their intended synthetic cases; historical facts remain unchanged.

### Release boundary

- This entry describes a local v0.5.3 code candidate. It is not a GitHub Release, tag, cloud upload, production cutover, or real-device acceptance result.
- Production facts remain those documented in the existing deployment evidence; production is unchanged until a separately authorized release and fresh deployment evidence are complete.

## [0.5.2] - 2026-08-09

### Pre-cutover release compatibility

- Allow the pre-cutover validator to inspect the existing v0.4.4 schema-3 current release whose manifest predates `ASSISTANT_CONFIRMATION_SECRET`.
- Keep the relaxed environment-name set bound to the canonical `current` release only; every candidate immutable release still requires the complete current manifest contract.
- Verify the legacy tree with the normal schema-3 archive, dependency, source, migration, and ownership hashes; no release-integrity gate is relaxed.

### Release boundary

- This patch supersedes the unpublished v0.5.1 candidate for deployment. Production remains unchanged until a fresh backup, migration rehearsal, 25/25 preflight, controlled cutover, HTTPS smoke, and browser/WeChat acceptance pass.
- No token, password, private key, cookie, model response, database content, or business attachment is recorded in Git or chat.

## [0.5.1] - 2026-08-09

### Production cutover contract

- Align the guarded cutover validator with the v0.5.0 preflight contract by requiring and validating the independent `env.assistantSecrets` check.
- Raise the exact preflight gate from `24/24` to `25/25`; a report that omits the machine/confirmation-secret gate is rejected before any service mutation.
- Add regression coverage proving a valid 25-check report is accepted and stale, incomplete, or incorrectly bound reports remain fail-closed.

### Release boundary

- This patch is a new immutable release candidate. Production remains unchanged until a fresh backup, migration rehearsal, 25/25 preflight, controlled cutover, HTTPS smoke, and real browser/WeChat acceptance are complete.
- No token, password, private key, cookie, model response, database content, or business attachment is recorded in Git or chat.

## [0.5.0] - 2026-08-09

### Persistent Clawbot assistant runtime

- Upgrade the WeChat Clawbot path to a SQLite-backed assistant runtime with durable conversations, drafts, pending confirmations, tool-run replay, and the first-slice visit, customer-search, sales-report, reimbursement, payment-proof, and invoice agents.
- Keep model routing deterministic and server-owned: the model can select only an allowlisted tool and validated arguments; unknown, transport, shell, database, and unsupported write paths fail closed.
- Preserve the existing natural-week personal reimbursement workflow and lossless original PDF/image storage. Company over-limit rules and automatic financial writeback remain outside this version.

### Security and recovery hardening

- Bind a confirmation to its persisted plan, owner, channel, and conversation; confirmation text cannot replace the stored tool or arguments.
- Add one-time execution leases, stable action-scoped tool-run identities, crash-window idempotency, expired-lease takeover, and confirmation-code rotation. Only hashes are persisted.
- Add owner isolation for quick records and assistant read queries, with a forward-only migration and a safe `legacy` fallback for unverifiable historical rows.
- Require independent high-entropy production secrets for the WeChat machine boundary and assistant confirmations, and require HTTPS for non-loopback remote Clawbot backends.

### Release boundary

- This entry describes the v0.5.0 code candidate on the GitHub development branch. Production remains on v0.4.4 until a separately authorized backup, migration rehearsal, preflight, atomic cutover, and real WeChat/browser acceptance are completed.
- No token, password, private key, cookie, model response, database content, or business attachment is recorded in Git or chat.

## [0.4.4] - 2026-08-08

### Sales decision reasoning budget

- Raise the DeepSeek sales-decision completion budget from `6400` to `12000` tokens so reasoning-capable responses retain enough budget for the required `sales-decision-v1` JSON body.
- Preserve the existing two-minute minimum model timeout, evidence guardrails, deterministic fallback, API contract, database schema, dependency set, and human-confirmed writeback boundary.
- Record the production diagnosis without model content or credentials: the v0.4.3 smoke context intermittently returned HTTP 200 with empty `message.content`; a controlled `3000`-token run ended with `finish_reason=length`, while the same context completed at `6946` tokens under a `12000` limit.
- Require a new immutable v0.4.4 release and fresh production evidence; the deployed v0.4.3 tree and its reports remain preserved and must not be edited in place.

### Production closeout

- Published from merged `main` as `v0.4.4` and deployed to a new immutable release; the controlled cutover, post-cutover `24/24` preflight, fresh HTTPS `25/25` smoke (`cleanup=clean`) and real Chrome desktop/mobile acceptance are recorded in `docs/部署记录.md`.

## [0.4.3] - 2026-08-08

### CentOS 7 cutover compatibility

- Read each project unit through one complete `systemctl show <service>` snapshot before extracting the allowlisted properties, avoiding CentOS 7 failures on single-property selectors for newer systemd fields.
- Treat an absent `DynamicUser` field on systemd 219 as unsupported and therefore disabled, while continuing to reject `DynamicUser=yes` or any unknown value.
- Continue accepting the legacy singular `EnvironmentFile=` output key while rejecting missing, duplicate, or additional environment bindings.
- Preserve every v0.4.2 release-integrity, immutable-ownership, database, service-scope, rollback, and protected-service gate; this patch does not change business APIs, database migrations, or user-facing workflows.
- Require a new immutable v0.4.3 release and fresh production evidence; the staged v0.4.2 candidate and its preflight evidence are not reusable.

## [0.4.2] - 2026-08-08

### Production preflight hardening

- Require the frontend systemd unit to use exactly `/opt/sentelligent-sales-workbench/config/frontend.env`; suffix-matching paths outside the project configuration root are rejected.
- Require schema-2 current releases to remain an exact SHA-256-bound archive inventory; unverified deployment-installed dependencies are rejected.
- Require both legacy and current releases to be `root:root` immutable trees, reject candidates that were not frozen before hash verification, and document root-owned extraction so the runtime identity cannot replace files between verification and cutover.
- Add regression fixtures for both boundary cases and refresh release-facing documentation before the guarded production cutover.

## [0.4.1] - 2026-08-08

### Production hardening

- Corrected the production service-surface contract to accept the existing `PrivateTmp=true` hardening, the isolated public `frontend.env`, and the fixed non-secret WeChat `HOME` assignment.
- Added CentOS 7 compatibility for the singular `EnvironmentFile=` key emitted by `systemctl show`, while requiring one exact environment file per service.
- Kept backend/weixin environment binding strict and continued rejecting backend credentials from the frontend or unexpected systemd execution surfaces.
- Added regression coverage for the real CentOS 7 unit contract before the patch release.

## [0.4.0] - 2026-08-08

### 新增

- 新增个人差旅报销模块：按自然周管理七类费用、多笔实际付款、提前请款、多退少补、付款凭证、发票仓库、人工匹配、无票确认和报销整理。
- 新增实际付款记录 A4 主表/凭证附页，以及每页固定四槽的发票合并打印；认证 PDF 使用 PDF.js 逐页渲染 Canvas，全部页面就绪后才能打印。
- 新增 iCost 只写文本 Webhook 与统一快捷指令交付物；先完成 iCost 记账，再按账本名精确分流，“出差报销”只写森特智行，未知账本不进入本系统。
- 新增微信付款凭证和发票图片/PDF写入能力、OCR/PDF文本提取、DeepSeek结构化分析、冲突复核与精确验收数据清理工具。

### 数据与安全

- 新增迁移 `0007`至 `0010`，将费用、付款、请款、iCost ingestion、发票、匹配候选、无票确认和幂等处理租约持久化；迁移保持向前兼容。
- 图片和 PDF 保留原始字节；仅在 Brotli 严格缩小时无损压缩，同账号按原始 SHA-256 内容寻址去重，读取时校验长度与摘要。完整 OCR/PDF 文本继续保留用于人工复核，但模型请求副本统一限制为最多 200,000 个字符。
- 付款凭证、微信待处理原件和发票原件使用 `Cache-Control: no-store`，退出或切换账号后不复用浏览器缓存。
- iCost 使用独立 URL、Bearer Token、owner、限流、幂等与审计，只允许 `POST /api/integrations/icost/expenses`，不复用登录、模型或微信凭据。
- 生产预检扩展为 `24/24`，增加正式 DeepSeek 模式/端点/模型/独立密钥、iCost 配置隔离、发票提取配置、主机身份，以及 `DATABASE_URL`/数据库/backend-weixin `EnvironmentFile` 路径及 SHA-256 绑定。

### 发布要求

- 正式发布必须重新通过后端、前端、发布脚本、Chromium、WebKit、完整 Git 历史秘密扫描和 `git diff --check`。
- 发布包仅接受明确允许的前端公开资产、构建资产、品牌资产和无密钥 unsigned 快捷指令；业务图片、PDF、Office 文件和设计工作参考不进入归档。
- 生产只重启 backend、frontend、weixin-agent；共享 Caddy、轻氧、account-vault、Mihomo 和 `127.0.0.1:8797` 保持不变。
- cutover 必须先验证 15 分钟内生成、权限为 `0600`、SHA-256 一致且绑定当前主机/数据库/release 的 `24/24` 预检报告，否则不得冻结 release 或修改服务。
- 上线完成以 GitHub Release、不可变归档、`24/24` 预检、`25/25` HTTPS 冒烟、浏览器验收和 iCost 测试数据精确清理为准。

## [0.3.6] - 2026-08-03

### List actions and itinerary date polish

- 将客户、商机、知识和行程的新增操作收回对应内容卡片标题区，减少页面顶部空白并保持操作与列表上下文相邻。
- 优化行程日期卡片，按“月 / 日 / 星期”展示并使用本地日期字段，避免时区转换造成日期偏移。
- 增加列表操作区静态契约、日期格式模型测试，以及桌面和移动端 WebKit 布局验收；无 API、数据库结构或生产配置变更。

## [0.3.5] - 2026-08-01

### Sales decision writeback-preview hotfix

- 保持销售决策核心契约严格校验，仅在进入契约前清洗四个可选的人工确认写回预览数组：保留合法非空字符串，丢弃模型偶发输出的对象、空值和占位项。
- 明确提示词中 `writebackPreview` 四个数组的字符串约束，并始终强制 `requiresHumanConfirmation=true`；不改变决策、评分、合规、数据库或 API 边界。
- 生产诊断证据：DeepSeek HTTP 200、`finish_reason=stop`、内容 5711 字符，原降级原因为 `writebackPreview.customerFields[0]` 非字符串，而非 token 或超时。

## [0.3.4] - 2026-08-01

### Sales decision long-tail hotfix

- 将销售决策模型调用的最短超时从 `60s` 提高到 `120s`，并将生产 HTTPS 冒烟中该单项请求超时提高到 `180s`，覆盖推理型模型在完整业务上下文下的长尾响应。
- 保留 `v0.3.3` 的 6400 completion token 预算；快速记录继续使用生产显式配置的 `60s`，其他模型任务不变。
- 无 API、数据库、认证或写回确认边界变更；仍以生产 `19/19`、`25/25`、清理 `clean` 和 10 类残留为 0 作为验收门禁。

## [0.3.3] - 2026-08-01

### Sales decision token-budget hotfix

- 将销售决策 DeepSeek 请求的 completion token 预算从 `3200` 提高到 `6400`；生产无写入诊断证明 `3200` 会出现 HTTP 200、`finish_reason=length` 且最终内容为空，`6400` 可返回完整 `sales-decision-v1` JSON。
- 增加真实请求体预算回归测试；保留 `v0.3.2` 的销售决策 60 秒最短超时，不修改快速记录、其他模型任务、API、数据库、认证或写回确认边界。
- 正式验收仍要求生产预检 `19/19`、HTTPS 冒烟 `25/25`、清理 `clean` 且 10 类残留为 0。

## [0.3.2] - 2026-08-01

### Sales decision timeout hotfix

- 将销售决策 DeepSeek 请求的最短超时从共享默认值 `30s` 提高到 `60s`，为更大的 `sales-decision-v1` 结构化响应保留合理余量；更大的显式模型超时仍保持有效。
- 增加超时下限回归测试；不修改快速记录、其他模型任务、API、数据库结构、认证或生产配置。
- 修复候选必须重新通过全量测试、生产 `19/19` 预检和 `25/25` HTTPS 冒烟，失败冒烟产生的数据必须保持物理清理为 `clean`。

## [0.3.1] - 2026-08-01

### UI polish

- 去除总览、快速记录及各业务列表页重复的大标题；列表页仅保留新增操作，客户、商机、动作、风险、知识库和行程的详情/编辑页继续显示紧凑上下文标题。
- 将快速记录重排为“左侧录入、右侧分析、下方历史记录”的双栏工作区，增加顶部强调线、编号流程步骤和更清晰的录入空间；平板与手机自动切换为录入、分析、历史的单列顺序。
- 保留既有 `data-testid`、交互、API 和业务文案契约；无数据库迁移、无依赖升级、无生产配置变更。
- 发布候选已通过前端生产构建、169 项前端测试、Chrome 7 视口集成和 WebKit 26.5 双移动视口验收；正式部署仍须重新通过 GitHub Release 工作流、生产 `19/19` 预检和 `25/25` HTTPS 冒烟。

## [0.3.0] - 2026-08-01

### UI redesign candidate

- 整体视觉升级：品牌主色 `#007aff` 调整为 `#2f6bff`，语义色加深（绿 `#16a34a`、橙 `#d97706`、红 `#dc2626`），去除大窗框圆角改全出血布局。
- 侧栏改为藏青深色渐变并新增「AI 同步引擎」状态卡；登录页改为左侧深蓝品牌区、右侧表单的分栏布局。
- KPI 卡片增加彩色图标芯片（lucide 图标），卡片改白底发丝边框，表格数字使用 `tnum` 等宽数字。
- 无数据库迁移、无 API 变更、无依赖升级；为纯样式与少量 JSX 结构变更，必须重新通过生产 `19/19` 预检和 `25/25` HTTPS 冒烟。

## [0.2.5] - 2026-07-29

### Hotfix candidate

- 将快速记录 DeepSeek 请求的 completion token 预算从 1200 调整为 3200，避免推理型模型在生成最终 JSON 前因 `finish_reason: length` 截断并静默降级。
- 增加请求预算回归测试；不修改数据库、认证、部署配置或其他模型任务的 token 预算。
- 生产发布门禁仍要求预检 `19/19`、HTTPS 冒烟 `25/25` 且物理清理为 `clean`。

## [0.2.4] - 2026-07-29

### Hotfix candidate

- 完整收口销售决策阶段边界：`stage.current` 始终来自服务端事实；`stage.recommended` 仅接受 `sales-decision-v1` 规范枚举，未知值保守回落到 current。
- 修复 `v0.2.3` 生产冒烟仍出现的 `stage.recommended` 非规范业务阶段导致 DeepSeek 分析整体降级问题。
- 无数据库迁移、无依赖升级、无认证或部署配置变更；必须重新通过生产 `19/19` 预检和 `25/25` HTTPS 冒烟。

## [0.2.3] - 2026-07-29

### Hotfix candidate

- 修复销售决策模型边界：`stage.current` 由服务端根据已存商机阶段推导，不再接受模型回显的业务阶段名，避免合法 DeepSeek 结果被误判后静默降级。
- 修复 CentOS awk 兼容性：停服后的 8088/8897 监听检查不再使用保留函数名 `index` 作为变量，恢复项目端口关闭门禁。
- 保持 `stage.recommended`、写回确认、合规门禁及其余 `sales-decision-v1` 字段的严格校验；不包含数据库迁移或依赖升级。
- 发布门禁要求重新取得生产预检 `19/19`、HTTPS 冒烟 `25/25` 且物理清理为 `clean`，不得复用 `v0.2.2` 的失败报告。

当前工作树的目标版本为 `v0.2.3`。`v0.2.2` 已合并、发布并部署到 immutable release，但生产 HTTPS 冒烟发现销售决策模型阶段回显会触发静默降级；本分支仅记录尚未冻结的 hotfix 候选，`v0.2.3` tag、GitHub Release 和生产部署尚未创建。

### 候选改动

- 快速记录从总览、侧栏和子页面重新打开时统一回到语音模式；移动端导航收窄，输入控件采用适合 Safari 的触摸尺寸和字号。
- 客户详情改为只读展示，修改、取消和删除分别走显式操作；删除增加可访问确认对话框、取消、Escape、忙碌和错误状态。
- 增加 Playwright WebKit 验收、静态服务安全响应头、生产 HTTPS 冒烟清理、数据库身份绑定和不可变 release 预检收紧。
- CI 和 Release workflow 增加浏览器集成门禁、同标签并发控制以及发布前远端标签复核。

### 当前验证边界

- 最终候选工作树已通过根目录测试 `139/139`、后端测试 `286/286`、前端生产构建与全部本地检查、Chrome 7 视口集成和 WebKit 26.5 的 `390x844`/`360x800` Safari 等价验收。
- 当前树扫描 216 个文件、完整历史扫描 508 个对象和 70 条消息均无凭据发现，`git diff --check` 通过；这些仍是本地候选证据，不替代 PR CI、Release workflow 或生产验收。

### 尚未完成

- 完成最终代码审查、版本一致性复核、发布包校验和 GitHub 合并流程。
- 在新的 immutable release 部署后，才可以执行生产预检、HTTPS 冒烟和四视口浏览器验收。
- 音频资产闭环、微信事件幂等与恢复、销售决策 Agent V1 的 DeepSeek 接入计划和真实案例校准仍属于后续工作。

## [0.2.1] - 2026-07-29T03:29:14+08:00

### 状态判定

- `v0.2.1` 已合并到 `main`，生产提交为 `f8d43bbfd6172828340a270c5276485192223a65`。
- annotated tag `v0.2.1` 于 `2026-07-29T03:27:14+08:00` 创建，GitHub Release 于 `2026-07-29T03:29:14+08:00` 发布。
- Release 归档 `sentelligent-sales-workbench-v0.2.1.tar.gz` 的 SHA-256 为 `fbcd705dd28257faec3139f31837bb8562e6f7405b770c402d83c8746789a815`；资产清单和完整证据见 [GitHub Release](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.1)。
- `v0.2.1` 是当前生产基线，release 目录为 `/opt/sentelligent-sales-workbench/releases/2026-07-29_f8d43bb`；部署记录不包含凭据或客户数据。
- annotated tag `v0.2.0` 已固定指向提交 `591e48d464341d1df95f541d84790e7452341d5d`，不得删除、移动或复用。
- `v0.2.0` 的 Release workflow run `30389038587` 在 `Verify release tooling and source boundaries` 阶段失败，因此没有创建 `v0.2.0` GitHub Release，也没有发布对应资产。

### 修复

- 跨宿主识别 Windows 绝对路径：在 Linux/WSL 上遇到 `C:/...` 时使用 `path.win32` 判断、规范化和拼接，避免被错误解析为当前工作目录下的 `C:/...` 相对路径。
- 对无法可靠映射到 WSL 的 UNC 网络共享和 Windows 根相对工作区路径失败关闭，提示改用盘符或已挂载的 POSIX 路径。
- 将上述规则统一用于本地开发、WSL 后端和 WSL 全栈配置入口，覆盖发布流程暴露出的 6 项跨平台回归。
- 收紧 CI 门禁：PR CI 与标签 Release workflow 使用同一组根脚本测试 `node --test scripts/*.test.mjs`，使 Linux runner 在合并前执行完整的发布工具与源码边界检查。
- 将共享凭据扫描命令显式固定为 `--history`，防止默认值变化造成 PR CI 与 Release workflow 的扫描范围漂移。

### 发布要求

- `v0.2.1` 的发布事实以 GitHub Release、标签提交和资产摘要为准；生产基线以 [部署记录](docs/部署记录.md) 为准。
- 后续版本必须使用新的 annotated tag，不得移动、删除或复用已有发布标签。
- `v0.2.2` 的测试、发布包、部署和线上验收不得借用本条目的 `v0.2.1` 证据。

## [0.2.0] - 2026-07-29T02:36:24.435+08:00

### 状态判定

- 当前仓库代码版本已冻结为 `0.2.0`。
- 是否已经正式发布或部署，分别以 GitHub Release 和 [部署记录](docs/部署记录.md) 为准；本条目不预填尚未发生的结果。

### 新增

- 增加 GitHub 标签发布 workflow。`v*` 标签会校验包版本，使用 Node.js 24 重跑发布、后端和前端质量门。
- 标签发布生成不可变源码包、`release-result.json` 和 `SHA256SUMS`，同时上传 Actions artifact 并创建 GitHub Release。
- 增加项目架构与模块说明、多设备开发手册、发布回滚手册、部署记录和独立版本说明。
- 增加统一 `VERSION`，并统一根项目、后端和前端包版本。

### 更新

- README 区分当前代码版本、内容冻结时已验证的生产基线，以及正式发布和生产部署证据。
- 路线图、开发日志和验收材料改用可核验状态，区分代码实现、生产部署、线上验收和后续限制。
- 正式规定 systemd 的三个项目单元直接固定到不可变 release 真实路径；`current` 不作为 Node ESM 服务入口或回滚完成依据。
- 正式规定生产直接使用 GitHub Release 归档内已验证的前端 `dist`，服务器不重新构建前端。
- 发布包秘密门禁识别受限的 GitHub Actions 上下文引用，同时拒绝普通配置和无插值 JavaScript 模板字符串中的真实敏感赋值。
- GitHub Release 拆分为只读验证 job 和独立写权限发布 job；验证 checkout 不持久化仓库凭据。
- 凭据门禁覆盖当前树、全部 refs 的历史 blob、commit、annotated tag 和 Git notes 消息，并分批读取历史内容。
- PR CI 使用完整 Git 历史运行强制凭据扫描，避免浅克隆在安全门禁阶段失败关闭。
- 浏览器视觉 QA 为 CDP 与 HTTP server 设置期限，在 POSIX 上终止并验证独立进程组，在 Windows 上验证 `taskkill` 结果，并保证多项清理互不跳过。
- 发布包以完整 commit 作为稳定身份，同一提交在命名分支和 detached HEAD 下生成字节一致的归档。
- 生产预检增加 `release.identity`，强制三个项目服务使用项目 Node 24，并把 `ExecStart`、`WorkingDirectory`、manifest 和完整 commit 绑定到同一 immutable release。

### 验证基线

- 根发布与安全测试：`78/78`。
- 后端测试：`267/267`；前端构建、`qa:local` 和 `qa:integration` 均通过。
- 内容冻结时的已验证生产基线 `v0.1.0`：公开 HTTPS 冒烟 `25/25`，生产预检 `18/18`。
- `360x800` 与 `1920x1080` 文档宽度等于视口宽度，无页面级横向溢出；Chrome 控制台无业务 `error` 或 `warn`。

### 已知限制

- 手机模块导航的横向滚动条仍较显眼。
- 根 HTML 目前缺少 API 已具备的 HSTS/CSP 响应头；后续应由前端静态服务增加，不能贸然修改共享 Caddy。

## [0.1.0] - 2026-07-28T22:30:21+08:00

### 正式生产基线

- 部署提交 `f89e1e79f57ccfa95def5fb402dc27ebfec446b4`。
- 发布目录 `/opt/sentelligent-sales-workbench/releases/2026-07-28_f89e1e7`。
- 后端、前端和微信 worker 使用项目独立 Node.js 24，均设置为 systemd 开机启动。
- 共享 Caddy 保持原配置和进程；account-vault、Qingyang 与 Mihomo 服务未重启。

### 业务能力

- Apple Design 风格一的 PC 与移动端工作台。
- 客户、商机、行动、风险、知识、周报和管理总览使用后端真实数据。
- 快速记录默认语音模式，AI 分析持久化后可人工修改，历史读取不重复调用模型。
- 智能拜访行程和高德路线已上线；销售决策 Agent V1 规则规格已完成，但完整规格尚未接入 DeepSeek 运行时，不按已上线功能统计。
- Cookie 登录、七天会话、CSRF、Origin、乐观锁、软删除、审计和一致性备份已启用。
- 微信机器人绑定入口和 worker 已部署。

### 生产验收

- DeepSeek 快速记录预览和持久化分析链路可返回 `source=deepseek`；这不代表销售决策 Agent V1 规则规格已经接入。
- 高德路线验收返回约 `379076m`，路线和优化结果可持久化读取。
- 登录、CORS、CSRF、CRUD、审计、周报、微信状态、软删除和乐观锁均通过公开 HTTPS 冒烟。

## [0.1.0-baseline] - 2026-07-15T00:00:00+08:00

- 建立首个可测试项目基线。
- 确认 Apple Design 风格一。
- 完成第一阶段安全、数据、备份和认证设计。

[Unreleased]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.7...HEAD
[0.6.1]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.7...HEAD
[0.5.7]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.5.1...v0.5.2
[0.5.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.4.4
[0.4.3]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.4.3
[0.4.2]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.4.2
[0.4.1]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.4.1
[0.4.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.4.0
[0.3.6]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.3.6
[0.3.5]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.3.5
[0.3.4]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.3.4
[0.3.3]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.3.3
[0.3.2]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.3.2
[0.3.1]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.3.1
[0.3.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.3.0
[0.2.5]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.5
[0.2.4]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.4
[0.2.3]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.3
[0.2.1]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.1
[0.2.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.0
[0.1.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0
[0.1.0-baseline]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0-baseline
