# AI 平台融合升级状态

## 2026-09-13 当前后续收口状态

- 当前继续在 `ai-platform-production-integration-20260909` 工作树开发，目标模式保持
  `active`，开发执行设置为 Codex `gpt-5.6-luna / max`；业务系统仍统一使用 DeepSeek
  provider `deepseek`、逻辑模型 `deepseek-flash`。本轮未读取 iCloud，未从生产取密钥，未修改生产。
- provider readiness 已收口为 `configured`、`probeReady`、`liveReady` 分层，并绑定凭据 revision/digest、
  provider policy digest、有效期和真实 completion evidence；只有 `/models` 成功时不能放行普通生产任务。
- P2 真实供应商验收已具备可恢复 checkpoint 状态机和固定幂等键，已通过 `12/12` checkpoint 测试；
  AI Platform `99/99`、Backend AI adapter `38/38`、部署脚本 `35/35`、Backend 全量 `2083/2083`
  和部署门禁 `292 passed / 0 failed / 2 skipped`。本轮已补齐 live 文本样本的
  `finishReason=stop` 持久化和报告 contract 校验。
- Mac 原生 Google Chrome 集成验收已通过，包含客户级主动助手、医院招标 bridge、action/risk 预览边界、
  CSV/XLSX 导入、滚动回归、管理台、AI Platform console、权限/冲突和桌面/窄窗口视口。按用户要求不做
  iPhone 真机或 WebKit 验收；浏览器移动尺寸检查不等同于真机证据。
- 真实 DeepSeek canary 已完成 10 个合成样本，状态为 `samples_passed`，但账单和观察门禁仍未完成。
  runId 为 `p2-prod-20260913-ten-r4`，候选提交为 `88f83d157bc9dc1ae6c95557993c7ed133625010`，
  10/10 样本均返回 `model=deepseek-flash`、`provider=provider-deepseek` 和唯一 provider request id，
  暂计费用为 `6,634 micro-CNY`。脱敏报告位于 `/private/tmp/p2-prod-20260913-ten-r4.json`，
  SHA-256 为 `57b4060095d964c3e14d3380044e955de0852a136c3f8a7bc5e32b84332c4309`。
  报告明确 `billing.status=pending`、未访问业务库、未调用通知、未修改生产服务；仍需供应商逐请求账单
  证据、失败场景补验和至少 2 小时观察，不能把本项标记为 reconciled 或 production-ready。
- 微信 Clawbot 仍是唯一外部通知通道，PushPlus 保持退役。SDK 当前 context token 从真实入站消息建立，
  有效期约 23 小时；轮询或 heartbeat 只维持 worker 在线，不能伪造 token 续期。context 过期时 outbox
  保留并不消耗发送次数，真实新入站后才可恢复；这一限制已由本地合成测试覆盖，真实微信窗口仍待执行。
- 生产保持 P1 边界：AI Platform `disabled`、execution `local-simulated`、admission closed；本轮分支
  未部署生产。生产切换前仍必须完成真实 canary/账单、真实 Clawbot 投递、备份恢复、transition lock、
  drain、preflight/postflight、回滚演练和观察窗口。

## 2026-09-12 当前融合与生产事实

本节是最终 P1 交付记录；下方较早段落保留为实施过程和历史检查点，不覆盖本节事实。

- 当前融合工作树：`ai-platform-production-integration-20260909`。生产候选源提交为
  `44e6d36c5aa9b30285ee63ce9b3a48a3e197edf9`；发布时工作树干净。
- 模型边界已固定：本次代码开发、测试和 Mac Chrome 验收使用 Codex
  `gpt-5.6-luna / max`；业务系统 AI 助手统一使用 provider `deepseek`、model
  `deepseek-flash`。开发执行模型不会写入业务生产配置，也不代表生产已调用 Codex 模型。
