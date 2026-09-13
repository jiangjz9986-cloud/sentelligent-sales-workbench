# AI 统一调度平台后续开发完善计划

更新时间：2026-09-13（Asia/Shanghai）
目标模式：本主任务已通过目标工具创建为 `active`。  
用户指定的开发设置：model `gpt-5.6-luna`、reasoning effort `max`；实际切换以应用工具返回为准，文档本身不会切换模型。  
业务模型：DeepSeek provider `deepseek`，统一模型 `deepseek-flash`。  
生产边界：不把 Codex 执行模型写入业务运行配置；PushPlus 保持退役；主动调度唯一所有者保持 Backend；不做 iPhone 真机验收。

## 目标

把当前已经完成 P1 旁路部署和本地模拟验收的 AI 平台，收口为可审计、可灰度、可回滚的生产能力。最终交付必须同时具备：

- 真实 DeepSeek `deepseek-flash` 文本/JSON 调用链路、供应商响应身份和费用记录。
- 预算预占、实际用量、未知费用、价格日历和供应商账单之间可核对。
- 客户级主动助手、销售决策、快速记录、周报、行程、票据/记账和 ASR 的入口矩阵证据。
- 微信 Clawbot 主动消息在无入站消息时的投递、上下文失效恢复、限速、重试、去重和解绑保护。
- 管理台的管理员认证代理、CSRF、发布/回滚、排空和权限拒绝证据。
- 生产写入型验收：客户导入、客户/商机、action/risk、医院招标转化，均使用可识别的合成数据并完成清理和审计核对。
- 新旧 worker 的单一所有权、排空、备份、恢复、观察和回滚证据。

## 固定边界

| 项目 | 固定值 |
| --- | --- |
| 开发执行模型 | Codex `gpt-5.6-luna / max` |
| 业务供应商 | `deepseek` |
| 业务模型 | `deepseek-flash` |
| 业务视觉模型 | `deepseek-flash` |
| 供应商端点 | `https://api.deepseek.com` |
| 主动调度所有者 | Backend `proactive worker` |
| 外部通知通道 | 微信 Clawbot；PushPlus 永久退役 |
| 生产数据 | 业务 SQLite 与平台 SQLite 分离；不读取 iCloud |
| 浏览器验收 | Mac 原生 Google Chrome；移动尺寸只做浏览器兼容性 |
| 当前生产 release | `21cb281ee37e30c12cf9c1de663c50cc0d9bc5ab`（只读核对于 2026-09-13） |
| 当前生产阶段 | P1 受控在线：`paused`、`local-simulated`、`externalProvidersEnabled=false`、admission closed |

## 阶段计划

### 执行基线与优先级

- 工作树为 `ai-platform-production-integration-20260909`，本轮开始于文档提交
  `758847a03e9b6f78c3bbbab061b4eff43262cfae`；生产代码基线为表中 `44e6d36...`。
- 已完成的客户级助手、招标 bridge、action/risk、客户批量导入和滚动修复继续保留。
  现有自动化和生产只读证据可作基线，不重做四条业务功能；改动后按受影响范围验证。
- 本轮新增的 provider catalogue 探针仍属实现中。`GET /models` 只能产生
  `probeReady=true`；真实 completion、结果校验、usage 和 request id 证据未齐前，
  生产业务任务保持 `liveReady=false`。前一轮 `97/38/29` 通过数不能证明本项已收口。
- 优先修实际代码阻塞：首次 canary 需要 liveReady 才能运行的循环依赖；P2 样本当前
  `{text}` 与 provider 所需 `chat.completions.v1` 不符；账单到达后的重验缺少持久检查点。
  同时补凭据轮换、过期证据和并发刷新隔离，不能靠把布尔值设为 true 放行。
- 生产修改沿用本任务已获授权；必要的低额合成样本和用户本人微信验收沿已有范围执行，
  不反复索要同一授权。付费试验采用本计划选定的初始上限：单并发、10 个文本样本、
  合计不超过人民币 5 元或现有更低预算，不充值、不自动增加限额；达到上限即记录停止。

### 契约、迁移与写集冻结

本次优先以现有表和前向兼容字段实现，不修改已有业务迁移 0042-0045 或平台迁移 0001-0010。
确需新增持久化表时，主负责人先复核两个迁移注册表，冻结下一个空闲编号及 checksum 后再委派，
不得把推测的编号当作已分配编号。

