# AI 平台一期收口状态

更新：2026-09-08。

## 当前交付状态

- 任务：AI 统一调度平台一期开发。
- 分支：`codex/ai-unified-platform-v1`。
- 独立工作树：`/Users/jiangjizhen/Documents/Codex/repos/sentelligent-sales-workbench/.worktrees/ai-unified-platform-v1`。
- 开发基线：`741d104e79e2c81a040a2e9ef84bd635c294f1b9`。
- 独立实现提交：`8732328e6bec7acd1e01597dacd6240d45ac782f`。
- 独立验收文档提交：`2e046cc36b8d2ffc5f5be7d0b4c771bf475b89db`。
- 共享源码整合：`codex/v0120-full-upgrade` 已从 `741d104e79e2c81a040a2e9ef84bd635c294f1b9` 快进保留 `3337b340`、`8732328e`、`2e046cc3` 三项原始提交；旧含敏感测试字面量的提交未进入该分支。
- 平台版本：`0.1.0`。
- 目标模型配置：`gpt-5.6-luna / max`。
- 当前执行模式：`local-simulated`；供应商注册仍为本地模拟供应商，不代表已经调用真实模型。

本提交交付的是独立平台底座、管理 API、静态管理台、业务侧受限客户端和运维脚本。源码现已进入升级分支和统一质量门，但它不是现有业务系统的 AI 调用切换提交，也没有改动业务数据库或生产进程。

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
- 根 `npm run test:ai-platform` 同时运行平台 `37` 项和业务客户端 `11` 项，并已接入本地 `qa:full`、CI 与 release 验证。

## 本轮证据

以下证据均来自本工作树和本地模拟执行，不包含真实供应商、生产数据库或真实通知。

| 范围 | 命令/环境 | 结果 |
| --- | --- | --- |
| 平台单元与集成测试 | `cd ai-platform && npm test` | 37 passed，0 failed，0 skipped |
| 业务侧客户端测试 | `node --test backend/src/aiPlatform/client.test.js` | 11 passed，0 failed |
| HTTP 管理 API | `node --test ai-platform/tests/http-server.test.js` | 7 passed，包含资源详情、任务子资源、成本筛选、管理员取消、调度和布尔筛选 |
| 调度专项 | `node --test ai-platform/tests/schedule-service.test.js` | 9 passed，包含去重、暂停竞态、stale run 恢复、旧租约 fencing 和并发 claim |
| 语法与空白检查 | `node --check ...`、`git diff --cached --check` | 通过 |
| 独立运行态 | 临时端口 `19997`，独立 PID、runtime、SQLite 和日志目录 | `start/status/health/stop` 通过；健康状态为 `local-simulated`、数据库 `ready` |
| 备份 | `scripts/ai-platform/backup.sh` | `quickCheck=ok`，`foreignKeyErrors=0`，迁移数 `2`；备份位于临时证据目录 |
| 恢复 | 独立临时端口 `19998` 和临时数据库 | 运行中恢复拒绝为 `service_running`；无 `--force` 拒绝为 `confirmation_required`；强制恢复通过，并保留 `.before-restore-*` 旧库 |

## 已整合源码但尚未切换业务或生产

- M3 的周报、快速记录、手工建议、温度、销售决策和行程等现有业务入口尚未挂入业务 `server.js`；客户端已经准备，但当前没有旁路改造声明。
- M5 的业务快照、受限业务工具、旧主动 worker 停止/排空/切换和结果投递尚未进入共享文件整合窗口。
- M6 的视觉、票据和 ASR 真实网络协议适配尚未实施。
- 尚未执行真实供应商质量/费用验收，尚未启用 `external-provider`，尚未发送真实通知，尚未部署生产或安装 systemd 单元。
- 有界负载下的 CPU、内存、临时文件和日志增长测试尚未执行；不能用本地空载健康检查替代 OPS-04。
- 管理台当前使用独立本地 API；业务登录代理、生产访问控制和现有前端结果卡的最终整合仍待双方提交 SHA 后串行完成。

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
