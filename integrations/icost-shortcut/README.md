# iCost 截图记账统一分流快捷指令

本目录交付一份快捷指令。它保留原来的“截屏 → 裁剪 → OCR → iCost 智能记账”动作，并增加严格的账本分流：

1. 先选择本次 iCost 实际写入的账本。
2. 正常执行 iCost 智能记账。
3. iCost 成功返回后再发送文本 Webhook。
4. `出差报销` 只发送到森特智行。
5. `biubiu` 只发送到轻氧智能门店。
6. `仅记 iCost（不回传）` 不发送到任一业务系统。

由于 iCost 的 `ICAISnapshotShortcutV7` 动作没有向快捷指令暴露账本参数或账本输出，快捷指令中的账本选择必须与 iCost 本次实际使用的账本保持一致。若使用其他账本，请选择“仅记 iCost（不回传）”。

## 安全边界

- 两个系统使用独立 URL、独立 Webhook Token、独立数据库和独立审计。
- Token 只在导入快捷指令时写入各自独立的“文本”动作，不写入仓库模板、示例配置或构建日志。
- 请求只包含记账文本和幂等元数据，不上传截图、PDF、账号、Cookie 或数据库内容。
- 两个 Webhook 都只允许 `POST`；快捷指令不具备查询、修改或删除权限。
- 未知账本没有网络请求分支。

## 森特智行接口契约

- 相对路径：`/api/integrations/icost/expenses`
- 鉴权：`Authorization: Bearer <SENTELLIGENT_ICOST_WEBHOOK_TOKEN>`
- 请求体：

```json
{
  "text": "2026-08-04 午餐 客户招待 支付宝 128.50元",
  "ledger_name": "出差报销",
  "idempotency_key": "由快捷指令生成的 SHA-256",
  "source": "icost-shortcut",
  "captured_at": "2026-08-04T12:31:00+08:00",
  "source_id": "shortcut-<同一幂等键>"
}
```

必填字段为 `text`、`ledger_name`、`idempotency_key`、`source`。`ledger_name` 必须逐字等于 `出差报销`，`source` 必须逐字等于 `icost-shortcut`。

状态码：

- `201`：已创建费用和付款。
- `202`：已接收但需要人工复核，未创建正式财务记录。
- `200`：相同幂等键和正文的安全重放，没有重复记账。
- `401`：Token 缺失或错误。
- `405`：请求方法不允许。
- `409`：幂等键被不同正文复用，或同一请求仍在处理中。
- `422`：字段、账本、来源、日期或文本不符合契约。
- `429`：触发固定窗口限流，按 `Retry-After` 重试。

## 生成与验证

示例配置只包含两个公开 URL，不接受 Token 字段：

```powershell
node integrations/icost-shortcut/build-shortcut.mjs
node integrations/icost-shortcut/verify-shortcut.mjs integrations/icost-shortcut/icost-dual-write.unsigned.shortcut
```

自定义输出位置：

```powershell
node integrations/icost-shortcut/build-shortcut.mjs `
  --config=integrations/icost-shortcut/icost-dual-write.shortcut.example.json `
  --output=C:\Temp\icost-ledger-routing.unsigned.shortcut
```

验证器会检查：

- 原始截屏、裁剪、OCR 和 iCost 动作仍存在。
- iCost 动作位于两个业务 Webhook 之前。
- 三个账本选项和两个条件分支逐字匹配。
- 两个 URL、两个 Token 导入问题和两个请求动作相互独立。
- 请求字段严格为文本契约规定的六个字段。
- 未知账本没有请求分支。

## 签名与导入

Windows 无法使用 Apple 官方 `shortcuts sign`。请把无密钥文件复制到可信的 macOS，再执行：

```bash
shortcuts sign \
  --mode anyone \
  --input icost-dual-write.unsigned.shortcut \
  --output icost-dual-write.shortcut
```

然后把签名后的 `.shortcut` 发送到 iPhone 导入。导入时会依次询问：

1. 森特智行 URL。
2. 森特智行独立 Token。
3. 轻氧智能门店 URL。
4. 轻氧智能门店独立 Token。

不要把已填入 Token 的快捷指令重新分享到网盘、聊天群、GitHub 或第三方签名服务。仓库中的模板和生成产物均不包含真实 Token。

## 上线验收数据清理

验收请求的 `source_id` 必须使用唯一的 `ACCEPTANCE-<UUID>`，并保存响应中的 ingestion ID、expense ID 和 payment ID。清理前先离线备份生产数据库，再把本次响应整理成服务器本地 manifest；不要把 manifest 放进 Git：

```json
{
  "owner": "<ICOST_WEBHOOK_OWNER>",
  "source_id": "ACCEPTANCE-<UUID>",
  "ingestion_id": "<INGESTION_ID>",
  "expense_id": "<EXPENSE_ID>",
  "payment_id": "<PAYMENT_ID>",
  "database_identity": "<API_HEALTH_DATABASE_IDENTITY>"
}
```

`201 accepted` 的 manifest 必须同时包含 expense ID 和 payment ID；`202 review_required` 没有生成财务记录，应同时省略这两个字段。`database_identity` 取自本次上线实例的只读 `/api/health` 响应，用于阻止脚本误连其他数据库。

在服务器项目根目录执行，私有环境文件继续沿用后端服务本身的权限，不在命令参数中填写任何 Token 或密钥：

```powershell
node --env-file=<PRIVATE_BACKEND_ENV_PATH> backend/scripts/icost-acceptance-cleanup.mjs `
  --manifest=<SERVER_LOCAL_ACCEPTANCE_MANIFEST.json>
```

脚本只接受这一份精确 manifest，并在同一个 `BEGIN IMMEDIATE` 事务中校验：owner、`source='icost'`、`actor='icost-webhook'`、source ID 唯一性、ingestion/expense/payment 关联、审计记录，以及是否存在其他业务外键引用。只要出现缺失、额外、跨 owner、已编辑或被其他业务引用的记录，整笔清理都会拒绝并回滚；不得按模糊文本、金额或日期批量删除。

事务提交前脚本执行：

```sql
PRAGMA foreign_key_check;
PRAGMA quick_check;
```

输出只包含脱敏状态、删除/残留计数和完整性结果，不包含 owner、任何 ID、原始记账文本、数据库路径、identity 值或密钥。生产环境不向快捷指令开放删除接口。
