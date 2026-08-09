# Clawbot 全系统 AI 助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 复用已经接通的微信 Clawbot，把它从“拜访录入/客户查询”升级为森特智行全系统 AI 助手；所有 Agent 只能通过受控工具访问现有业务服务，敏感写入必须由本人确认，且不实现公司超标规则。

**Architecture:** `weixin-agent-sdk`、扫码绑定和现有 worker 保持不变，worker 只负责收发与媒体标准化。后端新增 Assistant Runtime：事件去重/租约 → 确定性命令或受限意图路由 → Agent/Tool 注册表 → 权限门 → 现有领域 API/Repository → 审计与可重放响应。模型只能产出枚举化 Agent、Tool 和参数，不能产出 URL、SQL、Token、owner 或任意文件路径。

**Tech Stack:** Node.js 24, SQLite migrations, existing JSON API and audit/idempotency primitives, `node:test`, existing DeepSeek-compatible model client only behind a bounded router.

---

## 不变的产品边界

- 不新增微信账号、Webhook、扫码流程或第二套 Clawbot 接入。
- 森特智行与轻氧智能门店继续使用独立 URL、Token、数据库和审计；Assistant Runtime 只能写森特侧。
- 公司超标/额度/发票硬规则本阶段不实现；金额以用户录入和人工确认值为准，只校验整数分、归属、版本和算术关系。
- 图片/PDF 进入现有无损文档仓库；不把媒体塞进 iCost 文本接口，不做有损重编码。
- 禁止 Agent 执行 SQL、任意 HTTP、密钥/配置管理、生产部署、服务重启、审计删除或跨 owner 写入。

## Agent 清单

| Agent ID | 作用 | 默认状态 | 写入边界 |
| --- | --- | --- | --- |
| `system-router` | 帮助、澄清、取消、确认 | enabled | 不直接写业务 |
| `dashboard` | 总览、待办、风险摘要 | enabled | 只读 |
| `visit-capture` | 拜访/电话/会议暂存、预览、快速记录 | enabled | 创建前确认 |
| `customer` | 客户查询和维护 | enabled | 增改删确认 |
| `opportunity` | 商机查询、阶段、金额、下一步 | enabled | 所有写入确认 |
| `sales-decision` | 诊断、会前准备、下一步建议 | enabled | 分析可预览，写回确认 |
| `action-risk` | 行动与风险查询/处理 | enabled | 状态写入确认 |
| `itinerary` | 行程与路线规划 | enabled | 规划预览；保存/改删确认 |
| `travel-expense` | 周费用、多笔实付、账单 | enabled | 财务写入确认 |
| `payment-proof` | 付款原件和候选识别 | enabled | 上传待处理可行；关联确认 |
| `invoice` | 发票仓库、匹配、无票替代 | enabled | 上传可行；匹配/替代确认 |
| `advance-settlement` | 请款、到账、多退少补 | enabled | 全部写入确认 |
| `reimbursement-report` | 自然周汇总、打印预览 | enabled | 预览可行；保存/删除确认 |
| `sales-report` | 销售周报与导出 | enabled | 预览可行；保存/发布确认 |
| `knowledge` | 知识查询与维护 | enabled | 增改删确认 |
| `solution` | 方案/会前大纲 | disabled | 等 feature flag |
| `personal-finance` | 个人总账和自然周助手 | disabled | MVP 完成后启用 |

“销售周报”和“差旅报销周汇总”语义不明确时必须先询问一次，不得猜测。

## 多子代理开发工作流

总控负责需求边界、集成文件、分支合并和最终验证；复杂架构/安全决策使用当前可用的最高推理档，边界清晰的迁移、契约和测试交给成本更低的子代理并行执行。子代理不得同时修改 `server.js`、`config.js`、`machineAuthorization.js`、`db/migrate.js`、`worker.js`、`agentBridge.js`；这些文件由总控在最后一批整合。

每个子任务都必须遵守：先写一个能复现需求的红灯测试 → 运行并记录失败原因 → 最小实现 → 专项测试全绿 → 交付文件清单和风险。总控重新运行所有测试、审阅 `git diff`、执行密钥扫描后才提交。

并行批次顺序：

1. 持久化底座：事件、会话草稿、待确认动作、工具运行记录。
2. Agent/Tool manifest、权限策略和确定性路由。
3. 总控集成：真实机器鉴权、现有快速记录/付款/发票兼容、服务器身份注入。
4. 独立安全与并发验收：重放、租约接管、重启、跨 owner、提示注入和真实 HTTP。

---

### Task 1: 修复现有微信预览机器鉴权回归

**Files:**
- Modify: `backend/src/auth/machineAuthorization.js`
- Test: `backend/tests/auth-http.test.js`, `backend/tests/weixin-agent-http-integration.test.js`

- [ ] **Step 1: 写红灯集成测试**

使用真实 `startServer({ weixinAgentApiToken })` 和 `createSalesWorkbenchWeixinAgent`，让“记录”调用 `/api/quick-records/preview`；预期机器身份收到 200，错误账本/未授权仍被拒绝。

- [ ] **Step 2: 运行测试确认当前白名单 403**

