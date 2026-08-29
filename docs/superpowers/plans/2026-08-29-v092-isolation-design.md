# v0.9.2 数据层 + Web 硬隔离 · 实施级设计（迁移 0031 / 端点矩阵 / 隔离测试）

日期：2026-08-29 · 作者：预研泳道 B · 状态：**定稿，可直接作为实施任务书**
基线：工作树 `.worktrees/integrate-v0626-candidate`（v0.9.0 实施工人并行中，**本文一律以文件名+函数名为锚点，不引行号**）。
范围依据：总蓝图 v0.9.2 行（D1 已裁定**完全隔离**，无共享开关）；多账号设计 L2；审计A §3.2 全表清册与 §4 #8/#9/#10/#16；v0.9.1 认证设计（users 表=迁移 0030）。
**硬前置**：v0.9.0（0029 owner 清洗）与 v0.9.1（0030 users + admin 门禁 + `requireAdminRole`）均已合入并上线。实施开始时若未合入，先 rebase。

## 0. 结论先行与版本边界

源码实读修正了审计A #10 的粗粒度判断——**已隔离资产比预期多**：差旅/借款/区域/工作台、发票/匹配/无票确认、凭证收件箱、记账评审、**快速记录全链**（`quickRecordOwnerScope` 对 user 会话同样生效）、audit-logs（`listAuditLogs` 已按 `actor OR metadata.owner` 过滤）全部就位。真正的改造面收敛为：

- **销售核心五域**（客户/商机/行动/风险/知识）Web 全量视角 + **行程域零过滤**（`itineraryRepository` 连 owner 概念都没有）+ **AI 决策域**（`salesDecisionRepository` 仅 created_by）+ **两枚聚合**（`dashboardSummaryFromDb` 代码注释自证"future multi-account rollout must narrow"；招标列表的客户名映射）+ **三个 body 传 owner 的写路径**（customerCreate/opportunityCreate schema 含 owner；weeklyDraft/solutionDraft owner required）。
- 统一机制三条：**owner ≡ `request.authContext.account`**（读=WHERE 过滤，写=服务端注入、忽略 body）；**跨账号一律 404 防枚举**（实现方式：before 读取语句加 owner 谓词，天然先于乐观锁——owner 不匹配时查无行→404，永远到不了 version 比对→绝不泄露 409/currentVersion）；**机器路径与全局域一字不动**。
- 本版**不做**：微信绑定表（v0.9.3）、招标匹配/推送 per-owner 分发（v0.9.3，本版仅堵 Web 显示面）、owner 转移功能、admin 全局审计查询面（记遗留项）、`?owner=me|all` 开关（D1 裁定完全隔离，无此参数）。admin 与 member 在业务数据上**同权同隔离**（D1：admin 不可见他人业务数据）。

## 1. 迁移 0031：`backend/src/db/migrations/0031_owner_isolation_tightening.mjs`

### 1.1 三个决策（先裁定后代码）

1. **◇表（customers/opportunities/quick_records/action_items）收紧＝RAISE(ABORT) 触发器，不做列重建**。理由（三重雷区，均为实读结论）：`migrateDatabase`（db/migrate.js）把全部待应用迁移包在**单个 BEGIN IMMEDIATE** 里，而 `configureConnection`（db/connection.js）恒开 `PRAGMA foreign_keys=ON` 且该 PRAGMA 在事务内是 no-op——重建所需的 FK 关闭窗口不存在；FK 开启下 DROP customers 会沿 `opportunities.customer_id ON DELETE CASCADE` **级联清空商机**；`ALTER TABLE ... RENAME` 在现代 SQLite 下会改写子表 FK 引用指向改名后的旧表。触发器有 0009 document_blobs 防篡改触发器先例，语义上等价于列级 NOT NULL（写入即拒绝）。
2. **✗表补列＝`ADD COLUMN owner TEXT NOT NULL DEFAULT 'jiangjz'`**（SQLite 原生要求 NOT NULL 新列必须带常量 DEFAULT，且自动回填存量行）。范围：risk_items、visit_itineraries、sales_decision_analyses、knowledge_items（D1 裁定知识隔离）、**ai_suggestions**（无父表可派生，见下）。`created_by` 与 owner 的关系裁定：**owner=归属/隔离键，created_by/updated_by=审计列**，本版创建时恒等（owner:=authContext.account），无转移功能故永不分叉；存量 DEFAULT 回填为 jiangjz 正确（生产 created_by 全部为 jiangjz 词表域）。DEFAULT 的副作用（新代码漏传 owner 会静默落 jiangjz 而非报错）由 §3 写路径清单 + §4 矩阵测试兜住。
3. **ai_insights 与 manual_confirmations＝随父派生，不补列**。两表均 `FK quick_record_id`（CASCADE），全部读写路径先经 owner 过滤的父记录（`getLatestInsight`、confirm 事务内按 quickRecord.id 查询），无独立列表端点——补列是冗余。**ai_suggestions 例外必须补列**：无父 FK、独立 INSERT（POST /api/ai/suggestions），虽本版无读端点，防未来越权并统一审计口径。

