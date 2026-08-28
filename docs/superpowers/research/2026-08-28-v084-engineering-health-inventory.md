# v0.8.4 工程健康盘点清册（只读调研定稿）

> 盘点时间：2026-08-28 17:47–18:10 CST · 全程只读，未删任何 worktree/分支/文件。
> 基准主线：`local/v0627-feature-closeout-20260827`（HEAD `cab3825`，工作树 `.worktrees/integrate-v0626-candidate`，v0.8.1 并行实施占用中）。tag 链 v0.6.24→v0.8.0 已逐一 `merge-base --is-ancestor` 验证全部在主线内。
> 方法学：包含性 = `git merge-base --is-ancestor <ref> 主线`；内容等价 = `git cherry 主线 <branch>`（全 `-` 记 equiv，`+` 记 unique）；脏检查 = 逐 worktree `status --porcelain`。
> 对应蓝图：`docs/superpowers/plans/2026-08-27-v07-v08-continuous-delivery.md` L 阶段（v0.8.4）。

## 0. 执行摘要与优先级排序

| 优先级 | 事项 | 预估工作量 | 风险 |
|---|---|---|---|
| P0 | 孤儿测试 `HospitalTenderPage.test.mjs` 补挂门禁（先本地跑通再挂 `test:tender` 入 qa:local 链） | 0.5h（若测试年久失修需修复则 +2h） | 低；纯增量 |
| P0 | docs 笔误修正：v0.7.5 测试基线口径（1158 vs 1148，交付报告§3-8） | 0.5h | 零 |
| P1 | worktree/分支清理：先全量 archive tag → remove worktree → branch -D → prune（§1 名单；预回收 ≈9.6 GB） | 2–3h（含脏工作树逐个人工确认） | 中；archive tag 兜底可全量恢复 |
| P2 | `pages.jsx` 按域拆分（§3 方案；先改守护测试取源方式，再抽 shared，再按域搬移，桶文件保导出面） | 2 人日 | 中；单提交可 revert |
| P3 | docs 回填（README/路线图/开发日志/部署记录/矩阵/架构/交接说明 7 份，§5 结构建议） | 1.5–2 人日 | 低；纯文档 |
| P4 | 服务器 staging/releases 历史目录清理（§6 仅建议，需用户点头）；GitHub 同步与否、客户 owner 归属、晨报开放问题真机问询（用户决策项） | 1h + 决策 | 中；先归档后删 |

建议顺序：P0 两项可立即做（不碰并行实施文件）→ P1 释放磁盘与心智负担 → P2 拆分（等 v0.8.1/0.8.2 视觉改造合入后做，避免同文件冲突）→ P3 回填 → P4 随发布窗口顺带。

---

## 1. worktree / 分支清册与安全分类

### 1.1 总量统计

- git 注册 worktree **76 个**：主 checkout 1 + `.worktrees/` 66 + `Documents/Codex/worktrees/` 3 + 本会话 `tmp/` 8 + `/private/var/folders/...`（v0.6.25 release 打包临时 checkout）1。无 prunable 标记。
- 本地分支 **80 个**：已被主线包含（CONTAINED）31 个，未包含 49 个；未包含中经 `git cherry` 判定内容已等价合入（unique=0）**17 个**。
- 磁盘：`.git` 69 MB；`.worktrees/` **9.0 GB**；外部 3 个 worktree ≈706 MB；`tmp/` git 注册副本与事务目录 ≈250 MB。**预计可回收 ≈9.6 GB**（保留主 checkout 与 `integrate-v0626-candidate` 266 MB）。
- 附注：`ls .worktrees` 目录数（67）与 git 注册数（66）差 1，实施时对照两份清单找出孤儿目录直接 `rm -rf`。

### 1.2 保留（3 个分支 + 2 个 worktree）

| 对象 | 理由 |
|---|---|
| 分支 `local/v0627-feature-closeout-20260827` | 当前主线（v0.6.26→v0.8.0 全链 + v0.8.1 实施中） |
| 分支 `main` | 远端主分支本地指针（cb9598f，落后 origin/main；GitHub 同步决策前不动） |
| 分支 `codex/settings-config-pushplus` | **主 checkout 当前挂载分支**（bd4fca2，未合入 unique=1）。建议主 checkout 切到主线后降级为"需确认" |
| worktree 主 checkout `repos/sentelligent-sales-workbench` | 主工作树不可删；建议后续 `git switch local/v0627-feature-closeout-20260827`（先确认无未提交改动） |
| worktree `.worktrees/integrate-v0626-candidate` | 活跃开发（v0.8.1 并行实施占用） |