| 责任 | 精确写集与交接内容 |
| --- | --- |
| 主负责人 A | `ai-platform/src/providers/*`、`ai-platform/src/tasks/taskService.js`、`ai-platform/src/server.js`、`ai-platform/src/cli.js`；真实证据状态、首次 canary 放行与启动/关闭 |
| 工作流 B | `scripts/ai-platform/p2-acceptance.mjs`、`scripts/ai-platform/p2-acceptance.test.mjs`；固定请求协议、采样检查点、只读恢复、账单导入和最终报告 |
| 工作流 C | `backend/src/weixin/*`、`backend/src/ops/*` 与对应测试；context 诊断、积压限速、告警投递与审计；vendor 改动先交主负责人复核 provenance |
| 主负责人串行整合 | `shared/*`、迁移/注册、`backend/src/server.js`、`backend/src/config.js`、`scripts/ai-platform/production-*`、CI/release；其他工作流只提交所需接口建议 |
| 验收 | 改动相关自动化可并行；所有真实 Chrome QA 串行，使用独立临时库、端口和 profile；验收报告由主负责人统一归档 |

先冻结就绪状态 `configured/probeReady/liveReady` 的含义及凭据 revision/policy digest 绑定。
首次 canary 使用明确隔离的服务权限和合成样本，照常经过 task/attempt/预算账本；不得用普通
业务请求绕过 liveReady，也不得对未启用 external provider 的 P1 启动付费探针。

### P0：合同和实现收口

目标是让“真实 provider、费用、媒体、主动推送、写回和回滚”都拥有可执行合同。

1. 补齐 OpenAI-compatible provider 的就绪状态：凭据、模型能力、官方 `GET /models` 探针、真实 completion 分级记录。凭据变更、证据超期或旧探针晚返回不得保留错误的 liveReady；启动失败可恢复，关闭期间中止探针并等待清理。
2. 固定 DeepSeek 价格版本与高峰预算上限：缓存命中输入、未命中输入、输出分别记账，图片按输入 token 计费，不虚构页费；未知 usage 保留 unknown 预算。真实文本 completion 的 `finish_reason=stop` 必须从 provider 结果一路写入 canary settlement 和 P2 报告，不能只在请求过程中校验。
3. 校验所有业务入口的 provider、model、agent、price version、owner、actor、channel、subject 和 request id；历史读取不得触发模型请求。
4. 完善管理代理和内部认证的 request binding、issuer、jti replay、CSRF、管理员/成员权限矩阵。
5. 串接 Backend proactive worker、AI executor、微信 outbox worker 的 drain/close/restore，确保关闭时等待在途结算，超时进入 unknown 而不是静默重跑。
6. 对 Clawbot 明确 context 生命周期：能够从 SDK 建立或重新绑定时才恢复发送；无有效 context 时保留 outbox，不伪造 heartbeat 续期。
7. 增加 production transition、preflight、postflight、backup/restore、rollback 的负向测试和证据绑定。
8. 将 P2 采样改为可恢复流程：持久记录 runId、sourceCommit、两种 policy digest、样本/task/attempt/request id；先采样、再观察和对账、最后验证报告。断线、重启、账单未到都不能重发已收费样本；unknown 保留预算待核对。

本轮已补齐运维告警的恢复性：`ops-alert.sh` 在 Backend 不可用时进入受限本地 spool，
`ops-inspect.sh` 在后续巡检中经同一 Backend ops-alert endpoint 排空；脚本 payload 带稳定
`eventId`/`occurredAt`，跨小时重试不重复入队。该实现不引入 PushPlus 或直接 Clawbot 旁路，
并已通过脚本集成、bash 语法和 ops API 回归；部署仍需纳入下一正式 release，并在生产用成功
receipt 复核历史 failed unit。

退出条件：本地代码门禁全部通过；`gpt-5.6-luna / max` 只作为开发执行模型；业务配置仍只出现 `deepseek-flash`。

### P2：真实 DeepSeek 单并发 canary

只使用脱敏或合成样本，关闭主动扫描和真实通知，设置明确的次数与金额上限。

