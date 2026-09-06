# 森特智行销售工作台 · 服务器架构与后端全景审计（只读定稿）

> 审计时间：2026-08-28 22:50–23:40 CST · 全程只读（本文件为唯一写操作）。
> 代码基准：`.worktrees/integrate-v0626-candidate`（审计期间 v0.8.4 工程健康在另一进程实施中，HEAD 从 34dc7d7 漂移至 85ea196，**引用行号以审计时点为准、可能漂移，函数/文件名为稳定锚点**；生产为 v0.8.3 冻结 `a2a9eb3`）。
> 服务器基准：`root@82.156.210.199`（只读命令）实况；数据库经项目 node-v24 `node:sqlite readOnly:true` 查询（系统 sqlite3 3.7.17 无法读 partial index 库，实测报 malformed schema）。
> 用途：作为"下一代大目标方案"（含多账号改造）的决策输入。§9 为十大架构建议。

---

## 1. 部署架构全景

### 1.1 主机与共存项目

单台腾讯云 CVM：CentOS 7（内核 3.10.0-1160，systemd 219）、4 vCPU、3.6 GiB 内存、40 GiB 盘用 44%（22G 可用）、up 81 天，时区 Asia/Shanghai + ntpd 同步（`uname/df/free/uptime` 实测 + server-facts TODO-2）。**三个项目共存**：

| 项目 | 服务/入口 | 端口 | 运行用户 | 数据 |
|---|---|---|---|---|
| 森特智行（本系统） | sentelligent-backend / frontend / weixin-agent / caddy 四个 systemd 服务 + daily-backup timer | 8897 后端、8088 前端、80+443 Caddy | sentzx（caddy 独立） | `/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite`（2.0 MB + WAL 1.3 MB + SHM） |
| 轻氧店 qingyang-store | qingyang-store.service（Python `backend.run_dev`）+ 03:15 备份 timer | 8797 | qingyang-store | `/srv/qingyang-store/{data,backups,releases,staging…}`（自成一套发布树） |
| 医院招标监测器（独立版） | hospital-it-tender-monitor **08:05 oneshot timer**（Python venv，ProtectSystem/ProtectHome/RestrictAddressFamilies 沙箱） | 无常驻端口 | 专用用户 | `/var/lib/hospital-it-tender-monitor/hospital-tender-monitor.sqlite3`；env 仅 PUSHPLUS_TOKEN+DATA_DIR |

**异常发现（✦新）**：18899 端口挂着一个 **root 身份运行 30 天的 qingyang `backend.run_dev` 孤儿进程**（pid 8614；正牌实例 8797/qingyang-store 用户/17 天），Caddy 未引用 18899——旧实例未清，root 权限 + dev 模式双重风险（`ss -tlnp` + `ps -eo` 实测）。

### 1.2 共享 Caddy 路由（/etc/caddy/Caddyfile 实测全文核对）

```
{ admin off; default_sni 82.156.210.199 }
82.156.210.199 {
  tls { issuer acme { profile shortlived } }   # IP 证书，短时效 ACME
  /qingyang/api/* → strip_prefix → 127.0.0.1:8797
  /qingyang/*     → 静态 /srv/qingyang-store/app/dist (SPA try_files)
  /api/*          → 127.0.0.1:8897 (森特后端)
  默认            → 127.0.0.1:8088 (森特前端静态服务)
}
```

v0.8.1 曾发生共存应用抢 `/manifest.webmanifest` 与手机根路径分流事故（交付报告 v0.8.1 节）；CodexAccountVault 已于 08-28 全量退役、48 行路由手术完成、端口 4876/7890/9097 释放（交付报告"运维与退役"节）。`/etc/caddy/` 存 8 份历史备份文件，Caddyfile 未纳入仓库版本管理。

### 1.3 systemd 单元清单（unit 文件全文实测）

| 单元 | 要点 |
|---|---|
| sentelligent-backend.service | node-v24 直跑 `releases/v0.8.3-20260828T142112Z_a2a9eb3f8325/backend/src/server.js`；EnvironmentFile=`/opt/…/config/backend.env`；Restart=on-failure/3s；NoNewPrivileges+PrivateTmp+UMask=0027 |
| sentelligent-frontend.service | node 跑 `outputs/product-design-prototype/scripts/static-server.mjs serve`（8088，服务 vite dist）；EnvironmentFile=frontend.env（NODE_ENV/HOST/PORT/DIST_PATH/API_BASE_URL 五键） |
| sentelligent-weixin-agent.service | node 跑 `backend/src/weixin/worker.js start`；**Environment=HOME=/opt/…/weixin-session**（登录态目录）；复用 backend.env |
| sentelligent-caddy.service | CAP_NET_BIND_SERVICE 绑 80/443；XDG 目录固定 |
| sentelligent-daily-backup.service/.timer | root oneshot，02:30（无时区后缀写法适配 systemd 219），Persistent=true，TimeoutStartSec=1800；**故意无 [Install] 防误启用** |
| hospital-it-tender-monitor.service/.timer | 08:05 oneshot，独立 Python 项目 |
| qingyang-store(.service)/qingyang-store-backup(.timer 03:15) | 共存项目 |
| 遗留 | sentelligent-frontend-80.service（HTTP 时代，未加载）；rc-local/tat_agent 云厂商组件 |

**全部单元均无 `OnFailure=`——服务、备份、timer 失败无任何主动告警**（server-facts TODO-6 决策项，至今悬置）。

### 1.4 发布流水线（scripts/ 实测 + 交付报告 §1）

`scripts/release-package.mjs`（本地 exact-commit 打包，bundle SHA-256 双端复算）→ 服务器解包为 `releases/v<版本>-<UTC时间戳>_<commit12>` 不可变目录（root:root 冻结 + manifest）→ **四关**：`production-preflight.mjs`（25 项）→ `production-cutover.sh`（受控切换：停服→`db/migrate.js` 迁移→切 `current` 软链→起服；自带 DB 离线备份 + 微信会话 tar 备份；失败自动回滚——v0.7.5 解包权限、v0.8.3 preflight fail-closed 两次实战自救，生产零事故）→ postflight（25 项）→ `production-https-smoke.mjs`（25 项，临时凭据 `/dev/shm` 内存备份字节级恢复）。辅助：`production-service-plan.mjs`、`project-secret-scan.mjs`（每版执行，findings=[]）、`fixed-stack-smoke.mjs`。服务器现存 **79 个 release 目录**、`current → v0.8.3-20260828T142112Z_a2a9eb3f8325`（readlink 实测）。已知惯例：服务器构建须 `LC_ALL=C`（git 1.8 中文 locale 陷阱，交付报告 §3-12）；发布无 CI，全程单操作者手跑。

### 1.5 备份体系（实测）

