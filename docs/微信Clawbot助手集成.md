# 微信 Clawbot 助手集成说明

## v0.5.4 候选边界

本说明描述当前 v0.5.4 热修复候选，不构成生产切换或真实设备验收证据。v0.5.3 的生产切换曾因未配置 sender 白名单自动回滚；现有生产事实仍以部署记录和服务器 evidence 为准。

## 入站事件与身份

候选使用 vendored `weixin-agent-sdk@0.5.0-sentelligent.1` 的受限入站元数据调用：

```text
POST /api/integrations/weixin-agent/events
Authorization: Bearer <WEIXIN_AGENT_API_TOKEN>
Idempotency-Key: <opaque sourceMessageId>
```

适配层取得 `senderId`、`chatType`、`conversationId`、消息身份和投递时间，并以机器 Token 派生不透明 delivery ID。缺少可验证 sender、聊天类型、稳定投递 ID 或投递时间时，在请求后端前失败关闭；生产不把 conversation 当作 sender，也不把会话/文本摘要当作消息身份。

请求正文必填 `conversationId`、`text`、`sourceMessageId`、`senderId`、`chatType`（`direct`/`group`）；群聊时可带 `groupId`。媒体只接收原始 Base64、文件名、MIME 和可选 SHA-256，服务端重新校验魔数、MIME、长度和摘要，单文件上限 12 MiB，原始字节无损保存。

## 私聊确认闭环

生产只接受 `WEIXIN_ALLOWED_SENDER_IDS` 中的 sender，并拒绝群聊（`WEIXIN_ALLOW_GROUPS=false`、群白名单为空）。首次部署且尚未绑定微信时允许该列表为空；此时服务正常启动，但所有微信入站事件都会被拒绝，直到配置真实 sender ID。需要写入时，服务端将待确认动作绑定到持久化工具名、参数、owner、sender、channel 和 private conversation。

- 确认：在产生动作的同一私聊中直接回复恰好六位 ASCII 数字，例如 `012345`，无需 action ID。
- 取消：原始文本必须精确等于 `取消`。
- 重发：原始文本必须精确等于 `重发确认码`，旧码立即失效，新码只展示一次。

命令不做 trim 或 Unicode 数字归一化；前后空格、换行、全角数字、`确认 012345` 或附加文字均不匹配。连续五次错误确认后动作锁定。确认码只在生成的微信回复中展示一次，SQLite 仅保存 HMAC；事件、响应投影、会话、草稿、待确认动作、工具结果和日志不得包含明文确认码。执行租约和稳定工具运行身份负责并发、重试和崩溃恢复。

## 运行配置与轮换

真实值只配置在私有环境文件中，不进入 Git、日志或聊天：

```text
WEIXIN_AGENT_API_TOKEN=<独立机器 Token>
WEIXIN_AGENT_BACKEND_URL=https://<公网基址>
WEIXIN_ALLOWED_SENDER_IDS=<逗号分隔的 sender ID；未绑定时留空，所有入站都会被拒绝>
WEIXIN_ALLOW_GROUPS=false
WEIXIN_ALLOWED_GROUP_IDS=
ASSISTANT_CONFIRMATION_SECRET=<独立的至少 32 字节 canonical base64url 密钥>
```

`ASSISTANT_CONFIRMATION_SECRET` 必须独立于 session、机器 Token、模型密钥和 iCost Token；非 loopback 后端必须使用 HTTPS。森特智行和轻氧继续使用独立 URL、Token、owner、数据库和审计。

机器 Token 轮换时：

1. 停止旧 Token 对应的 worker 接收新消息；
2. 排空并封存旧 worker 的 polling cursor；
3. 确认旧 Token/cursor 不再消费后启用新 Token 和新 worker；
4. 禁止新旧 Token 或 cursor 并行消费。

## 本地验收与发布边界

```bash
npm --prefix backend test
node --test backend/tests/assistant-http-integration.test.js backend/tests/weixin-confirmation-closure.test.js
npm run scan:secrets
```

这些检查通过只说明代码候选满足本地契约。真实微信设备往返、生产 Token 配置、发布归档、受控切换、fresh preflight 与 post-check 必须另行授权并取得当次证据。
