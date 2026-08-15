# 本地候选收口设计

## 目标

在生产锚点 `main@4eb6a8540ba3dbfa9824c8b2f1a66066b5348273` 上保留小小助手四文件能力层，并把本地交付闸门恢复到可复现、可审计的状态。完成后只合入本地 `main`，不推送 GitHub，不写云端，不改变生产。

## 现状与边界

- 小小助手候选提交 `585f89c1422b26423f5928a76e0b549529610424` 已精确 cherry-pick 到集成提交 `86b53becfd6c7df930e02bbed4c9da9b05003c53`。
- 四文件能力层必须保持纯 metadata / pure function，不接入 router、server、migration、微信或前端。
- 生产版本继续独立于代码候选；本目标不做 release 切换、服务重启、数据库恢复或云端写入。

## 三条独立车道

### A. 历史 secret-scan

扫描器继续扫描完整 Git 历史和所有可见 refs。只在测试源码上下文增加窄的 synthetic cursor/retry fixture 识别；生产配置、普通源码、供应商源码和真实混合大小写/数字凭据仍必须命中。修改范围严格为 `scripts/project-secret-scan.mjs` 与 `scripts/project-secret-scan.test.mjs`。

### B. release/preflight

先复现并区分本机夹具缺失、环境变量污染和真实实现回归。只有在证据证明是代码缺陷后，才修改 release/preflight 脚本或测试；不得放宽路径、身份、所有权、manifest、依赖清单或 cutover 安全边界。每个修复必须有针对性回归测试。

### C. StageStrip 浏览器 QA

追踪 headless Chrome 的启动、端口、页面加载和清理生命周期。优先使用条件等待、明确的子进程指纹和 finally 清理；不把业务断言超时无限延长。修改范围只限 StageStrip QA 脚本/测试及其明确的测试工具，不改业务数据契约。

## 集成顺序

三条车道在独立 worktree 并行完成只读审查或实现；主控按 A→B→C 串行审查每个 diff，分别运行 focused RED→GREEN，再 cherry-pick 到集成分支。最后运行 backend、root deploy gates、frontend local/integration/WebKit、完整 secret scan、diff 和 tracked-sensitive audit。所有门禁通过后才合入 `main`。

## 失败处理

任何新失败先回到根因调查，不接受关闭历史扫描、删除 refs、跳过测试、放宽安全断言或将真实 fixture 改成未审计的占位符。若需要修改超出车道 allowlist，暂停该车道并记录新的授权边界。
