# 森特智行 AI 销售作战台

森特智行 AI 销售作战台是一套面向个人复杂型 B2B 销售的业务系统。它把沟通记录、客户、商机、行动、风险、拜访行程、知识和周报放在同一套数据链路中，减少重复录入，也避免 AI 结果停留在一次性对话里。

系统已经部署到生产环境：[https://82.156.210.199/](https://82.156.210.199/)。仓库为私有项目，`main` 是唯一可部署来源；生产数据库、录音、微信状态、密钥和备份不进入 Git。

## 代码、发布与生产状态

| 项目 | 状态 |
| --- | --- |
| 当前开发候选 | `v0.6.2`（本地实现与验收中，尚未发布或切生产） |
| v0.6.1 Release | [森特智行 v0.6.1](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.6.1) |
| v0.6.1 Release 状态 | 正式 Release 已发布；生产切换、`0017` 迁移、切换前后预检和 HTTPS smoke 均已完成 |
| v0.6.0 Release | [森特智行 v0.6.0](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.6.0) |
| v0.6.0 Release 归档 SHA-256 | `3b4f747384ecd594aa9db0a337aee3d3f239432e89a13c14cb63678e69c5f371` |
| 当前生产版本 | `v0.6.1`（受控切换与线上验收已完成） |
| 生产提交 | `c461d6a60253d9a59cd8b187edec57e47a480e94` |
| 注释标签 | `v0.6.1` |
| 上一生产 GitHub Release | [森特智行 v0.6.0](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.6.0) |
| 当前生产 release | `/opt/sentelligent-sales-workbench/releases/v0.6.1-20260817T134944Z_c461d6a60253` |
| 回滚 release | `/opt/sentelligent-sales-workbench/releases/v0.6.0-20260817T124347Z_4c45656647f5` |
| v0.6.1 生产状态 | 已切换；切换前后预检均 `25/25`，HTTPS smoke `25/25`、`cleanup=clean`，数据库完整性通过 |
| 当前生产代码 | `v0.6.1` 已完成不可变发布、数据库迁移、受控切换和正式线上验收 |
| `v0.5.3` 生产边界 | 首次切换因缺少 sender 白名单自动回滚；未移动 `v0.5.3` 标签 |
| `v0.5.4` 生产边界 | 空 sender 白名单允许服务启动，但微信入站仍 fail-closed；已由后续版本取代 |
| `v0.5.7` 生产验收 | 第二轮 HTTPS smoke `25/25`、`cleanup=clean`；生产库 `quick_check=ok`、外键违规 `0`、smoke 标记残留 `0`；真实微信 `/clear` 往返通过 |
| `v0.4.4` 状态 | 已从合并后的 `main` 发布并完成受控生产切换；post-cutover 预检 `24/24`、HTTPS 冒烟 `25/25`（cleanup clean）和 Chrome 桌面/移动视口验收均有新鲜证据 |

上述现网版本、release 路径、服务状态和健康接口已于 `2026-08-17` 复核。v0.6.1 HTTPS smoke run `0a00efbc-f349-424f-9700-0f3f08cda157` 通过 `25/25`，`cleanup=clean`，清理后无合成数据残留；SQLite `quick_check=ok`、外键违规 `0`。生产部署细节见 [部署记录](docs/部署记录.md)，候选边界见 [v0.6.2 版本说明](docs/releases/v0.6.2.md)。

## 功能状态

| 模块 | 当前能力 | 边界 |
| --- | --- | --- |
| 战情总览 | 汇总真实客户、商机、行动、风险和周报数据 | 不使用演示业务数据回退 |
| 快速记录 | 默认语音模式，支持文本、浏览器实时识别、AI 提炼、历史结果读取和人工修改 | 长期录音资产的完整上传、播放与恢复仍需继续完善 |
| 客户画像 | 列表、模块内搜索、只读详情、显式新增/修改/删除 | 修改使用版本号和审计，删除为受保护软删除 |
| 商机档案与看板 | 商机 CRUD、阶段、金额、概率、风险、动作和阶段统计 | 阶段调整仍应由真实客户行为证明 |
| 销售决策 Agent V1 | 已接入 DeepSeek 运行时，支持机会诊断、场景 playbook、`sales-decision-v1` 严格合同、证据门槛、合规升级、只读历史和人工确认写回预览 | 更多场景与行业评估集仍需持续扩充和校准；不允许模型自动写回客户、商机或行动，快速记录分析仍是独立链路 |
| 下一步动作与风险 | 后端真实数据、状态更新、来源追踪和审计 | AI 建议必须经人工确认后写回 |
| 智能拜访行程 | 高德地址解析、路线、时间、里程、过路费、顺序优化、地图和历史快照 | 历史读取不重复调用地图或模型 |
| 差旅报销 | 按自然周管理费用、多笔实付、提前请款、多退少补、付款凭证、发票仓库、人工匹配和 A4 打印 | 单账号个人使用；自动识别结果必须人工复核，不包含审批流和财务付款 |
| iCost 快捷指令 | iCost 成功记账后按账本名精确分流；“出差报销”只写森特智行，其他账本不进入本系统 | 只写文本 Webhook，独立 URL、独立 Token、幂等和审计；未知账本不发送 |
| 自有 iOS 快捷指令 | 一个账号 Token、一次账本/分类选择、截图文字上传；出差报销支出写森特，biubiu 经独立服务桥接写轻氧 | v0.6.2 候选尚未发布；出差报销收入暂不开放，跨系统远端未确认、配置不完整或请求失败时一律不返回成功 |
| 周报与汇报 | 根据真实业务数据生成、编辑、保存和导出 | 生成内容仍需人工检查 |
| 知识库 | 模块内搜索、条目维护和引用 | 后续可继续扩展检索与引用质量评估 |
| 微信机器人 | 系统内绑定、worker 自启动、持久化 AI 助手会话、付款凭证和发票图片/PDF 接入；已完成真实设备 `/clear` 往返验收 | 机器身份只获得声明的写入路由；更多业务场景仍按人工确认边界扩展 |
| 系统配置 | 独立配置页生成/轮换 iCost Token，并加密保存 DeepSeek API Key；运行时统一读取服务端密钥提供器 | 主加密密钥只允许进入后端受保护环境；页面不回显已保存明文 |
| 医院招标监测 | `v0.6.0` 已内置公开来源采集，按每小时一批 10 个客户自动轮巡，持久化游标/快照/锁，展示公告、匹配证据、来源健康和轮巡进度 | 已随生产切换启用；当前 scheduler 初始状态为 `idle`、轮次 `0`，首批真实轮巡和通知仍需观察；不依赖额外招标 API，不自动修改客户或商机 |
| 方案辅助 | 只读兼容入口 | 按当前产品决定暂停写入和 AI 调用 |

## 技术结构

```text
React 19 + Vite
        |
Cookie Session + CSRF + JSON API
        |
Node.js 24 + node:http
        |
SQLite migrations + optimistic locking + soft delete + audit
        |
DeepSeek / AMap / WeChat Agent / browser voice
```

主要目录：

| 路径 | 说明 |
| --- | --- |
| `outputs/product-design-prototype/` | 正式 React 前端、样式、页面、浏览器测试和静态服务 |
| `backend/` | API、认证、数据库迁移、AI、地图、微信和服务脚本 |
| `shared/` | 前后端共享业务契约 |
| `scripts/` | 本地编排、密钥扫描、发布包、生产预检和发布测试 |
| `docs/` | 需求、架构、开发、验收、部署和版本记录 |
| `.github/` | CI、标签发布、Issue/PR 模板、CODEOWNERS 和依赖更新 |

详细边界见 [项目架构与模块说明](docs/项目架构与模块说明.md)。

## 新设备开始开发

要求：

- Git 与 GitHub CLI
- Node.js 24 和配套 npm
- Chrome，用于浏览器集成验收
- 本地环境文件；真实密钥通过私下渠道配置，不从 GitHub 获取

```bash
git clone https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench.git
cd sentelligent-sales-workbench
npm ci --prefix backend
npm ci --prefix outputs/product-design-prototype
```

根据 `backend/.env.example` 和 `outputs/product-design-prototype/.env.example` 创建本机配置。然后运行：

```bash
npm run dev:start
npm run dev:health
```

停止本地服务：

```bash
npm run dev:stop
```

完整的分支、worktree、同步和设备交接流程见 [多设备开发与版本管理](docs/多设备开发与版本管理.md)。

## 质量门

```bash
npm run scan:secrets
npm run test:deploy
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
npm --prefix outputs/product-design-prototype run qa:integration
npm --prefix outputs/product-design-prototype run qa:webkit
```

涉及生产发布时还要完成：

- 一致性数据库备份、`quick_check`、外键检查和 SHA-256
- 生产预检 `25/25`，其中 `env.assistantSecrets` 强制微信机器边界和助手确认密钥独立且具有足够熵，`env.aiModel` 强制正式 DeepSeek 模式、端点、模型和独立密钥；`release.identity` 绑定 manifest、完整 commit 和三个项目服务；`database.environmentBinding` 绑定 `DATABASE_URL`、实际数据库以及 backend/WeChat 的同一 `EnvironmentFile` 路径和 SHA-256
- 公开 HTTPS 冒烟 `25/25`
- Chrome 桌面与移动视口验收
- 三个项目服务、共享 Caddy 和受保护服务盘点
- 新旧 release 路径与回滚点记录

## 版本与发布

- 使用语义化版本，源文件版本写入 `VERSION` 和三个 `package.json`。版本字段只标识候选代码，正式发布仍以 tag、GitHub Release 和部署证据为准。
- `v*` 标签触发 GitHub Release workflow，重新运行质量门并生成 `.tar.gz`、`release-result.json` 和 `SHA256SUMS`。
- 生产只部署已合并到 `main` 且已打标签的提交。
- GitHub Release 归档已包含质量门验证过的前端 `dist`；生产直接使用该目录，不在服务器重新构建前端。
- 每个 release 使用独立目录。systemd 单元直接固定到真实 release 路径，`current` 只作人工识别，不作为服务启动依据。
- 回滚只切换三个项目服务到上一已验收 release。共享 Caddy 和同机其他系统不随应用回滚重启。

操作细节见 [发布与回滚操作手册](docs/发布与回滚操作手册.md) 和 [部署记录](docs/部署记录.md)。

## 安全边界

仓库不保存：

- 账号密码、API Key、Token、Cookie 和会话密钥
- `.env` 和生产配置
- SSH/TLS 私钥或证书包
- SQLite 主库、WAL/SHM、备份和客户导出
- 录音、转写原文和微信登录状态
- `.runtime`、日志、依赖、构建目录和发布压缩包

提交前必须运行密钥扫描。发现凭据进入 Git 后，先撤销和轮换，再清理历史；只删除工作区文件不算处理完成。详见 [SECURITY.md](SECURITY.md)。

## v0.5.3 助手能力元数据

候选版本新增只读的 capability catalog 和 bounded project-analysis helpers：目录描述每项能力的 readiness、工具/API 映射、依赖、集成点、确认级别和来源引用；项目分析按受限输入区分开放/关闭的行动与风险并保留来源引用。它们是描述性元数据和纯函数，不改变 agent registry、tool registry、router 或业务写入边界；`ready` 也只表示代码已接线，不表示生产已验收。

## 微信 Clawbot 助手事件契约

候选版本的 vendored `weixin-agent-sdk@0.5.0-sentelligent.1` worker 通过独立机器 Token 调用：

```text
POST /api/integrations/weixin-agent/events
Authorization: Bearer <森特智行专用 WEIXIN_AGENT_API_TOKEN>
Idempotency-Key: <稳定重试键>
```

请求正文只接受标准化事件字段：`conversationId`、`text`、`sourceMessageId`、`senderId`、`chatType`（`direct`/`group`），可选 `groupId`、`media`、`pendingActionId` 和六位 `confirmationCode`。`media` 只接收原始 Base64、文件名、MIME 和 SHA-256；服务端重新校验魔数、MIME、长度和摘要，单文件上限 12 MiB，原始字节无损保存。

sender 必须出现在 `WEIXIN_ALLOWED_SENDER_IDS`，生产只接受私聊且拒绝群聊。确认回复必须来自同一 sender、channel 和 private conversation：恰好六位 ASCII 数字确认，原始文本精确等于 `取消` 或 `重发确认码` 才执行取消或轮换；前后空格、换行、全角数字和附加文字均不匹配。确认码只展示一次，SQLite 只保存 HMAC，连续五次错误后动作锁定；执行租约和稳定工具运行身份负责并发、重试和崩溃恢复。

owner、Token、路径和数据库身份一律由服务端配置决定，不能由消息正文覆盖。机器 Token 派生投递身份；轮换 Token 时必须先停止旧 worker、排空并封存旧 polling cursor，再启用新 Token，禁止并行消费。真实设备往返和生产切换仍需另行授权；本地候选检查不构成生产证据。

## 文档索引

- [原始项目需求书](项目需求书.txt)
- [需求与验收矩阵](docs/需求与验收矩阵.md)
- [项目架构与模块说明](docs/项目架构与模块说明.md)
- [开发进度与路线图](docs/开发进度与路线图.md)
- [开发日志](docs/开发日志.md)
- [多设备开发与版本管理](docs/多设备开发与版本管理.md)
- [v0.4.4 换机交接说明](docs/森特智行-v0.4.4-换机交接说明.md)
- [发布与回滚操作手册](docs/发布与回滚操作手册.md)
- [部署记录](docs/部署记录.md)
- [正式交付验收手册](docs/正式交付验收手册.md)
- [变更日志](CHANGELOG.md)
- [安全策略](SECURITY.md)
- [协作规范](CONTRIBUTING.md)
- [微信 Clawbot 助手集成说明](docs/微信Clawbot助手集成.md)
- [医院招标监测集成说明](docs/医院招标监测集成说明.md)

## 许可

本项目为私有商用项目，不授予公开复制、分发或再许可权利。
