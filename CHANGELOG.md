# 变更日志

本项目按语义化版本记录代码变更。版本条目表示对应代码已经冻结，不自动表示 tag、GitHub Release 或生产部署已经完成。条目时间使用 ISO 8601 和 `Asia/Shanghai` 时区；正式发布以 GitHub Release 的 `publishedAt`、标签提交和资产 SHA-256 为准，生产状态以部署记录和服务器 evidence 为准。

## [Unreleased]

### iOS 快捷指令真实记账

- 新增 `0018` 快捷记账台账和 `POST /api/integrations/shortcut/bookkeeping`，支持账号全局幂等、处理租约、失败恢复和审计。
- 出差报销支出写入森特差旅费用和支付记录；biubiu 通过固定 loopback 地址与独立 bridge credential 写轻氧，远端未确认时 fail closed。
- Token 验证只有在写入链路配置完整时返回 `bookkeepingReady=true`；生产 preflight 扩展为 `27/27` 并校验桥接凭据隔离。

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
