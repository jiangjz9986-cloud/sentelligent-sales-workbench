# 森特智行 AI 销售作战台

森特智行 AI 销售作战台是一套面向个人复杂型 B2B 销售的业务系统。它把沟通记录、客户、商机、行动、风险、拜访行程、知识和周报放在同一套数据链路中，减少重复录入，也避免 AI 结果停留在一次性对话里。

系统已经部署到生产环境：[https://82.156.210.199/](https://82.156.210.199/)。仓库为私有项目，`main` 是唯一可部署来源；生产数据库、录音、微信状态、密钥和备份不进入 Git。

## 代码、发布与生产状态

| 项目 | 状态 |
| --- | --- |
| 当前生产版本 | `v0.4.3` |
| 生产提交 | `504fa81a30cf503b033385a950ff9d0af81778f2` |
| 注释标签 | `v0.4.3`，创建于 `2026-08-08T16:19:11+08:00` |
| GitHub Release | [森特智行 v0.4.3](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.4.3)，发布于 `2026-08-08T16:24:38+08:00` |
| Release 归档 SHA-256 | `5d1bcb22d50b8343cbf117bddebca3fd52bc1098c0c228b7dbd6e207ffd69739` |
| 当前生产 release | `/opt/sentelligent-sales-workbench/releases/2026-08-08_504fa81a30cf` |
| 当前开发目标 | `v0.4.4`，分支 `codex/v0.4.4-model-token-budget` |
| `v0.4.4` 状态 | 基于已部署的 `v0.4.3`，将销售决策推理型模型的 completion 预算从 `6400` 提升到 `12000`；业务 API、数据库迁移、依赖和用户工作流不变，正式状态以新 tag、GitHub Release 和生产证据为准 |

上述现网版本、release 路径、服务状态和健康接口已于 `2026-08-08` 复核。生产部署细节见 [部署记录](docs/部署记录.md)，本次候选说明见 [v0.4.4 版本说明](docs/releases/v0.4.4.md)。

## 功能状态

| 模块 | 当前能力 | 边界 |
| --- | --- | --- |
| 战情总览 | 汇总真实客户、商机、行动、风险和周报数据 | 不使用演示业务数据回退 |
| 快速记录 | 默认语音模式，支持文本、浏览器实时识别、AI 提炼、历史结果读取和人工修改 | 长期录音资产的完整上传、播放与恢复仍需继续完善 |
| 客户画像 | 列表、模块内搜索、只读详情、显式新增/修改/删除 | 修改使用版本号和审计，删除为受保护软删除 |
| 商机档案与看板 | 商机 CRUD、阶段、金额、概率、风险、动作和阶段统计 | 阶段调整仍应由真实客户行为证明 |
| 销售决策 Agent V1 | 规则规格文档已经完成并通过章节、UTF-8 和 JSON 示例检查 | 尚未按核心提示词、场景 playbook、行业规则、JSON Schema 和评估集拆分接入 DeepSeek 运行时，不能按已上线功能统计；现有快速记录分析是独立链路 |
| 下一步动作与风险 | 后端真实数据、状态更新、来源追踪和审计 | AI 建议必须经人工确认后写回 |
| 智能拜访行程 | 高德地址解析、路线、时间、里程、过路费、顺序优化、地图和历史快照 | 历史读取不重复调用地图或模型 |
| 差旅报销 | 按自然周管理费用、多笔实付、提前请款、多退少补、付款凭证、发票仓库、人工匹配和 A4 打印 | 单账号个人使用；自动识别结果必须人工复核，不包含审批流和财务付款 |
| iCost 快捷指令 | iCost 成功记账后按账本名精确分流；“出差报销”只写森特智行，其他账本不进入本系统 | 只写文本 Webhook，独立 URL、独立 Token、幂等和审计；未知账本不发送 |
| 周报与汇报 | 根据真实业务数据生成、编辑、保存和导出 | 生成内容仍需人工检查 |
| 知识库 | 模块内搜索、条目维护和引用 | 后续可继续扩展检索与引用质量评估 |
| 微信机器人 | 系统内绑定、worker 自启动、付款凭证和发票图片/PDF接入 | 机器身份只获得声明的写入路由；通用消息草稿持久化仍需继续加强 |
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
- 生产预检 `24/24`，其中 `env.aiModel` 强制正式 DeepSeek 模式、端点、模型和独立密钥；`release.identity` 绑定 manifest、完整 commit 和三个项目服务；`database.environmentBinding` 绑定 `DATABASE_URL`、实际数据库以及 backend/WeChat 的同一 `EnvironmentFile` 路径和 SHA-256
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

## 文档索引

- [原始项目需求书](项目需求书.txt)
- [需求与验收矩阵](docs/需求与验收矩阵.md)
- [项目架构与模块说明](docs/项目架构与模块说明.md)
- [开发进度与路线图](docs/开发进度与路线图.md)
- [开发日志](docs/开发日志.md)
- [多设备开发与版本管理](docs/多设备开发与版本管理.md)
- [发布与回滚操作手册](docs/发布与回滚操作手册.md)
- [部署记录](docs/部署记录.md)
- [正式交付验收手册](docs/正式交付验收手册.md)
- [变更日志](CHANGELOG.md)
- [安全策略](SECURITY.md)
- [协作规范](CONTRIBUTING.md)

## 许可

本项目为私有商用项目，不授予公开复制、分发或再许可权利。