- 生产 `current` 已切换为
  `/opt/sentelligent-sales-workbench/releases/sentelligent-sales-workbench-44e6d36c5aa9`，
  `readlink -f /opt/sentelligent-sales-workbench/current` 已现场核实为该路径。
- 新 release manifest 为
  `/opt/sentelligent-sales-workbench/releases/sentelligent-sales-workbench-44e6d36c5aa9/release-manifest.json`
  （SHA-256 `db31f480b1bf24abad0c0aa94ded391828cb6640dd0859f3875e34c9c11c2914`）；制品在
  `linux/x64`、Node `v24.18.0`、npm `11.16.0` 环境构建，归档包含 `1748` 个文件。
- 生产切换 transition 为 `ai-platform-44e6d36-20260912-p1-r11`，旧提交为
  `89ff3d5ffce2cae165897fd1340b6f62490550aa`，新提交为
  `44e6d36c5aa9b30285ee63ce9b3a48a3e197edf9`。transition report 为
  `/opt/sentelligent-sales-workbench/evidence/ai-platform-44e6d36-20260912-p1-r11/ai-transition-report.json`
  （SHA-256 `fddb7f6df191d601b62652ea4ef26964384681ef5e8d614598b1238d3c3dbe99`，
  `status=passed`、`rollbackStatus=not-required`），manifest 为
  `/opt/sentelligent-sales-workbench/evidence/ai-platform-44e6d36-20260912-p1-r11/transition-manifest.json`
  （SHA-256 `becf72f3fe14e0569f184e4b1e4d6dc3a527856d159ebfe79fa57a725464c306`）。
- 120 秒观察报告为
  `/opt/sentelligent-sales-workbench/evidence/ai-platform-44e6d36-20260912-p1-r11/observation-120s.json`
  （SHA-256 `ff7238dc2e10ec7d92f3ce1eea3e1e33a7704914907d65ab4acb7d2843f4bbab`，
  `status=passed`、`sampleCount=4`、`thresholdFailures=[]`）。观察期间 AI 平台队列深度为
  `0`，没有活动执行。
- 候选制品为
  `/opt/sentelligent-sales-workbench/evidence/ai-platform-44e6d36-20260912-p1-r11/sentelligent-sales-workbench-44e6d36c5aa9-linux.tar.gz`
  （SHA-256 `aed619feae9c9c5b87c8715a5d1d94e88d4cbc4f4a24158e656a8077df8b03c3`）；P1 policy
  SHA-256 为 `ffc730e7921dcdd8a2aaa3fc5f88a14c8775965f2e6f1b1f59b186d36295a347`，quality report
  SHA-256 为 `4845f641c10667d3509c8d344719266ad225b747ad4c35ef89330a6953020d5a`。
- 最新旧版本业务库只读备份为
  `/opt/sentelligent-sales-workbench/backups/ai-platform-44e6d36-20260912-p1-r11/core-preflight-business.sqlite`
  （SHA-256 `118de1ca4baba4bf5cb52c6d40ffb9486dc2dfc11dbe7141949656e3c51f827a`）；
  `old-core-preflight.json` 为 `25/25`，`ai-preflight.json` 的 `9` 个 gate 全部通过。
- 生产服务 `sentelligent-backend.service`、`sentelligent-frontend.service`、
  `sentelligent-weixin-agent.service`、`sentelligent-ai-platform.service` 和
  `sentelligent-caddy.service` 均为 `active`。`/_health`、`/api/health` 与 AI Platform Unix
  socket `/run/sentelligent-ai-platform/api.sock/healthz` 均返回 `200`；数据库为 `ready`，
  `quick_check=ok`，外键违规数为 `0`。
- 另有 `sentelligent-ops-alert@sentelligent-backend.service.service` 在
  `2026-09-11 19:23:44 CST` 因告警投递失败而处于 `failed`；该时间早于本次
  `21:16:03–21:16:16 CST` 的生产切换。已只读核对其日志，未将其误判为本 release 回归，
  也未在本次交付中重启或修改该告警服务。
