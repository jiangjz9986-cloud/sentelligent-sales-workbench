# 自有截图记账快捷指令

这是完全绕过 iCost 的兼容版 V4（当前修复文件名为“自有截图记账（兼容版V4修复）”）。当前 v0.6.1 最小发布只提供 Token 验证：快捷指令验证成功后会明确提示“记账写入功能尚未开放”，不会继续执行截图或 `POST /api/integrations/shortcut/bookkeeping`；后续开启写入路由时再启用完整的截图记账流程。

账本与分类目录固化在 `build-bookkeeping-shortcut.mjs` 的 `BOOKKEEPING_CATALOG` 中，并编译为 31 个合法显示项，例如“出差报销 · 支出 · 交通 · 打车”。用户只选择一次，不会重复选择账本；子分类没有值时显示“无”。后端按同一目录解析 `selection_path` 并再次校验，避免写入错误分类。

仓库只生成 unsigned plist，不保存真实 Token。导入时只询问一次 Token，URL 固定在签名文件中，不再让用户编辑最后一个动作。Token 保持占位符直到你在“系统配置页生成的快捷指令 Token”中填入账号 Token。不要把填入凭据的 `.shortcut` 文件提交或转发。

V4 使用 Apple 当前导出格式的完整顶层元数据，并删除旧版的 105 个四层嵌套菜单、非标准菜单 UUID 和设定变量参数。正式流程从 223 个动作压缩为 17 个动作，只保留一个原生 `Choose from List` 和一层标准条件。Token 状态动作保留显式输出名“Token验证状态”，否则 Apple 导入后会把条件显示为红色未配置。

Apple 的导入配置页只做参数替换，完成添加前不会运行网络动作，因此 Token 验证不能控制系统的“添加快捷指令”按钮。V4 会在成功安装后的每次运行开头调用 `GET /api/integrations/shortcut/verify`；当前接口会区分“Token 有效”和“记账写入未开放”，并让快捷指令停在验证提示页。验证接口不会调用 AI，也不会创建账目、差旅费用或支付记录；成功验证只会更新 Token 的 `last_used_at` 元数据。

```bash
node integrations/shortcut/build-bookkeeping-shortcut.mjs \
  --endpoint=https://82.156.210.199/api/integrations/shortcut/bookkeeping \
  --verify-endpoint=https://82.156.210.199/api/integrations/shortcut/verify \
  --output=/tmp/shortcut-bookkeeping.unsigned.shortcut
node integrations/shortcut/verify-bookkeeping-shortcut.mjs \
  /tmp/shortcut-bookkeeping.unsigned.shortcut
node --test backend/tests/shortcut-bookkeeping.test.js
```

V4 请求 JSON 字段严格为：`text`、`selection_path`、`note`、`idempotency_key`、`source`。`source` 固定为 `shortcut`，`note` 可以为空字符串。后端仍兼容旧版的展开字段：`ledger_name`、`entry_type`、`category`、`subcategory`。

正式使用时，在系统配置页的“快捷指令”页面生成 Token。数据库只保存 Token 的 SHA-256 哈希，并把它绑定到当前登录账号；快捷指令请求不再传 `owner` 或 `account`，后端按 Token 唯一映射账号。Token 只在生成成功时显示一次，列表只显示前缀；泄露或换手机时先撤销旧 Token，再生成新的。旧的 `SHORTCUT_WEBHOOK_TOKEN` / `SHORTCUT_WEBHOOK_OWNER` 只在开发和测试环境保留兼容读取，生产环境会明确拒绝。

目录接口仍按账本标记目标系统：`出差报销 → sentelligent`、`biubiu → qingyang`。本最小发布不接受记账写入请求；在跨系统写入适配完成并单独验收前，不应把 `targetSystem` 视为已落库。

快捷指令中的“收入/支出”和“无”是显示值，后端会规范化为 `income`/`expense` 和空子分类，并再次校验所选账本、分类、子分类的归属。选择与账本不匹配时请求会返回 422，不会写入错误分类。
