# 自有截图记账快捷指令

当前生产候选以 V8「智能截图记账（三级菜单待确认版V8·全屏OCR）」为准：它以用户提供的 iCost V7 四动作（截屏、裁剪、OCR、iCost App Intent）作为输入，只保留前三个采集动作，并把原始截屏再做一次全屏 OCR。两路 OCR 纯文本合并后先调用金额预览接口，再由用户完成三级菜单和本机最终确认，最后只把摘要字段提交到森特智行；不再执行 iCost 写入，也不包含账号、密码或六位确认码。

V8 的 HTTPS 链路是：

`截屏 → 裁剪 → 裁剪 OCR + 原图 OCR → OCR纯文本 → bookkeeping-capture-preview → 三级菜单 → 本机确认 → bookkeeping-capture`

预览接口只返回金额、摘要和截图时间；最终提交不会再次上传整段 OCR 原文。服务端仍按设备 Token 映射本人账号，生成服务端幂等键，并只创建微信待确认草稿。

## 微信待确认消息

小小发送的草稿固定为以下字段顺序（编号为发生时间的 `YYYYMMDDHHmm`，周期为发生日期所在周一至周日）：

```text
【小小提醒！新增一条待记账信息】
编号：202608242020
类型：支出
金额：……
费用类别：……
备注：……
周期：20260824-20260830
AI 状态：……

请引用本消息并回复
```

确认、修改、取消都必须引用小小发送的最新草稿，并且来自绑定账号的本人微信私聊。可识别的明确回复包括“确认”“确认入账”“确定”“同意”“记账”、以“修改”开头的字段修改，以及“取消”“撤销”“作废”等；单独的“好的/好/行”、问题句、六位数字和重发确认码均不会写入财务数据。

## 借款到账与周内分配

收入分类 `出差 → 借款` 只有在本人确认后才入账，表示实际到账金额，不创建“申请中”记录。确认后小小会发出“借款到账待归属”消息：

- 回复“本周/这周”或 `20260824-20260830`，按发生日期周一至周日对本周个人垫付费用 FIFO 分配；
- 引用某条费用草稿并回复“这笔借款用于这笔”，只绑定该支出；
- 借款周三到账时，仍可追溯覆盖同一自然周到账前和到账后的费用；
- 每笔支出可报销金额等于消费金额，初始付款事实保持“个人垫付”；分配层另外显示借款已用、借款剩余、个人垫付和未覆盖/超额，不改写原始付款。

多个借款必须引用对应的借款到账消息。借款分配也不接受六位确认码；取消或暂不分配不会撤销已经确认的借款收入。

## 兼容路径

旧 V5 设备直连、账号配对 V7 和手动常量 V9 仅作为兼容路径保留，不是新安装入口。它们仍共享服务端的本人、私聊、引用、最新版本和自然语言门禁；不要把已配对凭据或填入真实凭据的副本提交到 Git 或公共网盘。

## V9（兼容：手动常量、三级菜单）

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

## 兼容路径的微信确认闭环

旧 V5/V7/V9 也统一进入同一条小小微信复核边界：

- 明确回复“确认”“确认入账”“确定”“同意”等，才写入支出或收入；
- 以“修改”开头并说明字段，例如“修改金额为 18.50 元”“修改日期为 2026-08-19”“修改备注为客户拜访”，修改后重新发送最新草稿；
- 明确回复“取消”“撤销”“作废”等，本次草稿作废，不创建正式费用。

单独的“好的/好/行”、问题句、带前后多余语义的模糊同意、六位数字和重发确认码都不会入账；所有财务回复都必须引用最新草稿并来自绑定账号的本人私聊。

## 生成、验证和签名

```bash
# V8：先把用户自己的 V7 签名包只读解出为 Shortcut.wflow XML，
# 再用仓库中的转换器生成不含账号/密码/iCost 写入的 unsigned plist。
node integrations/shortcut/convert-icost-capture-shortcut.mjs \
  --input=/path/to/unpacked-v7-workflow.xml \
  --output=/tmp/智能截图记账（三级菜单待确认版V8·全屏OCR）.unsigned.shortcut

node integrations/shortcut/sign-icost-capture-shortcut.mjs \
  --input=/tmp/智能截图记账（三级菜单待确认版V8·全屏OCR）.unsigned.shortcut \
  --output=/tmp/智能截图记账（三级菜单待确认版V8·全屏OCR）.shortcut \
  --mode=anyone

# 下面是仅供兼容旧版本的构建命令，不是新安装入口。
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

签名前的 V8 unsigned plist 必须通过 `inspectConvertedIcostCaptureShortcutXml` 契约（101 个动作、全屏 OCR 绑定原始截屏、两路 OCR 合并、三个 HTTPS 请求、无 iCost/账号/密码）；签名脚本还会检查 Apple 归档魔数、非空输出和 `0600` 权限。设备 Token 只能从批准的安全存储注入，不能写进 Git、聊天、日志或公共网盘；本仓库只保留无 Token 的 unsigned 结构。

## 目录和数据边界

账本目录固化在 `backend/src/integrations/shortcutBookkeeping.js` 的 `SHORTCUT_BOOKKEEPING_CATALOG`，后端会再次校验同一目录；收入和支出都先进入 `review_required`，只有在绑定微信私聊完成自然语言确认后才完成记账。支出确认后创建差旅费用和付款记录；普通收入只保存在快捷记账流水中，`出差 → 借款` 额外创建一笔已到账的周借款池，待用户明确指定周期或费用后写入分配覆盖层。V8 的幂等键由服务端根据请求内容生成，避免依赖 iOS 富文本值。

V7 设备凭据和微信 outbox 不保存密码；V9 会在本机快捷指令中保存用户手动填写的两个常量，并只通过 HTTPS 提交。服务端认证后立即丢弃密码，不得把密码写入业务数据、审计、日志或错误响应。不要把填写过真实凭据的快捷指令资产提交到 Git、聊天或公共网盘。