- **每日库备份**：`tools/daily-db-backup.sh`（root oneshot：node:sqlite 只读连接 VACUUM INTO → 完整性校验 → SHA-256 + JSON manifest → 14 天保留 → flock 防重入），02:30 timer 激活；今日 17:21 安装验证跑出首份 1.8 MB 快照（journalctl 实测 SHA `cb095b34…`，PRUNED_COUNT=0）。
- **制品归档**：`tools/archive-release-artifacts.sh`（目标目录不可覆盖，重跑同版本即失败）；实测 `backups/releases/` 已归档 **v0.7.0–v0.8.0 九版**，**✦ v0.8.1–v0.8.3 尚未归档**（制品仅在 staging/）。
- **cutover 随发备份**：`backups/` 共 172 条目（每版 preflight/cutover/postflight run 目录 + weixin-session tar）。
- **空白**：备份失败无通知；**无异地副本**（TODO-7 悬置）——单盘单机，盘毁即全毁（每日快照与主库同盘）。

### 1.6 backend.env 键清单（50 键，值全部打码后实测枚举）

| 分组 | 键（用途） |
|---|---|
| 运行时 | NODE_ENV、HOST、PORT、DATABASE_URL（=/var/lib/…/sales-workbench.sqlite，纯路径无凭据）、JSON_BODY_LIMIT_BYTES、CORS_ALLOWED_ORIGINS |
| 鉴权（单账号核心） | AUTH_REQUIRED、**AUTH_ACCOUNT**（唯一登录账号）、AUTH_PASSWORD_HASH（scrypt 规范编码）、AUTH_SESSION_SECRET（会话 HMAC+库身份绑定）、AUTH_COOKIE_NAME、AUTH_COOKIE_SECURE |
| 模型 | AI_ANALYSIS_MODE、MODEL_PROVIDER、MODEL_API_KEY、MODEL_BASE_URL、MODEL_NAME、MODEL_VISION_NAME、MODEL_TIMEOUT_MS（+DEEPSEEK_API_KEY/BASE_URL/MODEL 兼容别名） |
| 微信（单绑定核心） | WEIXIN_AGENT_BACKEND_URL、**WEIXIN_AGENT_OWNER**（机器身份→业务 owner）、WEIXIN_AGENT_SESSION_HOME、WEIXIN_AGENT_API_TOKEN（机器令牌）、WEIXIN_ALLOWED_SENDER_IDS（入站白名单）、**WEIXIN_BOOKKEEPING_OWNER**、**WEIXIN_BOOKKEEPING_SENDER_ID**（财务确认唯一私聊）、WEIXIN_BOOKKEEPING_CONFIRMATION_ENABLED、WEIXIN_OUTBOX_POLL_MS |
| 发票/凭证 | INVOICE_OCR_COMMAND、INVOICE_PDF_TEXT_COMMAND、INVOICE_PDF_IMAGE_COMMAND、INVOICE_OCR_LANGUAGES、INVOICE_TEXT_EXTRACTION_TIMEOUT_MS |
| 招标 | HOSPITAL_TENDER_PYTHON（项目自带 python-3.12.14）、HOSPITAL_TENDER_AUTO_RUN、HOSPITAL_TENDER_INTERVAL_MINUTES、HOSPITAL_TENDER_BATCH_SIZE、HOSPITAL_TENDER_PUSHPLUS_TOKEN（兜底通道） |
| 其他 | ASSISTANT_CONFIRMATION_SECRET（六位码 HMAC）、SETTINGS_ENCRYPTION_KEY（secure_settings 加密）、AMAP_WEB_SERVICE_KEY、AMAP_TIMEOUT_MS、SOLUTION_WRITES_ENABLED、VOICE_RECORDINGS_DIR |

生产校验硬门（backend/src/config.js:172-231）：scrypt 哈希强制、base64url≥32B 密钥、四/五枚 secret 两两独立（:218-226）、**WEIXIN_BOOKKEEPING_OWNER 必须等于 WEIXIN_AGENT_OWNER**（:202-204）、群聊强制关闭（:212-217）、CORS 显式必填。

### 1.7 磁盘/资源占用（`du -sh`、`ps` 实测）

`/opt/sentelligent-sales-workbench/`：staging **1.5G**（当日 v0.7.x–v0.8.x 全部构建产物）、releases 885M（79 目录）、runtime 651M（node-v24+python-3.12.14）、backups 468M、candidates 347M + incoming 213M（旧流程残留）、evidence 35M；另有 6 月旧目录 `backend/`（含 `src.backup-*` 手工备份时代残迹、root/sentzx 权限混布）、`frontend/`、`build-*`。清理方案见清册 §6（待批）。进程 RSS：backend 77M、worker 65M、frontend 44M、caddy 38M。journald 持久化占 980 MB。

### 1.8 文字架构图

```
手机微信私聊(唯一发送者白名单) ─┐                 浏览器(单账号 Cookie 会话)
                                │                        │ HTTPS
                        [weixin-agent-sdk]         Caddy :80/443 (IP 证书, shortlived ACME)
                                │                  ├ /api/* ────────► backend :8897 (node24 单进程 server.js)
            sentelligent-weixin-agent.service      ├ /qingyang/* ──► qingyang :8797 (共存项目)
            (独立进程, HOME=weixin-session)        └ 默认 ─────────► frontend :8088 (static-server 服务 dist)
              │ 入站: POST /api/integrations/weixin-agent/events   (Bearer 机器令牌+幂等键)
              │ 出站: 轮询 GET/POST …/confirmation-outbox          (租约+就绪头+isCurrent 防超发)
              ▼
   backend 单进程 = 路由(≈115端点, if链) + assistant编排链(router→policy→registry→orchestrator→handlers→providers)
              ├ 招标调度器(9–20点/120min, 单行锁, spawn vendored python 采集器, 微信推送/PushPlus兜底)
              ├ 待办提醒调度器(60s, action_items 表即队列, remind_at+reminded_at 双幂等)
              ├ 晨报调度器(每日09:00+周五16:30, outbox幂等键补发语义)
              └ 全部出站消息 → weixin_confirmation_outbox → worker → 唯一绑定私聊
   SQLite WAL 单库(54表) ◄─ 每日02:30 VACUUM INTO 快照(14天) ; 发布=不可变release+四关+自动回滚
   独立 Python 招标监测器(08:05 timer, 自有sqlite, PushPlus) ─POST /api/integrations/hospital-tenders/sync(专属令牌)─► backend
```

---

## 2. 后端模块地图

### 2.1 backend/src 全目录结构（ls -R 实测；共 126 个 JS、50,340 行）

