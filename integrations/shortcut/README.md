# 自有截图记账快捷指令

这是完全绕过 iCost 的兼容版 V4（当前修复文件名为“自有截图记账（兼容版V4修复）”）。v0.6.2 开放 `POST /api/integrations/shortcut/bookkeeping`：有效账号 Token 且服务端桥接配置完整时，验证响应返回 `bookkeepingReady=true`，快捷指令继续截图、提取文字并提交一次分类记账请求。

账本与分类目录固化在 `build-bookkeeping-shortcut.mjs` 的 `BOOKKEEPING_CATALOG` 中，并编译为 31 个合法显示项，例如“出差报销 · 支出 · 交通 · 打车”。用户只选择一次，不会重复选择账本；子分类没有值时显示“无”。后端按同一目录解析 `selection_path` 并再次校验，避免写入错误分类。

仓库只生成 unsigned plist，不保存真实 Token。导入时只询问一次 Token，URL 固定在签名文件中，不再让用户编辑最后一个动作。Token 保持占位符直到你在“系统配置页生成的快捷指令 Token”中填入账号 Token。不要把填入凭据的 `.shortcut` 文件提交或转发。

V4 使用 Apple 当前导出格式的完整顶层元数据，并删除旧版的 105 个四层嵌套菜单、非标准菜单 UUID 和设定变量参数。正式流程从 223 个动作压缩为 21 个动作，只保留一个原生 `Choose from List` 和必要的标准条件。Token 状态动作保留显式输出名“Token验证状态”，否则 Apple 导入后会把条件显示为红色未配置。

Apple 的导入配置页只做参数替换，完成添加前不会运行网络动作，因此 Token 验证不能控制系统的“添加快捷指令”按钮。V4 会在成功安装后的每次运行开头调用 `GET /api/integrations/shortcut/verify`；接口只有在 Token 有效且跨系统桥接配置完整时才返回 `bookkeepingReady=true`。验证本身不会调用 AI 或创建账目，只会更新 Token 的 `last_used_at` 元数据。

```bash
node integrations/shortcut/build-bookkeeping-shortcut.mjs \
  --endpoint=https://82.156.210.199/api/integrations/shortcut/bookkeeping \
  --verify-endpoint=https://82.156.210.199/api/integrations/shortcut/verify \
  --output=/tmp/shortcut-bookkeeping.unsigned.shortcut
node integrations/shortcut/verify-bookkeeping-shortcut.mjs \
  /tmp/shortcut-bookkeeping.unsigned.shortcut
node integrations/shortcut/sign-bookkeeping-shortcut.mjs \
  --input=/tmp/shortcut-bookkeeping.unsigned.shortcut \
  --output=/tmp/自有截图记账（兼容版V4修复）.shortcut \
  --mode=anyone
xxd -l 4 /tmp/自有截图记账（兼容版V4修复）.shortcut
stat -f '%Sp %z %N' /tmp/自有截图记账（兼容版V4修复）.shortcut
node --test backend/tests/shortcut-bookkeeping.test.js
```

签名命令只在可信 macOS 上调用 Apple 自带的 `/usr/bin/shortcuts sign`；签名前的 unsigned plist 由 verifier 校验，签名脚本再检查 Apple 归档魔数 `AEA1`、非空输出和 `0600` 权限。把签名后的 `.shortcut` 通过 AirDrop、iCloud Drive 或本机 Finder 发送到 iPhone，点开后由“快捷指令”App 安装，并在导入配置中填入系统配置页刚生成的账号 Token。不要使用在线签名站，也不要把已填入 Token 的安装副本提交到 Git 或转发给其他人。

V4 请求 JSON 字段严格为：`text`、`selection_path`、`note`、`idempotency_key`、`source`。`source` 固定为 `shortcut`，`note` 可以为空字符串。后端仍兼容旧版的展开字段：`ledger_name`、`entry_type`、`category`、`subcategory`。

正式使用时，在系统配置页的“快捷指令”页面生成 Token。数据库只保存 Token 的 SHA-256 哈希，并把它绑定到当前登录账号；快捷指令请求不再传 `owner` 或 `account`，后端按 Token 唯一映射账号。Token 只在生成成功时显示一次，列表只显示前缀；泄露或换手机时先撤销旧 Token，再生成新的。旧的 `SHORTCUT_WEBHOOK_TOKEN` / `SHORTCUT_WEBHOOK_OWNER` 只在开发和测试环境保留兼容读取，生产环境会明确拒绝。

目录接口按账本标记目标系统：`出差报销 → sentelligent`、`biubiu → qingyang`。出差报销首期只开放支出，经服务端分析后写入森特差旅费用和支付记录；信息不足时返回 `review_required`，并在森特网页“差旅费用 → 付款凭证 → 快捷指令待复核”显示 owner-scoped 记录，支持补齐日期/金额/用途/商户后确认入账、拒绝或重新识别。确认接口使用租约和幂等状态，只有确认成功才创建正式费用和付款记录。出差报销收入分类显示为空并由 API 拒绝，不伪造不存在的收入模型。biubiu 由森特使用仅存在于服务器的独立桥接凭据转发到轻氧；轻氧明确返回成功前，森特不会向快捷指令返回成功。

同一账号的 `idempotency_key` 全局唯一，不能通过切换账本重复使用。V4 的幂等键原文只由 OCR 文本、分类和备注组成，不含 `CurrentDate` 等每次运行都会变化的值；整条快捷指令在响应丢失后重跑仍会复用同一 key。桥接超时、4xx/5xx、重定向或错误 JSON 都会 fail closed；重试仍使用同一派生远端幂等键。用户账号 Token 只发送给森特，绝不能填入轻氧服务或 `QINGYANG_BOOKKEEPING_BRIDGE_TOKEN`。

快捷指令中的“收入/支出”和“无”是显示值，后端会规范化为 `income`/`expense` 和空子分类，并再次校验所选账本、分类、子分类的归属。选择与账本不匹配时请求会返回 422，不会写入错误分类。
