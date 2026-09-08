# 微信 Clawbot 助手集成说明

## 当前候选边界

本说明描述小小微信助手当前候选，不构成生产切换或真实设备验收证据。现有生产事实仍以部署记录和服务器 evidence 为准。

## 入站事件与身份

候选使用 vendored `weixin-agent-sdk@0.5.0-sentelligent.10` 的受限入站元数据调用：

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

微信记账使用独立确认策略，不适用上述通用六码。本人必须引用小小已经成功送达的当前版本草稿，再用自然语言确认、修改字段或取消；疑问句、没有引用的回复、其他 sender、群聊或旧版本草稿都不会写账。

付款凭证图片和收入/支出文字先进入 OCR/AI 草稿；多笔交易截图可拆成多个独立草稿。确认后才写入报销记录并关联压缩付款凭证。后续发票图片/PDF按金额优先匹配当前自然周的唯一条目；歧义或超出日期窗口时进入人工复核。

## 运行配置与轮换

真实值只配置在私有环境文件中，不进入 Git、日志或聊天：

```text
WEIXIN_AGENT_API_TOKEN=<独立机器 Token>
WEIXIN_AGENT_BACKEND_URL=https://<公网基址>
WEIXIN_AGENT_OWNER=<正式账号>
WEIXIN_BOOKKEEPING_CONFIRMATION_ENABLED=true
WEIXIN_BOOKKEEPING_OWNER=<与 WEIXIN_AGENT_OWNER 一致>
WEIXIN_BOOKKEEPING_SENDER_ID=<本人 sender ID>
WEIXIN_OUTBOX_POLL_MS=5000
WEIXIN_ALLOWED_SENDER_IDS=<逗号分隔的 sender ID；未绑定时留空，所有入站都会被拒绝>
WEIXIN_ALLOW_GROUPS=false
WEIXIN_ALLOWED_GROUP_IDS=
ASSISTANT_CONFIRMATION_SECRET=<独立的至少 32 字节 canonical base64url 密钥>
```

`ASSISTANT_CONFIRMATION_SECRET` 必须独立于 session、机器 Token 和模型密钥；非 loopback 后端必须使用 HTTPS。旧 iCost/快捷指令写入变量不得出现在生产环境中。

机器 Token 轮换时：

1. 停止旧 Token 对应的 worker 接收新消息；
2. 排空并封存旧 worker 的 polling cursor；
3. 确认旧 Token/cursor 不再消费后启用新 Token 和新 worker；
4. 禁止新旧 Token 或 cursor 并行消费。

## 主动推送窗口与心跳边界

微信主动发送依赖最近一次真实入站消息携带的 `context_token`。SDK 将它以 AES-256-GCM 密文保存在微信 session 目录，密文同时绑定 Clawbot 账号、目标用户、到期时间和由 `WEIXIN_AGENT_API_TOKEN` 派生的 delivery key；服务重启或 release 切换后，只要账号和机器 Token 未变化，仍在有效期内的 context 可以恢复，明文不会写入磁盘或日志。

本项目按 23 小时本地安全窗口处理该凭据。空轮询、typing、`getconfig` 和普通定时 heartbeat 不能替代真实微信入站，也不得被声明为续期成功。运维巡检在剩余不足 3 小时和已过期时分别告警；到期后，新消息继续保留在 durable outbox，不增加发送尝试次数。本人向小小发送任意一条真实微信消息取得新 context 后，worker 再按约 1 秒间隔释放积压，避免短时间突发发送。

因此定时任务的职责是检查 worker heartbeat、outbox backlog 和 context 到期时间，而不是伪造微信心跳。机器 Token 轮换、重新扫码导致账号身份变化，或 session 目录被清空时，旧 context 密文必须失效并等待同一目标用户的新入站消息。

## 本地验收与发布边界

```bash
npm --prefix backend test
node --test backend/tests/assistant-http-integration.test.js backend/tests/weixin-confirmation-closure.test.js
npm run scan:secrets
```

这些检查通过只说明代码候选满足本地契约。真实微信设备往返、生产 Token 配置、发布归档、受控切换、fresh preflight 与 post-check 必须另行授权并取得当次证据。