- Caddy PID `13001`、Qingyang PID `9217` 未被切换改变，Caddyfile SHA-256 仍为
  `ee907b56aecf1c23b44c49a6e8e15f777cbab0f5029bd7290e3280758cc612f5`。本次没有手工修改
  `current`、systemd unit、Caddy 配置或生产数据库。
- P1 安全边界仍为 `phase=legacy`、`rolloutPhase=P1`、`AI_PLATFORM_MODE=disabled`、
  `executionMode=local-simulated`、`paused=true`、`admissionOpen=false`、
  `externalProvidersEnabled=false`，仅有 `provider-mock`。逻辑目标元数据为
  `deepseek-flash` / `max`，不代表真实付费模型已调用；Backend 仍是 `proactive.analyze`
  和业务通知 outbox 的唯一调度所有者。
- 当前 DeepSeek 文本和视觉模型统一为 `deepseek-flash`（DeepSeek-V4.1-Flash）。
  官方 CNY 价格日历为：缓存命中输入 `20/40`、缓存未命中输入 `1000/2000`、输出
  `4000/8000` micro-CNY 每 1K token（空闲/高峰）；旧 V4 Flash 名称仅保留为兼容转发历史。
- PushPlus 已退役且不再作为生产通知渠道。微信 Clawbot outbox 在加密
  `context_token` 缺失或过期时 fail-closed，消息保留在持久 outbox；当前 SDK 没有
  `context_token` renewal/rebind 合同，heartbeat 或轮询不能伪造续期。因此“无用户消息也能
  永久主动推送”与真实主动微信投递仍未验收，不能用本地模拟或健康检查替代。
- Mac Google Chrome 生产验收已完成：`/overview`、`/customers`、客户详情（含 CSV/XLSX
  客户导入预览和客户级主动助手）、客户招标监测、`/opportunities`、`/opportunities/risks`、
  `/opportunities/actions`、`/itineraries`、`/travel-expenses`、`/weekly-reports`、`/knowledge`、
  `/settings/config`、`/settings/notifications` 以及登录保护的 AI Platform 管理台代理均可打开并渲染。
  只读检查确认通知页为微信 Clawbot 状态页、PushPlus 无操作入口、AI 管理台仅显示 mock provider
  与队列 `0`，未暴露 provider secret。正式管理台入口是 `/api/ai-platform/console/`；裸路径
  `/ai-platform-admin/` 在生产按预期回到业务 `/overview`，不计作管理台验收通过。
- 直达路由验收报告为
  `.runtime/browser-evidence/v0120/production-direct-2026-09-12T12-50-14-562Z/production-direct-report.json`：
  `/opportunities/risks` 和 `/opportunities/actions` 均 HTTP `200`、路径不变且页面 test id 正确；
  `/api/ai-platform/console/` HTTP `200`；Chrome `153.0.8010.36`，控制台错误、页面错误、失败请求
  和登录之外的非 GET 请求均为 `0`。
- 页面上下滚动已在 Chrome 原生窗口通过 `Page Down` 验证；同时 `qa:integration` 的
  scroll-wheel 回归和 customer-import acceptance 均通过。没有上传生产 CSV/XLSX、生成生产
  周报、写入客户/商机/action/risk、发送微信或 PushPlus 消息；不做 iPhone 真机验收。
- 最终 `npm run qa:full` 通过：`test:deploy` 为 `291 pass / 2 skipped / 0 fail`，AI Platform
  `89/89`，Backend `2083/2083`，前端本地 QA、Chrome 集成 QA、滚轮回归、CSV/XLSX 客户批量
  导入验收和 WebKit 自动化均通过。WebKit 结果是浏览器自动化，不是 iPhone 真机证据。

当前剩余门禁仅为真实外部能力：Clawbot 的 context 续期/rebind 协议、真实供应商质量与费用
证据、以及在明确启用前提下的真实主动扫描和通知验收。它们不影响本次 P1 代码与受控生产切换
交付，但不能被描述为已经上线。