### 1.2 迁移全文

```js
// v0.9.2 L2 数据层收紧：✗表补 owner 列（NOT NULL DEFAULT）、◇表 RAISE 触发器实现
// NOT NULL 语义（migrateDatabase 单事务 + foreign_keys=ON 下列重建不可行，见设计 §1.1）、
// v0.9.1 窗口残余 owner 词表清扫（对齐 users.account）、owner 过滤索引。全部幂等。
const OWNER = "jiangjz";
const ADD_OWNER_TABLES = [
  "risk_items", "visit_itineraries", "sales_decision_analyses", "knowledge_items", "ai_suggestions",
];
const SWEEP_TABLES = [
  "customers", "opportunities", "action_items", "quick_records", "weekly_reports", "solution_drafts",
];
const GUARD_TABLES = ["customers", "opportunities", "quick_records", "action_items"];
const INDEX_TABLES = [
  "customers", "opportunities", "action_items", "risk_items", "knowledge_items",
  "visit_itineraries", "sales_decision_analyses", "solution_drafts", "weekly_reports",
];

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function apply(db) {
  for (const table of ADD_OWNER_TABLES) {
    addColumnIfMissing(db, table, "owner", `TEXT NOT NULL DEFAULT '${OWNER}'`);
  }
  // 0029 之后、本迁移之前（v0.9.1 窗口）Web 仍可经 body 写任意 owner（customerCreate/
  // opportunityCreate schema 含 owner、weeklyDraft/solutionDraft owner 自由传入）。
  // 以 users.account 为词表把非法值归一；users 表由 0030 保证先于本迁移存在，
  // 直连旧库单测时回退为仅清 NULL。
  const hasUsers = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).get();
  for (const table of SWEEP_TABLES) {
    db.prepare(hasUsers
      ? `UPDATE ${table} SET owner = '${OWNER}' WHERE owner IS NULL OR owner NOT IN (SELECT account FROM users)`
      : `UPDATE ${table} SET owner = '${OWNER}' WHERE owner IS NULL`).run();
  }
  for (const table of GUARD_TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_owner_required_insert
      BEFORE INSERT ON ${table} WHEN NEW.owner IS NULL
      BEGIN SELECT RAISE(ABORT, '${table}.owner must not be NULL'); END;
      CREATE TRIGGER IF NOT EXISTS trg_${table}_owner_required_update
      BEFORE UPDATE OF owner ON ${table} WHEN NEW.owner IS NULL
      BEGIN SELECT RAISE(ABORT, '${table}.owner must not be NULL'); END;
    `);
  }
  for (const table of INDEX_TABLES) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner)`);
  }
}
```

（quick_records 已有 `idx_quick_records_owner_week`（0012），不重复建单列索引。）

### 1.3 挂载与 `backend/tests/migrations.test.js` 基线（在 v0.9.1 的 30 项账本之上）

1. `db/migrate.js`：import + migrations 数组尾部 `{ version: "0031", type: "module", apply }`。
2. 主用例 `firstMigrations.length` 29 → **30**；追加 `firstMigrations[29].version === "0031"`（[28] 为 0030）。
3. 「reconciles the former settings migration 0019」计数 29 → **30**；「upgrades all legacy business data」与「rolls back every 0002」版本数组追加 `"0031"`；「adopts legacy baseline tables」计数 29 → **30**。
4. 新用例「migration 0031 tightens owner isolation」（直接 `import { apply }`，0030 先例）：(a) 预置 users(jiangjz+testb) 与各表混合行 → apply → ✗五表出现 owner 列且存量='jiangjz'；SWEEP 六表中 NULL/'王五' 归一 jiangjz、'testb' 行**保留**；(b) 无 users 表的库 → 仅 NULL 归一；(c) 触发器断言：四表 `INSERT ... (owner) VALUES (NULL)` 与 `UPDATE ... SET owner = NULL` 均 `assert.throws(/owner must not be NULL/)`，带 owner 写入成功；(d) 二次 apply 幂等（列/触发器/索引不重复、UPDATE 零变更）；(e) 九枚 `idx_*_owner` 存在。