1. 以 `quick-record.analyze` 作为第一条真实文本入口，使用专用 owner、单并发、10 个固定合成样本、人民币 5 元合计上限和固定超时；使用 provider 实际支持的 `chat.completions.v1` 请求。
2. 记录供应商真实 `request id`、返回模型、HTTP 状态、usage、价格版本、计算费用和 unknown 状态。
3. 验证 `finish_reason`、JSON 合同、模型不匹配、429、5xx、超时、取消、断网、空正文和超大响应。
4. 用 DeepSeek 官方账单或余额/用量记录核对至少一个完整 canary 窗口；没有账单凭证的项目保持 pending，不能记作费用准确。
5. 对比 deterministic fallback 与真实模型结果的结构、事实/推断/未知分离和人工确认边界；不自动写业务数据。
6. 维持当前生产合同中至少 10 个样本、2 小时观察要求；账单未到可以继续只读观察、开发和验收其他独立项，最终 report 保持 pending，不伪造 reconciled。余额变化只能作为汇总辅助证据，不替代逐请求账单。

退出条件：真实模型身份正确、协议稳定、预算不越界、无秘密泄露、费用可核对，且每个失败场景不会产生第二条收费出口。

### P3：低风险文本灰度

逐步放开一个 owner 和低风险文本功能，未选入口保持原路径或明确降级。

1. 放开快速记录、周报、温度/行程建议中的只读分析。
2. 连续观察至少 2 小时，并完成至少 10 个获准样本，覆盖成功、降级、重试和取消。
3. 验证任务重复提交、结果查询、业务写回前人工确认、跨 owner 拒绝和历史读取不发模型。
4. 在 Mac Chrome 中验收管理台路由、任务详情、费用、队列、预算和审计。

退出条件：P95 延迟、错误率、费用和队列符合冻结阈值；没有重复写回、重复收费或越权。

### P4：销售决策和业务写回

1. 逐项放开销售决策、客户级主动助手、action/risk 建议和医院招标 bridge。
2. 所有模型建议仍只生成 preview；正式写回由 Backend 做 owner、版本、关系、幂等和人工确认校验。
3. 使用合成客户、商机、行动、风险和招标对象完成一次端到端写入，记录前后版本、审计和清理结果。
4. 复核导入 CSV/XLSX 的预览、确认、冲突、取消、重复文件和事务回滚。

退出条件：业务写回零重复、零跨 owner、零关系错绑；浏览器验收和数据库审计一致，完成至少 24 小时业务观察。

### P5：媒体、ASR、主动分析和微信主动投递

1. 票据/发票图片和 PDF：验证受限媒体句柄、摘要/魔数、页面上限、清理、取消、失败重试和真实视觉结果。
2. ASR：先核实可用的语音识别实现和凭据，再验证有效 WAV、时长上限、上传取消、响应、临时文件清理和费用计量。DeepSeek 文本/视觉模型不能自动视为支持音频转写；缺少兼容能力时记录具体阻塞，保留已有可用语音链路，不擅自引入其他付费模型。
3. 主动分析：先处理现存 `PROACTIVE_CUSTOMER_NOT_FOUND` 事件，按软删除/来源逐项归因；无效事件终止，合法事件只按幂等键有限重试。
4. 微信：验证已有有效 context 时无需本次先发消息即可主动发送；context 过期时消息留在 outbox，真实新入站恢复后验证限速、重试、去重和审计。重新登录/绑定不等于 provider context 已续期。若上游仍无续期 API，完整交付须明确这一产品限制，不能承诺永久无入站推送。
5. 只在单独的真实消息验收窗口启用真实微信发送；PushPlus 不恢复。
6. 复核历史 `sentelligent-ops-alert@sentelligent-backend.service.service` 失败的原因；修复实际告警链路并验证成功 receipt，不能只清除 systemd failed 标记。

当前代码层修复已经完成，但生产 receipt 尚未取得：待下一候选 release 安装脚本后，先以受控
`manual-test` 告警验证 endpoint 入队/Clawbot 投递，再只读复核该历史 failed unit 的恢复状态；
若 context 缺失，告警必须保持 queued/spooled，不能把缺少 context 当作投递成功。

退出条件：至少覆盖一次主动扫描周期和 26 小时观察；媒体清理、租约、预算、outbox 和上下文状态均有证据。

### P6：全量生产交付