`local/production`（6b2142f = v0.6.25）单列**需确认**：指针语义已过时（生产实际 v0.8.0），建议清理时 fast-forward 到当前生产 tag 或直接删除（生产身份以服务器 release 目录与 tag 为准，该分支非事实来源）。

### 1.3 可删 A 类——已被主线包含（28 个分支，`merge-base --is-ancestor` 判定）

`codex/audit-local-v0613-20260824`、`codex/expense-ledger-production-v0624-20260826`、`codex/expense-ledger-redesign-20260826`、`codex/expense-ledger-week-region-v0625-20260826`、`codex/integrate-small-small-capability`、`codex/local-prod-function-candidate-20260822`、`codex/local-prod-release-v065-final-clean-20260822`、`codex/local-prod-shortcut-ai-direct-v0614-20260824`、`codex/local-prod-xiaoxiao-settlement-20260823`、`codex/main-local-integration-20260823`、`codex/pre-three-lane-merge-20260818`、`codex/recover-prod-assistant`、`codex/release-secret-scan-prerequisite`、`codex/shortcut-token-verify-v058`、`codex/v053-final-qa`、`codex/v053-integration`、`codex/wechat-image-bookkeeping-20260824`、`codex/weixin-image-bookkeeping-prototype`、`codex/weixin-meal-auto-classification-20260825`、`codex/weixin-note-correction-hotfix-20260825`、`codex/weixin-stale-delivery-hotfix-20260825`、`codex/weixin-trip-region-profile-20260825`、`codex/weixin-vision-routing-hotfix-20260825`、`fix/weixin-provider-message-id`、`local/integration/v0.6.26`、`local/integration/v0.6.26-candidate`、`local/release-expense-ledger-week-region-v0625-20260826`（+ 需确认后的 `local/production`）。

### 1.4 可删 B 类——未包含但 patch 内容已等价合入（17 个，`git cherry` unique=0）

`codex/audit-release-preflight-next`、`codex/fix-secret-scan-next`、`codex/hospital-tender-frontend`、`codex/hospital-tender-v0626-20260827`、`codex/production-service-plan-generator`、`codex/recover-prod-hospital`、`codex/recover-prod-travel`、`codex/settings-config`、`codex/settings-config-v2`、`codex/tender-data-layer`、`codex/tender-internalization`、`codex/unified-assistant-runtime`、`codex/v053-final-docs`、`codex/v053-final-weixin`、`codex/v066-v9-prod-fix-20260822`、`local/expense-acceptance-usability-v0626-20260827`、`local/hospital-tender-ui-v0626-20260827`。

### 1.5 需确认（32 个，含独有提交或语义特殊；建议 archive tag 后删）

**旧史勘探组（v0.5.x 时代，ahead 32–77，与主线有共同祖先但整批未回并；功能后来以 v0.6.5+ 链重做合入）**：`codex/fix-cutover-schema`(72)、`codex/fix-mts-scan`(72)、`codex/fix-weixin-cursor`(72)、`codex/project-governance-baseline`(55)、`codex/small-small-capability-analysis`(77)、`codex/v0.5.3-weixin-closure`(76)、`codex/xiaoxiao-capability-analysis`(76)、`codex/v0.5.3-clean-history`(3，历史重写基线)、`codex/unmerged-updates`(38)、`codex/unmerged-updates-settings`(35)、`codex/unmerged-updates-settings-latest`(41)、`codex/xiaoxiao-agent-suite`(32)。

**小差量组（unique 1–9，多为被后续版本取代的迭代稿）**：`agent/hospital-tender-monitoring-polish`(5)、`codex/fix-integration-cleanup-next`(2)、`codex/fix-stagestrip-next`(2)、`codex/hospital-tender-frontend-v3`(2)、`codex/hospital-tender-live-sources`(1)、`codex/hospital-tender-scheduler-v2`(2)、`codex/local-prod-release-v065-20260822`(2)、`codex/release-v063-candidate`(4)、`codex/shortcut-bookkeeping-assistant-pure`(1)、`codex/shortcut-bookkeeping-single-v063`(1)、`codex/shortcut-bookkeeping-write-v062`(1)、`codex/shortcut-icost-url-bridge-20260824`(3)、`codex/shortcut-weixin-delivery-clean`(5)、`codex/shortcut-weixin-delivery-fix`(21)、`codex/unified-assistant-runtime-wiring`(1)、`codex/v063-travel-expense-core`(9)、`codex/v063-xiaoxiao-safety-closure`(4)、`codex/xiaoxiao-sales-loop`(2)、`codex/settings-config-pushplus`(1，主 checkout 切走后)、`local/production`（指针过时）。

