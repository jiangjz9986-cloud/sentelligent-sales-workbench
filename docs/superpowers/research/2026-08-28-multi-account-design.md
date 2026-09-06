# 多账号架构设计草案（v0.9 候选）

日期：2026-08-28 · 作者：主会话（基于源码实读，非推测） · 状态：草案 v2，已与审计A（`2026-08-28-audit-architecture-backend.md` §4/§9-1）对齐，待总方案定稿

## 0. 结论先行

系统的**内核早已按账号建模**，单账号只是"入口薄壳"上的三处闭包约束。改造不需要动核心业务逻辑，按"数据先行"分四层推进，每层可独立上线（审计A核出 18 项假设点，合计估 12–18 人日）：

| 层 | 现状约束 | 改造 | 风险 |
| --- | --- | --- | --- |
| L0 数据清洗（先行） | 生产 owner 已碎片化：jiangjz/继振/legacy/??/NULL 混存（审计A §4 实测）；audit actor 7 种混杂值 | 定规范词表=账号 id，逐表回填迁移（彩排+备份），不改任何行为 | 中（纯迁移） |
| L1 认证层 | 凭据来自 env（`AUTH_ACCOUNT`+`AUTH_PASSWORD_HASH`），`configuredCredentialsMatch` 只比对这一对 | `users` 表 + DB 校验 + 管理页 | 低 |
| L2 数据层+Web 隔离 | 大部分表已有 `owner` 列且写路径已传 `actor`；少数表缺 owner；**Web 端读写完全不做 owner 过滤（上帝视角，审计A #10，最大改造面）** | 补列+NOT NULL 化+Web 读写全面按 `authContext.account` 过滤（差旅域是现成模板），同版收口 | 高（漏一处=越权） |
| L3 微信绑定层 | 单 `senderId→owner` 闭包（config 注入 runtime），生产还有 `WEIXIN_BOOKKEEPING_OWNER === WEIXIN_AGENT_OWNER` 硬校验 | `weixin_bindings` 表 + 入口解析 + worker 按 deliveryScope 多目标投递 | 高（投错人=越权泄露） |

## 1. 现状证据（源码实读）

### 1.1 会话与审计已按账号建模（无需改）
- `auth_sessions` 表含 `account` 列；`createSession({account})`、`getActiveSession` 返回 `account`（`backend/src/auth/session.js:22-72`）。
- 全部写路径已传 `actor: request.authContext.account`（server.js 数十处）。
- 登录限流器 key 已含账号维度：`loginRateLimitKey(secret, account, address)`（server.js:2272-2277）。

### 1.2 单账号约束的确切位置
1. `configuredCredentialsMatch`（server.js:2289-2295）：`account === config.authAccount && passwordMatches`——唯一凭据源是 env。
2. `authenticateLogin`（server.js:2269-2287）：命中后 `createSession({account: config.authAccount})`。
3. 生产校验（config.js:173-205）：强制 `AUTH_ACCOUNT`、`WEIXIN_AGENT_OWNER` 存在，且 `WEIXIN_BOOKKEEPING_OWNER === WEIXIN_AGENT_OWNER`。
4. `shortcutBookkeepingRuntime.conversationFor(account, requestedSender)`（shortcutBookkeepingRuntime.js:552-556）：闭包持有唯一 `senderId`，不匹配即 403。
5. 调度器（晨报/待办提醒/招标推送）目标会话解析自单一 owner。

### 1.3 owner 列现状（schema.sql 基表；迁移表待审计A全量清点）
- 已有 owner：`customers`、`opportunities`、`quick_records`、`weekly_reports`(NOT NULL)、`solution_drafts`(NOT NULL)、`action_items`（另有 `assignee`）。
- 缺 owner：`risk_items`（只有 assignee）、`knowledge_items`、`ai_insights`、`manual_confirmations`、`ai_suggestions`。
- 记账/差旅/行程域：`shortcut_bookkeeping_*`、outbox、pending_actions 均已带 owner（微信链路数据面天然多账号就绪）；`itineraries`/`travel_expenses`/`invoices` 待清点。

