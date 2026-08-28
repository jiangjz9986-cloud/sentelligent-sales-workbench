# 森特智行 AI 销售作战台

森特智行 AI 销售作战台是一套面向个人复杂型 B2B 销售的业务系统。它把沟通记录、客户、商机、行动、风险、拜访行程、差旅报销、待办、知识和周报放在同一套数据链路中，由小小（微信 AI 助手）承接移动端录入与提醒，减少重复录入，也避免 AI 结果停留在一次性对话里。

系统已部署到生产环境：[https://82.156.210.199/](https://82.156.210.199/)。生产数据库、录音、微信状态、密钥和备份不进入 Git。

## 当前版本与生产状态

| 项目 | 状态 |
| --- | --- |
| 当前版本 | 以根目录 `VERSION` 与 [CHANGELOG](CHANGELOG.md) 顶部条目为准（本次回填时为 v0.8.4 工程健康收官） |
| 生产身份 | 以服务器 `releases/` 当前 `current` 指向目录的 manifest（完整 commit）为准；`docs/releases/vX.Y.Z.md` 逐版保存部署证据表 |
| 发布方式 | 自 v0.6.5 起按项目所有者授权采用本地 exact-commit 路径：本地注释 tag（不推 GitHub）+ git bundle + 服务器打包为不可变 release 目录；GitHub Release 停在 v0.6.1，是否恢复同步为待决策项 |
| 制品与备份 | v0.8.0 起服务器每日 02:30 自动备份数据库与微信会话（14 天保留），发布 bundle+evidence 自动归档到 `backups/releases/<version>/`（root:root 0700） |
| 回滚 | 每版部署证据表记录回滚点 release 目录；回滚只切换三个项目 systemd 服务 |

## 能力总览（按业务域）

| 业务域 | 当前能力 | 边界 |
| --- | --- | --- |
| 战情总览 | KPI、今日焦点（行程/到点待办/风险/新招标四分区）、周趋势、商机漏斗、客户温度、优先动作；进入页面即静默刷新 | 全部来自真实数据聚合，无演示数据回退 |
| 快速记录 | 默认语音模式，浏览器实时识别、AI 提炼（自动引用知识库并标注出处）、历史结果读取与人工修改、URL 直达 | 录音长期保存/回放已裁撤；不支持语音识别时引导文本录入 |
| 客户画像 | 列表、搜索、只读详情、显式新增/修改/删除、aliases 匹配 | 修改带版本号与审计；删除为受保护软删除；aliases/tags 暂无 Web 表单（API 已支持） |
| 医院招标监测 | 公开来源采集、白天窗口轮巡、公告匹配证据、来源健康、调度设置、微信推送 | 只读监测，不自动修改客户或商机 |
| 商机档案与看板 | 商机 CRUD、七阶段看板、时间线、销售决策 Agent 诊断（DeepSeek、证据门槛、人工确认写回） | 模型不得自动写回业务档案 |
| 下一步动作与风险 | 真实数据、状态流转、来源追踪、审计、微信到点提醒 | AI 建议必须人工确认后写回 |
| 智能拜访行程 | 高德地址解析、路线、里程、顺序优化、地图、历史快照；行程详情一键预填当日差旅费用 | 历史读取不重复调用地图或模型 |
| 差旅报销 | 自然周账本工作台（日选择器、正式/待确认分离、行内编辑与删除）、多笔实付、提前请款、多退少补、付款凭证、发票仓库与匹配、区域档案、A4 打印与 Excel 导出 | 单账号个人使用，无审批流 |
| 小小微信记账 | 私聊付款凭证图片/文字生成草稿，OCR/AI 拆分多笔，餐饮时段自动分类，自然语言确认/修改/取消 | 未确认不写账；大额仅结合语义推断 |
| 小小业务 agent 套件 | 客户画像、拜访行程、快速记录、商机、智能待办五组微信自然语言 agent，统一回复卡片，写操作走确认流程 | owner-scoped；结构化数组字段仅 Web 可改 |
| 智能待办与晨报 | 微信创建/完成待办、到点提醒（remind_at）、每日晨报（行程/待办/风险/新招标聚合推送） | remind_at 暂无 Web 编辑入口；晨报周末不补发 |
| 周报与汇报 | 真实业务数据生成、编辑、保存、导出 | 生成内容仍需人工检查 |
| 知识库 | 搜索、条目维护；快速记录与销售决策自动引用并标注出处 | 引用为确定性匹配，模型不得虚构知识 id |
| 系统配置 | 加密保存 DeepSeek API Key 与 PushPlus Token、通知设置、招标调度、记账日志 | 主加密密钥只进后端受保护环境，页面不回显明文 |
| 微信机器人 | 绑定、worker 自启动、持久化会话、图片/PDF 接入、outbox 单次投递 | 机器身份只获得声明的写入路由 |
| 方案辅助 | 只读兼容入口 | 按产品决策暂停写入与 AI 调用 |

## 技术结构

```text
React 19 + Vite (PWA)
        |
Cookie Session + CSRF + JSON API
        |
Node.js 24 + node:http
        |
SQLite migrations (0001–0028) + optimistic locking + soft delete + audit
        |
DeepSeek / AMap / WeChat Agent / browser voice
```

主要目录：

| 路径 | 说明 |
| --- | --- |
| `outputs/product-design-prototype/` | 正式 React 前端；`src/features/` 按域组织（salesWorkbench 页面已拆分至 `pages/` 子目录，`pages.jsx` 为桶文件） |
| `backend/` | API、认证、迁移、AI、地图、微信、招标、差旅、待办、晨报等子域与服务脚本 |
| `shared/` | 前后端共享业务契约 |
| `scripts/` | 本地编排、密钥扫描、发布打包、生产预检/切换/冒烟与发布测试 |
| `docs/` | 需求、架构、开发、验收、部署与版本记录；`docs/superpowers/` 存放蓝图/研究/报告 |

详细边界见 [项目架构与模块说明](docs/项目架构与模块说明.md)。

## 本地开发与启动

要求：Node.js 24 与配套 npm、Chrome（浏览器集成验收）、本地环境文件（真实密钥私下渠道配置）。

> GitHub 同步自 v0.6.5 起暂停，主线以本机仓库 `local/v0627-feature-closeout-20260827` 分支与本地注释 tag 链为准；换机恢复路径见 [交接说明](docs/森特智行-v0.8.x-交接说明.md)。

```bash
npm ci --prefix backend
npm ci --prefix outputs/product-design-prototype
npm run dev:start
npm run dev:health
npm run dev:stop   # 停止本地服务
```

## 质量门

```bash
npm run scan:secrets
npm run test:deploy                                   # 根发布工具测试
npm --prefix backend test                             # 后端全量（v0.8.3 基线 1276）
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npm --prefix outputs/product-design-prototype run qa:local    # 前端本地 QA（v0.8.3 基线 434）
npm --prefix outputs/product-design-prototype run qa:integration
npm --prefix outputs/product-design-prototype run qa:webkit
```

生产发布另需：一致性数据库备份与 `quick_check`/外键/SHA-256、`production-preflight.mjs` 动态合同 25/25、公开 HTTPS 冒烟 25/25（cleanup=clean）、三个项目服务与共享 Caddy 受保护边界盘点、回滚点记录。完整流程与全部踩坑见 [部署记录](docs/部署记录.md) 与最近版本的 `docs/releases/vX.Y.Z.md` 证据表。

## 版本与发布

- 语义化版本写入 `VERSION` 与三个 `package.json`（root/backend/前端）。
- 每版必须：全量门禁 → 冻结提交（精确 add）→ 本地注释 tag → `docs/releases/vX.Y.Z.md` 证据表。
- 发布制品从干净 exact commit 生成 git bundle，SHA-256 双端复算；服务器 `LC_ALL=C` 打包为不可变 release 目录（root:root，755/644 归一）。
- systemd 单元直接固定到真实 release 路径，`current` 只作人工识别。
- 回滚只切换三个项目服务到上一已验收 release；共享 Caddy 不随应用重启（如需变更须用 restart 显式操作并另行授权）。

## 安全边界

仓库不保存：账号密码、API Key、Token、Cookie、会话密钥、`.env` 与生产配置、SSH/TLS 私钥、SQLite 主库与备份、录音与微信登录状态、`.runtime`、日志、依赖与构建产物。

提交前必须运行密钥扫描。发现凭据进入 Git 后，先撤销和轮换，再清理历史。详见 [SECURITY.md](SECURITY.md)。

## 微信 Clawbot 助手事件契约

vendored `weixin-agent-sdk` worker 通过独立机器 Token 调用：

```text
POST /api/integrations/weixin-agent/events
Authorization: Bearer <森特智行专用 WEIXIN_AGENT_API_TOKEN>
Idempotency-Key: <稳定重试键>
```

请求正文只接受标准化事件字段：`conversationId`、`text`、`sourceMessageId`、`senderId`、`chatType`（`direct`/`group`），可选 `groupId`、`media`、`pendingActionId` 和通用助手使用的六位 `confirmationCode`。记账草稿在同一会话中只接受"确认"、以"修改"开头的明确字段修改或"取消"。`media` 只接收原始 Base64、文件名、MIME 和 SHA-256；服务端重新校验魔数、MIME、长度和摘要，单文件上限 12 MiB。

sender 必须出现在 `WEIXIN_ALLOWED_SENDER_IDS`，生产只接受私聊且拒绝群聊。高风险确认回复必须来自同一 sender、channel 和 private conversation；确认码只展示一次，SQLite 只保存 HMAC，连续五次错误后动作锁定。owner、Token、路径和数据库身份一律由服务端配置决定，不能由消息正文覆盖。

## 文档地图

**入口四类**：

1. 交付蓝图与阶段状态：[v0.7–v0.8 连续交付蓝图](docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md)
2. 逐版部署证据：`docs/releases/vX.Y.Z.md`（v0.6.5 起含完整生产证据表）
3. 设计与调研：`docs/superpowers/research/`、交付报告 `docs/superpowers/reports/`
4. 操作手册：[正式交付验收手册](docs/正式交付验收手册.md)、[发布与回滚操作手册](docs/发布与回滚操作手册.md)

**基础文档**：

- [原始项目需求书](项目需求书.txt)
- [需求与验收矩阵](docs/需求与验收矩阵.md)
- [项目架构与模块说明](docs/项目架构与模块说明.md)
- [开发进度与路线图](docs/开发进度与路线图.md)
- [开发日志](docs/开发日志.md)
- [部署记录](docs/部署记录.md)
- [v0.8.x 交接说明](docs/森特智行-v0.8.x-交接说明.md)（历史版本：[v0.4.4 换机交接说明](docs/森特智行-v0.4.4-换机交接说明.md)）
- [多设备开发与版本管理](docs/多设备开发与版本管理.md)
- [变更日志](CHANGELOG.md) · [安全策略](SECURITY.md) · [协作规范](CONTRIBUTING.md)
- [微信 Clawbot 助手集成说明](docs/微信Clawbot助手集成.md) · [医院招标监测集成说明](docs/医院招标监测集成说明.md)

## 许可

本项目为私有商用项目，不授予公开复制、分发或再许可权利。
