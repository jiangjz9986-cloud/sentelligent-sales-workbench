# 变更日志

本项目采用语义化版本思路记录可验证里程碑。正式版本以 Git 标签和 GitHub Release 为准。

## [Unreleased]

### 开发中

- 页面 URL 状态、浏览器前进后退和滚动恢复整合
- 语音录音上传、私有存储、播放、Range 下载和重启恢复
- 新版发布包、生产预检和部署切换验收
- 微信机器人事件幂等、草稿持久化和单消费者保护

### 待补齐

- 快速记录显式修改/删除流程
- 语音前端完整联调和 iPhone Safari 实机验收
- 微信机器人持久化改造
- 大型页面组件拆分
- 新版生产发布与回滚演练

## [0.1.0-rc.1] - 待发布

### 新增

- React 19 + Vite 的 Apple Design 风格一 PC/移动端业务界面
- 客户、商机、行动、风险、周报、知识库和管理总览
- DeepSeek 分析、快速记录历史与人工确认回写
- Cookie 登录、CSRF、Origin 校验和七天会话
- SQLite 版本迁移、备份恢复、数据完整性检查和审计日志
- 乐观锁、软删除、幂等确认和受保护导出
- 规范化业务路由核心
- 可移植发布包和只读生产预检

### 修复

- 移除前端演示数据和静态商机时间线
- 修复业务数据竞态和商机阶段计数守恒
- 历史 AI 分析加载时不再重复调用模型
- 分析结果可持久化修改，确认时使用已保存结果
- 方案辅助写入按产品决策关闭并返回明确错误
- 收紧路由输入、发布路径、命令白名单和敏感信息扫描

### 验证

- 第一阶段安全、恢复和并发测试通过
- 快速记录分析持久化和周报展开集成测试通过
- PC、平板、iPhone 和 Android 窄屏无横向溢出

## [0.1.0-baseline] - 2026-07-15

- 建立经过验证的项目基线
- 确认 Apple Design 风格一视觉方向
- 完成第一阶段安全与数据基础设计

[Unreleased]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/compare/v0.1.0-rc.1...HEAD
[0.1.0-rc.1]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0-rc.1
[0.1.0-baseline]: https://github.com/jiangjz9986-cloud/sentelligent-sales-workbench/releases/tag/v0.1.0-baseline
