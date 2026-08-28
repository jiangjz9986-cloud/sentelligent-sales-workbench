# v0.9.0 地基包 · 实施级设计（告警面 / L0 清洗 / 审计C小修 / 运维收口）

日期：2026-08-28 深夜 · 作者：预研泳道 B · 状态：**已实施（v0.9.0，2026-08-29 冻结；发布记录见 `docs/releases/v0.9.0.md`，偏差见其「关键裁定与设计偏差」节）**
基线：工作树 HEAD `2140205`（v0.8.4 冻结提交，v0.8.4 正在部署，v0.9.0 在其之上实施）；生产核对时点 2026-08-28 23:52（SSH 只读实测）。
锚点纪律：本文以**文件名+函数名**为稳定锚点，不引用行号（v0.8.4 并行实施行号漂移）。
范围依据：总蓝图 `2026-08-28-grand-plan-v09-v10.md` §4 v0.9.0 行；审计A §5/§6、审计C 修复建议、多账号设计 L0、健康清册 §6。

---

## 1. 块1 · 告警面（备份/调度器/worker/服务失败 5 分钟内推送小小）

### 1.1 链路总图

```
systemd 单元失败 ──OnFailure──▶ sentelligent-ops-alert@%n ──▶ tools/ops-alert.sh
5分钟巡检 timer ──▶ tools/ops-inspect.sh（四项检查）──┘        │
        │  backend 存活时：POST /api/integrations/ops-alerts（Bearer OPS_ALERT_TOKEN）
        │      → weixin_confirmation_outbox(kind=ops_alert, 小时级幂等) → worker → 小小微信卡片
        │      → 微信投递未就绪时端点内叠加 PushPlus 兜底
        └─ backend 失败/端点不可达时：脚本直接 PushPlus HTTP（读 env HOSPITAL_TENDER_PUSHPLUS_TOKEN，已实测在位）
```

### 1.2 告警入口端点契约（新集成 ops-monitor）

**`POST /api/integrations/ops-alerts`**（机器令牌，仿 `hospital-tender-monitor` 白名单模式）
- 鉴权：`Authorization: Bearer <OPS_ALERT_TOKEN>`；`auth/machineAuthorization.js` 的 `configuredMachineCredentials` 增加 `{ token: config.opsAlertToken, integration: "ops-monitor", owner: config.authAccount }`；`INTEGRATION_ROUTES["ops-monitor"] = Set(["POST /api/integrations/ops-alerts", "GET /api/integrations/ops-alerts/status"])`，同步加入 `ALLOWED_MACHINE_ROUTES`。其他集成 token 打此路由必须 403 `MACHINE_SCOPE_DENIED`。
- 入参（JSON，未知字段 422）：`source`（必填，`/^[A-Za-z0-9:._@-]{1,100}$/`，如 `systemd:sentelligent-backend.service`、`ops-inspect:backup-freshness`）、`severity`（必填，`critical|warning`）、`summary`（必填 ≤300 字）、`detail`（可选 ≤2000 字）、`occurredAt`（可选 ISO）。
- 行为：小时键 `hourKey = ISO 时刻截到小时（UTC）`；outbox 幂等键 `ops-alert:{source}:{hourKey}` ——**同源同小时只入队一条，即风暴去重**；enqueue 到 `weixin_confirmation_outbox`（owner/conversation 取 `shortcutBookkeepingAssistantRuntime.owner / conversationFor(owner)`，与招标推送同源）。若 `weixinTenderDeliveryReady()` 为假（复用 server.js 既有函数），同请求内再直发一次 PushPlus（新 `createOpsAlertPushplusNotifier`，逐字复用 `hospitalTender/notifier.js` 的 HTTPS 校验/超时/响应限长/`onSuccess|onFailure` 模式，token 经 `resolvePushplusToken()` 即 secure_settings 优先、env 兜底）。两通道皆不可用→ 503 `OPS_ALERT_DELIVERY_UNAVAILABLE`（调用方 shell 转本地 PushPlus 兜底）。审计：`insertAudit(action: "ops_alert.receive", metadata: { severity, delivery, replayed })`（actor=机器身份）。
- **payload 键名红线**：`outboxRepository.inspectPayload` 拒绝含 `source/owner/account/actor/token…` 子串的键。ops_alert 载荷定为 `{ kind: "ops_alert", origin, severity, summary, detail, occurredAt }`——`source` 入参落库时改名 `origin`，实施勿回退。
- 响应：200 `{ item: { id, status, replayed, pushplusFallback } }`；重复小时键返回 `replayed: true`（200，不报错）。

**`GET /api/integrations/ops-alerts/status`**（同 token，巡检专用只读聚合）
- 返回 `{ item: { generatedAt, outbox: { queued, processing, sent, failed, oldestQueuedAt }, weixinDelivery: weixinDeliveryReadiness.snapshot(), schedulers: { hospitalTender: getState() 摘要(enabled/lastStatus/lastError/lastFinishedAt/nextRunAt), actionReminders: reminderScheduler.status(), dailyDigest: digestScheduler.status() } } }`。
- **取舍（任务书问点）**：会话鉴权的 `GET /api/actions/reminders/status` 巡检脚本拿不到会话；只读 sqlite 能查招标 `hospital_tender_scheduler_state.last_error`，但**提醒/晨报调度器的 lastError 仅在进程内存**（`reminderScheduler.js`/`digestScheduler.js` 的 `state` 对象），sqlite 不可见。故裁定：**新增机器可达聚合 status 端点**——一次探测同时覆盖 backend 存活、三调度器 lastError、outbox 积压、worker 心跳（`weixinDeliveryReadiness.snapshot()` 自带 30 秒陈旧窗，worker 每次轮询 GET outbox 都会 `report()`，无需新增心跳埋点）；只读 sqlite 保留为 backend 宕机时的人工诊断手段，不进巡检主路径。
- 需在 `weixin/outboxRepository.js` 增只读 `statusCounts()`（按 status 计数 + 最老 queued 的 available_at）。

### 1.3 微信卡片渲染

新文件 `backend/src/ops/opsAlertMessage.js` 导出 `renderOpsAlertMessage(payload)`（校验 kind、fail-closed），`assistant/shortcutBookkeepingRuntime.js` 的 `renderOutboxMessage` 在 `daily_digest`/`friday_closeout` 分支旁新增 `if (payload.kind === "ops_alert")` 分支。文案（`weixinCard` 三段式）：

