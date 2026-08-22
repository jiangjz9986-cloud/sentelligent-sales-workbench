# 自有截图记账快捷指令

正式交付只包含账号配对版 V7（可撤销设备凭据）。V7 提交后由“小小”发送草稿和六位确认码，只有在同一微信会话回复最新码才完成记账。现有已安装的 V9 仍可暂时调用 `POST /api/integrations/shortcut/bookkeeping-inline`，但仓库不再提供 V9 的生成、验证或签名工具；该兼容路由只用于完成真机迁移，不能用于新安装。

## 现有 V9 的临时兼容边界

V9 会在每次请求中提交用户手动保存在本机快捷指令里的账号和密码。服务端先校验、限流，并在创建任何记账记录前丢弃密码；认证失败返回 401 且零落库。由于该模式缺少设备级撤销和轮换能力，应尽快迁移到 V7，迁移完成后移除兼容路由。

## V7 账号配对版使用流程

首次运行时快捷指令会：

1. 在本机/iCloud Drive 查找 `Shortcuts/森特智行快捷指令凭据.txt`。
2. 找不到时询问森特账号和密码，只调用一次 `POST /api/integrations/shortcut/pair`。
3. 将服务端返回的设备凭据保存到上述 iCloud Drive 文件；密码不会保存到文件、数据库或快捷指令文件。
4. 后续运行自动读取设备凭据，不再询问账号密码。换手机或撤销设备时，删除该文件并重新运行即可重新配对。

配对接口只返回一次完整设备凭据，服务端数据库只保存哈希和设备元数据；配对响应使用 `Cache-Control: no-store`，也不会创建浏览器 Cookie 会话。

每次记账仍会先调用 `GET /api/integrations/shortcut/verify`，验证通过后才截图、OCR、按三级列表选择收支类型、费用类别和子类别，最后调用 `POST /api/integrations/shortcut/bookkeeping`。快捷指令只提交识别文本、分类、备注、幂等键和 `source=shortcut`，账号由设备凭据在服务端映射，不接受客户端伪造 owner/account。

## 微信确认闭环

小小助手会把识别草稿发到绑定的微信私聊：

- 在同一会话回复最新消息中的六位 ASCII 数字确认码，才写入费用和付款记录；
- 回复“金额改为 18.50 元”“时间改为 2026-08-19T10:20:00+08:00”“商户改为济南客户”“备注改为 客户拜访”等严格 parser 支持的字段修改，旧码立即失效，助手重新发送最新草稿和新码；
- 原始文本精确回复“取消”会作废本次草稿且不创建正式费用；精确回复“重发确认码”会使旧码失效并发送新码。

回复“确认”或其他肯定语句不会直接入账。前后空格、换行、全角数字、附加文字和旧确认码均不匹配，必须使用最新六位码。

## 生成、验证和签名

```bash
node integrations/shortcut/build-bookkeeping-shortcut.mjs \
  --endpoint=https://82.156.210.199/api/integrations/shortcut/bookkeeping \
  --verify-endpoint=https://82.156.210.199/api/integrations/shortcut/verify \
  --pair-endpoint=https://82.156.210.199/api/integrations/shortcut/pair \
  --output=/tmp/shortcut-bookkeeping.unsigned.shortcut

node integrations/shortcut/verify-bookkeeping-shortcut.mjs \
  /tmp/shortcut-bookkeeping.unsigned.shortcut

node integrations/shortcut/sign-bookkeeping-shortcut.mjs \
  --input=/tmp/shortcut-bookkeeping.unsigned.shortcut \
  --output=/tmp/自有截图记账（账号配对版V7）.shortcut \
  --mode=anyone
```

签名前的 unsigned plist 必须通过 verifier；签名脚本会检查 Apple 归档魔数、非空输出和 `0600` 权限。不要把已配对的凭据文件或包含个人凭据的安装副本提交到 Git、聊天或公共网盘。

## 目录和数据边界

账本目录固化在 `build-bookkeeping-shortcut.mjs` 的 `BOOKKEEPING_CATALOG`，后端会再次校验同一目录；收入和支出都先进入 `review_required`，只有在绑定微信私聊回复最新六位确认码后才完成记账。支出确认后创建差旅费用和付款记录；收入确认后保存在快捷记账流水中，不创建支出付款行。幂等键对 OCR 文本、完整分类路径和备注拼接后的原文计算 SHA-256，不依赖 `CurrentDate`。

V7 凭据和微信 outbox 不保存密码或明文确认码；待确认动作只保存确认码 HMAC。V9 兼容只接受既有客户端，不再生成新安装资产；服务端认证后立即丢弃密码。
