# 开发协作规范

新设备初始化、跨设备接续和版本发布的完整步骤见 [多设备开发与版本管理](docs/多设备开发与版本管理.md)。生产操作见 [发布与回滚操作手册](docs/发布与回滚操作手册.md)。

## 基本原则

- `main` 始终代表已验证、可部署或可回滚的版本。
- 每个需求、缺陷或技术债先建立 GitHub Issue。
- 每个 Codex 会话使用独立分支和独立工作树，不共享未提交文件。
- 禁止直接在 `main` 开发大功能。
- 禁止提交真实业务数据和任何运行时凭据。

## 分支命名

```text
codex/<issue-number>-<short-topic>
```

示例：

```text
codex/42-voice-persistence
codex/57-weixin-idempotency
codex/61-mobile-layout
```

## 提交信息

采用简洁的 Conventional Commits 风格：

```text
feat(voice): persist uploaded recordings
fix(auth): reject expired sessions
test(quick-record): verify saved analysis restore
docs: update production handoff
```

一次提交只表达一个可审查意图。不要把无关格式化、运行时文件或其他会话修改混在一起。

## Pull Request

默认创建 Draft PR。PR 必须说明：

- 对应需求或 Issue
- 用户可见变化
- 前端、后端、数据库和部署影响
- PC 与移动端验证证据
- 自动化测试结果
- 数据迁移和回滚方式

所有检查通过并完成实际浏览器验收后，才能改为 Ready 并合并。

## 最低验证

```bash
npm run scan:secrets
npm run test:deploy
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
```

涉及跨模块、登录、AI、录音、数据库或部署的修改，还必须运行：

```bash
npm --prefix outputs/product-design-prototype run qa:integration
```

## 多会话交付

子会话完成任务时必须报告：

- 修改文件
- 提交 SHA
- 测试命令与结果
- 已知风险和未完成项

主控制会话负责审查差异、复跑关键测试、整合分支和最终产品验收。

## 正式版本

- `VERSION`、三个 `package.json`、两个 lockfile 和 `CHANGELOG.md` 必须保持一致。
- 版本内容、内容冻结时间和已知限制写入 `docs/releases/vX.Y.Z.md`。
- 只有已合并到 `main` 的提交可以创建 `vX.Y.Z` 标签。
- 标签不能移动。发布有误时递增版本，不覆盖原标签或 GitHub Release。
- GitHub Release 保存最终 tag 时间、提交 SHA、发布包、manifest 和 SHA-256。
- 云端部署完成后记录新旧 release、数据库备份、预检、冒烟和回滚点。