1. 取得 transition lock，冻结 admission，停止并排空旧 worker 和平台 executor。
2. 完成业务库、平台库、微信 session、配置版本和在途任务的最终一致性备份。
3. 启动新平台和新 Backend，先保持主动扫描与通知关闭，验证人工 CRUD、管理代理和选定 AI 入口。
4. 按顺序恢复文本、销售决策、媒体、ASR、主动分析和微信投递；每次变更记录 policy digest、实际模型和 price version。
5. 观察至少 48 小时，完成一个供应商账单周期对账，再关闭旧出口或保留已批准的兼容回滚窗口。
6. 预演一次代码回滚和一次平台数据库恢复；回滚不覆盖新业务写入，不重置预算、账单、游标或已发送 outbox。

退出条件：双层 preflight、cutover、postflight、观察、备份恢复、Chrome matrix 和回滚报告均为 passed；所有剩余风险有明确 owner 和截止时间。

## 并行执行编排

为了缩短时间，下面四条工作流可以在共享合同冻结后并行；同一文件仍只允许一个负责人修改。

| 工作流 | 主要目录 | 交付物 |
| --- | --- | --- |
| Provider/费用 | `ai-platform/src/providers/`、`ai-platform/src/budgets/` | live readiness、DeepSeek 价格、真实 canary 和账单核对 |
| 认证/控制 | `ai-platform/src/auth/`、`ai-platform/src/operations/`、`backend/src/aiPlatform/` | request binding、CSRF、jti replay、drain/rollback |
| 微信/主动任务 | `backend/src/assistant/`、`backend/src/weixin/`、`backend/src/ops/` | context 生命周期、主动扫描归因、outbox 主动投递 |
| QA/发布 | `scripts/ai-platform/`、`outputs/product-design-prototype/scripts/`、`docs/` | 全量测试、Chrome matrix、制品、transition 和证据 |

融合负责人串行维护 `shared/*`、`backend/src/server.js`、`backend/src/config.js`、根脚本、迁移注册和发布 manifest。
此表只描述能力分工，实际文件写入以上“契约、迁移与写集冻结”中的精确分配为准，避免 broad 目录所有权互相覆盖。

## 快速收口与放行标准

1. 先完成 A/B 两个代码阻塞，再运行相关 provider、P2 和费用回归；C 的微信/告警工作可同时推进。
2. 通过局部检查后冻结候选，一次执行全量测试、历史密钥扫描、Linux/x64 制品核验及 Python 招标测试。
   前端无新改动时复用已有基础 QA，本轮最终 Chrome 仍须覆盖新增行为；不得同时跑多个浏览器验收争抢资源。
3. 在观察窗口里完成账单核对、Chrome 管理/业务写入、故障恢复等独立项，不把 2/24/26/48 小时窗口简单相加。
   窗口仅在对应能力实际启用且健康时计时，不能预写未来时间或缩短门禁。
4. 当前 P2 检查不全时不重打付费样本；使用同一 runId 和 idempotency key 续跑，修复后只补失败项。
5. 验收每项保存环境、完整 commit、命令、退出码、报告路径、通过/失败/未执行、清理和回滚状态。
6. 越权、秘密泄漏、重复业务写回或重复收费出现一次即关闭受影响入口；健康连续失败、队列增长、
   内存不足或 unknown 预算异常按现有 transition 合同处理，保留在途账本和已发生业务数据。

完成定义：代码与相关回归全部通过；真实模型/用量可验证；有界生产写回与清理闭环；微信在已验证
能力范围内投递；管理权限/排空/备份恢复/灰度和观察有证据；正式 release 可追溯。ASR 不兼容、
微信上游限制和未到账单如仍存在，逐项列出影响，不能将整个目标提前标记为 complete。

## 统一验收命令

每个阶段都绑定当前 exact commit，并保存独立报告。最终收口至少执行：

```bash
npm run qa:desktop
git diff --check
git status --short --branch
```

`qa:desktop` 包含部署门禁、AI Platform、Backend、前端本地 QA 和 Mac Chrome 集成验收；
`qa:webkit`/iPhone 真机验收不属于本次交付范围，仅当用户重新授权移动真机验收时才追加执行。

真实 provider、真实微信和生产写入验收必须单独记录：请求数、owner、样本标识、实际 model、request id、费用状态、写入行数、清理行数、outbox 水位、context 状态和报告 SHA-256。

## 当前交付判断