```
【小小运维告警】
级别：严重（或：警告）
来源：systemd:sentelligent-backend.service
时间：2026-08-29 01:05（occurredAt 或入队时间，+08:00 展示）
摘要：sentelligent-backend.service 进入 failed 状态
详情：<weixinClip(detail, 300)>

同一来源一小时内只提醒一次；处理后无需回复。排查：journalctl -u <单元名>
```

### 1.4 代码文件清单（块1）

| 文件 | 动作 |
|---|---|
| `backend/src/ops/opsAlertService.js` | 新增：入参校验、小时键、enqueue+PushPlus 兜底、审计 |
| `backend/src/ops/opsAlertMessage.js` | 新增：渲染器 |
| `backend/src/config.js` | 新增 `opsAlertToken`（`OPS_ALERT_TOKEN`，可选）；生产校验：若配置必须过 `isStrongIndependentSecret` 并加入秘密两两独立集合（`validateProductionConfig` 的 Set 计数随之 +1） |
| `backend/src/auth/machineAuthorization.js` | ops-monitor 凭据与两条路由白名单 |
| `backend/src/server.js` | 机器路由段（`hospital-tenders/sync` 分支之后、`isAuthMisconfigured` 之前）挂两个新路由；装配 opsAlertService（注入 outboxRepository、runtime、resolvePushplusToken、weixinDeliveryReadiness、三调度器引用） |
| `backend/src/weixin/outboxRepository.js` | 新增 `statusCounts()` |
| `backend/src/assistant/shortcutBookkeepingRuntime.js` | `renderOutboxMessage` 加 ops_alert 分支 |
| `scripts/deploy/sentelligent-ops-alert@.service` `sentelligent-ops-inspect.service` `sentelligent-ops-inspect.timer` `ops-alert.sh` `ops-inspect.sh` | 新增（入仓即事实来源，安装到服务器 `/opt/.../tools` 与 `/etc/systemd/system`） |

### 1.5 systemd 单元（全文）与四主单元接线

`scripts/deploy/sentelligent-ops-alert@.service`（模板单元，%I=失败单元名；**无 [Install]，仅由 OnFailure 拉起**）：

```ini
[Unit]
Description=Sentelligent ops failure alert for %I

[Service]
Type=oneshot
User=root
UMask=0077
TimeoutStartSec=60
SyslogIdentifier=sentelligent-ops-alert
ExecStart=/usr/bin/env bash /opt/sentelligent-sales-workbench/tools/ops-alert.sh %I
```

四个主单元 patch（`sentelligent-backend/frontend/weixin-agent/daily-backup`，实测全文见服务器 `/etc/systemd/system/`，均无 OnFailure）：
- `[Unit]` 段各加一行：`OnFailure=sentelligent-ops-alert@%n.service`。
- 三个常驻单元（backend/frontend/weixin-agent）`[Service]` 段加 `StartLimitInterval=300` 与 `StartLimitBurst=5`（systemd 219 写法）。**理由**：现有 `Restart=on-failure` + `RestartSec=3/10` 下崩溃循环永远到不了 failed 态、OnFailure 永不触发；加限流后「300 秒内失败 5 次→进入 failed→告警」。语义变化：疯狂崩溃 5 次后停止自动重启，需人工 `systemctl reset-failed && systemctl start`——有告警在手这是期望行为；缓慢崩溃循环（间隔>60s）仍到不了限流，由 1.7 巡检的端点探测兜底。daily-backup 为 oneshot，失败即 failed，仅加 OnFailure 一行。
- **backend 自身失败悖论**：ops-alert.sh 对 `sentelligent-backend.service` 跳过端点直接走 PushPlus（见 1.6）；其余单元先试端点、curl 失败再退 PushPlus。

### 1.6 `tools/ops-alert.sh` 全文草案

```bash
#!/usr/bin/env bash
# 入参 $1 = 失败单元名（sentelligent-ops-alert@%I 传入）。root 运行，0700。
set -uo pipefail
UNIT="${1:-unknown-unit}"
ENV_FILE="/opt/sentelligent-sales-workbench/config/backend.env"
env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
OPS_BEARER="$(env_value OPS_ALERT_TOKEN)"
PUSH_BEARER="$(env_value HOSPITAL_TENDER_PUSHPLUS_TOKEN)"
DETAIL="$(journalctl -u "$UNIT" -n 20 --no-pager -o cat 2>/dev/null | tail -c 1500)"
SUMMARY="systemd 单元失败：$UNIT"
post_endpoint() {
  [[ -n "$OPS_BEARER" ]] || return 1
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $OPS_BEARER" -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys;print(json.dumps({"source":"systemd:"+sys.argv[1],"severity":"critical","summary":sys.argv[2],"detail":sys.argv[3]}))' "$UNIT" "$SUMMARY" "$DETAIL")" \
    http://127.0.0.1:8897/api/integrations/ops-alerts | grep -qE '^2'
}
post_pushplus() {
  [[ -n "$PUSH_BEARER" ]] || return 1
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys;print(json.dumps({"token":sys.argv[1],"title":"【严重】"+sys.argv[2],"content":sys.argv[3],"template":"txt"}))' "$PUSH_BEARER" "$SUMMARY" "$DETAIL")" \
    https://www.pushplus.plus/send | grep -qE '^2'
}
if [[ "$UNIT" != "sentelligent-backend.service" ]] && post_endpoint; then exit 0; fi
post_pushplus && exit 0
echo "ops-alert delivery failed for $UNIT" >&2; exit 1   # 模板单元无 OnFailure，不会级联
```

注意：JSON 用 python3 组装防注入（CentOS 7 自带 python3？**部署时核验 `command -v python3`，缺失则改用 printf + 手工转义并在 release 文档记录**）；curl 打 127.0.0.1:8897 直连 backend 不经 Caddy。

### 1.7 巡检 timer 与 `tools/ops-inspect.sh` 全文草案

`sentelligent-ops-inspect.timer`：`[Unit] Description=…` / `[Timer] OnCalendar=*:0/5`、`Persistent=false`、`Unit=sentelligent-ops-inspect.service` / `[Install] WantedBy=timers.target`。
`sentelligent-ops-inspect.service`：oneshot、root、`TimeoutStartSec=120`、`SyslogIdentifier=sentelligent-ops-inspect`、`ExecStart=/usr/bin/env bash /opt/sentelligent-sales-workbench/tools/ops-inspect.sh`，无 [Install]。

