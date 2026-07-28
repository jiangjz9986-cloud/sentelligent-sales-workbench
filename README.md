# 森特智行 AI 销售作战台

森特智行 AI 销售作战台是一套面向个人复杂型 B2B 销售的业务系统。它把沟通记录、客户、商机、行动、风险、拜访行程、知识和周报放在同一套数据链路中，减少重复录入，也避免 AI 结果停留在一次性对话里。

系统已经部署到生产环境：[https://82.156.210.199/](https://82.156.210.199/)。仓库为私有项目，`main` 是唯一可部署来源；生产数据库、录音、微信状态、密钥和备份不进入 Git。

## 代码版本与已验证基线

| 项目 | 状态 |
| --- | --- |
| 当前代码版本 | `0.2.0` |
| 代码内容冻结时间 | `2026-07-29T01:40:43.097+08:00` |
| 正式发布判定 | 以 [GitHub Releases](https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases) 中 `v0.2.0` 的 tag、`publishedAt` 和资产 SHA-256 为准 |
| 生产部署判定 | 以 [部署记录](docs/部署记录.md) 的最新版本条目和服务器 evidence 为准 |
| 内容冻结时已验证的生产基线 | `v0.1.0` / `f89e1e79f57ccfa95def5fb402dc27ebfec446b4` |
| 该基线部署时间 | `2026-07-28T22:30:21+08:00` |
| 该基线 release | `/opt/sentelligent-sales-workbench/releases/2026-07-28_f89e1e7` |
| 该基线运行时 | 独立 Node.js 24，后端 `127.0.0.1:8897`，前端 `127.0.0.1:8088` |
| 该基线验收 | 公开 HTTPS 冒烟 `25/25`，生产预检 `18/18` |

`0.2.0` 表示仓库当前代码版本，不自动表示 tag、GitHub Release 或生产切换已经完成。该版本增加跨设备开发文档、模块说明、版本记录、标签发布和回滚规范；正式发布和部署状态始终由上表所列证据判定。

## 功能状态

| 模块 | 当前能力 | 边界 |
| --- | --- | --- |
| 战情总览 | 汇总真实客户、商机、行动、风险和周报数据 | 不使用演示业务数据回退 |
| 快速记录 | 默认语音模式，支持文本、浏览器实时识别、AI 提炼、历史结果读取和人工修改 | 长期录音资产的完整上传、播放与恢复仍需继续完善 |
| 客户画像 | 列表、模块内搜索、只读详情、显式新增/修改/删除 | 修改使用版本号和审计，删除为受保护软删除 |
| 商机档案与看板 | 商机 CRUD、阶段、金额、概率、风险、动作和阶段统计 | 阶段调整仍应由真实客户行为证明 |
| 销售决策 Agent V1 | 在商机详情显式运行 DeepSeek 诊断，保存输入/分析快照和只读历史 | 不自动修改客户、商机、行动或风险；评分仍需真实赢单/输单案例校准 |
| 下一步动作与风险 | 后端真实数据、状态更新、来源追踪和审计 | AI 建议必须经人工确认后写回 |
| 智能拜访行程 | 高德地址解析、路线、时间、里程、过路费、顺序优化、地图和历史快照 | 历史读取不重复调用地图或模型 |
| 周报与汇报 | 根据真实业务数据生成、编辑、保存和导出 | 生成内容仍需人工检查 |
| 知识库 | 模块内搜索、条目维护和引用 | 后续可继续扩展检索与引用质量评估 |
| 微信机器人 | 系统内绑定入口、worker 自启动和状态查询 | 消息事件幂等、草稿持久化和单消费者保护仍需加强 |
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
```

涉及生产发布时还要完成：

- 一致性数据库备份、`quick_check`、外键检查和 SHA-256
- 生产预检 `19/19`，其中 `release.identity` 必须绑定 manifest、完整 commit 和三个项目服务的同一 immutable release
- 公开 HTTPS 冒烟 `25/25`
- Chrome 桌面与移动视口验收
- 三个项目服务、共享 Caddy 和受保护服务盘点
- 新旧 release 路径与回滚点记录

## 版本与发布

- 使用语义化版本，源文件版本写入 `VERSION` 和三个 `package.json`。
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
