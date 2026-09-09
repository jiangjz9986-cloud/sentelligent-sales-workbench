# 并行开发与文件所有权

2026-09-10 更新：用户将融合实施和生产交付收回主任务
`01a07521-3776-7b00-bcb7-559545c7c4a3`。另一 AI 任务已停止；
当前写集由主任务在 `ai-platform-production-integration-20260909`
中统一持有，共享文件串行整合。现行授权和实施边界见
[FUSION-EXECUTION.md](FUSION-EXECUTION.md)，下文保留为历史协作记录。

## 1. 任务身份

| 项目 | AI 平台任务 | 原升级任务 |
| --- | --- | --- |
| 标题 | AI 统一调度平台一期开发 | 继续开发 v0.12.0 完整升级 |
| 任务 ID | `01a07c0f-8927-7793-b734-e5d94c305f83` | `01a07521-3776-7b00-bcb7-559545c7c4a3` |
| 分支 | `codex/ai-unified-platform-v1` | `codex/v0120-full-upgrade` |
| 工作树后缀 | `.worktrees/ai-unified-platform-v1` | `.worktrees/v0120-full-upgrade` |

初始 AI 平台基线：`741d104e79e2c81a040a2e9ef84bd635c294f1b9`。

2026-09-07，原升级任务已通过任务消息确认：继续持有现有 v0.12.1 修复树，负责 PushPlus 退役、微信 readiness/到期预警、发布校验和现有产品前端，避免与新增 AI 目录交叉。

2026-09-08，AI 平台分支在重建并通过完整历史密钥扫描后，由原升级任务从共同基线 `741d104e79e2c81a040a2e9ef84bd635c294f1b9` 快进整合 `3337b340`、`8732328e`、`2e046cc3`。本文件以下写集规则继续约束后续业务接线；本次整合只纳入独立目录、新共享合同和受限客户端，没有挂载业务路由、迁移业务数据库或切换生产服务。

## 2. AI 平台任务独占写集

- `ai-platform/**`
- `docs/ai-platform/**`
- `shared/aiPlatformContract.mjs`
- `backend/src/aiPlatform/**`
- `outputs/ai-platform-admin/**`
- `scripts/ai-platform/**`

不得把业务库迁移文件放进上述目录后在未协调情况下挂入业务迁移注册表。

## 3. 原升级任务持有

- 现有微信 worker、绑定、readiness、通知、旧 outbox 修复与生产 smoke 清理。
- 现有 PushPlus 退役与通知配置变更。
- `outputs/product-design-prototype/**` 现有产品页面、应用壳和共享样式。
- 当前业务发布、生产预检、cutover、服务清单及既有版本字段。

AI 平台任务可以读取这些文件作为接口证据，但不能在对方工作树中编辑、安装依赖、启动服务、提交或切换分支。

## 4. 共享文件整合规则

以下文件在双方工作尚未收口前不由 AI 平台任务修改：

- `backend/src/server.js`、`backend/src/config.js`
- `backend/src/modelAnalysis.js`、`backend/src/ai/agents/salesDecisionAgent.js`
- `backend/src/assistant/orchestrator.js`、`proactiveBackgroundWorker.js` 及既有助手合同
- `backend/src/asr/**`、`backend/src/settings/**`
- `shared/salesWorkbenchApiContract.mjs`
- `backend/src/db/migrations/**` 与业务迁移注册表
- 根和现有产品包的 `package.json`、锁文件、`VERSION`、`CHANGELOG.md`
- 既有产品前端应用壳、路由、登录与共享 API 客户端
- `scripts/production-*.mjs`、`scripts/production-cutover.sh` 和原部署单元

整合流程：

1. AI 任务准备最小适配说明，明确接口、文件、预期行为和测试。
2. 对方给出已提交且已验收的修复 SHA，以及本次允许的共享文件窗口。
3. 先确认工作树干净，评审提交；只在 AI 工作树合并或摘取明确提交，不在对方分支直接合并 AI 工作。
4. 共享文件按窗口串行修改，重新运行双方受影响用例和完整门禁。
5. 交换精确提交、差异摘要和验收证据。未确认前不修改对方任务的发布版本或生产状态。

如有冲突，保留双方原始提交，不执行强制覆盖、reset --hard 或 checkout --。

## 5. 运行时隔离

- AI 平台 API 端口候选：`18997`；管理页面候选：`18088`。启动前检查占用，冲突则更换，不能杀占用者。
- 平台数据库、测试库、日志、临时媒体、浏览器证据和 PID 文件都放在本工作树忽略目录。
- 不复用对方开发服务的 Cookie、端口、数据库、.runtime 或浏览器配置目录。
- 开发脚本必须确认 PID、工作目录、启动时间或任务标识后才停止自己的进程。
- 避免同时运行全量历史扫描/全量浏览器套件；重型验证窗口通过任务消息协调。
- 禁止读取 iCloud、生产环境文件、真实密钥或业务数据库用于本地开发。

## 6. 生产边界

本任务当前只负责本地开发、测试和发布方案。未经单独授权，不访问付费生产模型、不向真实微信发送消息、不部署、不改生产配置或业务数据库，也不重启任何生产服务。

原升级任务已获授权的生产动作不自动授权给 AI 平台任务。