```bash
#!/usr/bin/env bash
# 四项检查：outbox failed 新增 / worker 心跳 / 三调度器 lastError+backend 存活 / 备份新鲜度
set -uo pipefail
ROOT="/opt/sentelligent-sales-workbench"; STATE="$ROOT/tools/.ops-inspect-state"   # k=v 状态文件
NODE="$ROOT/runtime/node-v24/bin/node"; DB="/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite"
env_value() { grep -E "^$1=" "$ROOT/config/backend.env" | head -1 | cut -d= -f2-; }
OPS_BEARER="$(env_value OPS_ALERT_TOKEN)"; PUSH_BEARER="$(env_value HOSPITAL_TENDER_PUSHPLUS_TOKEN)"
state_get() { grep -E "^$1=" "$STATE" 2>/dev/null | head -1 | cut -d= -f2-; }
state_set() { touch "$STATE"; chmod 600 "$STATE"; grep -vE "^$1=" "$STATE" > "$STATE.tmp" || true; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
alert() { # $1 source  $2 summary  $3 detail —— 端点优先（端点侧小时级幂等去重），失败退 PushPlus
  local payload; payload="$(python3 -c 'import json,sys;print(json.dumps({"source":sys.argv[1],"severity":"critical","summary":sys.argv[2],"detail":sys.argv[3]}))' "$1" "$2" "$3")"
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OPS_BEARER" \
    -H 'Content-Type: application/json' --data "$payload" \
    http://127.0.0.1:8897/api/integrations/ops-alerts | grep -qE '^2' && return 0
  [[ -n "$PUSH_BEARER" ]] && curl -sS --max-time 10 -o /dev/null -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys;print(json.dumps({"token":sys.argv[1],"title":"【巡检】"+sys.argv[2],"content":sys.argv[3],"template":"txt"}))' "$PUSH_BEARER" "$2" "$3")" \
    https://www.pushplus.plus/send
}
# ① outbox failed 新增（水位=最新 failed 行 updated_at，首跑只建水位不告警——4 条陈账不触发）
FAILED_MAX="$("$NODE" --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync('$DB',{readOnly:true});const r=d.prepare(\"SELECT COALESCE(MAX(updated_at),'') m, COUNT(*) n FROM weixin_confirmation_outbox WHERE status='failed'\").get();console.log(r.m+'|'+r.n)" 2>/dev/null)"
if [[ -n "$FAILED_MAX" ]]; then
  MARK="$(state_get outbox_failed_mark)"; CUR="${FAILED_MAX%%|*}"; CNT="${FAILED_MAX##*|}"
  if [[ -z "$MARK" ]]; then state_set outbox_failed_mark "$CUR"
  elif [[ -n "$CUR" && "$CUR" > "$MARK" ]]; then
    alert "ops-inspect:outbox-failed" "outbox 出现新的 failed 消息（现共 $CNT 条）" "最新 failed updated_at=$CUR，请查 weixin_confirmation_outbox 与 worker 日志"
    state_set outbox_failed_mark "$CUR"
  fi
fi
# ② worker 心跳：进程态 + 投递就绪快照（快照经 ③ 的 status 端点取，30 秒陈旧窗内 worker 未轮询即 not_ready/worker_unavailable）
systemctl is-active --quiet sentelligent-weixin-agent \
  || alert "ops-inspect:weixin-worker" "sentelligent-weixin-agent 未在运行" "$(systemctl status sentelligent-weixin-agent --no-pager -n 5 2>&1 | tail -c 800)"
# ③ backend 存活 + 三调度器 lastError + 投递就绪（一次 GET 四合一）
STATUS_JSON="$(curl -sS --max-time 10 -H "Authorization: Bearer $OPS_BEARER" http://127.0.0.1:8897/api/integrations/ops-alerts/status 2>/dev/null)"
if [[ -z "$STATUS_JSON" ]]; then
  alert "ops-inspect:backend" "backend 状态端点不可达" "curl 127.0.0.1:8897 失败；若 systemd 显示 active 可能在崩溃循环"
else
  echo "$STATUS_JSON" | python3 -c "
import json,sys
item=json.load(sys.stdin).get('item',{})
out=[]
for name,s in (item.get('schedulers') or {}).items():
    if s and s.get('lastError'): out.append('scheduler:'+name+'|'+str(s.get('lastError')))
w=item.get('weixinDelivery') or {}
if w.get('status')!='ready': out.append('weixin-delivery|'+str(w.get('reason','not_ready')))
print('\n'.join(out))
" | while IFS='|' read -r SRC ERR; do
    [[ -n "$SRC" ]] && alert "ops-inspect:$SRC" "巡检发现异常：$SRC" "$ERR"
  done
fi
# ④ 每日备份新鲜度（<26h）
LATEST="$(ls -t "$ROOT"/backups/daily/*.sqlite 2>/dev/null | head -1)"
if [[ -z "$LATEST" || $(( $(date +%s) - $(stat -c %Y "$LATEST") )) -gt 93600 ]]; then
  alert "ops-inspect:backup-freshness" "每日备份超过 26 小时未更新" "最新文件：${LATEST:-无}；请查 sentelligent-daily-backup timer/journal"
fi
exit 0
```

去重策略：端点侧小时级幂等键是唯一风暴闸——持续性故障每小时提醒一条直至修复（有意为之）；outbox 检查另用水位防陈账反复告警。

### 1.8 测试清单（块1，全部合成栈/单元级）

| 文件 | 用例 |
|---|---|
| `backend/tests/ops-alerts-api.test.js`（新） | 无/错 token 401；weixin-agent token 打 ops-alerts 403 `MACHINE_SCOPE_DENIED`；source/severity/长度非法 422；合法请求 200 且 outbox 落一行 kind=ops_alert；同 source 同小时重发 10 次 → outbox 仍 1 行且 `replayed:true`（风暴去重）；跨小时（注入 clock）→ 第 2 行；投递未就绪 → fetch 桩收到 PushPlus 调用且响应 `pushplusFallback:true`；两通道皆不可用 → 503；审计行 `ops_alert.receive` |
| `backend/tests/ops-alert-message.test.js`（新） | 渲染卡片字段/裁剪/非法 payload 抛错；`renderOutboxMessage` 分支路由到位 |
| `backend/tests/ops-alerts-status-api.test.js`（新） | 鉴权矩阵；注入三调度器桩后 lastError 透出；`statusCounts` 形态；deliveryReadiness 快照透传 |
| `backend/tests/weixin-outbox.test.js`（增） | `statusCounts()` 计数与 oldestQueuedAt |
| 注入故障集成（`backend/tests/ops-alerts-api.test.js` 内） | 全链：POST ops-alerts → 模拟 worker 带就绪头 GET confirmation-outbox → 租约返回渲染后的告警卡文本（复用 `weixin-agent-http-integration.test.js` 的请求器模式） |

