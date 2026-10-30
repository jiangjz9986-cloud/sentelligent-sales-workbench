# 2026-10-24 第一批正确性升级合同

## 基线和范围

- 分支 `codex/reliability-upgrade-20261024`，基线为已核验生产提交 `b52fb0ef5a6989a3d85e1f0502659ef9bd34177a` (v0.13.26)。
- 复用 `.worktrees/invoice-qr-production`。已有通知格式/预算提取草稿与审查报告保留，按本合同整合，不撤销用户或其他任务改动。
- 实施审查报告 F1-F4、T1-T5、O1。整周替票联合优化、完整AI平台启用和OS迁移另批实施。
- 本批保持现行业务API和owner校验；不更换系统助手模型，不自动启用AI平台，不发送真实测试通知。

## 不变量

1. 发票自动绑定必须同时满足日期先后、31天窗口及现有金额/多候选规则；周优先仅排序。
2. 删除用户已确认删除的付款凭证后，补偿不得重新创建；inbox引用必须与实际附件一致。
3. 分类改名/停用不破坏已有草稿和历史账目。草稿保存稳定分类引用及创建时快照；用户主动改分类时按当前字典校验。
4. 微信多笔队列全部进入终态（含过期）且没有其他待处理队列时，对实际已入账项恰好发送一次汇总；取消/过期项不作为成功入账。
5. 项目身份与公告身份分离。同项目采购/更正/中标/终止独立保留；同一公告双来源收敛；已有canonical IDs/bridge引用保留兼容，不破坏已确认转换。
6. 正式客户匹配必须有规范医院名称、采购人或受控别名证据。同城/需求只作推荐证据，不能独立生成正式关联。
7. 公告入库与待通知事件在同一SQLite事务中提交；投递冻结payload、唯一事件键，重启和跨批客户处理可恢复，不依赖firstSeenAt与lastSeenAt相等。
8. PushPlus已明确拒绝才进入可重试failed；发送后无法确认结果（含body读取失败/截断/缺回执）进入uncertain，不盲目重复提交。accepted继续只表示平台受理。
9. 同源后续页面失败保留已验证成果，健康标为degraded/partial；保存配置绑定的恢复游标，下一轮可继续。
10. 运维告警区分warning/critical。同一故障不持续制造新未读；恢复有独立记录；后端返回非2xx/非法JSON必须作为状态端点故障。

## 迁移编号（禁止改写0001-0054）

| 编号 | 文件 | 所有者 | 合同 |
| --- | --- | --- | --- |
| 0055 | `0055_bookkeeping_category_reference.mjs` | category worker | shortcut_bookkeeping_entries增加nullable稳定分类引用/快照；只对可唯一确认的已有分类回填；保留历史文字 |
| 0056 | `0056_bookkeeping_proof_detachments.mjs` | lifecycle worker | owner/inbox/expense/payment范围的主动解除关联记录，删除附件与标记原子提交；不删除业务历史 |
| 0057 | `0057_hospital_tender_notice_sources.mjs` | identity worker | 来源到公告映射与项目身份，保留现有canonical/bridge引用；加法迁移 |
| 0058 | `0058_hospital_tender_delivery_events.mjs` | main | durable通知事件/冻结批次及collector恢复游标；已有历史匹配以已处理基线回填，升级不群发历史公告 |

主控独占 `backend/src/db/migrate.js`、全局迁移测试和发布脚本调整。各worker仅创建已分配迁移文件，由主控注册。

## Collector内部同步合同

- `hospital-tender-snapshot-v1` 保持兼容，新增可选顶层 `collectionProgress` 数组（最多200项）。
- 每项为 `{sourceId, configurationDigest, cursor}`，sourceId最长200，configurationDigest为64位小写SHA-256；cursor为有界JSON对象，仅包含非负整数分页/类别/医院位置，不含URL、凭据或业务正文。
- Node保存该数组，调用runner.run时传入同名 `collectionProgress`；internalRunner将其写入本次私有临时JSON文件，并向Python CLI传 `--resume-progress=<path>`。
- Python仅对source配置摘要一致的条目恢复；新增/修改source配置后安全重置游标。成功完成后游标回到起点；partial保留下一应处理位置。
- Python输出sources.status使用现有 `healthy/degraded/error`，部分可用公告照常导出；Node不扩大未知字段或无界JSON接受范围。
- 临时collector环境继续显式allowlist，无Token/model key/cookie/生产环境继承。

## 文件所有权

| 工作流 | 独占写入 |
| --- | --- |
| Invoice F1 | `backend/src/travelExpense/invoiceRepository.js`，专用新增测试 |
| Lifecycle F2/F4 | `backend/src/assistant/shortcutBookkeepingRuntime.js`、`backend/src/travelExpense/repository.js`、`backend/src/travelExpense/documentInboxRepository.js`、0056、专用新增测试 |
| Category F3 | `backend/src/bookkeeping/categoryRepository.js`、`categoryCatalog.js`、`backend/src/integrations/shortcutBookkeepingRepository.js`、0055、专用新增测试 |
| Tender identity T2/T5 | `backend/src/hospitalTender/canonicalBridge.js`、`repository.js`、`matching.js`、0057、专用新增测试 |
| Collector T3 | `backend/vendor/hospital-tender-monitor/`全部；保留已有预算草稿 |
| Ops O1 | `scripts/deploy/ops-inspect.sh`、`ops-alert.sh`（如有必要）、运维专用测试/新增帮助模块 |
| Main | tender scheduler/schedulerRepository、pushplus notifier/deliveryRepository、notificationMessage、internalRunner/sync、shared合同、server.js、迁移注册/全局测试、版本/发布文件、前端、集成与浏览器验收 |

不得跨写其他worker文件；需要共享改动时提交具体接口需求给主控。不得提交整个worktree、替换既有dirty文件或修改生产。每个worker先补真实业务反例回归，再修复并运行相关测试，交付变更路径和验证结果。

## 验收

- 新迁移从生产schema前向升级、旧数据保留、foreign_key_check/quick_check正常；迁移校验与release manifest合同更新。
- 覆盖报告中边界场景、中断点、owner隔离、幂等重放、主动删除/替换、过期收尾、双源跨阶段。
- 后端全量、collector全量、发布/部署脚本、前端local/integration及Chrome/WebKit验收；页面若未修改也验证关键现行工作流。
- 准备干净的发布候选和准确变更说明；真实provider/生产验证与本地模拟结果分开记录。
