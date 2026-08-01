# 变更日志

本项目按语义化版本记录代码变更。版本条目表示对应代码已经冻结，不自动表示 tag、GitHub Release 或生产部署已经完成。条目时间使用 ISO 8601 和 `Asia/Shanghai` 时区；正式发布以 GitHub Release 的 `publishedAt`、标签提交和资产 SHA-256 为准，生产状态以部署记录和服务器 evidence 为准。

## [Unreleased]

### v0.3.0 UI redesign candidate

- 整体视觉升级：品牌主色 `#007aff` 调整为 `#2f6bff`，语义色加深（绿 `#16a34a`、橙 `#d97706`、红 `#dc2626`），去除大窗框圆角改全出血布局。
- 侧栏改为藏青深色渐变并新增「AI 同步引擎」状态卡；登录页改为左侧深蓝品牌区、右侧表单的分栏布局。
- KPI 卡片增加彩色图标芯片（lucide 图标），卡片改白底发丝边框，表格数字使用 `tnum` 等宽数字。
- 无数据库迁移、无 API 变更、无依赖升级；为纯样式与少量 JSX 结构变更，必须重新通过生产 `19/19` 预检和 `25/25` HTTPS 冒烟。

### v0.2.5 hotfix candidate

- 将快速记录 DeepSeek 请求的 completion token 预算从 1200 调整为 3200，避免推理型模型在生成最终 JSON 前因 `finish_reason: length` 截断并静默降级。
- 增加请求预算回归测试；不修改数据库、认证、部署配置或其他模型任务的 token 预算。
- 生产发布门禁仍要求预检 `19/19`、HTTPS 冒烟 `25/25` 且物理清理为 `clean`。

### v0.2.4 hotfix candidate

- 完整收口销售决策阶段边界：`stage.current` 始终来自服务端事实；`stage.recommended` 仅接受 `sales-decision-v1` 规范枚举，未知值保守回落到 current。
- 修复 `v0.2.3` 生产冒烟仍出现的 `stage.recommended` 非规范业务阶段导致 DeepSeek 分析整体降级问题。
- 无数据库迁移、无依赖升级、无认证或部署配置变更；必须重新通过生产 `19/19` 预检和 `25/25` HTTPS 冒烟。

### v0.2.3 hotfix candidate

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

[Unreleased]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.1
[0.2.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.0
[0.1.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0
[0.1.0-baseline]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0-baseline