### 1.9 部署动作与回滚（并入 §6 总部署序）

cutover 前：生成 `OPS_ALERT_TOKEN`（`openssl rand -base64 48 | tr '+/' '-_' | tr -d '='`）写入 backend.env；安装两脚本到 `/opt/.../tools`（root 0700）+ `bash -n` 语法核验 + `command -v python3`；安装 `sentelligent-ops-alert@.service`；patch 四主单元（OnFailure/StartLimit）→ `systemctl daemon-reload`。此时端点尚不存在，若有单元失败脚本自动走 PushPlus——顺序安全。
cutover 后：安装并 `enable --now sentelligent-ops-inspect.timer`；首发验证 `systemctl start sentelligent-ops-alert@manual-test.service` → 微信应收到告警卡；`systemctl start sentelligent-ops-inspect.service` 手动跑一轮看 journal 无 alert 误报；curl status 端点核对 JSON。
回滚：代码回滚（cutover 自动）→ 端点消失，ops-alert.sh 自动退 PushPlus、巡检会告"backend 端点不可达"（预期），可 `systemctl disable --now sentelligent-ops-inspect.timer` 静默巡检；OnFailure 行可原样保留（模板单元自包含）；完全回退=删 OnFailure/StartLimit 行 + daemon-reload。

### 1.10 验收标准（块1）

1. 手动 `systemctl start sentelligent-ops-alert@manual-test.service`，微信 5 分钟内收到【小小运维告警】卡片。2. `systemctl stop sentelligent-weixin-agent && systemctl start sentelligent-ops-inspect.service`（维护窗内）触发 worker 告警经 PushPlus 到达，恢复后巡检不再报。3. 同一故障一小时内重复巡检只产生一条微信消息。4. 新增后端测试全绿，既有 1276 项无回归。

---

## 2. 块2 · L0 owner 数据清洗（迁移 0029）

### 2.1 生产 owner 分布实测（2026-08-28 23:52，node:sqlite readOnly，全表扫 owner/assignee/actor/created_by）

| 表.列 | 现值分布 | 目标值 | 动作 |
|---|---|---|---|
| customers.owner | jiangjz=2 · **继振=1** | 继振→jiangjz | 0029 UPDATE |
| opportunities.owner | jiangjz=2 · **继振=1** | 继振→jiangjz | 0029 UPDATE |
| action_items.owner | jiangjz=1 · **继振=1 · NULL=1** | 继振/NULL→jiangjz | 0029 UPDATE |
| quick_records.owner | jiangjz=3 · **legacy=3** | legacy→jiangjz | 0029 UPDATE |
| weekly_reports.owner | jiangjz=2 · **继振=1** | 继振→jiangjz | 0029 UPDATE |
| solution_drafts.owner | **"??"=1** | ??→jiangjz | 0029 UPDATE |
| audit_logs.actor | jiangjz=233·weixin-agent=7·NULL=5·deploy=4·system:daily-digest=2·??=2·继振=1 | 不动 | 历史留痕（任务书明确） |
| assistant_conversations/inbound_events.owner | 各含 weixin-agent=1/3 | 不动 | 机器身份词，属词表合法值；v0.9.2 数据层再决策 |
| risk_items.assignee | 继振=3（seed 来源展示名） | 不动 | 展示字段，v0.9.1 users.display_name 后统一 |
| 其余 owner 列（差旅/记账/助手/outbox 等 20+ 表） | 全部 jiangjz | 已规范 | 无动作 |

与审计A §4 相比新增发现：assistant 两表存在 `weixin-agent` 机器 owner（审计时点未列）；action_items.assignee 现网已无"继振"存量。清洗共改 **8 行**。

### 2.2 迁移 0029 草案（幂等，值白名单，不动 audit_logs / updated_at / version）

`backend/src/db/migrations/0029_owner_vocabulary_cleanup.mjs`（全文）：

```js
// L0 owner 词表清洗：业务六表的历史别名/占位值统一为账号 id "jiangjz"。
// 值白名单 + IS NULL 双幂等；不触碰 audit_logs、assistant_* 机器身份、展示列 assignee。
const TABLES = ["customers", "opportunities", "action_items", "quick_records", "weekly_reports", "solution_drafts"];
export function apply(db) {
  for (const table of TABLES) {
    db.prepare(
      `UPDATE ${table} SET owner = 'jiangjz' WHERE owner IN ('继振', 'legacy', '??') OR owner IS NULL`,
    ).run();
  }
}
```

挂载：`db/migrate.js` import + migrations 数组尾部 `{ version: "0029", path: …, type: "module", apply }`。说明：不 bump `version` 列、不改 `updated_at`（对账时"除 owner 外行哈希不变"依赖此点；先例=0028 存量回填）；weekly_reports/solution_drafts owner NOT NULL，`IS NULL` 分支空转无害；测试/开发库中 `seed.js` 在迁移后插入 owner=继振 的种子行不受影响（审计C B2 的 seed 口径对齐**不在本版范围**，登记遗留）。

### 2.3 彩排步骤（/dev/shm 副本 + 前后对账）与生产执行

1. 服务器（root）：`STAGING_BACKEND=/opt/sentelligent-sales-workbench/staging/build-v0.9.0-*/backend`；用项目 node 只读连生产库执行 `VACUUM INTO '/dev/shm/rehearsal-v090.sqlite'`。
2. 对账前快照：对副本跑分布 SQL（下方）+ 六表 `COUNT(*)` + `SELECT COUNT(*) FROM schema_migrations`（应 27）。
3. 执行迁移：`cd $STAGING_BACKEND && DATABASE_URL=/dev/shm/rehearsal-v090.sqlite $NODE --input-type=module -e "import('./src/db.js').then(m=>m.openDatabase({databaseUrl:process.env.DATABASE_URL}).close())"`（openDatabase 自动跑迁移链）。
4. 对账后：分布 SQL 全部只剩 `jiangjz`（及不在清洗面的值）；六表行数不变；schema_migrations=28 且含 0029；抽查 `SELECT id,version,updated_at FROM customers` 与前快照一致（仅 owner 变）。
5. `rm /dev/shm/rehearsal-v090.sqlite`。生产执行=cutover 内 `db/migrate.js` 自动应用（cutover 自带停服+离线备份），cutover 后在生产库复跑分布 SQL 归档进 release 证据。

