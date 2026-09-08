# AI 平台 v1 内部接口草案

状态：独立平台 M1/M2/M4 基础合同已在提交 `0d693152b3c3d099d8e04a634d4786b874d2e19a` 中实现并由本地测试覆盖；业务共享整合前仍属于内部 v1 合同，不宣称现有业务入口已经全部切换。

## 1. 通用约束

- API 前缀：`/internal/ai/v1`。
- 平台运行 API 只接受被认证的服务请求；浏览器经业务端代理访问。
- 业务主体身份由可信业务服务声明，不能从浏览器任意正文推导。
- 身份至少包括 issuer、owner、actor、能力范围、请求标识、有效期；当前实现使用 HMAC bearer service token，开发认证捷径只允许非生产配置。
- 内部服务身份不替代业务 owner 权限；读取、取消与结果投递都校验作用域。
- 响应均包含稳定错误码和 `requestId`；不得把供应商原始错误、密钥或内部路径返回前端。
- v1 采用有界 JSON；媒体通过独立有界通道处理，不把任意 URL 当作下载指令。
- 输入允许的字段、字符串长度、数组长度、递归深度及响应上限需要逐字段合同测试。

## 2. 任务类型

初始登记范围如下，实际与现有函数逐个对照后冻结，不得以列表代替已接入证明：

| 任务类型 | 来源功能 | 接入阶段 |
| --- | --- | --- |
| `weekly.generate` | 销售周报 | M3 |
| `quick-record.analyze` | 快速记录 | M3 |
| `suggestion.generate` | 手工业务建议 | M3 |
| `customer.temperature` | 拜访后的温度建议 | M3 |
| `sales-decision.analyze` | 商机/客户销售决策 | M3 |
| `itinerary.enhance` | 行程 AI 增强 | M3 |
| `assistant.execute` | 已登记助手意图及受限工具编排 | M5 |
| `proactive.analyze` | 后台主动分析 | M5 |
| `payment-proof.recognize` | 付款凭证 | M6 |
| `invoice.recognize` | 发票识别 | M6 |
| `bookkeeping.extract` | 记账候选提取 | M6 |
| `asr.transcribe` | 快速记录和助手语音 | M6 |

停用的方案辅助、个人财务预留能力不能因为新平台默认登记而自动启用。

## 3. 创建任务

`POST /internal/ai/v1/tasks`

头：内部身份、`Idempotency-Key`、内容类型；可选的有界等待参数必须在 M1 定义。

```json
{
  "schemaVersion": "ai-task-v1",
  "taskType": "weekly.generate",
  "feature": "sales-weekly",
  "channel": "web",
  "subject": {"type": "weekly-report", "id": "fixture-week"},
  "input": {},
  "evidenceDigest": "server-computed-digest",
  "priority": "interactive"
}
```

示例不是可直接发送到生产的完整有效请求。身份、对象权限、摘要算法和输入 schema 都需要服务端校验。普通调用者不能选择任意供应商地址、API Key、管理员 Agent 或输出 Schema。

创建结果：

```json
{
  "schemaVersion": "ai-task-result-v1",
  "requestId": "request-id",
  "taskId": "task-id",
  "status": "queued",
  "replayed": false,
  "agentVersion": "agent-version-id",
  "policyVersion": "policy-version-id"
}
```

- 合法新任务返回 `202`；有界同步完成策略必须明确返回语义，不依赖模糊的长连接。
- 同 key、同身份、同任务及同输入重放返回原任务；同 key 不同内容返回 `409`。
- 无可用预算时拒绝新的付费执行，不发起供应商请求。
- 配置禁用、认证失败、未知任务类型和输入超限在执行前拒绝。

## 4. 状态、结果和取消

- `GET /tasks/:id`：本人任务状态和安全摘要。
- `GET /tasks/:id/result`：已完成任务的标准结果；历史读取不重新执行模型。
- `POST /tasks/:id/cancel`：请求取消；已提交业务写入不能通过取消 AI 任务撤销。
- 结果保留来源、引用、事实/推断/未知、模型与 Agent 版本；有写回建议时明确要求业务确认。
- 任务状态和业务确认状态分别建模，模型输出 `confirmed=true` 不具备任何授权意义。

## 5. 兼容适配

在业务侧 `backend/src/aiPlatform/` 中实现受限客户端，转换平台结果为现有函数返回合同。

- 迁移先保持旧功能结果格式和来源标识，再迁移 Prompt 配置。
- 过渡期遗留 Prompt 通道只能供已登记的内部任务使用，固定功能标签和调用身份；不得暴露成浏览器任意 completions 代理。
- 原有返回原始 Response 的票据客户端与 ASR 协议需要专门适配，不能用文本 JSON 入口硬套。
- 业务旧接口错误语义、取消、幂等与临时媒体清理保持兼容。
- 每项功能通过显式接入开关切换；运行时错误不自动绕过平台调用供应商。

## 6. 管理接口资源

管理 API 逻辑资源：模型、凭据元数据、价格版本、Agent、标准规范、草稿、测试运行、发布、任务、预算、调度、成本、审计。

- 管理读取和修改权限分离；全局成本仅管理员可见。
- 资源更新需要版本条件，冲突返回 `409` 或明确约定的条件请求状态。
- 凭据写入后只返回掩码与更新时间，读取不回显原值。
- 发布动作绑定草稿版本及离线测试结果，不允许发布后原地修改。
- 回滚创建可审计的发布指针变化，不删除历史执行版本。
- 任意“测试 Agent”默认使用模拟供应商，且不执行真实业务写入或通知。

## 7. 待双方确认的业务接口

以下是需要能力，不是已有端点承诺：

1. 获取 owner 有权访问的业务对象快照和版本。
2. 分页获取需要主动分析的对象及变更游标。
3. 执行已经登记的只读工具。
4. 创建人工确认预览，不执行正式写入。
5. 在真实确认后由业务端执行幂等写回。
6. 接收幂等分析结果、关联业务历史记录。
7. 经业务端现有通知流程处理结果提醒。

所有接口通过新建适配模块准备，在共享文件整合窗口才挂入现有 server，不抢占另一升级任务的路由或业务迁移。
