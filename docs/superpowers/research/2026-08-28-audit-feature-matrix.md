# 森特智行销售工作台 v0.8.3 逐功能实测审计矩阵（2026-08-28）

## 审计环境与方法

- 代码来源：`git archive v0.8.3` 导出到 `/tmp/audit-stack`，与生产完全隔离；数据库 `/tmp/audit-stack.sqlite`（种子合成数据），全程只用合成数据。
- 后端 `127.0.0.1:18901`（`AI_ANALYSIS_MODE=mock`、`SOLUTION_WRITES_ENABLED=false`、`NODE_ENV=test`）；前端 Vite dev `127.0.0.1:18902`；微信链路直打 `POST /api/integrations/weixin-agent/events`（Bearer 机器令牌 + Idempotency-Key=sourceMessageId）。
- **方法降级声明**：Cursor IDE 浏览器在本会话不可用（标签页创建后立即被回收，8 次尝试均失败，属 IDE 环境故障而非被测系统问题）。A 组因此降级为「前端资产可达性 + 驱动 UI 的同源 HTTP API 全链实测」，纯视觉/交互行为（拖拽动画、打印排版、弹窗轮询表现等）改由源码断言与项目自动化测试佐证，并全部列入盲区清单。
- 佐证测试实跑：后端全量 **1276/1276 通过**；前端 `module-coverage` 8/8、`trip-region-settings-browser`（WebKit 真浏览器）1/1、settings/quickRecordModel 等通过；`HospitalTenderPage.test.mjs` 1 项失败（见 D5）。

## A. Web 功能面（14 项）