对账 SQL（前后各一次）：

```sql
SELECT 'customers' t, owner v, COUNT(*) n FROM customers GROUP BY owner
UNION ALL SELECT 'opportunities', owner, COUNT(*) FROM opportunities GROUP BY owner
UNION ALL SELECT 'action_items', COALESCE(owner,'<NULL>'), COUNT(*) FROM action_items GROUP BY owner
UNION ALL SELECT 'quick_records', owner, COUNT(*) FROM quick_records GROUP BY owner
UNION ALL SELECT 'weekly_reports', owner, COUNT(*) FROM weekly_reports GROUP BY owner
UNION ALL SELECT 'solution_drafts', owner, COUNT(*) FROM solution_drafts GROUP BY owner ORDER BY t, v;
```

### 2.4 `upsertActionFromQuickRecord` 深写回 assignee 修复（两步设计）

- 现状（server.js 内函数 `upsertActionFromQuickRecord`）：`$assignee: "继振"` 硬编码（`$due: "待确认"` 保留不动）；owner 已继承 `quickRecord.owner`。全仓 backend/src 仅此一处"继振"硬编码（另 seed.js 为种子数据，不动）。
- **过渡（本版 v0.9.0）**：`$assignee: quickRecord.owner ?? null`——与 owner 继承同源；L0 后即恒为账号 id `jiangjz`。展示面从"继振"变为"jiangjz"，属词表统一的预期变化，写入 release 文档验收卡。reactivating 分支的 `$assignee` 同值，无需另改。
- **终态（v0.9.1，本版不做）**：users 表落地后改为 `users.display_name(owner)`，并一次性 `UPDATE action_items SET assignee=<display_name> WHERE assignee='jiangjz'` 回填（归 v0.9.1 设计）。
- 测试：现有 `api.test.js` 中全部 `assignee: "继振"` 断言均为"请求体显式传入→回读"，与本修复无关（已核）；新增用例：quick-record confirm 深写回后 `action.assignee === quickRecord.owner`（挂 `backend/tests/api.test.js` confirm 用例内）。

### 2.5 迁移测试更新清单（`backend/tests/migrations.test.js`）

1. 主用例计数 `assert.equal(firstMigrations.length, 27)` → **28**，并补 `firstMigrations[27].version === "0029"`。
2. 「reconciles the former settings migration 0019」尾部 schema_migrations 计数 27 → **28**。
3. 「upgrades all legacy business data」版本清单数组追加 `"0029"`。
4. 「adopts legacy baseline tables」计数 27 → **28**。
5. 「rolls back every 0002 …」重迁移后的版本清单追加 `"0029"`。
6. 新用例「migration 0029 normalizes legacy owner vocabulary」：fresh openDatabase 后 INSERT 六表脏行（继振/legacy/??/NULL）+ 一行 `other-user`（**必须不被改**，验证白名单语义）+ 一行 jiangjz；直接 `import { apply }` 调用（0021/0013 用例先例）；断言映射正确、`other-user` 保留、二次 `apply(db)` 幂等（行哈希不变）、updated_at/version 未动。

### 2.6 回滚与风险

数据迁移**不回滚**：清洗后旧代码（若 cutover 自动回滚到 v0.8.4）行为无差且更优——生产 `WEIXIN_AGENT_OWNER=jiangjz`，"继振"客户清洗后对小小可见（消灭交付报告 §3-1 遗留项），Web 端无 owner 过滤不受影响。风险面=8 行 UPDATE，彩排+cutover 离线备份+每日快照三重兜底。

### 2.7 验收标准（块2）

1. 彩排四步全过、证据归档。2. 生产 cutover 后分布 SQL 六表仅剩 jiangjz。3. 微信发"客户 胶州"（原继振客户）可查到。4. migrations.test.js 与后端全量绿。5. 深写回新建待办 assignee=jiangjz（微信记一下→确认→Web 待办页核对）。

---

## 3. 块3 · 审计C 四项小修

### 3.1 招标摘要微信意图（审计C B12 ❌）

- **路由**（`assistant/router.js`）：`naturalPlan` 中插入点=「差旅汇总」分支之后、`/记账|支出|收入|借款到账/` 记账捕获之前（R0 查询组集中处；位于 quick-capture/todo 前缀组之后，保证"记一下：拜访了招标办…"、"提醒我跟进招标"不被抢）。正则采用**锚定全匹配**而非任务书宽式 `查.*招标`（宽式会吞"查上周招标办的拜访记录"这类以「记录」收尾、应归 QUICK_SEARCH 的长句）：

```js
const HOSPITAL_TENDER_SUMMARY_RE = /^(?:查一下|查查|查询|查)?\s*(?:最近|今天|本周)?\s*(?:有什么|有哪些)?\s*(?:医院)?招标(?:公告|信息|动态|情况|摘要|监测)?\s*(?:有什么|有哪些|怎么样)?\s*[?？]?$/u;
```

  另在 `explicitPlan` 的 `aliases` 表加 `招标摘要: ["hospital-tender.summary", () => ({})]`；`HELP` 文案「行程摘要、」后插入「招标摘要、」。
- **四处登记**：`policy.js` 加 `["hospital-tender.summary", { risk: "R0", confirmation: "none", reason: "read_only" }]`；`agentRegistry.js` 新 agent `hospital-tender`（"医院招标情报"，只读说明）+ `tool("hospital-tender.summary", "hospital-tender", "查询医院招标监测摘要", {})`；`agentManifest.js` 加 `manifestDefinition("hospital-tender", { contractVersion: "hospital-tender-v1", modelPolicy: "none", taskTypes: ["summary"], tools: ["hospital-tender.summary"], confirmation: { preview: "none", write: "none" }, … })`（registry↔manifest 启动一致性校验强制此项）；`capabilityCatalog.js` 加 capability `hospital-tender.summary`（mappings.apis=`GET /api/hospital-tenders/summary`，status ready，confirmationLevel none）。
- **handler**（`assistant/runtimeHandlers.js`，同源数据=`hospitalTenderRepository.summary()`，与 GET summary 端点同一函数；`createAssistantToolHandlers` 增注入 `hospitalTenderRepository`，server.js 装配处传入）：

