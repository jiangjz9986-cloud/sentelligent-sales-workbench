# 森特智行 AI 销售作战台

森特智行 AI 销售作战台是一套面向个人销售作业的轻量业务系统。它不以“大而全 CRM”为目标，而是围绕客户信息、商机推进、沟通记录、AI 提炼、行动跟进、风险识别和周报输出形成闭环。

当前仓库包含 React 前端、Node.js 后端、SQLite 数据库、DeepSeek 分析接入、微信机器人接入基础、部署脚本、测试证据和产品设计资料。

## 当前状态

项目处于 `0.1.0` 发布候选开发阶段。

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| 数据库、安全认证和审计 | 已验证 | 迁移、备份恢复、Cookie 会话、CSRF、乐观锁、软删除和审计已覆盖 |
| 客户、商机、行动、风险、周报 | 已实现 | 使用后端真实数据，不使用演示业务回退 |
| 快速记录和 AI 分析 | 已实现 | 新建默认语音，分析结果持久化并可保存修改 |
| URL 路由与浏览器历史 | 开发中 | 路由核心已验证，页面级整合仍需完成验收 |
| 语音资产持久化 | 开发中 | 后端存储与恢复正在完善，前端上传与播放仍需联调 |
| 微信机器人持久化 | 待开发 | 已有接入基础，仍需事件幂等、草稿持久化和单消费者保护 |
| 方案辅助 | 暂缓 | 按产品决策关闭写入，仅保留只读历史入口 |
| 新版生产部署 | 待验收 | 现网旧版本保留，发布候选通过全部门禁后再切换 |

真实进度与下一步计划见 [开发进度与路线图](docs/开发进度与路线图.md)。

## 核心模块

- 总览与管理汇报
- 快速记录、录音和 AI 沟通纪要
- 客户画像
- 商机档案与商机看板
- 下一步行动
- 风险识别
- 周报生成与导出
- 销售知识库
- 微信机器人绑定与消息接入
- 方案辅助只读历史

## 视觉基线

PC 与移动端统一采用 Apple Design 风格一，强调清晰层级、紧凑业务布局、明确操作状态和跨分辨率适配。

![PC 端视觉基线](outputs/design-renders/selected/2026-07-15-style-1-desktop.png)

![移动端视觉基线](outputs/design-renders/selected/2026-07-15-style-1-mobile.png)

## 技术架构

```text
React 19 + Vite
        |
Cookie Session + CSRF + JSON API
        |
Node.js 24 + node:http
        |
SQLite + migrations + audit log
        |
DeepSeek / WeChat Agent / private voice storage
```

## 本地运行

要求：

- Node.js 24
- npm
- Windows、WSL Ubuntu 24.04 或兼容 Linux 环境

安装依赖：

```bash
npm ci --prefix backend
npm ci --prefix outputs/product-design-prototype
```

根据 [backend/.env.example](backend/.env.example) 创建本机 `backend/.env`。禁止把真实账号、密码、API 密钥或生产地址提交到 Git。

启动完整本地开发栈：

```bash
npm run dev:start
npm run dev:health
```

停止：

```bash
npm run dev:stop
```

## 质量验证

```bash
npm run scan:secrets
npm run test:release
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
npm --prefix outputs/product-design-prototype run qa:integration
```

`qa:integration` 会启动真实前后端并执行浏览器流程，运行时间和环境要求高于普通单元测试。

## 文档索引

- [原始项目需求书](项目需求书.txt)
- [需求与验收矩阵](docs/需求与验收矩阵.md)
- [升级设计规格](docs/superpowers/specs/2026-07-15-sentelligent-sales-workbench-upgrade-design.md)
- [共享 API 契约](outputs/product-design-prototype/docs/06-shared-api-contract.md)
- [开发进度与路线图](docs/开发进度与路线图.md)
- [开发日志](docs/开发日志.md)
- [变更日志](CHANGELOG.md)
- [正式交付验收手册](docs/正式交付验收手册.md)
- [安全策略](SECURITY.md)
- [协作规范](CONTRIBUTING.md)

## 数据与安全边界

此仓库只保存源码、产品文档、设计基线和脱敏测试证据，不保存：

- `.env` 和任何真实凭据
- SQLite 生产数据库及备份
- 客户原始数据
- 语音录音和微信会话状态
- SSH 私钥、证书和发布压缩包
- `.runtime`、日志、依赖与构建产物

详细要求见 [SECURITY.md](SECURITY.md)。

## 版权

本项目为私有商用项目，不授予公开复制、分发或再许可权利。