| # | 功能 | 操作步骤（实测） | 预期 | 实测 | 判定 | 备注 |
|---|------|------|------|------|------|------|
| A1 | 登录与登出 | 错密码登录→正确登录→查会话→无 CSRF 登出→带 CSRF 登出→再查会话 | 错密码拒绝；登录发 cookie+csrfToken；登出后会话失效 | 401 INVALID_CREDENTIALS / 200+csrfToken / 200 / 403 CSRF_INVALID / 204 / 401 | ✅ | 写操作强制 X-CSRF-Token，安全加分 |
| A2 | 战情总览三卡与钻取 | GET /api/dashboard/summary + 钻取源列表（商机/风险/快速记录/待办） | 指标与钻取列表口径一致 | metrics（快速记录 0 待确认/商机 2/预测 3000 万/风险 1）与列表逐一吻合，priorityActions 含 tone/due | ✅ | 卡片点击跳转视觉未验（盲区） |
| A3 | 快速记录建/分析/确认/历史 | POST preview（mock 分析）→ POST 落库 → GET 历史 | 分析识别客户；确认 201；历史可见 | 识别「日照中医医院」置信 88（source=mock）；201 落库；历史 1 条挂 rizhao | ✅ | mock 关键词命中逻辑正确 |
| A4 | 客户 CRUD+详情 | POST→GET 详情→PATCH（If-Match）→DELETE→再 GET | 全链可用，乐观锁生效 | 201 / 详情 v1 / If-Match:"1" 改 200 / 删 200 / 404 | ✅ | If-Match 必须带引号（ETag 风格），无引号 428 |
| A5 | 商机看板拖拽与列表 | GET 列表 → PATCH stage（拖拽等价操作）→ 拖回 | 阶段变更持久化、版本递增 | 方案输出→商务谈判→方案输出，version 1→2→3 | ✅ | 拖拽手势视觉未验（盲区）；数据链完整 |
| A6 | 待办四态流转 | PATCH status 依次 pending→in_progress→done；deferred→pending | 四态可达可逆 | a1: in_progress→done→pending；a2: deferred→pending，均 200+版本递增 | ✅ | 枚举 pending/in_progress/done/deferred |
| A7 | 风险 | GET /api/risks | 种子风险完整呈现 | 3 条，字段含 score/severity/evidence/action/due | ✅ | |
| A8 | 行程建/详情/记当日费用联动 | POST /api/itineraries（缺字段→补齐字段两轮） | 建行程成功并联动费用 | 缺字段 422 字段级报错清晰；补齐后 **503 AMAP_NOT_CONFIGURED** — 行程规划强依赖高德 Web 服务，无 mock 通道，隔离栈无法建行程；详情 404 语义正常 | ⚠️ | 受控降级非崩溃；「记当日费用联动」连带不可测（盲区）。建议为行程规划增加 mock/直通模式 |
| A9 | 差旅全链 | 建费用→传凭证→下载凭证→传发票→无票确认→区域画像读写→预支请款→工作台 | 全链 201/200，数据联动 | 费用 201；凭证附件 201+content URL 下载 200(image/png)；发票 201 进入识别评审；无票确认 201 带金额快照；区域画像 PUT（cities/defaultCity/dateOverrides）200 且触发 draftRefresh；预支 201；工作台聚合 7 键齐全 | ✅ | 打印预览/XLSX 为前端渲染（盲区），其数据源工作台 API 已验；附件魔数校验（base64 类型必须匹配 mediaType） |
| A10 | 周报生成/保存 | POST draft（缺参→补参）→PATCH 保存→GET 读回 | 草稿生成、保存流转 | 缺参 422 明确；补 owner/period 后 201 生成结构化草稿；PATCH content+status=saved 200 v2；读回一致 | ✅ | |
| A11 | 知识库检索/建条目 | POST search→POST 新条目→再检索 | 建后立即可检索 | 检索「双活」命中 2 条；201 建条目；「验收清单」命中新条目 | ✅ | |
| A12 | 招标页过滤 | GET /api/hospital-tenders 带 q/city/noticeType/relevance；GET summary/health | 过滤参数生效 | 合法参数 200（隔离环境无公告数据，空列表+total/hasMore 正确）；**未知参数（region=）400 严格拒绝**；summary/health 200 | ✅ | 严格查询参数白名单，安全加分；真实公告过滤效果因无源数据未验（盲区） |
| A13 | 系统配置各子页 | 安全设置/DeepSeek 密钥/PushPlus/记账日志源/提醒/晨报/招标调度 | 各子页数据源可达 | settings/security 200；密钥写读见 C6；`/api/audit-logs?scope=bookkeeping` 200（前端每 10s 轮询此源）；reminders/digest/scheduler status 均 200 | ✅ | |
| A14 | PWA manifest 可达 | GET / 与 /sentelligent.webmanifest | manifest 可达且字段完整 | 200，name/short_name/start_url(./overview)/display=standalone/192+512 图标齐全 | ✅ | |

## B. 微信意图面（15 项，HTTP events 实测）