更新：2026-09-12（r11 生产切换与 Chrome 直达验收证据均生成于 2026-09-12）。主任务已接管生产融合，完整执行边界见
[FUSION-EXECUTION.md](FUSION-EXECUTION.md)。

后续完整开发完善计划见 [FOLLOW-UP-PLAN-20260912.md](FOLLOW-UP-PLAN-20260912.md)。目标工具已创建
`active` 目标；用户指定的开发执行设置为 Codex `gpt-5.6-luna / max`，实际切换以应用工具返回为准。
业务系统仍统一调用 DeepSeek `deepseek-flash`。当前有新增代码待收口：首次真实 canary 放行、
与 provider 相容的 P2 请求、可恢复采样和后置账单对账；不能仅将它们归类为外部条件不足。
模型目录 GET 只建立 `probeReady`，不证明真实 completion 成功，不得直接设置 `liveReady`。

## 历史融合进度

- 工作树：`ai-platform-production-integration-20260909`；
  融合基线 `4cfdcdb9d3f499056c45a7c83434d3fa7b96d3cd`，
  生产基线 `3209a073486e22370307a6f46021ac9cf2ec71d1`。
- 已实现持久化暂停/控制版本/审计、关闭等待结算、请求级身份绑定、
  持久化 nonce 防重放、原子迁移及费用预占/未知费用恢复修复。
- 平台迁移新增 0003/0004；业务 0042-0045 和平台 0001/0002 未改写。
- 本地平台 69/69、全部适配器 34/34、双服务和 QA 脚本专项 16/16
  通过。生产认证模式测试使用临时库和模拟供应商，不等同生产上线。
- 以上条目记录的是早期实施检查点。管理代理、生产发布控制、主动事件修复、全量验收和
  受控 P1 切换已在本页顶部记录中完成；真实供应商、费用和主动微信投递仍受外部能力门禁约束。

## 2026-09-08 历史验收记录

以下工作树、测试总数和未部署声明描述当时独立开发阶段，不代替
当前融合进度或本任务已有的开发与生产切换授权。

## 当前交付状态

- 任务：AI 统一调度平台一期开发。
- 当前工作树：`/Users/jiangjizhen/Documents/Codex/repos/sentelligent-sales-workbench/.worktrees/ai-unified-platform-v2`。
- 当前分支：`codex/ai-unified-platform-v2`。
- 当前基线提交：`456ec8b59f1f3fbc07dc8cb64f3cdd7417a6df59`；工作树仍有本任务的未提交改动，不能把它视为已发布制品。
- 并行升级工作树：`/Users/jiangjizhen/Documents/Codex/repos/sentelligent-sales-workbench/.worktrees/v0120-full-upgrade`；本任务未修改该工作树。
- 平台版本：`0.1.0`。
- 目标模型：`gpt-5.6-luna / max`。
- 当前执行模式：`local-simulated`，仅使用本地模拟供应商。
- 主动分析调度唯一所有者：Backend `proactive worker`；AI Platform 不自行执行 `proactive.analyze` 计划。

当前交付是独立平台底座、管理 API、静态管理台、业务侧受限客户端、媒体/ASR 适配和本地双服务联调基础。它不是生产切换完成，也不等同于真实模型质量或真实费用验收。

## 已完成并验证