### 1.4 彩排与对账（/dev/shm 纪律照旧）

- 彩排前后各跑一份**owner 分布对账单**：11 张表 `SELECT owner, COUNT(*) GROUP BY owner`＋四表触发器/九索引存在性＋`PRAGMA foreign_key_check` 为空。预期：全部行 owner='jiangjz'（或 v0.9.1 后建的真实账号），无 NULL、无词表外值。
- 彩排为 env-less 全链 `src/db.js --migrate`：0031 无 env 依赖，一遍即可（0030 的带 env 种子彩排纪律不受影响）；`schema_migrations` 应为 30 行。
- 生产切换前 `VACUUM INTO` 手动备份；对账单数字写进 release 文档。

## 2. 端点隔离矩阵（核心交付，17 域全量；"账号过滤"= `WHERE owner = request.authContext.account`）

图例——现状：`✔`已按 account 过滤｜`✘`无过滤｜`◐`仅机器分支过滤｜`G`全局域｜`M`机器专属。目标：`过滤`=账号硬过滤｜`404`=跨账号 404 防枚举（owner 谓词进 before 读取，先于乐观锁）｜`保持`=零改动。

### 2.1 健康/鉴权/设置/用户管理（无业务数据，全部保持）

GET health（匿名）、POST auth/login、GET auth/session、POST auth/logout、GET settings/security、PUT|POST|DELETE settings/deepseek-key(+别名)、PUT|POST|DELETE settings/pushplus-token(+别名)、POST settings/pushplus/test（后四组 v0.9.1 已 admin 门禁）、GET|POST admin/users、PATCH admin/users/:account、POST auth/change-password——**保持**。

### 2.2 总览/审计/晨报

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET dashboard/summary | ✘（五张全量查询+todayFocus+weeklyTrend） | 过滤 | `dashboardSummaryFromDb(db,{owner})`：customers/opportunities/actions/risks/quick_records 五查询加 owner；`dashboardTodayFocus` 行程改 `owner=$owner`、待办查询加 owner；`dashboardWeeklyTrend` 三计数器加 owner；招标段保持全局（外部情报） |
| GET audit-logs | ✔（`listAuditLogs` 已 `actor=$account OR metadata.owner=$account`） | 保持 | scope=bookkeeping 前缀白名单不动；**取舍**：多账号下语义自然成立（各看各的 actor 轨迹），admin 全局审计面本版不做、记 v0.9.3+ 遗留项 |
| GET digest/status | 调度器状态，无业务行 | 保持 | — |
| POST digest/run | ✘（dryRun 用 `shortcutBookkeepingAssistantRuntime.owner` 构建并**回显消息全文**→B 可读 jiangjz 晨报=泄露） | admin 门禁+过滤 | 加 `requireAdminRole`（运维端点归位）；dryRun 的 digestOwner 改 `authContext.account`；非 dryRun `runManual` 语义不变（v0.9.3 再多播） |
| GET actions/reminders/status | ✘（pendingCount 全库计数） | 过滤 | pendingCount SQL 加 owner；`actionReminderScheduler.status()`（纯运行时态）保持 |
| POST bookkeeping/client-events | ✔（metadata.owner=account） | 保持 | — |

### 2.3 客户域（`customers/customerStore.js` + server.js handler）

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET customers | ◐（机器分支 `owner=$owner`，Web 分支全量） | 过滤 | 两分支 SQL 合一为 owner 过滤；**机器路径行为不变**（weixin-agent 传自身 account，SQL 等价） |
| POST customers | ✘（`createCustomer` 落 `body.owner ?? null`） | 强制注入 | handler 传 `{...body, owner: authContext.account}`；schema 收口见 §3 |
| GET customers/:id | ✘（按 id 直查） | 404 | SELECT 加 owner 谓词 |
| PATCH customers/:id | ✘（before 读取与 `updateCustomer` 均无 owner） | 404（先于 409） | before 读取加 owner；`updateCustomer` 增 owner 参数（`getActiveCustomer(db,id,{owner})` + UPDATE WHERE 加 owner）；owner 从 patch 词表移除（§3） |
| DELETE customers/:id | ✘（`softDeleteCustomer` 无 owner） | 404（先于 409） | `softDeleteCustomer` 增 owner 参数（beforeRow 与 UPDATE 谓词） |