**带脏改动的 worktree（删除前须逐个 `git -C <path> status` 人工过目）**：`.worktrees/expense-ledger-week-region-v0625-20260826`(48 项)、`.worktrees/integrate-v063-internal`(36 项)、`Codex/worktrees/sentelligent-shortcut-single-v063`(15 项)、`.worktrees/v063-xiaoxiao-safety-closure`(11 项)、`tmp/expense-acceptance-usability-v0626-20260827/fixtures/rollback-final-07c91ce`(8 项)、`tmp/weixin-jpeg-trailer-baseline-worktree-v0616`(2 项)、`.worktrees/expense-ledger-redesign-20260826`(1 项)、`.worktrees/project-governance-baseline`(1 项)。

### 1.6 建议命令清单（仅列出，未执行；实删须用户批准）

```bash
# ① 兜底：为全部待删分支打 archive tag（tag 常驻 .git，可随时 git branch <name> archive/<name> 复活）
git for-each-ref --format='%(refname:short)' refs/heads/ \
  | grep -vE '^(main|local/v0627-feature-closeout-20260827)$' \
  | while read b; do git tag "archive/${b//\//-}" "$b"; done

# ② 移除 worktree（脏的先人工过目，确需丢弃改动才加 --force）
git worktree remove .worktrees/<name>            # 干净的
git worktree remove --force .worktrees/<name>    # 脏的（人工确认后）
# 外部同理：git worktree remove /Users/jiangjizhen/Documents/Codex/worktrees/sentelligent-shortcut-*、
#          tmp/ 下 8 个、/private/var/folders/.../sentelligent-release-commit-nNqHsQ/checkout

# ③ 删分支（A 类可用 -d 验证包含性；B 类与需确认组用 -D）
git branch -d <A类分支>
git branch -D <B类/需确认分支>

# ④ 收尾
git worktree prune && git gc --prune=now
```

### 1.7 回收量估算

`.worktrees` 9.0 GB − 保留 266 MB ≈ **8.7 GB**；外部 3 个 ≈ **706 MB**；`tmp/` 副本 ≈ **250 MB**。合计 ≈ **9.6 GB**。`.git` 69 MB 删分支后 `gc` 收益有限（对象大多被 tag 链引用）。

---

## 2. 孤儿测试排查

**结论：全仓唯一孤儿 = `outputs/product-design-prototype/src/features/hospitalTender/HospitalTenderPage.test.mjs`。**

| 区域 | 测试文件数 | 门禁覆盖方式 | 孤儿 |
|---|---|---|---|
| `backend/tests/` | 143 | `npm --prefix backend test` = `node --test tests/*.test.js`（全部顶层，无子目录漏网）；CI（ci.yml/release.yml）同跑 | 0 |
| 原型 `src/` | 29 | 28 个逐一挂在 `test:*` 脚本并串入 `qa:local`（含 v0.7.1 孤儿先例 `SystemSettingsPage.test.mjs` 已挂 `test:settings`） | **1**：`HospitalTenderPage.test.mjs` 无任何 `test:*`/qa/CI 引用（rg 全仓验证，`qa:integration`/`qa:webkit` 亦不动态发现测试） |
| 原型 `scripts/` | 17 | 全部被 `test:*` 脚本引用 | 0 |
| 根 `scripts/` | 15 | `test:deploy` = `node --test scripts/*.test.mjs`（顶层 glob 全覆盖）；CI 同 glob | 0 |

修复建议（P0）：先 `node --test src/features/hospitalTender/HospitalTenderPage.test.mjs` 验证现状能否跑绿（自 v0.6.26 招标 UI 合入后从未执行过，可能与现组件签名脱节）；绿则加 `"test:tender": "node --test src/features/hospitalTender/HospitalTenderPage.test.mjs"` 并插入 `qa:local` 链（`test:settings` 之后）；不绿先修测试再挂。