### 已完成（本轮代码与本地证据）

- 目标模式已保持 `active`：开发执行模型为 `gpt-5.6-luna / reasoning max`，业务调用模型仍为
  `deepseek-flash`；Codex 执行模型不会写入业务运行配置。
- provider readiness 已增加凭据 revision/digest、policy digest、过期时间和真实 live evidence
  绑定。仅有 `GET /models` 探针时，普通生产任务仍拒绝 admission，不创建 task 或预算预占。
- P2 真实供应商验收已改为可恢复 checkpoint 状态机：`collecting`、`observing`、`reconciling`、
  `finalizing`、`completed`、`failed`；样本使用固定 provider-canary 幂等键，进程重启或账单未到
  不会重新调用供应商或重复收费。每个 live 文本样本同时必须记录 `finishReason=stop`，并在
  settlement、报告 contract 和 transition binding 中验证。
- P2 checkpoint 测试 `13/13`、AI Platform 测试 `100/100`、Backend AI adapter 测试 `38/38`、
  部署/AI 脚本测试 `36/36` 全部通过。
- Backend 全量测试 `2083/2083`（`240` suites）通过；部署门禁 `292 passed / 0 failed / 2 skipped`。
  secret scan 无 findings；`git diff --check` 已通过一次，候选提交前复跑。
- `qa:local` 已通过前端 production build、bundle budget、auth/session、route/state/API contract、
  客户 CSV/XLSX 导入、客户级主动助手、客户元数据、医院招标、action/risk、浏览器证据、滚动回归、
  管理设置、AI card、行程、ASR capture、销售决策和响应式视口检查。

### 已完成的本地验收

- Mac 原生 Google Chrome 集成验收已通过：客户级主动助手、医院招标 bridge、销售决策和 action/risk
  预览边界、CSV/XLSX 导入、overview 下滚动、管理台和 AI Platform console、任务/费用/队列/provider
  readiness、权限/冲突、桌面与窄窗口视口均完成；滚动回归和客户导入验收也已通过。按用户明确范围不
  执行 iPhone 真机/WebKit 验收。

### 未完成且不能用模拟证据替代

| 门禁 | 当前状态 | 完成所需证据 |
| --- | --- | --- |
| 真实 DeepSeek canary | `10/10 samples passed; billing pending` | 已完成真实 `chat/completions` 的 model/usage/request id 和 10 个合成样本；新候选需重新采样并记录 `finish_reason=stop`，仍需失败场景补验、逐请求账单核对和至少 2 小时观察 |
| 微信 Clawbot 主动投递 | `pending` | 有效 context 无入站主动发送、context 到期保留 outbox、新入站恢复、限速/重试/去重/审计 |
| 生产交付 | `blocked by gates` | canary/账单、备份恢复、transition lock、admission freeze、drain、preflight/postflight、回滚演练、观察窗口 |
| iPhone 真机验收 | `out of scope` | 用户已取消；仅保留 Mac Chrome 桌面和移动尺寸兼容性检查 |

较早记录中的 P1 release `44e6d36c5aa9b30285ee63ce9b3a48a3e197edf9`、AI Platform
`disabled`、execution `local-simulated`、admission closed 和“本轮分支尚未部署生产”均为历史状态；真实 DeepSeek
canary 已在候选提交 `aa443cc63430185650c01e0811ddc96fa27c6172` 的隔离运行目录完成 10/10 样本，
但费用账单、失败场景、观察窗口和真实微信证据仍未齐全，因此不改变生产边界，也不把 canary
样本成功写成生产完成。当前可恢复续跑绑定为 `p2-prod-20260913-aa443cc-r1`，不能重发已结算样本。

DeepSeek 官方价格页已在 2026-09-13 重新核对：逻辑名 `deepseek-flash` 对应 DeepSeek-V4.1-Flash，
文本输入/输出价格仍以供应商页面的百万 tokens 口径为准，现有 off-peak/peak 微元换算与代码合同
一致；真实 canary 仍必须记录 `/models`、completion 响应和真实账单。若供应商响应返回的模型名与
逻辑名不同，必须先形成显式映射证据再放行。

## 2026-09-13 执行附录（覆盖较早的当前状态描述）

本附录是本轮继续开发前的现场基线，优先于本文中较早的历史段落；历史段落保留用于追溯，不作为
当前生产判断。