`customerStore` 签名变化后微信侧调用点（runtimeHandlers `customer.update`/`customer.delete`）同步传 `businessOwner`——**顺手封死微信侧理论上的跨 owner 写洞**（现仅校验绑定非空、未校验目标行归属）。

### 2.4 商机域（`opportunities/opportunityStore.js`）

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET opportunities | ✘（JOIN customers 全量） | 过滤 | WHERE 加 `opportunities.owner=$owner`（新写入恒有商机 owner=客户 owner 不变式，legacy 全 jiangjz） |
| POST opportunities | ✘（body.owner 直落；`requireActiveCustomer` 不校归属） | 强制注入 | owner:=account；`requireActiveCustomer(db,id,owner)` 传 account（跨账号客户→422 validationFailure，语义与"不存在"同响应，防枚举） |
| GET opportunities/:id | ✘ | 404 | `activeOpportunityEntityRow(db,id,owner)` **已支持第三参**（机器路径在用），Web 传 account 即可 |
| PATCH opportunities/:id | ✘ | 404（先于 409） | before 读取传 owner；`updateOpportunity` 增 owner 参数；patch 词表删 owner |
| DELETE opportunities/:id | ✘（`softDeleteRecord` 通用） | 404（先于 409） | `softDeleteRecord` 增可选 `owner`（beforeRow SELECT 加谓词），四域共用 |
| POST opportunities/:id/diagnose-risks | ✘（商机+客户直查，`upsertRiskItem` 无 owner） | 404 | 两次读取加 owner；`buildOpportunityRiskDrafts` 产出的 draft 落 `owner: account` |

### 2.5 行动/风险域

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET actions | ✘ | 过滤 | 列表 SQL 加 owner |
| PATCH actions/:id | ✘ | 404（先于 409） | before 读取加 owner；`updateActionItem` current 读取加 owner |
| DELETE actions/:id | ✘ | 404（先于 409） | `softDeleteRecord` owner 参数 |
| GET risks | ✘ | 过滤 | 列表 SQL 加 owner（0031 后 risk_items 有 owner 列，弃用派生） |
| PATCH risks/:id、DELETE risks/:id | ✘ | 404（先于 409） | 同 actions 模式；`updateRiskItem` current 读取加 owner |

深写回链（quick-record confirm → `upsertActionFromQuickRecord`/`upsertRiskFromQuickRecord`）：action 已继承 `quickRecord.owner`；risk 的 `upsertRiskItem` INSERT/UPDATE 补 `owner: quickRecord.owner`；`getDraftActions`（方案生成用）加 owner 参数。

### 2.6 知识域（D1 裁定隔离，本版从"全局"翻转为"个人"）

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET knowledge | ✘ | 过滤 | 列表 SQL 加 owner |
| POST knowledge | ✘（表原无 owner 列） | 强制注入 | `createKnowledgeItem` INSERT 增 owner 列，值=account |
| PATCH / DELETE knowledge/:id | ✘ | 404（先于 409） | `updateKnowledgeItem` current 读取加 owner；`softDeleteRecord` owner 参数 |
| POST knowledge/search | ✘ | 过滤 | `searchKnowledgeItems(db,{owner,...})` SQL 加 owner |

**知识注入面同版收口**（漏一处=B 的分析里出现 A 的知识）：`searchKnowledgeForAnalysis`（快速记录 preview/analyze 两处调用）、`getKnowledgeItemsByIds`（周报/方案引用校验）、方案 draft 的 `autoKnowledge` 检索、businessSnapshotAdapter `knowledgeSearch`（微信侧传 `businessOwner`）——五个调用面全部加 owner 参数。

### 2.7 快速记录域（已隔离，验证即可）

GET quick-records、POST quick-records、POST :id/analyze(M)、PATCH :id/analysis、POST :id/confirm——`quickRecordOwnerScope(request.authContext)` 对 user 与 machine 会话一视同仁地注入 `AND owner=$owner`，POST 落 `owner=account`：**现状即达标**，矩阵测试写断言固化。两处收尾：POST quick-records 的 `validateCustomerOpportunityPair` 与 confirm 内 `finalCustomer`/`finalOpportunity` 读取，现仅机器分支传 owner → **改为恒传 `authContext.account`**（机器 account=WEIXIN_AGENT_OWNER，值相同、行为不变）；POST quick-records/preview(M) 无库读，仅知识注入收口（§2.6）。