---

## 3. `pages.jsx` 拆分方案

### 3.1 现状

- `outputs/product-design-prototype/src/features/salesWorkbench/pages.jsx`：**3710 行**，导出 13 个符号；引用方仅 2 处：`App.jsx`（导入其中 12 个：PageHeading/Overview/QuickRecord/CustomerPage/OpportunityPage/ActionsPage/SolutionPage/WeeklyPage/RiskPage/KnowledgePage/WeixinBindingPage/KanbanPage）与 `src/app/workbenchState.test.js`（**readFileSync 读源文本做守护断言**，见 3.4）。`SummaryLine` 仅文件内部使用（QuickRecord 域），导出面可顺带收敛。

### 3.2 拆分文件规划（`src/features/salesWorkbench/pages/` 目录，13 文件）

| 新文件 | 迁入内容（行号为现文件定位） |
|---|---|
| `pages/shared.jsx` | **先抽**：`FormField`(L1433，全文件 61 处使用)、`confirmDelete`/`showOperationError`(L1442/1447，客户/商机/知识三域共用)、`DeleteConfirmationDialog`(L1453)、`joinedList`(L103，11 处跨域)、`StakeholderGrid`/`FieldTags`/`DecisionChain`/`DraftPreview`(L1213–1308，客户+商机+快速记录共用)、`textFromArray`/`arrayFromText`/`numberFromInput`(L1310–1326)、`sourceRefText`(L2592，方案/风险/知识共用) |
| `pages/PageHeading.jsx` | `PageHeading`(L64) + `pageTitle`(L86) |
| `pages/OverviewPage.jsx` | `Overview`(L116) |
| `pages/QuickRecordPage.jsx` | `QuickRecord`(L354) + `SummaryLine`(L1189，改为不导出或域内导出) + 语音/同步 helper（L300–353：`syncTargetLabel`/`formatSyncTime`/`getSpeechRecognitionConstructor`/`canUseSpeechRecognition`/`quickRecordHistoryView`） |
| `pages/CustomerPage.jsx` | `CustomerPage`(L1828) + `CustomerEditor`(L1523) + `customerToForm/FromForm`(L1327–1367) |
| `pages/OpportunityPage.jsx` | `OpportunityPage`(L2096) + `OpportunityEditor`(L1628) + `opportunityToForm/FromForm`(L1368–1408) |
| `pages/ActionsPage.jsx` | `ActionsPage`(L2360) |
| `pages/SolutionPage.jsx` | `SolutionPage`(L2604) |
| `pages/WeeklyPage.jsx` | `WeeklyPage`(L2671) |
| `pages/RiskPage.jsx` | `RiskPage`(L2948) + `riskStatusLabel`/`riskSourceLabel`(L2925–2947) |
| `pages/KnowledgePage.jsx` | `KnowledgePage`(L3174) + `KnowledgeEditor`(L1743) + `knowledgeToForm/FromForm`(L1409–1432) |
| `pages/WeixinBindingPage.jsx` | `WeixinBindingPage`(L3453) + `bindingStatusMeta`/`formatBindingTime`(L3426–3452) |
| `pages/KanbanPage.jsx` | `KanbanPage`(L3611) |

### 3.3 导入方替换点

- **`pages.jsx` 原地改为纯桶文件**（`export { … } from "./pages/…"` 13 行）→ `App.jsx` 的导入语句**零改动**；外部无其他导入方（已 rg 验证）。
- 头部公共依赖（lucide-react 30 个图标、`primitives.jsx` 11 个组件、`salesWorkbenchData.js` 的 `kanbanStages`/`statusTone`、`workbenchState.js` 的 `assertBackendReady`、`quickRecordModel.js`、`weekRange.js`、`opportunityTimeline.js`、`SalesDecisionPanel.jsx`、`downloadFile.js`、`salesWorkbenchApi.js`）按各域实际使用拆到对应文件。

### 3.4 "类名与测试断言零变化"保护策略