```
【医院招标监测】          字段：公告总数 totalNotices / 今日新增 todayNewCount / 高相关 highRelevanceCount
截至：<asOf 转 +08:00>    / 已匹配客户 matchedNotices / 截止临近 deadlineSoonCount / 最新发布 latestPublishedAt
…（weixinCard 逐行）      / 最近采集 latestRun.finishedAt+status（无 runs 时"待首轮采集"）
页脚：高相关新公告会自动推送；详情见工作台「招标监测」页。
```

  招标为全局域（D1 裁定），handler 不做 owner 过滤，与 Web 端点一致。
- **测试**：`assistant-unified-router.test.js` 增语料——命中组：招标摘要 / 医院招标 / 查一下医院招标 / 查询招标 / 最近有哪些招标公告；不命中组（回归既有归属）：记一下：拜访了招标办沟通项目（visit-capture）/ 提醒我周五跟进招标（todo）/ 查上周招标办的拜访记录（quick search）/ 知识检索 招标（knowledge）。新 `backend/tests/hospital-tender-assistant-summary.test.js`：handler 卡片渲染（有数据/空库两态）+ policy R0 免确认 + manifest 一致性校验通过。

### 3.2 「修改客户」被记账前缀拦截（审计C B4 ⚠️）

- 根因（`assistant/shortcutBookkeepingRuntime.js`）：`explicitModification` = `/^修改(?:[：:\s]+)?(.+)$/su` 任意"修改X"都算记账语言，在 `handlePending` 的 `bookkeepingLanguage`、`draftOnlyCorrection` 与 `commandTargetsShortcut`（含 `/^(?:确认|修改|取消)/`）三处生效——记账草稿活跃期"修改客户 …"永远进不了路由器。
- **收窄设计**："修改 + 记账字段词表才命中"。词表从 `integrations/shortcutBookkeepingAssistant.js` 的 `CORRECTION_LABELS` 提取并**导出常量**（单一来源）：`发生时间|记账时间|费用类别|日期|时间|金额|花费|费用|商户|商家|店铺|用途|事由|备注|说明|子分类|小类|分类|大类`。任务书举例中的「城市/区域」不入此词表——它们不是纠错字段而是 region_assignment 意图（"本周区域是济南"），已由 `bookkeepingLanguage` 的 `intent.status === "accepted"` 项覆盖，与修改分支无关。
- 三处改动（行为对齐）：① `explicitModification` 改为：剥去 `修改[：:\s]*` 前缀后，剩体必须匹配 `/^(?:把|将)?\s*(?:<词表>)/u` 才返回非空；② `commandTargetsShortcut` 的正则改 `/^(?:确认|取消)/u`（修改分支由 ① 的 `explicitModification(text)` 项承担）并保留 `|| /^修改\s*[:：]?\s*$/u.test(text)`（**裸"修改"仍归记账**，维持"请引用草稿"引导）；③ `draftOnlyCorrection` 无需改（引用 ①）。
- **让路后仍须命中记账的回归语料**（全部在草稿活跃态下断言仍走记账链）：`修改金额 100元`、`修改：金额改为86.5元`、`修改时间 14:30`、`修改日期 8月27日`、`修改发生时间 2026-08-27T09:00:00+08:00`、`修改费用类别 交通`、`修改分类 餐饮`/`修改大类 差旅`/`修改子分类 打车`、`修改商户 滴滴出行`、`修改用途 客户拜访打车`、`修改备注：加急`、`修改说明 项目应酬`、`修改 把金额改成99元`、裸`修改`、`确认`、`取消`（后三者行为不变）。**让路语料**（活跃草稿下应到达路由器）：`修改客户 黄岛人民医院，级别 重点推进` → customer.update 六位码链（B4 修复目标）、`修改客户 X，区域 日照` → customer.update；`修改商机的金额改成600万` 类句式让路后由路由器商机组接（较今日整句被吞为改善，验收卡建议话术"把X商机的金额改成Y"）。
- 测试落点：`backend/tests/shortcut-weixin-confirmation.test.js`（上述记账语料回归）+ `weixin-agent.test.js`（活跃草稿期"修改客户"走客户改档全链集成，复刻审计C B4 场景）。

### 3.3 招标页测试断言 + test:tender 挂门禁（审计C D5 ⚠️）——**已完成，本版仅核销**

实测：commit `752a793`（v0.8.4 期间）已将 `HospitalTenderPage.test.mjs` 断言改为 `setCustomerFilter(customerId ?? "")`/`useState(customerId ?? "")` 并把 `"test:tender"` 挂入 `qa:local` 链（package.json 实读确认）；本设计撰写时实跑 4/4 全绿。v0.9.0 动作=release 文档记录核销，无代码改动。

### 3.4 AMAP_MODE=mock（审计C A8 ⚠️）

- **config**（`backend/src/config.js`）：新键 `amapMode`（`AMAP_MODE`，`live|mock`，默认 `live`，非法值抛错）；`validateProductionConfig` 增 `if (config.amapMode === "mock") throw`（mock 几何进生产会污染行程数据，比 AI_ANALYSIS_MODE 更需硬闸）。
- **装配**（server.js `amapClient` 三元处）：`config.amapMode === "mock" ? createMockAmapClient() : (config.amapWebServiceKey ? createAmapClient(...) : null)`；`options.amapClient` 注入优先级不变（既有测试桩零影响）。
- **桩**（新 `backend/src/maps/amapMockClient.js`）：实现 planner 要求的四方法（`itinerary/planner.js` 校验 geocode/drivingMatrix/drivingRoute 必需 + 浏览器定位路径需 reverseGeocode），**确定性**：`geocode({address})` 以 sha256(address) 取模映射到青岛城区 bbox（lng 120.10–120.60、lat 35.90–36.40，保留 6 位小数），formattedAddress=原地址、city=青岛市、district=黄岛区、adcode=370211；`reverseGeocode` 返回同规则的固定行政区；`drivingMatrix` 距离=两点球面直线米数×1.4 取整、时距=距离/11（≈40km/h）取整秒；`drivingRoute` 距离/时距同公式，`tollsCny=0`、`trafficLights=2`、polyline=[origin,…waypoints,destination]、steps=单步桩（instruction="沿演示路线行驶"）。同输入恒同输出，测试可断言具体数值。
- 受影响/新增测试：新 `backend/tests/amap-mock-client.test.js`（四方法契约、确定性、bbox 边界、矩阵对称性）；行程 API 测试增一条"`AMAP_MODE=mock` 下 POST /api/itineraries 全链 201"（不再 503 `AMAP_NOT_CONFIGURED`）；config 测试增 amapMode 校验+生产拒绝 mock。隔离栈（fixed-stack/审计栈）配方补 `AMAP_MODE=mock`，消灭审计盲区 2「行程全链不可测」。