### 2.8 AI 决策域（`ai/agents/salesDecisionRepository.js`）

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET ai/sales-decisions | ✘（list 仅按业务 id 过滤） | 过滤 | repository `list({owner,...})` SQL 加 owner |
| GET ai/sales-decisions/:id | ✘ | 404 | `get(id,{owner})` |
| POST ai/sales-decisions | ✘（created_by 已落，无 owner；`buildSalesDecisionContext` 三实体直查） | 强制注入+404 | create 落 `owner: account`；context 内 customer/opportunity/quickRecord 读取全部加 owner（查无→notFound） |
| POST ai/suggestions | ✘（表补列后） | 强制注入 | INSERT 增 owner 列=account（无读端点，写入即闭环） |

### 2.9 周报/方案域（#16 收口在此）

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| POST reports/weekly/draft | ◐（机器 OWNER_SCOPE_DENIED 已锁本人；**Web 信任 body.owner**，且 Web 分支源记录查询 `$owner=NULL` 全量聚合） | 强制注入 | `draftOwner := authContext.account`（两种身份统一）；机器 mismatch 403 契约保留；源记录查询恒带 owner；schema 见 §3 |
| GET reports/weekly/:id、GET :id/export、PATCH :id、DELETE :id | ✘（按 id 直查） | 404（先于 409） | 四处读取 SQL 加 owner；`updateWeeklyReport`、`softDeleteRecord` 同 §2.5 模式 |
| GET solutions | ✘（`activeSolutionDraftRows` 全量） | 过滤 | SQL 加 `solution_drafts.owner=$owner` |
| POST solutions/draft | ✘（body.owner 直落；客户/商机/知识直查） | 强制注入 | owner:=account；customer/opportunity 读取与 `validateCustomerOpportunityPair` 传 owner；知识面见 §2.6 |
| GET solutions/:id、PATCH solutions/:id | ✘ | 404（先于 409） | `activeSolutionDraftRow(db,id,owner)` 加谓词 |

### 2.10 差旅/发票/收件箱/借款/区域/工作台/记账评审（模板域，已达标——实读确认后全部"保持"）

- **模板模式**（实读 `travelExpense/repository.js`、server.js 各 handler）：handler 取 `owner=request.authContext.account` → repository 每条 SQL 带 owner → before 读取查无即 404（天然先于版本比对）→ actor 同值入审计。
- 覆盖端点（全部 ✔ 保持）：travel-expenses GET|POST|GET:id|PATCH|DELETE|POST :id/attachments|POST/DELETE :id/no-invoice；travel-expense-attachments GET :id/content|DELETE :id；travel-expense-advances GET|POST|PATCH|DELETE（`activeTravelExpenseAdvance(db,id,owner)`）；travel-expense-document-inbox GET|GET :id|GET :id/content|POST :id/confirm|POST :id/reject（user）与 POST（M，owner=机器 account）；invoices GET|POST(M)|GET :id|GET :id/content|DELETE|PATCH :id/review|POST :id/matches；invoice-matches GET|DELETE :id；invoice-match-candidates accept|reject；travel-expense-weeks :week/invoice-suggestions GET|POST、:week/invoice-coverage；no-invoice-confirmations GET；travel-expense-workbench GET；region-profile GET|PUT；integrations/weixin/bookkeeping/review GET|GET :id|confirm|reject|retry。
- **附件 owner 链已闭环**（矩阵测试仍须覆盖）：`getAttachmentContent` 单查询三表贯通 `attachments JOIN expenses e (e.owner=$owner) JOIN document_blobs b (b.owner=e.owner)` + blob 地址 `documentBlobId(owner,sha256)` 复核——间接归属无旁路。

### 2.11 行程域（改造面最干净的一域：repository 增 owner 维度）

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET itineraries | ✘（零过滤） | 过滤 | `itineraryRepository.list({owner,status})` SQL 加 owner |
| POST itineraries | ✘（仅 created_by=actor） | 强制注入 | `create` INSERT 增 owner 列（=actor=account） |
| GET / PATCH / DELETE itineraries/:id | ✘ | 404（先于 409） | `get(id,{owner})`、`update`/`softDelete` 的 UPDATE WHERE 加 owner；`mutationFailure` 前置读取带 owner→查无即 NotFound |

### 2.12 招标域（全局情报域：公告不动，堵"他人客户名"显示面）