1. **唯一硬约束**：`workbenchState.test.js` L161–194 用 `readFileSync` 读 `pages.jsx` 源文本断言（禁 demo 数据导入、禁 `fallbackSuggestion|local-suggestion`、禁四个演示医院名、**必须匹配** `{item.artifactType} / {item.status}` JSX、禁旧写法）。拆分后桶文件不再含这些文本 → 断言必挂。**先行改造取源方式**：把 `pagesSource` 改为聚合读取 `salesWorkbench/pages/` 目录全部 `.jsx` 文本（或 `pages.jsx` + 目录并集），**断言本身一字不动**——先单独提交这一步并跑绿，再做搬移。
2. DOM/类名级门禁（`module-coverage`/`visual-rhythm`/`interaction-polish` 等 scripts 测试与 Chrome/WebKit 集成）跑的是 **vite 构建产物**，与源文件组织无关；只要搬移是纯剪切（不改 JSX/类名/文案），全部保持绿。沿用 v0.8.1 已验证的"改值不改名、只增不删"纪律。
3. 搬移顺序：shared → 各域文件（每步 `npm run build` + 相关 `test:*` 快验）→ 桶文件收口 → 全量 `qa:full`。单 PR 单提交，失败回滚 = revert。
4. 时机：**等 v0.8.1（视觉统一，pages.jsx 30+ 处 pill/类改动）与 v0.8.2（差旅整改）合入后再拆**，避免大面积同文件冲突。
5. 顺带机会（拆分同 PR 或紧随）：阶段词表下沉（§4-1）落到 `KanbanPage`/后端 API 单一来源。

预估：守护测试改造 0.5d + shared 抽取与域搬移 1d + 门禁全绿与收口 0.5d = **2 人日**。

---

## 4. 登记技术债汇总（去重，含出处；以实扫为准）

| # | 债项 | 出处 | 状态/建议去向 |
|---|---|---|---|
| 1 | **阶段词表两份**（后端 `stageVocabulary.js` ↔ Web `kanbanStages` 注释互指），根治=下沉后端 API `GET /api/opportunities/stages` 或共享包 | `research/2026-08-28-v075-opportunity-agent-design.md` §411；CHANGELOG [0.7.6] | 开放；并入 v0.8.4 拆分（§3.4-5） |
| 2 | **naturalPlan 头部前缀膨胀**（capture+todo 两组抢最前），应重构为前缀表驱动 | `research/2026-08-28-v074-todo-agent-design.md` §416 | 开放；v0.8.4 评估（先评估收益再动，router 测试已固化互斥） |
| 3 | **outbox 4 条历史 failed**（08-22/08-25 遗留，8 次重试耗尽终态） | `docs/releases/v0.7.6.md` L54（部署核验注记） | 开放；清账方式=生产只读确认后人工核销或 `requeueFailed`（仅 retryable 码），建议 v0.8.4 深度测试时顺带 |
| 4 | **待办 remind_at 无 Web 编辑**（微信侧专写；Web 确认页深写回待办 remind_at=NULL 不提醒） | `research/2026-08-28-v074-todo-agent-design.md` L276、§421 开放问题 2 | 开放;建议并入 Web 表单改版（原 J 阶段语境） |
| 5 | **customer `contact` 审计脱敏**：before/after 剔除 contact 为预期行为，changedFields 可证明改动 | 交付报告 `reports/2026-08-28-v07-series-delivery-report.md` §3-6 | 说明性（非缺陷）；docs 回填时写入架构/审计说明 |
| 6 | **招标 lenient 观察项**：再现"单条坏公告拒绝整批"（scheduler lastError=快照校验失败持续）则按施工图 §4.3 三件加固 | `docs/releases/v0.7.7.md` 偏差③；蓝图遗留登记 | 观察项（陈账已自愈核销）；保持登记 |
| 7 | **晨报开放问题 5 项**（任务书记 3 项，实扫为 5）：心跳版/周末补发/Web 管理面开关/招标行带 URL/"晨报"手动拉取意图 | `research/2026-08-28-v076-daily-digest-design.md` §7.2–7.6 | 开放；全部"默认保守"，待真机反馈决策（M 阶段问询） |
| 8 | **走查低危两项**（招标页 select null 警告、快速记录 sourceChannel 误标"语音转写"） | 交付报告"合成栈截图走查"节 | **已修**：CHANGELOG [0.8.1] "顺带修复两项走查发现"；随 v0.8.1 发布即核销 |
| 9 | **`.production-cutover.lock` 残留**（服务器项目根，0 字节 flock 残留，mtime 08-23） | `research/2026-08-28-v080-server-facts.md` L14（判"正常现象"） | 低危；下次发布窗口顺手 rm 或维持 |
| 10 | **本机 18088/18841/18842/18897 遗留进程与临时库** | 08-27 晚验收遗留 | **已清**（08-28 主会话清理完毕，本盘点确认标记） |
| 11 | 存量客户 1 例 owner ≠ `WEIXIN_AGENT_OWNER`（对小小不可见） | 交付报告 §3-1 | 用户决策（Web 端调整归属） |
| 12 | owner 为空的存量待办微信端只读 | 交付报告 §3-2 | 接受态；docs 说明 |
| 13 | aliases/tags 无 Web 表单（API 已支持） | 交付报告 §3-3（v0.7.2 设计开放问题 2） | 开放；建议并入 Web 表单改版 |
| 14 | "修改客户 …"前缀在记账草稿活跃期被记账纠错优先消费 | 交付报告 §3-5（v0.7.2 偏差 5，惯例保留） | 接受态；话术规避已写验收卡 |
| 15 | `spokenTime.js` 不支持分钟级相对时间（"5分钟后"不解析） | 交付报告 §3-7 | 开放；按需求排期 |
| 16 | v0.7.5 测试基线口径笔误（1158 vs 1148） | 交付报告 §3-8 | P0 文档修正 |
| 17 | 服务器构建须 `LC_ALL=C`（git 1.8 中文 locale 绕过英文正则） | 交付报告 §3-12（v0.7.4 踩坑） | 已入 runbook 惯例；docs 回填确认落章 |
| 18 | GitHub 同步恢复与否 | 蓝图遗留登记 | 用户决策（制品异地风险已由 v0.8.0 解除） |
| 19 | v0.6.25《连续验收目标》11 项中的用户真机项 | 蓝图遗留登记 | 并入 M 阶段验收卡 |
| 20 | "行程页 plan_json 展示"（任务书点名） | **实扫未见独立登记**。最接近：晨报侧 plan 形状 fail-open 已实现（v0.7.7 偏差⑤）；行程页视觉 P2-12 已并入 v0.8.1；`VisitItineraryPage.jsx` 无 raw JSON 输出 | 待与用户确认所指；暂不立项 |

