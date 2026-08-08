# 变更日志

本项目按语义化版本记录代码变更。版本条目表示对应代码已经冻结，不自动表示 tag、GitHub Release 或生产部署已经完成。条目时间使用 ISO 8601 和 `Asia/Shanghai` 时区；正式发布以 GitHub Release 的 `publishedAt`、标签提交和资产 SHA-256 为准，生产状态以部署记录和服务器 evidence 为准。

## [Unreleased]

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

[Unreleased]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.4.1...HEAD
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
