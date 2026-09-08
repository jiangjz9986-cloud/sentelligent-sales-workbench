#!/usr/bin/env bash
# v0.9.0 five-minute ops inspection, four checks:
#   1. new failed rows in weixin_confirmation_outbox (watermark; first run only
#      records the watermark so historical failures never alert)
#   2. weixin worker process liveness
#   3. backend liveness + three scheduler lastError + delivery readiness via
#      one GET on the ops-alerts status endpoint
#   4. daily backup freshness (< 26h)
# Alerts go only to the Clawbot-backed outbox endpoint (hour-keyed dedup there).
# Runs as root, installed 0700 at /opt/sentelligent-sales-workbench/tools/ops-inspect.sh.
# python3 blocks do an explicit fsencode/UTF-8 round trip because systemd runs
# this under the C locale (surrogate-escaped argv would emit mojibake JSON).
set -uo pipefail
ROOT="/opt/sentelligent-sales-workbench"
STATE="$ROOT/tools/.ops-inspect-state"
NODE="$ROOT/runtime/node-v24/bin/node"
DB="/var/lib/sentelligent-sales-workbench/sales-workbench.sqlite"
env_value() { grep -E "^$1=" "$ROOT/config/backend.env" 2>/dev/null | head -1 | cut -d= -f2-; }
OPS_BEARER="$(env_value OPS_ALERT_TOKEN)"
state_get() { grep -E "^$1=" "$STATE" 2>/dev/null | head -1 | cut -d= -f2-; }
state_set() {
  touch "$STATE"
  chmod 600 "$STATE"
  grep -vE "^$1=" "$STATE" > "$STATE.tmp" || true
  echo "$1=$2" >> "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
json_utf8() { # argv -> UTF-8-safe JSON object per the calling template
  python3 -c '
import json, os, sys
argv = [os.fsencode(value).decode("utf-8", "replace") for value in sys.argv[2:]]
body = {"source": argv[0], "severity": "critical", "summary": argv[1], "detail": argv[2]}
print(json.dumps(body))
' "$@"
}
alert() { # $1 source  $2 summary  $3 detail
  [[ -n "$OPS_BEARER" ]] || return 1
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OPS_BEARER" \
    -H 'Content-Type: application/json' --data "$(json_utf8 alert "$1" "$2" "$3")" \
    http://127.0.0.1:8897/api/integrations/ops-alerts | grep -qE '^2'
}
# 1. new failed outbox rows (watermark = latest failed updated_at)
FAILED_MAX="$("$NODE" --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync('$DB',{readOnly:true});const r=d.prepare(\"SELECT COALESCE(MAX(updated_at),'') m, COUNT(*) n FROM weixin_confirmation_outbox WHERE status='failed'\").get();console.log(r.m+'|'+r.n)" 2>/dev/null)"
if [[ -n "$FAILED_MAX" ]]; then
  MARK="$(state_get outbox_failed_mark)"
  CUR="${FAILED_MAX%%|*}"
  CNT="${FAILED_MAX##*|}"
  if [[ -z "$MARK" ]]; then
    state_set outbox_failed_mark "$CUR"
  elif [[ -n "$CUR" && "$CUR" > "$MARK" ]]; then
    alert "ops-inspect:outbox-failed" "outbox 出现新的 failed 消息（现共 $CNT 条）" "最新 failed updated_at=$CUR，请查 weixin_confirmation_outbox 与 worker 日志"
    state_set outbox_failed_mark "$CUR"
  fi
fi
# 2. worker process liveness
systemctl is-active --quiet sentelligent-weixin-agent \
  || alert "ops-inspect:weixin-worker" "sentelligent-weixin-agent 未在运行" "$(systemctl status sentelligent-weixin-agent --no-pager -n 5 2>&1 | tail -c 800)"
# 3. backend liveness + scheduler lastError + delivery readiness (one GET)
STATUS_JSON="$(curl -sS --max-time 10 -H "Authorization: Bearer $OPS_BEARER" http://127.0.0.1:8897/api/integrations/ops-alerts/status 2>/dev/null)"
if [[ -z "$STATUS_JSON" ]]; then
  alert "ops-inspect:backend" "backend 状态端点不可达" "curl 127.0.0.1:8897 失败；若 systemd 显示 active 可能在崩溃循环"
else
  echo "$STATUS_JSON" | python3 -c "
import datetime, json, sys
item = json.loads(sys.stdin.buffer.read().decode('utf-8', 'replace')).get('item', {})
out = []
for name, s in (item.get('schedulers') or {}).items():
    if s and s.get('lastError'):
        out.append('scheduler-' + name + '|' + str(s.get('lastError')))
w = item.get('weixinDelivery') or {}
expires_at = w.get('expiresAt')
if isinstance(expires_at, str):
    try:
        expiry = datetime.datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
        remaining = (expiry - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        if remaining <= 0:
            out.append('weixin-context-expired|' + expires_at)
        elif remaining <= 3 * 60 * 60:
            out.append('weixin-context-expiring|' + expires_at)
    except ValueError:
        pass
if w.get('status') != 'ready':
    out.append('weixin-delivery|' + str(w.get('reason', 'not_ready')))
sys.stdout.buffer.write(('\n'.join(out)).encode('utf-8'))
" | while IFS='|' read -r SRC ERR; do
    case "$SRC" in
      weixin-context-expiring)
        alert "ops-inspect:weixin-context-expiry" \
          "微信主动推送上下文将在 3 小时内到期" \
          "expiresAt=$ERR；请在到期前给小小回复任意消息，以刷新微信主动推送上下文。普通心跳不能续期。"
        ;;
      weixin-context-expired)
        alert "ops-inspect:weixin-context-expiry" \
          "微信主动推送上下文已到期" \
          "expiresAt=$ERR；业务消息仍会保留在 outbox 排队，但必须给小小发送一条真实微信消息后才能恢复发送。普通心跳不能续期。"
        ;;
      *)
        [[ -n "$SRC" ]] && alert "ops-inspect:$SRC" "巡检发现异常：$SRC" "$ERR"
        ;;
    esac
  done
fi
# 4. daily backup freshness (< 26h)
LATEST="$(ls -t "$ROOT"/backups/daily/*.sqlite 2>/dev/null | head -1)"
if [[ -z "$LATEST" || $(( $(date +%s) - $(stat -c %Y "$LATEST") )) -gt 93600 ]]; then
  alert "ops-inspect:backup-freshness" "每日备份超过 26 小时未更新" "最新文件：${LATEST:-无}；请查 sentelligent-daily-backup timer/journal"
fi
exit 0