---

## 5. docs 回填差距

| 文档 | 现停版本口径 | 与 v0.8.x 差距 |
|---|---|---|
| `README.md` | 主体 v0.5.3（助手能力元数据节）+ v0.6.24 零星更新；交接链接停 v0.4.4 | 缺 v0.6/v0.7 全部能力（IA 整合、小小 agent 套件、待办/晨报、招标微信推送、备份体系）；启动/门禁命令需对 qa:full 现状复核 |
| `docs/开发进度与路线图.md` | v0.2.2（"下一步完成 v0.2.2 质量门"） | 落后约 60 个版本；现行路线实际由蓝图文档承载 |
| `docs/开发日志.md` | 2026-07-29 / v0.2.1 | 缺 7-29 之后全部条目（v0.3–v0.8） |
| `docs/部署记录.md` | v0.2.1 / v0.1.0 | v0.3.0 起部署证据散在 `docs/releases/*.md`，本文件未汇总 |
| `docs/需求与验收矩阵.md` | 2026-07-28（基线 f89e1e7，v0.2.x） | 全部新模块（差旅/行程/招标/助手/待办/晨报）无矩阵行 |
| `docs/项目架构与模块说明.md` | 2026-07-29 | 缺 backend 新模块群（assistant/dailyDigest/actionReminders/hospitalTender/travelExpense/weixin 等）与前端 features 结构 |
| `docs/正式交付验收手册.md` | v0.3.6 现网基线 / v0.4.x 合同 | 25/25 preflight、HTTPS 冒烟、备份验收等现行口径未沉淀 |
| `docs/森特智行-v0.4.4-换机交接说明.md` | v0.4.4 | 服务器 IP/私钥事实仍被引用（server-facts 也引它），但克隆/检出/版本全旧 |