### 3.5 验收标准（块3）

1. 微信实测「招标摘要」「查一下医院招标」返回摘要卡（复测审计C B12 → ✅）。2. 造一笔待确认记账后发「修改客户 …」走客户改档六位码链，随后「修改金额 100元」仍走记账纠错（复测 B4 → ✅）。3. `test:tender` 在 qa:local 中执行且绿。4. 隔离栈 `AMAP_MODE=mock` 建行程 201 并联动当日费用（复测 A8 → ✅）。

---

## 4. 块4 · 运维收口（服务器动作，随本版部署窗执行）

### 4.1 v0.8.1–v0.8.3 制品归档（实测：backups/releases 现有 v0.7.0–v0.8.0 九版；v0.8.1–0.8.3 bundle 均在 staging/，v0.8.3 有 def703d（preflight 自救废弃版）与 a2a9eb3（生产版）两组）

工具用法（服务器 `/opt/sentelligent-sales-workbench/tools/archive-release-artifacts.sh`，root，版本目录不可覆盖故 **v0.8.3 两组制品必须一次归档**）：

```bash
R=/opt/sentelligent-sales-workbench; cd $R
bash tools/archive-release-artifacts.sh --version=v0.8.1 \
  --bundle=$R/staging/sentelligent-v0.8.1-7fc8177.bundle \
  --evidence-dir=$R/evidence/v0.8.1-20260828T100520Z_7fc817771d9c-preflight \
  --evidence-dir=$R/evidence/v0.8.1-20260828T100520Z_7fc817771d9c-postflight \
  --evidence-dir=$R/evidence/v0.8.1-20260828T100520Z_7fc817771d9c-smoke
bash tools/archive-release-artifacts.sh --version=v0.8.2 \
  --bundle=$R/staging/sentelligent-v0.8.2-ef2c4f9.bundle \
  --evidence-dir=$R/evidence/v0.8.2-20260828T120544Z_ef2c4f9531b8 \
  --evidence-dir=$R/evidence/v0.8.2-20260828T120544Z_ef2c4f9531b8-preflight \
  --evidence-dir=$R/evidence/v0.8.2-20260828T120544Z_ef2c4f9531b8-postflight \
  --evidence-dir=$R/evidence/v0.8.2-20260828T120544Z_ef2c4f9531b8-smoke
bash tools/archive-release-artifacts.sh --version=v0.8.3 \
  --bundle=$R/staging/sentelligent-v0.8.3-def703d.bundle \
  --bundle=$R/staging/sentelligent-v0.8.3-a2a9eb3.bundle \
  --evidence-dir=$R/evidence/v0.8.3-20260828T135156Z_def703df8a76 \
  --evidence-dir=$R/evidence/v0.8.3-20260828T135156Z_def703df8a76-preflight \
  --evidence-dir=$R/evidence/v0.8.3-20260828T135156Z_def703df8a76-postflight \
  --evidence-dir=$R/evidence/v0.8.3-20260828T135156Z_def703df8a76-smoke \
  --evidence-dir=$R/evidence/v0.8.3-20260828T142112Z_a2a9eb3f8325 \
  --evidence-dir=$R/evidence/v0.8.3-20260828T142112Z_a2a9eb3f8325-preflight \
  --evidence-dir=$R/evidence/v0.8.3-20260828T142112Z_a2a9eb3f8325-postflight \
  --evidence-dir=$R/evidence/v0.8.3-20260828T142112Z_a2a9eb3f8325-smoke
```

校验：每条输出 `ARCHIVE_STATUS=passed`；`cd $R/backups/releases/v0.8.X && sha256sum -c SHA256SUMS`；bundle 哈希与 staging 原件 `sha256sum` 对拍；manifest.json 的 totals 抽查。注：v0.8.1 无"无后缀"cutover 证据目录（实测仅 3 组），v0.8.2/0.8.3 各 4 组照单全收；v0.8.4 由其交付流程自行归档，若届时未归档随本窗补一条同式命令。

### 4.2 服务器杂物清理清单（清册 §6 方案落地；顺序一律"归档校验→删除"；发布窗外执行；`releases/` 的 current 与回滚点绝不动）

| # | 对象（实测） | 保留判据 | 动作 |
|---|---|---|---|
| 1 | `staging/` 内 v0.7.0–v0.8.0 的 `build-*` 目录与 bundle（v0.7.x 约 7MB×8、v0.8.0 25MB） | backups/releases 已有九版归档且 §4.1 校验通过 | `rm -rf $R/staging/build-v0.7.*  build-v0.8.0-* && rm $R/staging/sentelligent-v0.7.*.bundle sentelligent-v0.8.0-*.bundle` 及对应 `v07*-release-id.txt` |
| 2 | `staging/` 内 v0.8.1–v0.8.3 同类（含 def703d 组） | §4.1 三条归档全部 passed | 同式删除；**保留 v0.8.4 与 v0.9.0 两版**（"最近 2 版"滚动判据） |
| 3 | `candidates/`（347M，三个 v0.5.3 时代目录，8/9 起未动） | v0.5.3 链有 tag+releases 目录兜底；确认无脚本引用（rg 服务器路径无引用） | `tar czf $R/backups/legacy-candidates-20260828.tar.gz candidates/ && rm -rf candidates/` |
| 4 | `incoming/`（213M：f89e1e7 部署残件、v0.6.21 包验证残件、20260820 目录等，旧流程遗留） | 现行流水线不读 incoming/；v0.6.21 已在 releases 树 | 同式先 tar 进 backups/ 再整目录删除 |
| 5 | 6 月旧目录 `backend/`(1.4M)、`frontend/`(10M)、`shared/`、`build-v0619/0620`(20M×2)、`build-artifacts-v0619/0620`(4M×2) | 手工部署时代残迹；systemd 单元/Caddy 均只引用 releases/current 与 runtime | tar 归档 `legacy-june-tree-20260828.tar.gz` 后删除 |
| 6 | `/etc/caddy/Caddyfile.backup-*` 等 8 份历史备份 | Caddyfile 已随块4-4 入仓 | 拷入 `$R/backups/caddy-history/` 后删除原件 |
| 7 | `/var/lib` 下 `candidate-f89e1e7.sqlite` 三件套（server-facts TODO-9） | 7 月候选库，生产库不引用 | 归档同 #4 tar 后删除（低优先，可顺手） |