```
server.js(7470) config.js(458) db.js schema.sql seed.js modelAnalysis.js quickRecordAnalysis.js solutionDraft.js weeklyDraft.js
actionItems/actionItemStore.js            actionReminders/{reminderMessage,reminderScheduler}.js
ai/agents/{salesDecisionAgent,Playbooks,Repository,Schema}.js + sales-decision-agent-v1.md
assistant/ 41文件(19,303行): orchestrator(843) router(976) policy(93) agentRegistry(185) agentManifest(668)
  runtimeHandlers(2884) shortcutBookkeepingRuntime(2461) businessSnapshotAdapter(882) settlementSnapshotAdapter(567)
  businessOwnerResolver(33) contracts capabilityCatalog toolRegistry
  仓储: eventRepository sessionRepository pendingActionRepository(680) agentRunRepository salesLoopContextRepository
  适配器: customer(560)/opportunity(424)/visitCapture(605)/salesDecision(306)/salesReport(494)/advanceSettlement(567)
         /itinerary/knowledge/dashboard/actionRisk AssistantAdapter
  预览提供者: {customer,quickRecord,actionItem,opportunity}PendingPreviewProviders
  微信侧: weixinCard weixinEvent weixinInvoiceAttachment bookkeepingCapture bookkeepingTripRegion spokenDate spokenTime salesLoopPreview projectAnalysis
audit/auditRepository.js(108)             auth/{session(85),machineAuthorization(125),password,loginRateLimit}.js
bookkeeping/categoryCatalog.js            customers/customerStore.js
dailyDigest/{digestContent(451),digestMessage,digestScheduler(293)}.js
db/{connection,databaseIdentity,integrity,migrate,transaction}.js + migrations/×28
hospitalTender/{internalRunner(205),matching,notifier,repository(838),scheduler(580),schedulerRepository(378),sync(348),weixinNotifier}.js
http/{errors,request,response,security,strictBase64}.js       integrations/shortcut*{5文件}
itinerary/{optimizer,planner,repository}.js    maps/amapClient.js    opportunities/{opportunityStore,stageVocabulary}.js
quickRecords/quickRecordStore.js   services/idempotency.js(253)   settings/{repository,secretBox}.js
travelExpense/{documentBlobCodec,documentBlobStore,documentInboxMedia,documentInboxRepository,documentVisionAnalysis}.js
validation/requests.js             weixin/{worker(197),agentBridge(501),remoteAgent(285),outboxWorker(215),outboxRepository(349),outboxClient,loginBinding(206),deliveryReadiness,bookkeepingDeliveryScope}.js
```

### 2.2 server.js 路由清单（路由分支 rg 全量清点，≈115 端点，按域）

| 域 | 数 | 端点（M=机器令牌可达） |
|---|---|---|
| 健康/鉴权 | 4 | GET /api/health（匿名）；POST auth/login(M)、GET auth/session、POST auth/logout |
| 设置 | 6 | GET settings/security；PUT/DELETE settings/deepseek-key（含 deepseek-api-key 别名路径）；PUT/DELETE settings/pushplus-token（含 pushplus 别名）；POST settings/pushplus/test |
| 总览/审计/晨报 | 4 | GET dashboard/summary；GET audit-logs（scope=bookkeeping 前缀白名单）；GET digest/status、POST digest/run(?dryRun) |
| 客户 | 5 | GET/POST customers(GET 为 M 共享)、GET/PATCH/DELETE customers/:id |
| 商机 | 6 | GET/POST、GET/PATCH/DELETE /:id、POST /:id/diagnose-risks |
| 行动/风险 | 4+3 | GET actions、PATCH/DELETE /:id、GET actions/reminders/status；GET risks、PATCH/DELETE /:id |
| 知识 | 5 | GET/POST、PATCH/DELETE /:id、POST knowledge/search |
| 快速记录 | 6 | GET、POST preview(M)、POST(M)、POST /:id/analyze(M)、PATCH /:id/analysis、POST /:id/confirm |
| AI/决策 | 4 | GET/POST ai/sales-decisions、GET /:id、POST ai/suggestions |
| 周报/方案 | 5+4 | POST reports/weekly/draft(M)、GET/GET(导出)/PATCH/DELETE /:week；GET solutions、POST solutions/draft、GET/PATCH /:id |
| 差旅费用 | 8 | GET/POST travel-expenses、GET/PATCH/DELETE /:id、POST /:id/attachments、POST/DELETE /:id/no-invoice |
| 附件/凭证收件箱 | 2+6 | GET attachments/:id/content、DELETE /:id；document-inbox GET/POST(M)/GET :id/GET :id/content/POST :id/confirm/POST :id/reject |
| 发票域 | 7+2+2+3+1 | invoices GET/POST(M)/GET :id/GET :id/content/DELETE/PATCH :id/review/POST :id/matches；invoice-matches GET/DELETE；candidates accept/reject；weeks 建议×2+覆盖率；no-invoice-confirmations GET |
| 借款/区域/工作台 | 4+2+1 | advances CRUD；region-profile GET/PUT；GET travel-expense-workbench |
| 行程 | 5 | GET/POST itineraries、GET/PATCH/DELETE /:id |
| 招标 | 10+2M | GET 列表/:id/summary/sources/health/scheduler(+status)/scheduler/runs；PATCH scheduler；POST scheduler/run(-next)、POST run；M: POST integrations/hospital-tenders/sync、GET …/health |
| 微信集成 | 3+3M | 绑定页 GET/POST/DELETE integrations/weixin-agent/login；M: POST events、GET/POST confirmation-outbox；GET integrations/weixin/bookkeeping/review(+/:id) |
| 埋点/退役 | 1+410 | POST bookkeeping/client-events；`/api/integrations/icost|shortcut/*`、settings/icost-token* 显式退役（server.js:226-232） |

**鉴权分层**（server.js:3203-3580）：匿名 health → 机器令牌路由先行（Bearer，`auth/machineAuthorization.js:5-36` 按集成双白名单：weixin-agent 9 条+analyze 正则、hospital-tender-monitor 2 条；token 经 sha256+timingSafeEqual :88-97）→ 其余 `/api/*` 会话 Cookie（`auth/session.js`：auth_sessions 表存 HMAC 哈希、7 天 TTL :4、CSRF 派生自 session id :18-20）；登录限速 login_rate_limits 表。

### 2.3 assistant 编排链（router→policy→registry→orchestrator→handlers→providers）

1. **入口唯一**：worker POST `/api/integrations/weixin-agent/events` → 校验幂等键=消息 id、发送者白名单 → 计算会话 scope（记账专用会话 vs 通用 sha256 会话）与 financialScope（chatType=direct ∧ sender=BOOKKEEPING_SENDER ∧ account=BOOKKEEPING_OWNER，server.js:3412-3416）→ `assistantOrchestrator.handle({context:{owner: machineIdentity.account, channel:"weixin", conversation, event}})`（server.js:3425-3450）。**Web 端无助手对话端点，助手=纯微信通道**。
2. **router.js**（976 行）：纯确定性中文前缀/正则意图路由（路由零模型调用），输出 `intent_plan{status, toolName, agentId, arguments, confidence}`；help/取消系统词直答（:608-609）；策略拒绝在路由层即返 denied（:45）。已知债：capture/todo 前缀组抢最前（清册 §4-2）。
3. **policy.js**：39 条工具策略（R0×12 只读、R1×12 轻确认/预览、R2×7 六位码、R3×8 六位码或记账专用语言确认），显式 DENY_LIST（http/sql/shell/fs 八项 :2-4），**未注册工具默认 R3 拒绝**（:67-72）。
4. **agentRegistry.js**：17 个 agent 定义（:11-29）+ 37 个工具 schema（:35-174），工具↔agent 强绑定、policy 内联。
5. **agentManifest.js**：版本化 manifest（contractVersion/modelPolicy 六态/taskTypes/inputSchema/outputSchema/systemPrompt/fallback）；`UNSAFE_PROMPT` 正则拦提示注入（:28）；registry↔manifest 双向一致性启动校验（:644-648）。
6. **orchestrator.js**（843 行）：inbound 事件租约幂等（assistant_inbound_events）→ 路由 → 需确认建 assistant_pending_actions（六位码 HMAC 哈希、10 分钟过期、错 5 次锁 confirmation_attempts 0-5 CHECK、单会话唯一活跃 partial unique index）→ 确认执行（轻确认走派生凭据 :306-315）→ assistant_tool_runs 记录 → 会话/草稿 assistant_conversations/draft_parts → 业务上下文 salesLoopContextRepository（客户/商机指代记忆）。
7. **runtimeHandlers.js**（2,884 行）：每工具 handler；逐处 `resolveBusinessOwner(context.owner)` 将机器账号换算业务 owner（:968,1042,1112…共 20+ 处）；读取统一走 businessSnapshotAdapter（owner-scoped SQL 单一来源）。

