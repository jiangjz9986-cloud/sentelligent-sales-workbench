# AI 平台融合升级状态

更新：2026-09-10。主任务已接管生产融合，完整执行边界见
[FUSION-EXECUTION.md](FUSION-EXECUTION.md)。

## 融合进度

- 工作树：`ai-platform-production-integration-20260909`；
  融合基线 `4cfdcdb9d3f499056c45a7c83434d3fa7b96d3cd`，
  生产基线 `3209a073486e22370307a6f46021ac9cf2ec71d1`。
- 已实现持久化暂停/控制版本/审计、关闭等待结算、请求级身份绑定、
  持久化 nonce 防重放、原子迁移及费用预占/未知费用恢复修复。
- 平台迁移新增 0003/0004；业务 0042-0045 和平台 0001/0002 未改写。
- 本地平台 69/69、全部适配器 34/34、双服务和 QA 脚本专项 16/16
  通过。生产认证模式测试使用临时库和模拟供应商，不等同生产上线。
- 真实供应商/媒体、管理代理、灰度、主动事件修复、生产发布控制
  与最终全量验收仍在实施；当前生产没有改变，不能标为交付完成。

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