**回填章节结构建议（只列结构，不写正文）**：
1. `README.md`：项目一句话 → 当前版本与生产状态（指 CHANGELOG/tag）→ 能力总览表（按 12 业务域）→ 本地启动（qa:full/dev 命令实测口径）→ 文档地图（蓝图/releases/研究/手册四类入口）。
2. `开发进度与路线图.md`：改为薄壳——"现行路线见蓝图"+ 历史里程碑表（v0.1–v0.8 每版一行：日期/主题/tag）。
3. `开发日志.md`：补 7-29 之后的版本级摘要表（每版一行，链接 `docs/releases/vX.Y.Z.md`），不逐日补写。
4. `部署记录.md`：补"v0.3.0–v0.8.0 部署索引表"（版本/日期/release 目录名/回滚点/证据链接），现行证据仍以 releases 文档为准。
5. `需求与验收矩阵.md`：按 12 业务域重列矩阵行，状态口径沿用四态定义；每行证据指向 release/测试文件。
6. `项目架构与模块说明.md`：backend 模块清单（server + 14 子域）+ 前端 features 结构 + 三调度器（招标/提醒/晨报）+ 数据表 0001–0028 迁移索引 + 审计/脱敏边界（含 §4-5、§4-12）。
7. 交接说明：升级为 v0.8.x 版（恢复路径=蓝图开头恢复指引 + server-facts 事实 + 备份/恢复操作），保留 v0.4.4 原件不动作为历史。

---

## 6. 磁盘占用

**本机**（实测 2026-08-28）：`.git` 69 MB；`.worktrees/` 9.0 GB（Top3：integrate-v063-internal 430 MB、project-governance-baseline 273 MB、integrate-v0626-candidate 266 MB<保留>）；外部 worktree 3 个 706 MB；`tmp/` 事务与基线副本 ≈250 MB。回收方案见 §1.6–1.7。

**服务器**（`/opt/sentelligent-sales-workbench/`，引 server-facts 08-28 00:07 实况 + 当日 releases 文档佐证）：
- `staging/` **787 MB**（00:07 时点最新为 v0.7.0 产物）；**08-28 白天又新增 v0.7.3–v0.8.0 六组 `build-vX.Y.Z-2026-08-28T*/` + bundle**（如 `build-v0.7.5-20260828T063227Z_3251851e7ffd/`、`build-v0.7.7-20260828T083304Z_a3b5bbc6ecc1/`，见各 release 文档"服务器打包"行），估算现状已超 1 GB。
- `releases/` 718 MB / **69 个版本目录**；`backups/` 269 MB（129 run 目录）；`runtime/` 651 MB；`candidates/` 347 MB；`incoming/` 213 MB；磁盘整体 40G 用 16G（42%），无近期容量风险。
- **清理建议（仅建议，须用户批准后另行执行）**：① `staging/` 只保留最近 2 版 `build-*` 与 bundle——v0.8.0 起 `archive-release-artifacts.sh` 已自动归档 bundle+evidence 到 `backups/releases/<version>/`（root:root 0700 冻结），历史版本可"先补归档→SHA-256 对账→再删 staging 副本"；② `releases/` 保留 current + 上一版 + 最近 5 版，更早目录在 backups/releases 归档保底后删除；③ `candidates/`、`incoming/` 为旧流程残留，确认无引用后整体归档清理。08-28 六组 build-* 属当日发布链证据，**至少保留到 v0.8.x 收官验收后**再按 ① 处理。

**本机遗留进程**：18088/18841/18842/18897 四组昨晚遗留进程与临时库——**已清**（08-28 主会话完成，本盘点确认）。

---

## 7. 风险与回滚总则

- **分支删除**：一律先 `git tag archive/<name>`（§1.6-①），tag 在 `.git` 常驻、可整分支复活；A 类用 `-d`（git 自身二次校验包含性）；带脏 worktree 的 8 个必须人工过目后才 `--force`。
- **worktree 删除**：只影响工作目录副本，不影响对象库；误删后 `git worktree add <path> <branch>` 秒级重建。
- **pages.jsx 拆分**：守护测试取源改造先行单独提交；搬移单提交、全门禁绿后合入；回滚 = revert。与 v0.8.1/0.8.2 串行避免冲突。
- **服务器清理**：先归档 + SHA-256 对账再删；发布窗口外执行；`releases/` 现行 current 与回滚点目录绝对不动。
- **docs 回填**：纯文档提交，随任一版本发布捎带，无生产风险。

## 8. 工作量预估汇总

P0 合计 ~1h · P1 清理 2–3h · P2 拆分 2 人日 · P3 回填 1.5–2 人日 · P4 服务器清理 1h+决策。v0.8.4 全阶段（含蓝图内"全功能深度测试"，不在本清册范围）预估 **4–5 人日**。