```powershell
npm --prefix backend test -- --test-name-pattern="preview|weixin-agent-http"
```

- [ ] **Step 3: 最小加入精确 `POST /api/quick-records/preview` 白名单**

不开放通配路径，不改变其他机器能力。

- [ ] **Step 4: 运行集成与认证回归**

```powershell
npm --prefix backend test -- --test-name-pattern="preview|machine|weixin"
```

### Task 2: Assistant Runtime 持久化

**Files:**
- Create: `backend/src/assistant/eventRepository.js`
- Create: `backend/src/assistant/sessionRepository.js`
- Create: `backend/src/assistant/pendingActionRepository.js`
- Create: `backend/src/db/migrations/0011_assistant_runtime.mjs`（若 0011 已占用，使用下一编号并在计划中记录）
- Test: `backend/tests/assistant-repository.test.js`, `backend/tests/assistant-restart-recovery.test.js`

- [ ] **Step 1:** 测试 `(owner, channel, external_event_hash)` 唯一、同请求重放返回原响应、同 ID 不同哈希冲突、过期 lease 可接管。
- [ ] **Step 2:** 测试会话/草稿/待确认动作写入后关闭 SQLite 再打开仍可恢复；确认码只存哈希，过期动作不能执行。
- [ ] **Step 3:** 建立最小表与 repository，所有写入使用现有同步事务和审计边界，不保存 Token、Cookie 或完整媒体正文。
- [ ] **Step 4:** 运行专项测试和现有后端全量测试。

### Task 3: Agent/Tool 注册表和路由

**Files:**
- Create: `backend/src/assistant/contracts.js`
- Create: `backend/src/assistant/policy.js`
- Create: `backend/src/assistant/agentRegistry.js`
- Create: `backend/src/assistant/toolRegistry.js`
- Create: `backend/src/assistant/router.js`
- Test: `backend/tests/assistant-contracts.test.js`, `backend/tests/assistant-policy.test.js`, `backend/tests/assistant-agent-manifests.test.js`, `backend/tests/assistant-router.test.js`

- [ ] **Step 1:** 测试未知 Agent/Tool、owner/actor/token/url/httpMethod/sql/path 字段、越界参数全部拒绝；只接受注册表枚举。
- [ ] **Step 2:** 测试帮助/取消/确认和已有 `/客户`、`/付款凭证`、`/发票` 命令优先于模型路由；自然语言无法区分两类周报时返回澄清。
- [ ] **Step 3:** 注册上表全部 Agent，并将 solution/personal-finance 保持 disabled；为首批只读查询、拜访预览/确认、媒体待处理和报销预览声明工具契约。
- [ ] **Step 4:** 路由只产生经过校验的 intent plan，不直接发 HTTP/执行 SQL；低置信度和提示注入只返回安全澄清。

### Task 4: 总控集成与人工确认门

**Files:**
- Create: `backend/src/assistant/orchestrator.js`
- Modify: `backend/src/weixin/agentBridge.js`, `backend/src/weixin/worker.js`, `backend/src/auth/machineAuthorization.js`, `backend/src/server.js`
- Test: `backend/tests/assistant-orchestrator.test.js`, `backend/tests/weixin-agent-http-integration.test.js`, `backend/tests/assistant-security.test.js`

- [ ] **Step 1:** 将现有 Clawbot 请求标准化为事件，先 claim 再处理；重放直接返回保存的响应。
- [ ] **Step 2:** 服务器注入 owner/principal/conversation/request 时间；模型永远拿不到 Token、URL、SQL、文件路径或可控 actor。
- [ ] **Step 3:** R0/R1 只读和预览直接返回；R2/R3 生成绑定会话、对象版本和过期时间的确认码，同一会话最多一个待确认写操作。
- [ ] **Step 4:** 保留付款/发票原有无损上传和人工复核语义；创建快速记录与分析之间崩溃时，重启继续同一记录而不重复创建。

### Task 5: 并发、重启和真实验收

**Files:**
- Test: `backend/tests/assistant-concurrency.test.js`, `backend/tests/assistant-restart-recovery.test.js`
- Evidence: 受控本地验收 manifest（不提交）

- [ ] **Step 1:** 50 个同消息并发只产生一条业务记录、一条工具运行和一组审计。
- [ ] **Step 2:** 在业务实体创建后、模型返回前模拟进程退出，重启后继续同一实体。
- [ ] **Step 3:** 非白名单发送者、群聊、跨 owner、任意 URL/SQL/凭据输入全部拒绝且不泄露内部值。
- [ ] **Step 4:** 真实微信发送拜访、查询、费用、付款凭证和发票；浏览器核对记录、附件 SHA、审计及人工确认门。未完成真实设备验收前不宣称端到端完成。

---

## 验收门

```powershell
npm run test:deploy
npm --prefix backend test
npm --prefix outputs/product-design-prototype run qa:local
npm --prefix outputs/product-design-prototype run qa:integration
npm --prefix outputs/product-design-prototype run qa:webkit
```

所有本地门通过并经 GitHub Node 24 CI 验证后，才创建发布计划；本计划不授权生产部署、服务重启或密钥变更。