| # | 意图/语式 | 操作步骤（实测语料） | 预期 | 实测 | 判定 | 备注 |
|---|------|------|------|------|------|------|
| B1 | 帮助 | 「帮助」 | 能力清单 | status=help，完整能力清单文案 | ✅ | |
| B2 | 战情总览 | 「战情总览」 | 总览卡片 | 卡片可达（toolName=dashboard.summary），但客户/商机/待办/风险计数均 0，仅差旅 1 笔 | ⚠️ | 根因：businessOwnerResolver 精确闭合匹配，配方 `WEIXIN_AGENT_OWNER=jiangjz` 与种子数据 owner=继振 不一致 → 业务读全被过滤。语义为设计使然（封闭映射防越权），但配方/种子口径需对齐 |
| B3 | 记账文字（支出→草稿→clarify） | 「支出 打车…86.5元 微信支付」→ 空发「确认」 | 生成待确认草稿；无引用确认给 clarify | ok（收到并逐笔发送待确认信息）；工作台 bookkeepingReviews=1、审计日志 receive+review_required；空发「确认」→ clarify「最新记账草稿尚未确认送达…」 | ✅ | 引用确认场景按审计任务书跳过，以 clarify 语义验证替代 |
| B4 | 客户查建改删（六位码全链） | 新建→回码→查询→更新→回码→删除→回码→删后查询 | 每次写操作六位码确认 | 建档卡+码→已建档；查询命中；更新卡+码→级别 观察→重点推进；删除卡+码→已归档；删后查询未找到 | ⚠️ | **意图遮蔽**：「修改客户 …」被记账会话 `^(?:确认\|修改\|取消)` 前缀拦截（shortcutBookkeepingRuntime.commandTargetsShortcut），返回记账字段修改提示；「更新客户/改档/把X的…改成…」可正常走客户改档 |
| B5 | 记一下拜访（轻确认全链） | 「记一下：…拜访黄岛区中医院…」→「确认」 | 预览卡→轻确认落库 | confirmation_required 预览卡（时间/诉求/风险/建议）→ ok 已录入（编号 …902489） | ✅ | 轻确认「确认」被正确路由到拜访（pendingActionId 优先），未遭记账拦截 |
| B6 | 查记录 | 「查最近黄岛的拜访记录」 | 范围+主体检索 | ok visit-capture.search，范围 08-15~08-28·黄岛，命中 1 条 | ✅ | |
| B7 | 改记录 | 「把最近的记录的风险改成 …」→回码 | 六位码确认后更新 | 修改预览卡（原文+字段 diff）+码 → 已更新 | ✅ | |
| B8 | 作废记录 | 「作废最近的记录」→回码 | 六位码确认后作废 | 作废预览卡+码 → 已作废 | ✅ | |
| B9 | 待办建/查/完成/推迟/删除 | 「提醒我周五前给王工送…紧急」→确认；「下周有哪些待办」；「把待办 X 推迟到下周三」→确认；「完成待办 X」→确认；「删除待办 X」→回码 | 建查改删全链 | 建卡（提醒 09-04 周五 09:00、优先级高）→已创建；下周清单 1 条；推迟→09-02 周三；完成→已完成；删除走六位码→已删除（软删除说明） | ✅ | 周五当天说「周五前」解析为下周五，语义可再商榷（备注级） |
| B10 | 商机查改建删+阶段联动 | 列表/详情/新建（客户核验）→回码/推进阶段→确认/非法阶段/改金额→回码/删除→回码 | 全链+阶段联动检查 | 建档卡（客户已核验）→已建档；推进 调研机会→方案交流 确认后**自动运行销售决策阶段升级检查**（判断 nurture 置信 62、门槛缺口列举）；「太空阶段」给出未知阶段显式警示（新增列+不触发检查）；改金额 500万→600万；删除卡列关联引用计数→已归档 | ✅ | 种子商机读不到同 B2 根因（owner 过滤）；写链闭环全部验证 |
| B11 | 晨报 dryRun 端点 | POST /api/digest/run?kind=daily&dryRun=1、kind=friday | 预览渲染不落库 | daily→dryRun:true status=empty（当日无素材，合理）；friday→rendered，含周报+凭证发票两节完整文案 | ✅ | 用户会话+CSRF 鉴权；dryRun 不触发 outbox/幂等标记（源码确认） |
| B12 | 招标摘要 | 「招标摘要」「查一下医院招标」 | 摘要卡片 | 均 unknown「暂时无法识别」 | ❌ | v0.8.3 路由器无招标意图注册（帮助文案亦未宣称）；招标仅有 Web API 与主动推送通道。与审计清单预期不符 |
| B13 | 销售周报 | 「销售周报」 | 周报预览 | ok sales-report.preview，含周期/记录统计/结构化草稿 | ✅ | |
| B14 | 知识检索 | 「知识检索 双活」 | 检索结果 | ok，命中「医疗行业双活建设案例」 | ✅ | |
| B15 | 记账/拜访歧义门 | 「记一下 打车 86.5元」 | 歧义澄清 | clarify：更像记账，指引「支出 …」或「记拜访：…」 | ✅ | 歧义门与逃生前缀语义正确 |

## C. 边界与安全抽查（6 项）

