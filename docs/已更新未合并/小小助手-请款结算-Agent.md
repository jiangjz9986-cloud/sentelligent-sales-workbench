# 小小助手：请款结算与多退少补预览

## 登记信息

- 编号：`xiaoxiao-advance-settlement`
- 状态：`已开发 / 待合并`
- 登记日期：2026-08-20
- 来源分支：`codex/xiaoxiao-agent-suite`
- 来源提交：`35a6c0f`
- 聚合分支：`codex/unmerged-updates`
- 目标分支：`main`
- Draft PR：创建后回填

## 这次更新了什么

把请款结算 Agent 从只读请款事实草稿提升为可运行的只读结算预览：

- 新增服务端 `settlementSnapshotAdapter`，从 SQLite 重建请款、到账、费用、付款资金来源、发票匹配和无票确认证据。
- 新增 `advance-settlement.preview` 工具，并接入 Agent manifest、工具策略、确定性路由和运行时处理器。
- 支持“请款结算”“多退少补”等自然语言入口，也支持显式工具命令。
- 保留 owner-scoped 查询、上海时区自然周、来源引用、运行记录重放和截断检测。
- 在固定 Agent 合同和能力目录中登记为启用的 `modelPolicy=none` 预览能力。

## 结算口径

```text
非公司直付的可报销金额 - 已收到请款金额
```

- 正数：`company_reimburses`，公司应补给个人。
- 负数：`individual_returns`，个人应退回公司。
- 零：`balanced`，结算平衡。

没有请款记录时，系统明确标记“未录入请款”，不会静默把它当成“到账 0 元”。

## 用户可见结果

预览会包含：

- 结算方向和绝对金额。
- 公式两端的金额及带符号差额。
- 请款、到账、费用、资金来源和票据覆盖证据。
- 截断、异常、owner 范围、票据未覆盖等人工复核阻塞项。
- 明确的交易状态：当前没有退款或补款流水。

## 硬边界

本次没有实现、也不会暗中执行以下动作：

- 创建、修改或删除退款/补款流水。
- 修改费用金额、可报销金额、请款金额或请款状态。
- 自动提交报销、自动确认发票或替代无票确认。
- 跨 owner 读取数据，或把模型生成的字段当成服务端事实。
- 部署、重启生产或改动报销/记账专用工作树。

即使方向和金额可以计算，输出仍然是“待人工确认预览”，不能表述为财务交易已经发生。

## 验证证据

- 后端全量：`npm test`，`877/877` 通过。
- 定向覆盖：结算快照、Agent 适配器、固定合同、工具策略、自然语言路由、运行时 handler、HTTP 入口和 owner 隔离均通过。
- 代码检查：`git diff --check` 和 Node 语法检查通过。

## 主要代码范围

- `backend/src/assistant/settlementSnapshotAdapter.js`
- `backend/src/assistant/advanceSettlementAssistantAdapter.js`
- `backend/src/assistant/agentManifest.js`
- `backend/src/assistant/agentRegistry.js`
- `backend/src/assistant/policy.js`
- `backend/src/assistant/router.js`
- `backend/src/assistant/runtimeHandlers.js`
- `backend/src/server.js`
- 对应 `backend/tests/assistant-*` 结算、路由、运行时和 HTTP 测试

## 后续合并前需要确认

如果未来要真正记录退款/补款，需要另行设计交易表、幂等键、审批人、版本校验、审计事件和失败重试规则；不能把本预览直接升级成财务写入。
