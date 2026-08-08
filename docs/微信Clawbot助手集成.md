# 微信 Clawbot 助手集成说明

## 当前交付范围

本版本复用现有 `weixin-agent-sdk` 扫码和收发链路，把后端入口升级为持久化助手事件 API：

```text
POST /api/integrations/weixin-agent/events
Authorization: Bearer <WEIXIN_AGENT_API_TOKEN>
Idempotency-Key: <sourceMessageId 或 weixin:sourceMessageId>
```

机器 Token 只允许这一个事件路由，以及既有的快速记录预览、待处理区上传路由。owner 由服务端机器身份配置，正文不能覆盖 owner、actor、URL、SQL、路径或 Token。

## 请求字段

必填：

- `conversationId`：Clawbot 会话标识
- `text`：文本或命令，最多 20,000 字符
- `sourceMessageId`：来源消息标识；若 SDK 没有真实消息 ID，由 worker 用会话、文本和媒体 SHA-256 稳定生成
- `senderId`：发送者身份，必须命中 `WEIXIN_ALLOWED_SENDER_IDS`
- `chatType`：`direct` 或 `group`

可选：

- `groupId`：群聊时必填；群聊默认拒绝
- `pendingActionId`、`confirmationCode`：人工确认门的后续请求；确认码只接受六位数字
- `media`：`type`、`fileName`、`mimeType`/`mediaType`、`contentBase64`，可带 `sha256` 和 `sourceRef`

图片/PDF 会在服务端重新做 canonical Base64、魔数、MIME、文件名、12 MiB 和 SHA-256 校验，再按现有无损文档仓库保存。不会把媒体重编码成有损格式。

## 会话和写入规则

- 普通“拜访/电话/会议/沟通”文本进入 `visit-capture.collect`，只写持久化草稿。
- “记录”进入预览；“录入”创建人工确认动作，收到确认码后才写入快速记录和 AI 分析。
- `/客户` 或“查询客户”是只读查询。
- `/付款凭证` 和 `/发票` 先进入待处理区/发票仓库，不要求确认；正式关联、匹配、无票确认仍在确认门之后完成。
- “销售周报”和“报销周汇总”分开路由，不能猜测歧义。
- `solution`、`personal-finance` Agent 仍保持禁用。

所有事件、会话、草稿、待确认动作和工具运行结果写入 SQLite `0011` 迁移新增的助手运行时表。事件按 owner/channel/source 消息幂等；同一消息 ID 携带不同正文返回 409。确认码仅以 HMAC 形式保存在待确认表，首次响应后重放不再返回明文确认码。

## 运行配置

在私有环境文件中配置（不要提交 Git）：

```text
WEIXIN_AGENT_API_TOKEN=<森特智行专用机器 Token>
WEIXIN_AGENT_BACKEND_URL=https://<森特智行公网基址>
WEIXIN_AGENT_SENDER_ID=<可选，SDK 没有 sender 字段时的默认值>
WEIXIN_AGENT_CHAT_TYPE=direct
WEIXIN_ALLOWED_SENDER_IDS=<逗号分隔的 sender ID>
WEIXIN_ALLOW_GROUPS=false
WEIXIN_ALLOWED_GROUP_IDS=<可选的群 ID 白名单>
```

森特智行和轻氧智能门店必须继续使用独立 URL、Token、数据库和审计，不能复用任何密钥或 owner。

## SDK 兼容边界

当前 `weixin-agent-sdk@0.5` 的 `ChatRequest` 只提供 `conversationId`、`text` 和本地媒体路径，不提供真实 `senderId`、`messageId` 或群聊元数据。worker 因此默认用 `conversationId` 作为 sender 身份，默认按 `direct` 发送；没有命中 sender 白名单的请求会被服务端拒绝。升级 SDK 后应优先把真实 sender/message/chat 元数据映射到上述字段，并重新做真实微信设备验收。

## 本地验收

```powershell
npm --prefix backend test
node --test backend/tests/assistant-http-integration.test.js
npm run scan:secrets
```

真实设备往返、生产环境 Token 配置和生产部署仍需单独授权；本版本代码验证不等于已完成生产发布。