- 独立 SQLite 数据库、迁移、种子数据、12 个初始 Agent、规范、模型和价格版本。
- HMAC 服务身份认证、作用域检查、owner 隔离、开发认证仅限非生产配置。
- 任务创建、幂等、队列、租约、并发、取消、超时、重试、过期恢复和旧 worker fencing。
- 供应商尝试台账、输入/输出用量、估算/未知费用、价格版本、金额与次数预算预占及结算。
- Agent/规范草稿、版本、发布、回滚、乐观锁和管理审计。
- 主动调度的去重、暂停、运行租约、stale run 恢复和结果状态对账基础。
- 管理 API 的资源详情、任务子资源、成本筛选、管理员取消、调度启停/扫描/运行查询；`enabled=true|false` 查询参数已按布尔语义处理。
- 业务侧 `backend/src/aiPlatform/client.js`，包含安全 URL/请求头约束、token provider、超时、取消、响应大小上限、轮询清理和错误映射。
- 独立静态管理台：概览、任务、Agent、规范、模型、预算、调度、成本和审计视图；不依赖业务前端页面运行。
- 独立 `start/stop/status/health/backup/restore` 脚本、制品检查脚本和 systemd 模板。
- 根 `npm run test:ai-platform` 同时运行平台专项和业务客户端专项，并已接入本地 `qa:full`、CI 与 release 验证。
- Backend 与 AI Platform 在本地临时端口上已完成双服务 HTTP 联调：快速记录和拜访行程均能创建平台任务，并验证 `owner`、`actor`、`channel`、`taskType`、`subject`、目标模型和推理档位。
- 行程规划入口现在由服务端生成行程 ID，再以 `itinerary-<id>` 作为平台对象标识；ASR 使用 `sha256-<digest>` 作为音频对象标识，平台请求不携带原始媒体路径或字节。
- 健康接口仅返回非敏感运行状态，不返回 AI Platform HMAC、服务令牌、旧模型密钥或 ASR 凭据。
- 静态管理台 `/admin` 和 `/ai-platform-admin` 的无尾斜杠入口会重定向到带尾斜杠入口，避免相对 CSS/JS 被解析到根路径；HTTP 回归已覆盖该行为。

## 本轮证据

以下证据均来自当前工作树和本地模拟执行，不包含真实供应商、生产数据库或真实通知。精确总数和浏览器证据已在本轮补齐。

| 范围 | 命令/环境 | 结果 |
| --- | --- | --- |
| 平台单元与集成测试 | `cd ai-platform && npm test` | 52 passed，0 failed，0 skipped |
| 业务侧客户端/适配器测试 | `node --test backend/src/aiPlatform/*.test.js backend/tests/ai-platform-server-integration.test.js backend/tests/model-analysis.test.js` | 54 passed，0 failed，0 skipped |
| 双服务 HTTP 联调 | `node --test backend/tests/ai-platform-server-integration.test.js` | 4 passed，0 failed，包含快速记录、行程、owner 隔离和健康脱敏 |
| 行程规划回归 | `node --test backend/tests/itinerary-planner.test.js backend/tests/itinerary-api.test.js` | 17 passed，0 failed |
| ASR 回归 | `node --test backend/tests/asr-*.test.js` | 297 passed，0 failed，0 cancelled，0 skipped |
| Backend 全量测试 | `npm --prefix backend test` | 2057 passed，0 failed，0 cancelled，0 skipped；240 suites |
| 静态入口回归 | `node --test ai-platform/tests/http-server.test.js` | 8 passed，0 failed；覆盖 `/admin` 与 `/ai-platform-admin` 尾斜杠重定向和路径穿越拒绝 |
| Secret scan | `npm run scan:secrets` | `passed`；986 files、4194 Git objects、779 Git messages、0 findings |
| 语法与空白检查 | `node --check ...`、`git diff --check` | 本轮改动已通过 |
| 独立运行态 | 临时端口 `52251`，独立 PID、runtime、SQLite 和浏览器数据 | `healthz` 与 `readyz` 返回正常；停止后端口已释放；状态为 `local-simulated`、数据库 `ready` |
| 备份 | `scripts/ai-platform/backup.sh` | `quickCheck=ok`，`foreignKeyErrors=0`，迁移数 `2`；备份位于临时证据目录 |
| 恢复 | 独立临时端口 `19998` 和临时数据库 | 运行中恢复拒绝为 `service_running`；无 `--force` 拒绝为 `confirmation_required`；强制恢复通过，并保留 `.before-restore-*` 旧库 |
| 管理台浏览器验收 | 本地无头 Chrome，`http://127.0.0.1:52251/admin/` | 1440x900、1024x768、390x844、360x800 均无整体横向溢出；连接为“已连接”、运行态为“就绪”；0 控制台错误、0 失败请求。证据：`/tmp/ai-platform-browser-evidence-20260908/browser-evidence.json` 及四张 PNG |
| 管理台真实写入 | 同上，临时 SQLite | Agent 保存/发布/回滚：`PATCH 200`、`POST 200`、`POST 200`，版本 `1.0.1 -> 1.0.0`；规范：`POST 201`、`PATCH 200`；预算：`PATCH 200`；调度编辑/普通调度启停：`PATCH 200`、`POST 200`、`POST 200` |
| 主动分析所有权 | 同上 | 勾选启用 `proactive.analyze` 后停留在表单并显示 Backend 独占错误，新增管理请求数为 `0`；Backend 所有权未被 UI 绕过 |