| # | 场景 | 操作步骤 | 预期 | 实测 | 判定 | 备注 |
|---|------|------|------|------|------|------|
| C1 | 未认证 401 | 无 cookie 访问 /api/customers；events 无 Bearer/错 token | 401 | 三种场景均 401 UNAUTHORIZED | ✅ | |
| C2 | 群聊 403 | events chatType=group；另测非白名单 senderId | 403 | 403 WEIXIN_GROUP_NOT_ALLOWED；403 WEIXIN_SENDER_NOT_ALLOWED | ✅ | 发送者白名单同样闭合 |
| C3 | 错误六位码锁定 | 建确认卡后连发 5 次错码，再回正确码 | 多次错码后锁定 | 每次错码统一安全文案「确认信息无效或已过期」；第 5 次后 DB 状态 `failed / ASSISTANT_CONFIRMATION_LOCKED / attempts=5`，正确码不再被接受 | ✅ | 阈值 5 次；对外不泄露锁定细节（防枚举） |
| C4 | 版本冲突 409 文案 | PATCH 客户带过期 If-Match:"99" | 409+当前版本 | 409 VERSION_CONFLICT，fields.currentVersion=1 | ✅ | 微信侧亦有「刚在其他端被修改」文案（源码确认） |
| C5 | 非法参数 422 | 差旅费用负金额+非法类别；行程缺字段 | 422 字段级错误 | 422 VALIDATION_ERROR，fields 精确到 `payments[0].amountCents: min`；行程缺字段逐项列出 | ✅ | 报错粒度好，不回显堆栈 |
| C6 | 密钥不回显 | PUT DeepSeek key / PushPlus token 后读安全设置 | 只回掩码 | masked=`sk-a••••••0000` / `audi••••••etic`；响应全文无明文 | ✅ | |

## D. 回归红线（5 项，曾修缺陷不复发）

| # | 缺陷 | 验证方式 | 实测 | 判定 | 备注 |
|---|------|------|------|------|------|
| D1 | 区域弹窗轮询重置草稿 | 实跑守护测试 `scripts/trip-region-settings-browser.test.mjs`（WebKit 真浏览器） | 「keeps the live region draft intact across background workbench polls」1/1 通过 | ✅ | 修复语义：草稿仅在弹窗打开时初始化一次，轮询不打扰 |
| D2 | 记账日志页可达 | API 实测 + settings 守护测试 | `/api/audit-logs?scope=bookkeeping` 200（6 条流水）；「bookkeeping realtime log polls the scoped audit feed read-only」通过 | ✅ | 前端 10s 轮询接线在位 |
| D3 | 语音转写误标 | 源码断言 + quickRecordModel 测试 | pages.jsx 明确「只有真正发生过语音转写时才标记」注释与逻辑在位；测试通过 | ✅ | 真实语音交互未验（盲区） |
| D4 | 总览进入刷新 | 源码 + module-coverage 守护测试实跑 | App.jsx `active===overview` 时静默重拉 summary 在位；module-coverage 8/8 通过 | ✅ | |
| D5 | 招标 select 警告 | 源码断言 + 页面测试实跑 | 兜底在位（filters useState("")、prop 同步 `?? ""`）——警告不复发；**但** `HospitalTenderPage.test.mjs`「customer context」1 项失败：修复把 `customerId` 改为 `customerId ?? ""`，遗留断言 `setCustomerFilter(customerId)`/`useState(customerId)` 正则失配 | ⚠️ | 功能在位、测试过时；且该测试文件未挂入 `qa:local` 门禁，失败长期无人发现（双重问题） |

## 汇总统计

| 判定 | A（14） | B（15） | C（6） | D（5） | 合计（40） |
|------|---------|---------|--------|--------|-----------|
| ✅ | 13 | 12 | 6 | 4 | **35** |
| ⚠️ | 1 | 2 | 0 | 1 | **4** |
| ❌ | 0 | 1 | 0 | 0 | **1** |

佐证自动化：后端全量 1276/1276 ✅；前端守护测试（模块覆盖/区域弹窗 WebKit/设置页/快速记录模型）全过，仅招标页遗留断言 1 失败（即 D5 ⚠️）。