### 已核对现场事实

- 工作树为 `/Users/jiangjizhen/Documents/Codex/repos/sentelligent-sales-workbench/.worktrees/ai-platform-production-integration-20260909`，分支 `codex/ai-platform-production-integration-20260909`；本附录开始执行时的代码基线为 `21cb281ee37e30c12cf9c1de663c50cc0d9bc5ab`。后续放行以提交后的 exact release manifest 为准。
- 开发执行目标继续保持 `gpt-5.6-luna / reasoning max`；这是 Codex 开发设置，不写入业务运行时。业务助手固定使用 provider `deepseek`、model `deepseek-flash`。
- 生产 `current` 为 `/opt/sentelligent-sales-workbench/releases/sentelligent-sales-workbench-21cb281ee37e`，Backend、Frontend、WeChat agent、AI platform、Caddy 均为 active；本轮只读核对，没有读取 iCloud、没有读取生产密钥、没有修改生产。
- AI 平台 healthz 当前为 `paused`，`executionMode=local-simulated`，`externalProvidersEnabled=false`，`admissionOpen=false`，队列深度为 `0`，provider 仅有 `provider-mock`。`targetModel=deepseek-flash` 只是目标元数据，不是已完成真实调用的证据。
- WeChat agent 在线，但最新日志为 `category=outbox status=not_ready reason=context_token_missing`。没有有效 Clawbot context 前，不做主动消息成功声明、不清空 queued outbox、不恢复 PushPlus。

### 后续开发与验收顺序

| 优先级 | 交付项 | 实施动作 | 放行证据 |
| --- | --- | --- | --- |
| P0 | 代码与合同收口 | 保持 `configured/probeReady/liveReady` 分层、真实模型身份、finish reason、凭据/策略 digest 和固定幂等键；把 ops alert spool 修复纳入候选 release | 本地专项、secret scan、diff check、发布制品 manifest |
| P2 | DeepSeek 真实 canary | 只用合成文本、单并发、固定 runId/checkpoint；先补失败场景，再以供应商逐请求账单续跑，不重发已结算样本 | 10 样本、`actualModel=deepseek-flash`、`finishReason=stop`、request id、账单逐条 reconciliation、至少 2 小时观察 |
| P4 | v0.12.0 业务写回 | 逐项验收客户 CSV/XLSX preview/confirm/conflict/cancel、action/risk preview/confirm/writeback、医院招标 bridge preview/confirm/cancel；每项使用唯一 synthetic marker，完成审计读取和精确清理 | 写入行数=预期、owner/relationship/version/digest 正确、审计完整、清理后 residual=0、SQLite integrity 通过 |
| P5 | Clawbot 主动消息 | 先取得有效真实入站 context；验证无入站主动投递、过期保留 outbox、新入站恢复、限速/重试/去重/审计；context 缺失只做诊断 | 真实消息窗口报告；无 context 时保持 pending/blocked，不以 heartbeat 替代 |
| P6 | 完整生产交付 | 账单和微信门禁通过后才锁 admission，执行备份、drain、transition、postflight、回滚演练和灰度观察 | fresh preflight、transition manifest、backup/restore、rollback、48 小时观察和最终 release SHA |

### 快速执行规则

1. 先在隔离临时库完成 P4 专项回归和生产脚本的 contract test；不重复实现已通过的业务模块。
2. P2 只允许使用同一 `runId` 和 checkpoint 续跑；账单缺失时保持 `reconciling/pending`，不修改 `liveReady`。
3. P4 生产写入必须通过已有 HTTPS smoke 的 server-local cleanup 保护；cleanup、audit manifest 或
   `foreign_key_check` 任一失败，立即停止后续生产写入。
4. P5 不尝试用定时心跳伪造 context renewal；上游没有 renewal/rebind 合同时，产品限制必须保留在交付结论中。
5. 每个阶段以当前 exact commit、报告路径、SHA-256、清理结果和未执行项归档；只有所有硬门禁通过才允许把目标标为 complete。

### 当前判断

当前可继续开发和验收，但尚未达到完整 AI 统一调度平台生产交付：P2 的账单/失败场景/观察、P4 的生产专项写回证据、P5 的真实 Clawbot context，以及 P6 的 48 小时灰度仍未齐。P1 受控生产在线不等于上述门禁通过。