## 已接入但尚未完成最终验收

- 周报、快速记录、手工建议、温度、销售决策、行程、ASR、票据和记账入口已有平台适配；本轮已补充行程和 ASR 的显式对象身份，但全部入口仍需在共享质量门中逐项保留 HTTP/权限/历史读取证据。
- 主动分析仍由 Backend worker 负责读取业务快照、调用平台适配并处理结果投递；需要继续执行停旧、排空、启新、回滚演练，证明不双跑、不重复写回、不重复通知。
- 本地模拟供应商只验证调度、隔离、生命周期、台账和契约，不验证真实模型质量、真实供应商延迟、真实供应商费用、视觉识别质量或 ASR 质量。
- 尚未启用 `external-provider`，尚未使用真实供应商密钥，尚未发送真实通知，尚未部署生产或安装 systemd 单元。
- 有界负载下的 CPU、内存、临时文件和日志增长测试尚未执行；不能用空载健康检查替代 OPS-04。
- 管理台已绑定独立本地 API；本地浏览器证据已完成，但共享登录代理、生产访问控制和业务前端结果卡整合仍待最终共享窗口完成。

## 运行边界

- 本任务未连接生产服务器。
- 本任务未修改生产数据库、生产服务或生产配置。
- 本任务未调用真实付费模型或供应商。
- 本任务未读取或持久化真实供应商密钥。
- 本任务未发送真实通知。
- `local-simulated` 的文本任务在平台没有 completion 内容时，业务层回退到 deterministic 结果，并保留 `mock_model_fallback`；不能把模拟摘要描述为真实模型输出。
- `solution` Agent 当前保持 `disabled`，不会因为平台可用或存在模型配置而自动启用。
- AI Platform 只接收有界快照、结构化输入或媒体描述符，不直接读取销售业务表，也不直接写业务表或发送业务通知；业务写回和通知仍由 Backend 负责。

## 下一步

1. 按 `CONTRACT.md` 为每个文本入口建立业务快照、权限、结果卡和幂等适配测试，再逐项启用平台调用。
2. 迁移主动调度所有权前先完成停旧、排空、启新、回滚演练，确保不双跑、不重复写回、不重复通知。
3. 完成共享登录代理、最终管理台浏览器证据、资源负载和独立制品/回滚验证。
4. 另行授权后再进行真实供应商、成本、媒体和生产验收；在此之前保持 `local-simulated`。

## 接续注意

- 所有写操作使用本任务独立工作树，不能把默认 cwd 当作实际代码目录。
- 用户已确认精确模型；后续不可擅自改用相近型号或降低推理档位。
- 不读取 iCloud，不操作生产环境；既有任务授权不传递至本任务。
- 只有 `ACCEPTANCE.md` 的必选项全部具备证据后，才能把一期目标标为完成；本次提交是独立底座收口，不是生产切换完成。
