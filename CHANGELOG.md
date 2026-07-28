# 变更日志

本项目按语义化版本记录代码变更。版本条目表示对应代码已经冻结，不自动表示 tag、GitHub Release 或生产部署已经完成。条目时间使用 ISO 8601 和 `Asia/Shanghai` 时区；正式发布以 GitHub Release 的 `publishedAt`、标签提交和资产 SHA-256 为准，生产状态以部署记录和服务器 evidence 为准。

## [Unreleased]

### 计划

- 完成录音资产上传、认证播放、Range 下载、删除恢复和 Safari 实机回归。
- 完成微信消息事件幂等、草稿持久化和单消费者保护。
- 使用真实赢单、输单、暂停和合规升级案例校准销售决策评分。
- 把根 HTML 的 HSTS、CSP 等响应头补齐到与 API 一致，不直接修改共享 Caddy。

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
- DeepSeek 销售决策 Agent V1、智能拜访行程和高德路线已上线。
- Cookie 登录、七天会话、CSRF、Origin、乐观锁、软删除、审计和一致性备份已启用。
- 微信机器人绑定入口和 worker 已部署。

### 生产验收

- DeepSeek 预览、持久化分析和销售决策均返回 `source=deepseek`。
- 高德路线验收返回约 `379076m`，路线和优化结果可持久化读取。
- 登录、CORS、CSRF、CRUD、审计、周报、微信状态、软删除和乐观锁均通过公开 HTTPS 冒烟。

## [0.1.0-baseline] - 2026-07-15T00:00:00+08:00

- 建立首个可测试项目基线。
- 确认 Apple Design 风格一。
- 完成第一阶段安全、数据、备份和认证设计。

[Unreleased]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.2.0
[0.1.0]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0
[0.1.0-baseline]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0-baseline