## ❌/⚠️ 根因初判与修复建议

1. **B12 ❌ 招标摘要意图未注册**：`assistant/router.js` 无任何招标语式，帮助文案亦未宣称。初判为「审计清单预期超前于实现」或注册遗漏。建议：在路由器加 `招标摘要/医院招标` 别名 → 复用 `GET /api/hospital-tenders/summary` 数据渲染卡片（只读、无确认成本）；或在审计清单中降级为「计划项」。
2. **B4 ⚠️ 「修改客户」被记账前缀拦截**：`shortcutBookkeepingRuntime.commandTargetsShortcut` 对 `^(确认|修改|取消)` 一刀切拦截，绑定记账的会话里「修改客户/修改商机…」永远进不了路由器。v0.7.x 已修过类似让路缺陷（六位码/普通文本让路），但「修改X」类长句未让路。建议：拦截正则改为「修改 + 记账字段词表」才命中（如 `^修改(?:金额|时间|日期|类别|商户|用途|备注)`），其余「修改…」放行给路由器。
3. **B2 ⚠️ 微信侧业务读计数为 0**：封闭 owner 映射（防越权）+ 种子 owner=继振 与配方 `WEIXIN_AGENT_OWNER=jiangjz` 不一致。建议：审计配方与 seed.js 对齐 owner 口径（seed 增加 `SEED_OWNER` 环境变量或配方改用 owner=继振），避免每轮审计误报。
4. **D5 ⚠️ 招标页遗留测试断言失配且未进门禁**：select 兜底修复（`?? ""`）改变源码模式，`HospitalTenderPage.test.mjs` 的字面正则断言失败；该文件又不在 `qa:local` 链中，失败静默。建议：更新断言为 `setCustomerFilter\(customerId \?\? ""\)`，并把 `test:tender` 挂入 `qa:local`。
5. **A8 ⚠️ 行程创建强依赖高德无 mock**：`buildItineraryPlan` 无 AMAP key 直接 503（受控），但导致行程/费用联动在隔离环境不可审计。建议：仿照 `AI_ANALYSIS_MODE=mock` 增加 `AMAP_MODE=mock`（固定几何/时距桩），打通隔离栈全链审计。

## 测试盲区清单（无自动化守护/本轮未能实测）

1. **浏览器视觉与交互层**（本轮 IDE 浏览器故障，全部未实测）：商机看板拖拽手势、总览卡片点击钻取跳转、差旅打印预览排版、XLSX 导出文件内容、区域弹窗/各抽屉的真实交互、PWA 安装流。仅打印预览/XLSX 有组件级测试，无端到端视觉守护。
2. **行程全链**：建行程→详情→记当日费用联动，无 mock 通道 → 隔离环境永远不可测；生产验证依赖真实高德 key。
3. **招标真实数据链**：公告抓取→过滤→摘要→推送，隔离环境无源数据；过滤逻辑仅验证了参数合同。
4. **微信引用（quote）确认链**：引用草稿回复「确认/修改/取消」的完整链路本轮按任务书跳过，仅验证了无引用 clarify；出站 outbox 实际投递（weixin worker）不在栈内。
5. **语音转写真实链路**：仅有模型层单测与源码断言，无真实麦克风/SpeechRecognition 端到端守护。
6. **`HospitalTenderPage.test.mjs` 未挂入 qa:local**：招标页唯一的页面级测试游离于门禁之外（本轮即发现其静默失败）。
7. **晨报实发链路**：仅验证 dryRun；`runManual` 实发（outbox 写入+幂等标记）未触发以避免污染，无隔离环境守护。
8. **多用户/权限矩阵**：系统单账号（AUTH_ACCOUNT），owner 过滤语义只在微信侧生效，Web 侧无 owner 隔离测试。

## 收尾

- 审计栈已销毁：后端/前端进程已杀，`/tmp/audit-stack*`、临时脚本与中间产物已清理。
- 本文件为本轮审计唯一写入工作树的产物。