## 2. 目标模型（推荐，含一个待用户拍板的决策点）

### 2.1 可见性模型 —— 决策点 D1【已裁定 2026-08-28】
**裁定：同事使用，完全隔离模式（每账号一座孤岛）**
- 全部用户数据按 owner 硬隔离：客户/商机/风险/待办/快速记录/周报/知识 + 记账/差旅/行程/晨报，互不可见；无"只看我的/全部"开关（比 Team 模式实现更简单）。
- 例外仅一处：招标公告为**全局数据**（外部公开情报，非用户数据），但匹配结果与推送按各自客户的 owner 分发。
- admin 角色仅管理用户（建号/停用/重置密码/微信绑定管理），**不可见他人业务数据**；审计日志按需要保留全局可查（admin 运维用途）。

### 2.2 角色模型（最小可用）
- `admin`：用户管理（建号/停用/重置密码）、微信绑定管理、系统配置。
- `member`：全部业务功能，改不了他人个人域数据。
- 首个 admin：迁移时把现 env 账号（继振）种子为 admin。

## 3. 分层实施

### L0 数据清洗（独立先行发布，审计A建议的"阶段0"）
1. 定 owner 规范词表 = 账号 id（`jiangjz`）；display_name（继振）只存 users 表，业务表一律存账号 id。
2. 迁移逐表回填：`继振/legacy/??/NULL → jiangjz`（customers/opportunities/action_items/quick_records/weekly_reports/solution_drafts，按审计A §4 实测分布），audit actor 词汇统一为 `账号id | weixin-agent | system:* | deploy`（历史行不动，只定新规范）。
3. 彩排纪律照旧（/dev/shm 隔离副本 + SHA 对账 + VACUUM INTO 手动备份），不改任何行为，纯数据版本。
4. 附带修复：`upsertActionFromQuickRecord` 深写回 assignee 硬编码"继振"（server.js:1936）改取 users.display_name。

### L1 认证层（v0.9.x）
1. 迁移 0029：`users(account PK, display_name, password_hash, role, status, created_at, updated_at, last_login_at)`；种子行取自现 env（hash 直接搬 `AUTH_PASSWORD_HASH`，算法不变）。
2. `authenticateLogin` 改查 `users`（status='active'），密码校验复用 `verifyPassword`；限流/恒时比较保持。env 凭据仅作 `users` 表为空时的 bootstrap 回退（含告警日志），两个版本后移除。
3. 新端点（admin）：`GET/POST /api/admin/users`、`PATCH /api/admin/users/:account`（改姓名/角色/状态/重置密码）。改自己密码：`POST /api/auth/change-password`（需旧密码）。
4. 前端：登录页不变；设置区新增"用户管理"页（admin 可见）；顶栏显示 display_name。
5. 审计：`user.create/update/disable/password.reset/password.change` 全量入 audit_logs。
6. 兼容性：现有 session 不失效（account 值不变）；机器 token（微信 worker/招标）不受影响。

### L2 数据层 + Web 隔离（同版收口，v0.9.x）
1. 迁移 0030：◇可空表 owner NOT NULL 化并引用 users；✗缺失表逐一决策——`risk_items`/`visit_itineraries`/`sales_decision_analyses` 补 owner，`knowledge_items` 与招标全域定为**全局域**（团队共享情报，免改）。
2. 写路径：owner 一律取 `request.authContext.account`（含周报 body.owner 自由传入的收口，审计A #16）。
3. **Web 读路径全面隔离（审计A #10，最大改造面）**：全部列表/详情端点按 account 过滤，差旅域（`request.authContext.account`）是现成模板；个人域 repository 强制 `WHERE owner=$account`（actionItemStore 已是范本）；业务域列表加 `?owner=me|all` 参数（Team 模式下 all 为默认）。
4. `businessSnapshotAdapter`：L0 回填后收紧 NULL 回退分支（商机回退客户 owner、行动三分支等，审计A #9）。
5. 测试：跨账号隔离矩阵——每个个人域至少 1 条"跨账号不可见/不可改（404 而非 403，防枚举）"集成测试；业务域验证 owner 标记与 `?owner=me` 过滤。