### 2.4 Agent 能力/确认矩阵（agentManifest.js:132-547 全量核对）

| Agent | 生命周期 | modelPolicy | 工具（风险/确认） |
|---|---|---|---|
| system-router | active | none | —（只路由/澄清/help/取消） |
| dashboard | active | none | summary(R0) |
| customer | active | optional | search/detail(R0)；create/update(R2 六位码)；delete(R3 六位码软删) |
| visit-capture | active | required+确定性兜底 | capture(R1 轻确认)、search(R0)、update(R2)、void(R3)；collect/preview/confirm 草稿链 |
| opportunity | active | none | list/detail(R0)；update-stage/update-next(R1 轻确认)；update/create(R2)；delete(R3)。阶段前进联动 sales-decision 检查（8s 预算，config.js:358-364） |
| action-risk | active | none | summary/list(R0)；create/complete/defer(R1 轻确认)；delete(R2) |
| sales-decision | active | required+兜底 | preview(R1)；四类分析（诊断/客户/会前/下一步） |
| itinerary | active | none | summary(R0) |
| sales-report | active | required+兜底 | preview(R1)，输出永远是预览 |
| knowledge | active | none | search(R0)，全局无 owner |
| advance-settlement | active | none | preview(R1)；**合同禁确认禁写回**（:450） |
| travel-expense/payment-proof/invoice/reimbursement-report | **disabled**（工具经既有确定性运行时走，不入版本化 agent run） | disabled_until_data_boundary_approved | bookkeeping.confirm(R3 记账语言确认)/ingest(R1)；*.ingest(R1)；travel-expense.create(R3)；reimbursement-report.preview(R1) |
| solution / personal-finance | **disabled** | disabled_until_approved | 预留，回复"未启用" |

（交付报告"小小八项能力"= 招标推送/记账/客户/拜访/待办/商机/晨报/卡片化，对应 active 集合的用户视角。）

### 2.5 三个调度器（同进程 setTimeout 循环，`*_AUTO_RUN` 生产默认开，config.js:314-354）

| 调度器 | 节奏 | 状态持久化 | owner 语义 | 失败处理 |
|---|---|---|---|---|
| 招标 `hospitalTender/scheduler.js`(580行) | 120 分钟（生产 PATCH 过），仅 9–20 点窗口（0026 迁移列 active_start/end_hour） | 五张表：state(单行)+lock(单行租约 tryAcquireLock :234-236)+runs+snapshots+sources；游标分批遍历客户 | **customersProvider 取全库客户不分 owner**（server.js:2678-2681）；推送收件人=`shortcutBookkeepingAssistantRuntime.owner` 单人+其会话（server.js:2648-2658）；微信就绪否则 PushPlus 兜底（:2660-2666）；幂等键 `hospital-tender:cycle:{n}:chunk:{i}:{hash}`（CHANGELOG [0.7.0]） | lastError 落库可查（GET scheduler），**无告警**；生产实测 cycle 67、waiting、next 明日 09:00、无错 |
| 待办提醒 `actionReminders/reminderScheduler.js` | 60 秒 | **仅内存 state**（重启丢、GET /api/actions/reminders/status 暴露）；队列=action_items 表本身（remind_at≤now ∧ reminded_at IS NULL partial index） | `resolveOwner=()=>runtime.owner` 单人（server.js:2962-2965）；幂等=outbox 键 `action-reminder:{id}:{ms}`（:109）+reminded_at 双保险；迟到>24h 标"过期待办"（:10,93）；离线恢复补发 | deliveryReady 不就绪整轮 skip（:69-73）；lastError 仅内存，**无告警** |
| 晨报 `dailyDigest/digestScheduler.js` | 每日 09:00 + 周五 16:30（分钟轮询、补发语义：当天迟到也发一次） | 幂等=outbox 键 `daily-digest:{date}` / `friday-closeout:{周五}`（:29-33）+hasKey 查重+当日空报内存跳过（重启重扫可接受 :76） | `resolveOwner` 同上单人；内容构建 `digestContent.js` 按 resolveBusinessOwner owner-scoped（:117-159，行动可见性与快照适配器同三分支）；四段（行程/待办/风险/24h 新招标）空段省略、全空不发 | 发送/跳过写审计（digest.daily.sent/skipped/friday.sent），**无告警**；管理面 GET status + POST run?dryRun=1 |

### 2.6 outbox 投递链与微信 worker 进程边界

- **唯一出站通道** `weixin_confirmation_outbox`：owner+conversation_id+幂等键哈希 UNIQUE、payload JSON≤20KB、状态 queued/processing/sent/failed、lease_proof_hash+lease_until 租约、provider_message_id 回执。生产者：记账确认卡、agent 回执、招标推送、待办提醒、晨报——**五类消息全部复用同一队列**。
- **消费协议**（outboxRepository.js + server.js:3251-3358）：worker GET 租约（带 X-Weixin-Worker-Id 与 X-Weixin-Delivery-Status 就绪头，未就绪时后端不放租约）→ `isCurrent` 二次校验（outboxWorker.js:175-178 防旧租约超发）→ `bot.sendMessageTo` → POST ack（ok/errorCode/terminal）。`maxAttempts=8` 耗尽转 failed（outboxRepository.js:91,224）；`requeueFailed` 仅接受可重试错误码否则 409（:259-266）。scope mismatch 一律终态（outboxWorker.js:165-174）。
- **worker 进程边界**（weixin/worker.js，独立 systemd 单元）：加载 vendored `weixin-agent-sdk`；QR 登录态在 `weixin-session`（HOME 注入）；**入站**：SDK authorizeInbound 白名单过滤（:106）→ `remoteAgent.chat` → 转 POST events；**出站**：投递目标硬绑定唯一 senderId，clientId=HMAC(deliveryKey,outboxId) 防提供方重发（:39-52,140-150）；`getDeliveryStatus` 三态（未配置/SDK 不支持/目标不匹配）。worker 与 backend 只经 HTTP+令牌通信，可独立重启（今晚 v0.8.3 切换重启后 ready，journalctl 实测）。
- **Web 绑定页**：GET/POST/DELETE `/api/integrations/weixin-agent/login`（server.js:5985-6000）——backend spawn `worker.js login-start` 子进程、解析终端 QR 块字符转 SVG 展示（loginBinding.js:22-64）。绑定生命周期依赖 TTY 输出解析，较脆弱。
- **生产实况**（DB 只读实测）：sent=22、failed=4（3×WEIXIN_SEND_FAILED attempt 8-9 + 1×CANCELLED，08-22/08-25 陈账=清册 §4-3）；今晚 21:59 一次 retryable_error 自愈。

