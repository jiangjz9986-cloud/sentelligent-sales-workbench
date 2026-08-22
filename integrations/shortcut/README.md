# 自有截图记账快捷指令

正式交付以手动账号密码、三级菜单和微信自然语言确认的 V9 为准；V7 设备凭据版仍保留用于兼容。两者都不使用六位确认码。

## V9（手动常量、三级菜单）

V9 不读取凭据文件、不弹出配对窗口，也不依赖设备 Token。导入后在快捷指令顶部编辑 `森特账号常量（请编辑）` 和 `森特密码常量（请编辑）` 两个“文本”动作。快捷指令依次完成截图、裁剪、OCR、收入/支出 → 类别 → 子类别三级选择和可选备注，再调用 `POST /api/integrations/shortcut/bookkeeping-inline`。服务端先校验和限流，并在创建任何业务记录前丢弃密码；认证失败返回 401 且零落库。

成功提交后快捷指令保持静默，只等待“小小”微信消息；服务端返回错误 JSON 时会在 iPhone 明确显示失败提示。网络层或 HTTP 层直接中断时，由快捷指令系统显示运行错误。未收到小小确认前不能认为已经记账，也不要盲目重复提交。每次运行使用当前设备时间 `yyyyMMddHHmmss` 作为请求 ID。

## V7 账号配对版使用流程

首次运行时快捷指令会：

1. 在本机/iCloud Drive 查找 `Shortcuts/森特智行快捷指令凭据.txt`。
2. 找不到时询问森特账号和密码，只调用一次 `POST /api/integrations/shortcut/pair`。
3. 将服务端返回的设备凭据保存到上述 iCloud Drive 文件；密码不会保存到文件、数据库或快捷指令文件。
4. 后续运行自动读取设备凭据，不再询问账号密码。换手机或撤销设备时，删除该文件并重新运行即可重新配对。

配对接口只返回一次完整设备凭据，服务端数据库只保存哈希和设备元数据；配对响应使用 `Cache-Control: no-store`，也不会创建浏览器 Cookie 会话。

每次记账仍会先调用 `GET /api/integrations/shortcut/verify`，验证通过后才截图、OCR、按三级列表选择收支类型、费用类别和子类别，最后调用 `POST /api/integrations/shortcut/bookkeeping`。快捷指令只提交识别文本、分类、备注、幂等键和 `source=shortcut`，账号由设备凭据在服务端映射，不接受客户端伪造 owner/account。

## 微信确认闭环

小小助手会把识别草稿发到绑定的微信私聊，V9 快捷记账只接受三个明确指令：

- 只回复“确认”，才写入费用和付款记录；
- 以“修改”开头并说明字段，例如“修改金额为 18.50 元”“修改日期为 2026-08-19”“修改备注为客户拜访”，修改后重新发送最新草稿；
- 只回复“取消”，本次草稿作废，不创建正式费用。

“好的”“同意”“确认入账”“确认。”和带问号的询问都不会入账；快捷记账流程不向用户生成或接受六位确认码。

## 生成、验证和签名

```bash
node integrations/shortcut/build-bookkeeping-shortcut.mjs \
  --endpoint=https://82.156.210.199/api/integrations/shortcut/bookkeeping \
  --verify-endpoint=https://82.156.210.199/api/integrations/shortcut/verify \
  --pair-endpoint=https://82.156.210.199/api/integrations/shortcut/pair \
  --output=/tmp/shortcut-bookkeeping.unsigned.shortcut

node integrations/shortcut/verify-bookkeeping-shortcut.mjs \
  /tmp/shortcut-bookkeeping.unsigned.shortcut

node integrations/shortcut/build-bookkeeping-inline-shortcut.mjs \
  --endpoint=https://82.156.210.199/api/integrations/shortcut/bookkeeping-inline \
  --output=/tmp/shortcut-bookkeeping-inline.unsigned.shortcut

node integrations/shortcut/verify-bookkeeping-inline-shortcut.mjs \
  /tmp/shortcut-bookkeeping-inline.unsigned.shortcut

node integrations/shortcut/sign-bookkeeping-inline-shortcut.mjs \
  --input=/tmp/shortcut-bookkeeping-inline.unsigned.shortcut \
  --output=/tmp/自有截图记账（三级菜单微信确认版V9）.shortcut \
  --mode=anyone

node integrations/shortcut/sign-bookkeeping-shortcut.mjs \
  --input=/tmp/shortcut-bookkeeping.unsigned.shortcut \
  --output=/tmp/自有截图记账（账号配对版V7）.shortcut \
  --mode=anyone
```

签名前的 unsigned plist 必须通过 verifier；签名脚本会检查 Apple 归档魔数、非空输出和 `0600` 权限。不要把已配对的凭据文件或包含个人凭据的安装副本提交到 Git、聊天或公共网盘。

## 目录和数据边界

账本目录固化在 `build-bookkeeping-shortcut.mjs` 的 `BOOKKEEPING_CATALOG`，后端会再次校验同一目录；收入和支出都先进入 `review_required`，只有在绑定微信私聊完成自然语言确认后才完成记账。支出确认后创建差旅费用和付款记录；收入确认后保存在快捷记账流水中，不创建支出付款行。V9 幂等键使用快捷指令生成的当前时间 ID。

V7 设备凭据和微信 outbox 不保存密码；V9 会在本机快捷指令中保存用户手动填写的两个常量，并只通过 HTTPS 提交。服务端认证后立即丢弃密码，不得把密码写入业务数据、审计、日志或错误响应。不要把填写过真实凭据的快捷指令资产提交到 Git、聊天或公共网盘。