| 端点 | 现状 | 目标 | 改动点 |
| --- | --- | --- | --- |
| GET hospital-tenders（列表） | G＋✘（`hospitalTenderCustomerNameMap` 全库客户名注入 matchedCustomers；customerId 筛选不校归属） | 全局保留+显示过滤 | 名映射改 `hospitalTenderCustomerNameMap(db,owner)`；`serializeHospitalTenderNotice` 只渲染 map 命中的匹配客户（他人客户的 match id 不出现）；customerId 参数先校 `owner=account`，不属于→返回空集（200，防枚举且不破 UI） |
| GET hospital-tenders/:id | G＋✘ | 同上 | 详情同用过滤后的名映射 |
| GET summary/sources/health | G | 保持 | 纯情报统计 |
| GET|PATCH scheduler(+/status)、POST scheduler/run(-next)、GET scheduler/runs、POST run | 管理面 | 保持 | v0.9.1 已给写端点 admin 门禁；调度器全库匹配计算面**本版不动**（推送分发=v0.9.3 #13） |
| POST integrations/hospital-tenders/sync、GET …/health | M | 保持 | 机器专属令牌域 |

### 2.13 微信集成与机器域（全部保持）

POST integrations/weixin-agent/events、GET|POST …/confirmation-outbox（M，租约/scope 协议不动）；GET|POST|DELETE integrations/weixin-agent/login（v0.9.1 admin）；POST integrations/ops-alerts、GET …/status（M）；机器白名单 `machineAuthorization.js` 的 `ALLOWED_MACHINE_ROUTES`/`INTEGRATION_ROUTES` **一字不动**（审计A #18）。

## 3. 写路径收口

1. **schema 收口**（`validation/requests.js`，前后端同版发布故可直接删字段）：`customerCreate`/`opportunityCreate` 删 `owner` 键（`partialSchema` 派生的 patch 词表随之收口——Web 从此传 owner 即 422 unknown）；`weeklyDraft.owner`、`solutionDraft.owner` 由 required 降为可选（机器契约 OWNER_SCOPE_DENIED 需要它，Web 忽略其值）。前端配套：`salesWorkbenchApi.js` 的 `WRITABLE_FIELDS.customer/opportunity` 删 "owner"，`generateWeeklyDraft`/`generateSolutionDraft` 停发 owner；客户/商机编辑表单若有"负责人"输入框一并摘除（展示可留只读 owner）。
2. **POST 注入清单**（owner:=authContext.account，忽略/覆盖 body）：customers、opportunities、knowledge、quick-records（已是）、ai/sales-decisions、ai/suggestions、reports/weekly/draft、solutions/draft、itineraries、diagnose-risks 的风险落库。差旅/发票/收件箱域已全部注入（保持）。
3. **store 签名变化**（微信共用，调用点同步）：`updateCustomer`/`softDeleteCustomer`、`updateOpportunity`、`updateActionItem`/`updateRiskItem`/`updateKnowledgeItem`/`updateWeeklyReport`、`softDeleteRecord`（通用 owner 选项）、`itineraryRepository` 五函数、`salesDecisionRepository` 三函数、`searchKnowledgeItems`/`searchKnowledgeForAnalysis`/`getKnowledgeItemsByIds`/`getDraftActions`。runtimeHandlers 内全部调用点传 `businessOwner`（`resolveBusinessOwner` 本身不动）。
4. **seed.js owner 语义**：customers/opportunities 的 `owner: "继振"` 改 `"jiangjz"`；action_items、risk_items 两组 INSERT 增 owner 列='jiangjz'（否则触发器/展示不一致）；knowledge_items INSERT 增 owner='jiangjz'（列有 DEFAULT，显式写更直白）。seed 仅 dev/test 使用，生产不受影响。
5. **快照适配器收紧清单**（0031 全量回填后 NULL 回退分支=死代码，全部删除；对 jiangjz 结果集恒等——所有行 owner 非空）：`businessSnapshotAdapter` 的 `opportunityById`/`opportunitySearch` 的 `(owner IS NULL AND customer.owner=$owner)` 支、`actionRows` 三分支收敛为 `action.owner=$owner`、`riskRows` 派生分支改 `risk.owner=$owner`、dashboard counts 同款、`itinerarySummary` 与 counts 的 `created_by=$owner` 改 `owner=$owner`、**`knowledgeSearch` 加 owner 过滤（本版新增）**；`actionItems/actionItemStore.js` 的 `VISIBILITY_CLAUSE`/`VISIBILITY_JOINS` 收敛为单 owner 谓词；`opportunityStore` 的可见性 OR 支；`dailyDigest/digestContent.js` 的 `unscheduledTodoCountStatement` 三分支与 `itineraryTodayStatement` 的 created_by。收紧完成判据：四文件 `rg "owner IS NULL"` 归零（门禁 §8-5）。