---

## 3. 数据模型（服务器 sqlite_master 全量导出核对：54 表、60+ 索引、8 触发器；schema_migrations 已应用 27 项 + 0001 基线）

### 3.1 迁移链（db/migrations/ 实测 28 个）

0001 baseline(SQL 全量) → 0002 写完整性(version/软删/审计 before-after) → 0003 快速记录 voided_* → 0005 visit_itineraries → 0006 sales_decision_analyses → 0007 travel_expenses → 0008 发票摄取 → 0009 document_blobs 无损存储 → 0010 idempotency claim 租约 → 0011 assistant 运行时五表 → 0012 assistant owner+plan_digest → 0013 确认闭环(attempts/锁) → 0014 招标监测四表 → 0015 secure_settings → 0016 招标调度器四表 → 0017 shortcut webhook tokens → 0018 记账 entries → 0019 微信确认(outbox+revisions) → 0020 收入分录 → 0021 pushplus 键 → 0022 agent_runs → 0023 business_contexts → 0024 借款分摊四表 → 0025 区域档案 → 0026 招标活动窗口 → 0027 客户 aliases/tags → 0028 待办 owner/remind_at/reminded_at+存量回填。（0004 空缺为历史编号跳号。）

### 3.2 全表清册（★=owner NOT NULL；◇=owner 可空；✗=无 owner；V=乐观锁 version；SD=软删；行数=生产实测）

| 域 | 表（标记） |
|---|---|
| 销售核心 | customers◇V·SD(3)、opportunities◇V·SD(3, FK customer CASCADE)、action_items◇V·SD(3, source_record_id UNIQUE→quick_records, remind_at/reminded_at)、risk_items✗V·SD(3, 派生 owner)、quick_records◇V(6, voided_* 软作废)、ai_insights✗(6, FK qr CASCADE)、ai_suggestions✗(1)、manual_confirmations✗(0, UNIQUE(qr,target∈customer\|opportunity\|weekly))、sales_decision_analyses✗(3, created_by)、solution_drafts★V(1)、weekly_reports★V·SD(3)、knowledge_items✗V·SD(4) |
| 差旅财务 | travel_expenses★V·SD(10, reference_code 触发器强制+partial UNIQUE, trip_region/来源枚举)、travel_expense_payments✗(10, funding_source∈personal\|company\|advance, UNIQUE(expense,seq))、travel_expense_attachments✗(3, kind∈payment_proof\|invoice\|substitute, FK blob RESTRICT)、attachment_payments✗(3, 多对多)、document_blobs★(6, UNIQUE(owner,sha256), ≤12MB, br 压缩 CHECK, 三组防篡改触发器)、invoice_documents★V·SD(0, UNIQUE(owner,sha256), 金额三列 cents)、invoice_matches★V(0, partial UNIQUE 活跃唯一)、invoice_match_candidates★V(0)、travel_expense_no_invoice_confirmations★V(2, revoked_* 可撤销)、travel_expense_advances★V·SD(0)、advance_sources★(0, entry/advance 双 UNIQUE)、advance_allocation_plans★(0, plan_hash)、advance_allocations★(0, 全 RESTRICT+reversed 状态)、travel_expense_document_inbox★V(6, +actor, UNIQUE(owner,kind,sha256))、travel_expense_ingestions★(0, +actor, UNIQUE(owner,source,幂等键))、travel_expense_region_profiles★V(1, PK(owner,week)) |
| 记账 | shortcut_bookkeeping_entries★(10, +actor, target_system∈sentelligent\|qingyang, 接受态 CHECK 强制挂 expense+payment, UNIQUE(owner,幂等键)+remote_id 唯一)、shortcut_bookkeeping_revisions★(16, UNIQUE(entry,version))、shortcut_webhook_tokens(1, account) |
| 助手运行时 | assistant_inbound_events★(38, UNIQUE(owner,channel,event_hash), 租约)、assistant_conversations★(8)、assistant_draft_parts✗(76, FK 会话 CASCADE)、assistant_pending_actions★(12, 六位码哈希+attempts 0-5+单会话唯一活跃 partial index)、assistant_tool_runs★(15, UNIQUE(owner,channel,event,tool))、assistant_agent_runs★(3, 输入输出快照哈希+UNIQUE(owner,channel,request_hash))、assistant_business_contexts★(0)、assistant_confirmation_attempts✗(0, PK(action,event_hash)) |
| 招标（全局无 owner） | hospital_tender_notices✗(17, identity_key UNIQUE, match_customer_ids_json/score)、sources✗(12)、runs✗(1)、scheduler_state(单行, 窗口/游标/lastError)、scheduler_lock(单行)、scheduler_runs(67)、scheduler_snapshots(6) |
| 基础设施 | audit_logs(254)、auth_sessions(35, account)、login_rate_limits(0)、idempotency_keys(2, **PK(actor,method,path,key)**+claim_token 租约)、secure_settings(3, 键白名单 CHECK: icost_webhook_token/deepseek_api_key/hospital_tender_pushplus_token, 密文+状态一致性 CHECK)、schema_migrations(27) |

**文字 ER 主干**：customers 1—n opportunities 1—n {action_items,risk_items,solution_drafts,sales_decision_analyses}；quick_records n—1 customers/opportunities（SET NULL）且 1—n ai_insights、1—1 action_items(source_record_id)；travel_expenses 1—n payments 1—n(经 attachment_payments) attachments n—1 document_blobs；invoice_documents n—n travel_expenses(经 invoice_matches, 可到 payment 粒度)；shortcut_bookkeeping_entries →(接受时) expense+payment，→advance_sources→advances→allocation_plans→allocations；assistant_conversations 1—n draft_parts、1—n pending_actions。

### 3.3 审计体系：audit_logs 全 action 词表（rg 全源实扫，按域列全）

- customer.create/update/delete；opportunity.create/update/delete；action.update/delete、action.reminder.sent；risk.update/delete/diagnose
- quick_record.create/update/void/confirm/analyze、quick_record.analysis.update；knowledge.create/update/delete；weekly_report.draft/update/delete；solution_draft.generate/update；visit_itinerary.create/update/delete；sales_decision_analysis.create
- travel_expense.create/update/delete、attachment_add/attachment_delete/invoice_attachment_add、no_invoice_confirm/no_invoice_revoke、region_profile.save(.weixin)、ingestion.receive/review_required/accept
- travel_expense_advance.create/update/delete；travel_expense_document_inbox.create/confirm/reject/match
- invoice.create/delete/review_finalize/match_confirm/match_revoke/candidate_accept/candidate_reject/suggestions_generate
- shortcut_bookkeeping.receive/review_required/accept/processing_failed/manual_retry/manual_reject/advance_received/advance_allocation.confirm
- settings.deepseek_key.save/clear、settings.pushplus_token.save/clear/test/test_failed；hospital_tender.sync/internal_run
- digest.daily.sent/daily.skipped/friday.sent；assistant.event.receive/event.complete/action.execute/draft.clear
- bookkeeping_client.`${event}`（动态：print_expense_list/print_invoices/export_expenses_xlsx，server.js:4314）