预计回收 staging ≈1.2G + candidates 347M + incoming 213M ≈ **1.7G+**。执行人逐条记录进 release 文档"运维与退役"节。

### 4.3 18899 root 孤儿进程（D4）——**已处置，记录在案**

2026-08-28 深夜已核实停删；本设计 23:52 实测 `ss -tlnp | grep 18899` 为空、qingyang 正牌实例（8797）不受影响。v0.9.0 release 文档抄录此结论即核销审计A S1。

### 4.4 Caddyfile 与 systemd 单元入仓（为 v1.0.0-rc 铺垫；本版只收集入仓+drift 校验，不做自动同步）

目录设计（与既有 `scripts/deploy/` 顶层"仓库为事实来源的可安装件"区分：`server-config/` 是"服务器为事实来源的实况快照"）：

```
scripts/deploy/server-config/
  README.md                        # 采集时间/来源主机/同步策略（手动）/drift 用法/BOM 警告
  caddy/Caddyfile                  # 字节级快照（注意现网文件带 UTF-8 BOM，原样保留）
  systemd/sentelligent-backend.service      # 采集后把 /releases/v…/ 具体路径替换为 @RELEASE_DIR@ 占位
  systemd/sentelligent-frontend.service     # （cutover 每版重写该路径，字节级对比必然漂移，故模板化）
  systemd/sentelligent-weixin-agent.service
  systemd/sentelligent-caddy.service
scripts/deploy/server-config-drift.sh       # 只读校验脚本
```

drift 脚本草案（本机运行，`SSH_TARGET`/`SSH_KEY` 环境变量参数化，退出码非 0=漂移）：

```bash
#!/usr/bin/env bash
set -uo pipefail
: "${SSH_TARGET:?}" ; SSH=(ssh ${SSH_KEY:+-i "$SSH_KEY"} "$SSH_TARGET")
BASE="$(cd "$(dirname "$0")/server-config" && pwd)"; DRIFT=0
normalize() { sed -E 's#/releases/v[0-9A-Za-z._-]+#/releases/@RELEASE_DIR@#g'; }
for u in sentelligent-backend sentelligent-frontend sentelligent-weixin-agent sentelligent-caddy; do
  "${SSH[@]}" "cat /etc/systemd/system/$u.service" | normalize \
    | diff -u "$BASE/systemd/$u.service" - >/dev/null || { echo "DRIFT: $u.service"; DRIFT=1; }
done
"${SSH[@]}" "cat /etc/caddy/Caddyfile" | diff -u "$BASE/caddy/Caddyfile" - >/dev/null || { echo "DRIFT: Caddyfile"; DRIFT=1; }
exit $DRIFT
```

采集时机：**部署尾声、四主单元 OnFailure patch 完成之后**（否则入仓即漂移）。新 ops 三单元与两脚本的事实来源在 `scripts/deploy/` 顶层（与 daily-backup 先例并排），不进 server-config/。

### 4.5 验收标准（块4）

1. `backups/releases/` 出现 v0.8.1/v0.8.2/v0.8.3 三目录且 `sha256sum -c` 全过。2. 清单 #1–#6 执行后 `du -sh` 复测（staging <600M、candidates/incoming 消失）且四服务与 qingyang 全部 active、HTTPS 冒烟绿。3. `server-config-drift.sh` 对刚采集的快照跑出退出码 0。4. release 文档记录 18899 核销与清理台账。

---

## 5. v0.9.0 版本门禁清单

**新增测试（预计 +10 文件/用例组，≥35 断言）**：`ops-alerts-api` / `ops-alert-message` / `ops-alerts-status-api` / `weixin-outbox`(statusCounts 增) / `migrations`(0029 新用例+5 处基线更新) / `api`(深写回 assignee) / `assistant-unified-router`(招标语料 9+) / `hospital-tender-assistant-summary` / `shortcut-weixin-confirmation`+`weixin-agent`(修改让路语料 16+) / `amap-mock-client`+行程 API mock 分支+config amapMode。
**既有门禁（一项不减）**：`npm run test:deploy`（秘密扫描+根 scripts 249 项）→ `npm --prefix backend test`（v0.8.4 基线 1276 项+新增，全绿）→ 前端 `qa:local`（build+28 条 test:* 链，含 test:tender）→ `qa:integration` → `qa:webkit`；即 `qa:full` 全绿 + `project-secret-scan` findings=[]（新增 shell/unit 文件纳入扫描面）。
**四关照旧**：production-preflight(25) → production-cutover（自动跑 0029 迁移+离线备份+失败自动回滚）→ postflight(25) → production-https-smoke(25)。

## 6. 部署序（cutover 前 / 切换 / 后）

| 序 | 动作 | 依据 |
|---|---|---|
| 前-1 | §4.1 三条归档 + 校验（与代码无关，可最先做） | 块4 |
| 前-2 | 生成 `OPS_ALERT_TOKEN` 写入 backend.env（隔离栈配方同步加 `AMAP_MODE=mock`，生产不加） | 块1/块3-4 |
| 前-3 | 安装 tools/ops-alert.sh、ops-inspect.sh（0700，bash -n、python3 核验）+ `sentelligent-ops-alert@.service`；patch 四主单元 OnFailure(+StartLimit)；daemon-reload | 块1 |
| 前-4 | 本地打包 v0.9.0 → 上传解包 → **/dev/shm 迁移彩排四步 + 对账**（§2.3） | 块2 |
| 前-5 | `VACUUM INTO` 手动备份一份（彩排纪律） | 块2 |
| 切换 | 标准四关（0029 随 cutover 自动应用） | — |
| 后-1 | 生产分布 SQL 复查（§2.3 归档证据）；微信实测：招标摘要 / 修改客户让路 / 记一下深写回 assignee | 块2/3 |
| 后-2 | 安装并 enable `sentelligent-ops-inspect.timer`；告警首发验证（`ops-alert@manual-test` + 手动巡检一轮） | 块1 |
| 后-3 | §4.2 清理清单 #1–#7（归档→校验→删；逐条记账） | 块4 |
| 后-4 | 采集 server-config 快照入仓（patch 后终态）+ drift 脚本跑 0 | 块4 |
| 回滚总则 | 代码=cutover 自动回滚；0029 数据不回滚（幂等、无行为差且改善可见性）；告警面降级路径=OnFailure→PushPlus 兜底 + 可停 inspect.timer；清理动作均有 tar/归档兜底 | — |
