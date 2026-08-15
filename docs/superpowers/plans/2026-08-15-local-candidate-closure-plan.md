# 本地候选收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复本地交付闸门并验证小小助手候选，使其可以安全合入本地 `main`。

**Architecture:** 三条独立 worktree 车道分别处理历史 secret scan、release/preflight 和 StageStrip 浏览器生命周期；主控只在每条车道 focused GREEN、diff review 和边界审查通过后串行 cherry-pick。应用能力层继续保持只读 metadata 与纯函数分析，不与执行 registry 或生产边界耦合。

**Tech Stack:** Node.js 24.19.0、npm 11.17.0、Node test runner、Playwright WebKit/Chromium、Git worktree。

## Global Constraints

- 主控与高风险审查只使用 `gpt-5.6-sol`；不调用 Terra 或 Luna。
- 所有源码、测试、构建和提交只在本地 Git clone/worktree 进行。
- 不推送 GitHub、不创建 PR/tag/Release、不写云端、不执行生产变更。
- 不输出密钥、Token、密码、环境文件内容、Cookie、数据库行或业务附件。
- 小小助手四文件之外的修改必须留在对应独立车道，并在主控审查后才可集成。
- 每个 bugfix 必须遵循 RED→GREEN；不得关闭历史扫描或放宽生产安全断言。
- 完成声明必须有本轮命令、退出码和失败计数证据。

---

### Task 1: 历史 secret-scan 误报收口

**Files:**
- Modify: `scripts/project-secret-scan.mjs`
- Test: `scripts/project-secret-scan.test.mjs`

**Steps:**

- [ ] 写一个只匹配测试源码中 cursor/retry synthetic label 的失败回归测试，并保留真实混合大小写/数字 assignment 的反例。
- [ ] 运行 `node --test --test-name-pattern='cursor|retry' scripts/project-secret-scan.test.mjs`，确认先因当前历史 fixture 仍被报告而失败。
- [ ] 实现最小、路径限定的 placeholder 规则；不得改变 `git rev-list --objects --all`、生产配置扫描或真实凭据模式。
- [ ] 运行同一 focused 命令，确认 GREEN；再运行 `node --test scripts/project-secret-scan.test.mjs`。
- [ ] 运行 `npm run scan:secrets` 与 `npm run scan:secrets -- --no-history`，记录完整历史对象/消息计数和 finding 数量。
- [ ] `git diff --check`，提交精确文件清单，回传 commit SHA、命令和结果。

### Task 2: release/preflight 失败根因与最小修复

**Files:**
- Inspect first: `scripts/release-package.mjs`, `scripts/release-package.test.mjs`, `scripts/production-preflight.mjs`, `scripts/production-preflight.test.mjs`, `scripts/production-cutover*.mjs`
- Modify only after root cause proof and RED test; exact list recorded in the task report.

**Steps:**

- [ ] 独立复现 7 个 root script failures，记录每个失败的输入、边界和共同根因；先确认哪些是本机夹具/环境问题。
- [ ] 对确认的代码缺陷写最小 RED 测试；环境缺口不得用源码改动伪装修复。
- [ ] 实现一个最小修复，保持 canonical path、manifest inventory、ownership、service allowlist 和 secret-free environment 约束。
- [ ] 运行对应 focused tests，再运行 `node --test scripts/release-package.test.mjs scripts/production-preflight.test.mjs`。
- [ ] 主控复核 changed-file allowlist、`git diff --check`、tracked-sensitive audit 后再集成。

### Task 3: StageStrip Chrome 生命周期

**Files:**
- Inspect/modify only `outputs/product-design-prototype/scripts/stage-strip-data.test.mjs`, `outputs/product-design-prototype/scripts/stage-strip-timeout.mjs`, and `outputs/product-design-prototype/scripts/stage-strip-timeout.test.mjs`; do not modify the StageStrip business component or fixture markup unless a focused RED test proves the fixture is the source.

**Steps:**

- [ ] 在显式 `CHROME_PATH` 下单独运行 StageStrip tests，记录子进程 PID、端口、临时 profile 和超时阶段。
- [ ] 在 `stage-strip-timeout.test.mjs` 写一个最小生命周期/条件等待 RED 回归测试；不得只把 60 秒业务超时改大。
- [ ] 修复启动握手、页面就绪或 finally 清理中的单一根因，并保证已退出子进程不会被重复 signal。
- [ ] 运行 StageStrip focused tests、前端 `qa:local`，确认无残留进程/临时 profile。
- [ ] 再运行 `qa:integration` 与 `qa:webkit`，保存报告和退出码。

### Task 4: 主控集成与最终门禁

**Files:**
- Modify only by cherry-pick from reviewed Task 1–3 commits plus the existing four-file candidate.

**Steps:**

- [ ] 按 Task 1→Task 2→Task 3 顺序 cherry-pick 到集成 worktree，逐次运行 focused tests。
- [ ] 运行 `node --test backend/tests/capability-catalog.test.js backend/tests/project-analysis.test.js`、`npm --prefix backend test`。
- [ ] 运行 `npm run scan:secrets`、`node --test scripts/*.test.mjs`、前端 `qa:local`、`qa:integration`、`qa:webkit` 和 `npm run qa:full`。
- [ ] 运行 `git diff --check`、精确 changed-file inventory、tracked-sensitive audit 和最终 diff review。
- [ ] 仅当所有命令退出 0 且 worktree clean 时，在本地 `main` 合入；不 push/PR/tag/云端/生产。