结构：action/entity_type/entity_id/actor/before_json/after_json/entity_version/request_id/metadata（0002 起）。脱敏：customer.contact 从 before/after 剔除、changedFields 保留可证性（交付报告 §3-6）。查询面：GET /api/audit-logs（bookkeeping scope 六前缀白名单）。**actor 为自由文本**，生产实测 7 种混杂值：jiangjz(233)/weixin-agent(7)/null(5)/deploy(4)/system:daily-digest(2)/"??"(2)/继振(1)。

### 3.4 完整性模式覆盖面

| 模式 | 覆盖 | 缺口 |
|---|---|---|
| 乐观锁 version | 销售核心全域、差旅主表、发票、advances、inbox、region_profiles、助手表（runVersionedUpdate 统一；PATCH 全线要求 expectedVersion） | payments/attachments 随主表 version（可接受） |
| 软删/软作废 | deleted_at/deleted_by 十余表；quick_records 用 voided_at 三件套（0003）；读路径统一过滤 | attachments 物理删；audit 不删 |
| 幂等 | HTTP 写路径 idempotency_keys（actor 维度+claim 租约，0010）；outbox/entries/ingestions UNIQUE(owner,幂等键)；agent_runs request_hash；events 事件哈希 | 常规 Web PATCH/DELETE 靠 version 防冲突（可接受） |
| 触发器 | document blob↔owner↔sha256 三组一致性；expenses reference_code 非空 | — |

---

## 4. 单账号假设全清单（多账号改造的决定性输入）

**生产 owner 数据实况**（node:sqlite 只读实测）——owner 为自由文本、无 FK、**已碎片化**：
customers{jiangjz:2, 继振:1}、opportunities{jiangjz:2, 继振:1}、action_items{NULL:1, jiangjz:1, 继振:1}、quick_records{jiangjz:3, **legacy**:3}、travel_expenses{jiangjz:10}、weekly_reports{jiangjz:2, 继振:1}、solution_drafts{**"??"**:1}。"继振"客户对小小不可见即交付报告 §3-1 遗留项的直接后果。

| # | 假设点 | 位置 | 现机制 | 多账号动作 | 工作量 | 风险 |
|---|---|---|---|---|---|---|
| 1 | AUTH_ACCOUNT 单账号鉴权 | config.js:378,174-179；server.js:3219 | env 单账号+单 scrypt 哈希，生产强制 | accounts 表（id/display_name/password_hash/status），登录改查表 | 中 1-2d | 中（登录/限速/CSRF 回归） |
| 2 | 会话与限速 | session.js:22-52；loginRateLimit | auth_sessions.account 已入库 | 近零改动，天然多账号 | 小 | 低 |
| 3 | WEIXIN_AGENT_OWNER 单绑定 | config.js:408,192-194；machineAuthorization.js:52-63 | 机器令牌→固定 owner 一对一 | weixin_bindings(account↔sender_id↔financial_enabled) 表，机器身份→按 senderId 查绑定 | 大 2-3d | 高（令牌/绑定协议） |
| 4 | WEIXIN_BOOKKEEPING_OWNER/SENDER | config.js:409-422,195-204（必须==AGENT_OWNER）；shortcutBookkeepingRuntime.js:536；financialScope server.js:3412-3416 | 财务确认只认唯一私聊 | 并入 #3；financialScope 改查绑定行 | 中 | 高（财务写入门禁） |
| 5 | resolveBusinessOwner 闭合映射 | businessOwnerResolver.js:20-27；装配 server.js:2872-2876 | 账号≠配置 owner→null 拒答（闭合、不回退全量） | 改 senderId→account 查表；**闭合语义必须保留** | 小 0.5d | 低（单点函数、测试完备） |
| 6 | worker 单投递目标 | worker.js:108-163（sendMessageTo 唯一 senderId、scope mismatch 终态） | outbox 行已带 owner/conversation/deliveryScope | worker 按 item.deliveryScope 路由多目标（SDK sendMessageTo 本就支持任意目标） | 中 1-2d | 中（投错人=越权泄露，需 scope 矩阵测试） |
| 7 | 微信登录态单实例 | systemd HOME=weixin-session；loginBinding.js | 一个"小小"机器人号 | 保持单机器人多绑定（推荐）；多机器人才需多 worker+会话目录 | 小/大 | 低/高 |
| 8 | 各表 owner 列现状 | §3.2 ★◇✗ 标记 | ★NOT NULL 15+ 表；◇可空 4 表；✗缺失：knowledge、risk_items、visit_itineraries(仅 created_by)、sales_decision_analyses(仅 created_by)、招标全域、ai_insights/suggestions/manual_confirmations | 数据清洗（jiangjz/继振/legacy/??/NULL→规范 id）→◇表回填+NOT NULL→✗表补列或明确"全局域"（知识/招标建议全局） | 大 2-3d 含彩排 | 高（迁移，需 0002 式彩排+备份） |
| 9 | 快照适配器 owner 分支 | businessSnapshotAdapter.js：客户严格 :232-236；商机 owner 空回退客户 owner :237-244；行动三分支 :300-321；风险纯派生 :343-363；行程用 created_by :424,559-565；快速记录/周报严格 :474,748-758；**知识无过滤 :849-867** | 读路径已全面 owner 参数化（v0.7 铺垫） | #8 回填后收紧 NULL 回退分支即可 | 小 | 低 |
| 10 | **Web 端读写不做 owner 过滤** | GET customers 仅机器过滤、Web 全量（server.js:6002-6009）；GET :id 无过滤 :6035-6040；opportunities/actions/risks/knowledge/quick-records 同 | 单账号 Web=上帝视角；差旅域例外（已按 authContext.account 过滤，:4911 等） | **最大改造面**：全部 Web 读写按 account 过滤/落 owner，差旅域为现成模板 | 大 3-5d | 高（漏一处=越权） |
| 11 | 深写回 assignee 硬编码"继振" | server.js:1936（upsertActionFromQuickRecord；$due:"待确认"同硬编码；owner 继承 quickRecord.owner :1940-1942） | 展示负责人写死 | assignee 取 accounts.display_name | 小 0.5d | 低 |
| 12 | 调度器/晨报/提醒收件人 | server.js:2962-2965/2987-2990/2648-2658 全 `()=>runtime.owner` | 三调度器服务单人 | 遍历绑定逐 owner 生成；幂等键加 owner 维度（`daily-digest:{owner}:{date}` 等） | 中 1-2d | 中（补发/幂等回归） |
| 13 | 招标匹配全库客户 | server.js:2678-2681 | 匹配面=全部客户 | 建议：情报保持全局，推送按 match_customer_ids 的客户 owner 分发 | 中 | 低 |
| 14 | audit actor 无词表 | §3.3 实测 7 种混杂 | 自由文本 | 规范为 account id + system:*；历史不动 | 小 | 低 |
| 15 | idempotency_keys actor 维度 | idempotency.js:190-193 PK(actor,…) | 已隔离 | 零改动 | — | — |
| 16 | 周报草稿 owner 自由传入 | server.js:7070-7077（Web 可传任意 body.owner；机器已锁本人 OWNER_SCOPE_DENIED） | Web 信任输入 | 强制 authContext.account | 小 | 低 |
| 17 | hospitalTenderSyncOwner 回退 AUTH_ACCOUNT | config.js:397-403 | 外部监测器同步记单账号名下 | 归入全局招标域即免改 | — | — |
| 18 | 机器路由白名单静态 | machineAuthorization.js:20-36 | 集成级白名单 | 多绑定后单令牌可续用（senderId 在事件层分流），白名单不动 | 小 | 低 |

