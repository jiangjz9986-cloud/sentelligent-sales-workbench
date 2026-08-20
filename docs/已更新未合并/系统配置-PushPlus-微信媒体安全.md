# 系统配置、PushPlus 与微信媒体安全

## 登记信息

- 编号：`settings-config-pushplus`
- 状态：`评审中`（已加入聚合分支，等待聚合 CI 和人工评审）
- 登记日期：2026-08-20
- 来源分支：`codex/settings-config-pushplus`
- 来源提交：`bd4fca2168968a6f58ac62e70c5d7c8faf34e22a`
- 聚合分支：`codex/unmerged-updates`
- 目标分支：`main`
- 来源 Draft PR：[PR #36](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/pull/36)，状态：Open / Draft / 未合并
- 聚合 Draft PR：[PR #38](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/pull/38)，状态：Open / Draft / 未合并

本次已将来源提交以独立聚合提交带入 #38，同时保留来源 PR #36 作为独立审查入口；医院招标、小小助手及其他功能分支没有被改写。

## 这次更新了什么

- 系统配置页增加 iCost Token 生成/轮换、DeepSeek API Key 加密保存/替换/清除，以及医院招标 PushPlus Token 加密保存/替换/清除和无客户数据测试通知。
- 增加 `0019_secure_settings_pushplus` 安全配置迁移，提供掩码、来源、启用状态、最近投递结果和有界计数；显式清除会抑制旧环境回退。
- 医院招标通知在发送时读取加密 Token，配置缺失时继续采集并明确报告通知停用状态。
- vendored `weixin-agent-sdk` 升级到 `0.5.0-sentelligent.2`：配置/CDN 访问前执行 sender/group allowlist，媒体下载流式限制 12 MiB，增加长度、超时、取消、解密后大小校验和临时文件清理；永久拒绝推进 polling cursor，临时错误保留重试。
- 补充 owner 隔离、模型/附件响应边界、下载响应头安全、配置页和微信回归测试及文档。

## 用户可见结果

- 登录后的系统配置页可以查看非敏感状态、掩码、来源和投递健康信息，并安全管理三类服务凭据。
- PushPlus 测试通知不携带客户数据；清除配置后不会偷偷回退到旧环境 Token。
- 微信不允许未授权 sender/group 触发配置或媒体访问，超限媒体不会被无界缓冲；永久拒绝不会卡住后续 polling。
- 这些结果仍属于待合并候选，不代表已经发布或生产启用。

## 没有做什么 / 硬边界

- 没有合并到 `main`，没有部署、重启生产或发送真实 PushPlus 客户通知。
- 没有把任何真实 Token、API Key、Cookie、客户原文或生产数据写入文档、日志或聚合登记。
- 没有改变医院招标、小小助手或其他功能分支的提交；只在聚合分支保留各自的独立更新。
- 反向代理后的登录限流策略仍未在本次登记中擅自改变。

## 验证证据

来源分支本地证据：

- 后端全量：`npm --prefix backend test`，`789/789` 通过。
- 前端 API 回归：`npm run test:api`，`59/59` 通过。
- 工作树 secret scan：`444` 个文件，`0` 条发现。
- 修改模块 `node --check` 和 `git diff --check`：通过。
- 此前本地 release/production preflight、前端 `qa:local`、integration QA 和 WebKit QA 也已通过；这些属于本地/候选证据，不等同于生产验收。

聚合分支合并回归：

- 后端全量：`npm test`，`888/888` 通过。
- 前端 API：`npm run test:api`，`59/59` 通过。
- 迁移顺序已验证为 `0019 → 0020 → 0021`，保留医院招标和小小助手已有迁移。
- Node 语法检查、冲突标记检查和 `git diff --check`：通过。
- 聚合工作树 secret scan 当前命中小小助手既有测试中的 2 条 API-key assignment 模式；这不是本次新增凭据，需与聚合 CI 一并人工复核，未放宽扫描规则。

来源 Draft PR #36 的远端证据：

- GitHub Actions 失败步骤：`Scan current source for secrets`。
- 历史扫描命中 19 条旧测试历史中的 API-key assignment 记录；来源工作树扫描仍为 0 条发现。
- 详情：[Actions run 32296952050](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/actions/runs/32296952050)。

## 主要代码范围

- `backend/src/settings/repository.js`
- `backend/src/db/migrations/0019_secure_settings_pushplus.mjs`
- `backend/src/db/migrate.js`
- `backend/src/server.js`
- `backend/src/hospitalTender/notifier.js`
- `backend/src/weixin/worker.js`
- `backend/src/weixin/remoteAgent.js`
- `backend/vendor/weixin-agent-sdk/`
- `outputs/product-design-prototype/src/features/settings/SystemSettingsPage.jsx`
- 对应配置、医院招标和微信回归测试

## 合并前需要确认

- 等待 #38 新提交的聚合 CI 完成，并单独处理 secret scan 门禁；不能把本地通过当作远端绿色。
- 完成代码评审，确认共享 `server.js`、`App.jsx`、`global.css` 和迁移顺序的跨功能回归。
- 复核反向代理登录限流方案；Codex Security 托管扫描（`9c2746cd-d6bc-4c6b-b29e-035ad108e2bf`）完成后再评估证据。
- 获得明确的手动合并授权；聚合专区本身不执行合并、发布或部署。