## 4. 隔离矩阵测试（测试先写：先红后绿）

- **fixture**：新文件 `backend/tests/owner-isolation-matrix.test.js` 单矩阵文件（域间共享双账号夹具，断言集中可核销；各域既有测试文件只做适配修复不塞新矩阵）。夹具 `createTwoAccountHarness()`：既有 auth-http harness 起服（env=jiangjz，0030 种子为 admin）→ 直插 users 第二行 `testb`（`hashPassword` 生成）→ 两账号各自 login 取 cookie+csrf → 返回 `asA(request)`/`asB(request)`。
- **通用断言器** `expectOwnerIsolated({createAsA, listPath, detailPath, patch, del})`：A 建行 → ①A list 含/ B list 不含；②B GET 详情 404；③B PATCH（携**正确 expectedVersion**）404——证明 owner 判定先于乐观锁、无 409/currentVersion 泄露；④B DELETE 404；⑤B 用错误 version PATCH 仍 404（同响应不可区分）。
- **逐域清单与断言预估（合计 ≈96 ≥ 目标 80）**：客户 10（含 POST body.owner 被忽略、PATCH 传 owner 422）；商机 10（含 B 引用 A 客户建商机 422）；行动 8；风险 8；知识 10（含 search 不见 A 词条、B 分析预览不注入 A 知识）；快速记录 6（固化既有隔离+confirm 目标校验）；AI 决策 8（list/get/POST 引用 A 实体 404）；ai/suggestions 2（owner 落库）；周报 8（draft 聚合只含本人记录、:id 四端点 404、body.owner 忽略）；方案 8；行程 10；dashboard/summary 6（B 全零、A 计数不变）；招标 4（B 看得到公告、matchedCustomers 不含 A 客户名、customerId=A 客户→空集）；digest 2（member 403、admin dryRun 空报）；reminders/status 2（B pendingCount=0）；审计 2（B 看不到 A 的 actor 行）；机器回归 4（weixin 令牌 GET customers/POST quick-records 照旧 owner=jiangjz）。
- **迁移测试**：§1.3 的 0031 用例（≈14 断言，独立计）。
- **浏览器级验证两条**（生产验收走查，§7 脚本内）：①testb 登录首页——总览指标全 0、八张列表空态文案正常、无报错 toast；②jiangjz 登录——bootstrap 八集合计数与升级前对账单一致，任一详情页可开。

## 5. 前端配合面（改动趋零的论证）

- **bootstrap 八集合天然随会话过滤**：`salesWorkbenchApi.loadBootstrap` 并发拉 customers/opportunities/actions/risks/knowledge/quick-records/solutions/itineraries + dashboard/summary——全部是本设计已收口的 GET 端点，cookie 会话即账号，**前端零改动**即获得隔离视图。
- 需要动的仅 §3-1 的四处 owner 字段摘除（api 层 WRITABLE_FIELDS/两个 draft 方法 + 表单输入框）。
- **空态走查清单**（testb 视角，浏览器级）：总览（指标 0/空 rhythm 不崩）、客户/商机/待办/风险/知识/快速记录/方案/行程八列表空态、差旅工作台空周、发票与收件箱空、周报 tab 生成空草稿不报错、招标页**有**全局公告（预期非空）、审计日志空。既有页面对空数组均有兜底渲染，走查目的是确认文案是"暂无数据"而非报错态。
- **member/admin 业务面无 UI 差异**：v0.9.1 仅按 role 过滤设置子导航；业务页面不读 role——确认不变，release 文档明示"admin 同样只见自己的业务数据"。

## 6. 微信侧一致性（回归红线清单，本版微信仍单 owner=jiangjz）