**总评**：读路径 owner 参数化完成度高（v0.7 系列刻意铺垫的资产）；**深水区为 ①Web 全量视角(#10)、②owner 数据清洗+FK 化(#8)、③微信绑定表化+worker 多目标(#3/#6)、④调度器 per-owner(#12)**。合计估 12–18 人日（不含真机验收）。

---

## 5. 联动性/完整性缺口

1. **招标命中→商机线索断链**：notices 持久化 match_customer_ids_json/match_score（hospitalTender/repository.js:573）并微信推送，但全域无"转线索/建商机/建待办"写路径（rg 无任何来自 tender 的 INSERT opportunities/action_items）——情报止步于消息，闭环缺最后一公里。
2. **拜访→客户温度断链**：快速记录确认深写回仅更新客户 sync_preview/needs/risks 与商机 requirements/solution_direction/risk/next（server.js:1880-1919），customers.relation（温度）只能 Web 手工改——"越拜访越熟"无数据通路。
3. **发票→报销闭环度**：结构完整（invoice_status 四态+无票确认+周建议/覆盖率端点+候选匹配），但缺口只在周五收尾包提醒一次（digestScheduler），无逾期升级；advance-settlement agent 合同明确禁写回（agentManifest.js:450）——多退少补最后一步永远人工（当前刻意保守，未来可放开）。
4. **死代码/未接线**：`deleteExpense`（TravelExpensePage.jsx:401）在 v0.8.3 生产为未接线死代码；审计时点 v0.8.4 进程正在接线（ExpenseLedgerWorkbench.jsx DeleteButton，工作树未提交改动实测）。孤儿测试 HospitalTenderPage.test.mjs 已修复挂门禁（commit 752a793）。
5. **合同不一致**：阶段词表两份（backend `stageVocabulary.js` ↔ 前端 kanbanStages，清册 §4-1）；settings 两组路由各留双别名路径（server.js:3913/3973）；owner"账号 id vs 中文显示名"双轨并存（§4 数据实况）；待办 remind_at 微信专写、Web 无编辑口（清册 §4-4）。
6. **错误处理与可观测性空白**：日志=console→journald 纯文本（worker 有 `category=` 结构化前缀，backend 无统一结构）；**备份失败、三调度器失败、outbox failed 积压、worker 掉线全部静默**（无 OnFailure、无巡检 timer、无心跳消费者）；提醒调度器状态仅内存；HttpError 错误码体系完备但无聚合面。
7. **微信不可达=静默降级**：worker 掉线时 outbox 堆积、提醒/晨报顺延补发（设计如此），但无人被告知掉线——单人系统里"收不到消息"即故障信号，多账号后此假设不成立。

---

## 6. 技术债与风险登记簿（合并 releases 遗留 + v0.8.4 清册 + 本审计新发现✦；按类分级）

**安全**
- S1 ✦【高】root 孤儿 qingyang dev 进程占 18899 三十天（§1.1）——核实后停删。
- S2 ✦【高·多账号前置】Web 层无 owner 隔离（§4-10）——单账号可接受，多账号第一收口点。
- S3 【中】IP 证书+default_sni 无域名；shortlived ACME 续期无监控（§1.2）。
- S4 【低】模型主键在 env 明文（0640）；secure_settings 白名单仅 3 键——现状可接受，记录在案。

**数据**
- D1 ✦【高】owner 值碎片化（legacy/??/显示名/NULL 混存，§4 实测）——多账号阶段 0 必须清洗。
- D2 【高】无异地备份副本（server-facts TODO-7 悬置）；每日快照与主库同盘。
- D3 ✦【中】v0.8.1–v0.8.3 制品未入 backups/releases 归档（§1.5 实测）。
- D4 【低】/var/lib 下 7 月遗留 candidate-f89e1e7.sqlite 三件套（server-facts TODO-9）。
- D5 【低】audit before/after 明文含业务数据、无保留期策略（现 254 行）。

**可用性**
- A1 【高·结构性】全栈单点：服务器×1、SQLite 单库单写者、微信 worker×1、微信登录态×1、Caddy×1、模型 provider×1、发布操作者×1（无 CI）。
- A2 【高】失败零告警面（§5-6）。
- A3 【低】outbox 4 条 failed 陈账（清册 §4-3；requeueFailed 仅可重试码，需人工核销）。
- A4 【低】招标 lenient 观察项（坏公告拒整批，v0.7.7 偏差③，已自愈保持观察）。
- A5 【低】spokenTime 不解析分钟级相对时间（交付报告 §3-7）；晨报 5 项开放问题默认保守（清册 §4-7）。

**维护性**
- M1 【高】server.js 7,470 行单文件 if 链路由+组合根——每个端点都碰同文件（§2.1）。
- M2 【中】runtimeHandlers 2,884 / shortcutBookkeepingRuntime 2,461 行；naturalPlan 前缀膨胀（清册 §4-2）。
- M3 【低】前端主 chunk 683 KB 超 vite 默认 500 KB 警告线（dist/assets/index-*.js 实测；无 vite.config 手动分包；pdf 443 KB 已自然分包）。
- M4 【中】服务器 staging 1.5G/candidates/incoming/6 月手工目录待清（§1.7，清册 §6 方案待批）；本机 .worktrees 9.6 GB（清册 §1，实施中）。
- M5 【中】docs 七份主文档停 v0.2–v0.5 口径（清册 §5）；Caddyfile/机器 env 无仓库版本管理。
- M6 【低】阶段词表双份、settings 双别名路径（§5-5）。

---

## 7. 规模与性能

- **数据库体量**：主库 2.0 MB + WAL 1.3 MB；54 表合计约 700 行（最大 audit_logs 254、scheduler_runs 67、draft_parts 76，业务实体均 ≤17）。当前单人写入节奏下**年增 < 5 MB**；多账号 ×N 线性放大后仍距 SQLite 能力数个数量级。owner+状态+时间复合索引全覆盖高频查询（§3 索引清单）。
- **进程资源**：backend 77 MB / worker 65 MB / frontend 44 MB / caddy 38 MB RSS，主机 3.6 GB 余量充足；模型调用为出站 HTTP（30s 超时+确定性兜底），无本地推理。三调度器与 HTTP 同一事件循环——当前负载无碍；重活（python 采集）已 spawn 隔离（internalRunner.js:29-48 且凭据不入子进程环境）。
- **大文件**：server.js 7,470（编辑热点）、runtimeHandlers 2,884、shortcutBookkeepingRuntime 2,461、router 976、businessSnapshotAdapter 882；前端 pages.jsx 已在 v0.8.4 拆为桶文件 12 行 + pages/ 13 域文件共 4,011 行（commit 34dc7d7 实测），App.jsx 1,698 行为下一候选。
- **构建**：dist 2.9 MB；index chunk 683 KB（M3）。测试规模：backend 143 文件/1,276 项、前端 434 项、根 deploy 249 项（交付报告收官判定），qa:full 全绿门禁。
- **单机单点清单**：见 A1；另注意微信登录态是"最难恢复的状态"（QR 重扫即可但依赖人工），weixin-session 已随每次 cutover tar 备份。

## 8. 值得保留的架构资产（改造时勿破坏）

① 不可变 release+四关+自动回滚（两次实战自救）；② outbox 租约幂等投递（8 试+终态+requeue 白名单+isCurrent 防超发）；③ 工具策略默认拒绝+R0-R3 分级确认+六位码 HMAC+提示注入拦截；④ businessSnapshotAdapter 把 owner 过滤 SQL 收敛单文件；⑤ document_blobs 触发器级防篡改；⑥ 迁移彩排纪律（/dev/shm 隔离副本+SHA 对账）；⑦ "表即队列"轻调度器模式；⑧ 每日 VACUUM INTO 在线备份；⑨ 机器令牌路由白名单+timingSafeEqual；⑩ 全链幂等键词汇（action-reminder:/daily-digest:/hospital-tender:cycle:）。

## 9. 给下一代方案的十大架构建议

1. **多账号改造走"数据先行"四阶段**（映射 §4 十八项）：
   - **阶段 0 · 清洗（先行独立发布）**：定 owner 规范词表=账号 id；迁移回填 jiangjz/继振/legacy/??/NULL（逐表 UPDATE+审计+彩排），不改任何行为——把 D1 消灭在改造前。
   - **阶段 1 · 认证层**：accounts 表（id/display_name/password_hash/status）替代 AUTH_ACCOUNT/AUTH_PASSWORD_HASH（#1）；auth_sessions/限速零改动（#2）；env 单账号导入为种子行，回滚=切回 env 校验。
   - **阶段 2 · 数据层+Web 隔离（整版发布）**：◇表 owner NOT NULL+引用 accounts；✗表逐一决策（知识/招标=全局域，risk/itinerary/sales_decision 补 owner）（#8）；**同版完成全部 Web 读写 owner 过滤**（#10，差旅域 `request.authContext.account` 是现成模板；周报 owner 传入一并收口 #16）；快照适配器收紧 NULL 回退（#9）；assignee/audit actor 词汇统一（#11/#14）。
   - **阶段 3 · 微信绑定层**：weixin_bindings(account, sender_id, financial_enabled, bound_at) 替代三枚 WEIXIN_*_OWNER env（#3/#4）；businessOwnerResolver 改查表、闭合语义不变（#5）；worker 按 deliveryScope 多目标投递（#6，SDK 已支持）；三调度器 per-binding 循环、幂等键加 owner 维度（#12）；招标推送按客户 owner 分发（#13）。单机器人多绑定优先，不上多 worker（#7）。
2. **先建告警面再扩功能**：全部 sentelligent-* 单元与备份 timer 挂 `OnFailure=` →经 outbox 发小小（PushPlus 兜底）；加 5 分钟巡检 timer 盯 outbox failed 积压/worker 心跳/三调度器 lastError/备份新鲜度——把 A2"静默失败"清零，是多账号 SLA 地基。
3. **拆 server.js（M1）**：按 §2.2 十七个域抽 handler 模块+显式路由表，组合根只留装配；沿用 pages.jsx"桶文件+守护测试改取源"已验证拆法，单版单提交可回滚。
4. **异地备份闭环（D2/D3）**：每日快照+backups/releases 加密同步到对象存储/异机（rclone 级即可），恢复演练入 runbook；顺手补归档 v0.8.1–0.8.3。
5. **联动补链（§5-1/2/3）**：招标命中→"转线索"一键（建商机草稿+待办，R2 确认）；拜访确认→relation 温度建议值（预览确认制）；发票缺口逾期升级提醒。全部复用既有 pending-action 确认框架与 outbox，不发明新模式。
6. **收口服务器杂物（S1/M4/M5）**：核实停删 18899 root 孤儿进程；按清册 §6 清 staging/candidates/incoming 与 6 月目录；Caddyfile 与 systemd 单元入仓版本管理。
7. **术语统一**：代码/审计/文档统一 account（登录身份）/display_name（展示名）/binding（微信绑定）三概念，杜绝"继振 vs jiangjz"双轨复发。
8. **坚持 SQLite+单机纵向演进**：当前与可见将来的体量（§7）距 SQLite 上限数个数量级；把预算投给告警/异地备份/Web 隔离，**迁 PG/MySQL 是伪需求**；若多账号并发写增长，先做"调度器批量事务化+busy_timeout 校准"即可。
9. **模型层备援**：MODEL_PROVIDER 已抽象，补一个备用 provider 配置与手动切换 runbook（A1 模型单点）；vision/text 双键保持。
10. **流水线两件小事**：bundle 上传 `--expect-sha256` 自动对账（server-facts TODO-11）；前端 manualChunks 压 index <500 KB（M3）——均为既有脚本增量。

---

### 附：证据索引

服务器只读命令（2026-08-28 22:5x–23:1x CST）：`systemctl list-units/list-timers`、`ss -tlnp`、`ps -eo`、7 份 unit 文件全文、Caddyfile 全文、backend.env/frontend.env 键名打码、`du -sh`、node:sqlite readOnly（sqlite_master 全量导出/54 表行数/owner 分布/outbox 状态与 failed 明细/调度器状态/audit actor 分布）、`journalctl -u`（backend/weixin-agent/daily-backup）、`tools/daily-db-backup.sh` 与 `archive-release-artifacts.sh`、backups/daily 与 backups/releases 目录、monitor.env 键名、`readlink current`。代码引用为 `.worktrees/integrate-v0626-candidate` 审计时点行号（v0.8.4 并行实施，**行号可能漂移**）。历史文档：`docs/superpowers/reports/2026-08-28-v07-series-delivery-report.md`、`research/2026-08-28-v084-engineering-health-inventory.md`、`research/2026-08-28-v080-server-facts.md`、`research/2026-08-27-v080-backup-design.md`、releases v0.7.0–v0.8.3、CHANGELOG。