### L3 微信绑定层（v0.9.x）
1. 迁移 0031：`weixin_bindings(sender_id PK, account NOT NULL REFERENCES users, display_name, financial_enabled INTEGER, status, bound_at, bound_by)`；种子行取自现 env sender/owner（`financial_enabled=1` 对应现 BOOKKEEPING 绑定语义）。
2. 绑定流：Web 设置页（admin）生成 6 位绑定码（TTL 10 分钟，一次性）→ 用户微信发"绑定 123456" → 事件入口校验并落表。解绑同理。
3. 入口改造：`/api/integrations/weixin-agent/events` 收到 senderId → 查绑定表得 account，未绑定回"请先绑定"卡片；`businessOwnerResolver` 改查表但**闭合语义必须保留**（查无绑定→null 拒答，不回退全量，审计A #5）；`shortcutBookkeepingRuntime` 的闭包 senderId/owner 改为按事件解析（runtime 函数已全部收 `account` 参数，改动集中在装配处与 `conversationFor` 校验）；financialScope 改查绑定行的 `financial_enabled`。
4. worker 多目标投递：outbox 行已带 owner/conversation/deliveryScope，worker 按 `item.deliveryScope` 路由（SDK `sendMessageTo` 本就支持任意目标，审计A #6）；**保持单机器人多绑定，不上多 worker**（审计A #7）；投错人=越权泄露，需 scope 矩阵测试全覆盖。
5. 调度器多播：晨报/待办提醒/招标推送改为遍历 active bindings，各自的数据范围（L2 已就位）+ 各自的会话投递；幂等键加 owner 维度（`daily-digest:{owner}:{date}`）；招标情报保持全局采集，推送按 match_customer_ids 的客户 owner 分发（审计A #13）。
6. 配置退役：`WEIXIN_BOOKKEEPING_SENDER_ID/OWNER`、`WEIXIN_AGENT_OWNER` 降级为 bootstrap 种子，生产硬校验（config.js:192-204）改为"绑定表非空"运行时检查。
7. 安全：`WEIXIN_ALLOWED_SENDER_IDS` 白名单保留为第一道闸（防未知 sender 打接口），绑定表是第二道；机器令牌与路由白名单不动（审计A #18）。

## 4. 迁移与回滚
- 四层各自独立发版（L0→L1→L2→L3 严格串行，版本号随总方案定），沿用既有不可变 release + 自动回滚流水线。
- L1 上线后先双轨一周（DB 校验为主、env 回退兜底），确认无锁死风险再关回退。
- 数据回填迁移写成幂等（`UPDATE … WHERE owner IS NULL` / 值白名单替换），回滚只回滚代码不回滚数据（owner 列多出无害）。
- 每层上线前照例 `VACUUM INTO` 手动备份一份；L0/L2 迁移版必须走 /dev/shm 彩排。

## 5. 工作量预估（净新增，含测试；与审计A 12–18 人日总估对齐）
| 层 | 后端 | 前端 | 测试 | 预估 |
| --- | --- | --- | --- | --- |
| L0 | 清洗迁移+彩排 | — | 迁移对账 | 0.5 个版本周期 |
| L1 | users 表+登录改造+admin API | 用户管理页+改密页 | 单元+集成+浏览器 | 1 个版本周期 |
| L2 | 迁移+repo scope 全检+**Web 读写全过滤** | 列表"只看我的"开关 | 跨账号隔离矩阵 | 1.5 个版本周期（最大面） |
| L3 | 绑定表+入口解析+worker 多目标+调度器多播 | 绑定管理页 | 绑定流+scope 矩阵+多播集成 | 1 个版本周期（最需小心） |

## 6. 开放问题（进总方案决策点清单）
- D1 可见性模型（§2.1，推荐 Team 模式）。
- D2 新用户的微信接入需要新 sender 加入 `WEIXIN_ALLOWED_SENDER_IDS`（env，需重启）——是否顺手把白名单也搬进 DB（推荐搬，随 L3）。
- D3 多账号后晨报/周五收尾是否人人默认开，还是按账号订阅（推荐订阅制，绑定时默认开）。