1. 入口链不动：`machineAuthorization` 白名单、events 的 conversationScope/financialScope 判定、`resolveBusinessOwner` 闭合映射、`shortcutBookkeepingRuntime.conversationFor`、outbox 租约协议——零 diff。
2. 行为不变论证：微信读写全部经 `resolveBusinessOwner(context.owner)`='jiangjz'；0029+0031 后全部存量行 owner='jiangjz'，§3-5 的分支收紧对 jiangjz 结果集恒等；store 签名新增的 owner 参数微信侧传同一值。
3. 红线测试（既有全绿即证）：weixin 相关既有集成测试一项不减一项不改语义（客户建档/改/删、商机全链、待办 store、拜访记录、记账确认、晨报 digestContent、招标推送、outbox scope 矩阵）；快照适配器测试中含 NULL-owner fixture 的用例**更新 fixture 而非放宽断言**，并在 release 文档列明每一处更新理由。
4. 生产回归三条（验收脚本内）：微信问"客户列表"回卡片照旧；记一条待办并完成；`POST digest/run?dryRun=1`（admin）渲染含 jiangjz 数据。

## 7. 部署与回滚

- **部署序**：确认生产 schema_migrations 含 0030 → 打包 → /dev/shm 彩排（§1.4 对账单前后对照）→ `VACUUM INTO` 手动备份 → 标准四关（0031 随 cutover 后首启原子应用）→ 验收脚本。
- **回滚=回代码不回数据，无害论证**：①✗五表新列带 `DEFAULT 'jiangjz'`——旧代码（v0.9.1）INSERT 省略该列时由 DEFAULT 兜底，**不会违反 NOT NULL**，且落 jiangjz 与回滚后的"无隔离单池"语义一致；②◇四表触发器——旧代码唯一可能写 NULL owner 的路径是 Web POST customers/opportunities 表单不带 owner（quick_records/action_items 写路径恒有 owner），命中即 500；回滚 runbook 附成对手工 SQL：`DROP TRIGGER trg_<t>_owner_required_insert/_update`（×8）与对应 CREATE 原文——**注意 0031 已入账本，前滚不会自动重建，DROP 后必须手工执行配对 CREATE**；若回滚窗口短，可用运维口径"暂不新建客户/商机"替代 DROP；③九枚索引与词表清扫对旧代码无害（清扫不可逆但语义=纯数据修复）。
- **生产验收脚本**：①升级前记录 jiangjz bootstrap 八集合计数（对账基线）；②升级后 jiangjz 登录全量可见照旧（计数一致、抽开客户/商机/行程详情）；③admin 建测试账号 `testiso`（member）→ 登录走 §5 空态清单，招标页可见全局公告；④testiso 建一条测试客户 → jiangjz 列表**不可见**（admin 无特权，双向隔离）；⑤互探 404：jiangjz 会话持 testiso 客户 id、testiso 会话持 jiangjz 客户/商机/行程/周报 id，GET/PATCH/DELETE 全 404 且无 currentVersion 字段；⑥§6-4 微信三条；⑦只读查库：audit_logs 两账号 actor 各自成轨；⑧testiso 删除自己的测试客户 → admin 停用 testiso；⑨journal 无触发器 ABORT 报错。证据（截图+SQL 输出）回填 release 文档。

## 8. v0.9.2 门禁清单与验收标准

1. **测试先写**：`owner-isolation-matrix.test.js` 先于实施提交并红（现状越权即失败），实施后全绿；断言 ≥80（§4 清单 ≈96）。
2. 迁移账本：migrations.test.js 基线=30 全绿；/dev/shm 彩排 owner 分布对账单前后一致归档。
3. 零回归：后端全量（v0.9.1 基线 ≥1276+新增）与前端 `qa:local` 全绿；weixin/adapter 既有测试语义零放宽（fixture 更新逐条说明）；`npm run qa:full` + `project-secret-scan` findings=[]。
4. 契约红线自查：跨账号一律 404（禁 403/409 泄露 currentVersion）；全部 POST 忽略 body owner；机器白名单与 outbox 协议零 diff。
5. 收紧完成判据：`rg "owner IS NULL" backend/src/assistant/businessSnapshotAdapter.js backend/src/actionItems/actionItemStore.js backend/src/opportunities/opportunityStore.js backend/src/dailyDigest/digestContent.js` 归零。
6. 端点矩阵逐行核销：release 文档回填 §2 每行的实施状态（改动 commit/测试引用），"保持"行注明复核人。
7. 四关部署全绿 + §7 验收脚本 ①–⑨ 全过；release 文档写明回滚触发器注意事项与 admin 无特权语义。

**验收标准（战役口径）**：两真实账号 Web 各自登录只见各自数据；互探全 404；jiangjz 微信链路与升级前行为完全一致；招标公告双账号可见但匹配客户名各归各。
