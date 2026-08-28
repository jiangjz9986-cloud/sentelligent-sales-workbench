#!/usr/bin/env bash
# v0.9.0 ops failure alert. $1 = failed unit name (from sentelligent-ops-alert@%I).
# Runs as root, installed 0700 at /opt/sentelligent-sales-workbench/tools/ops-alert.sh.
# Path: backend alive -> POST /api/integrations/ops-alerts (hour-keyed dedup on
# the server); backend itself failed or endpoint unreachable -> direct PushPlus.
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
# A failed backend cannot serve its own alert endpoint: go straight to PushPlus.
if [[ "$UNIT" != "sentelligent-backend.service" ]] && post_endpoint; then exit 0; fi
post_pushplus && exit 0
echo "ops-alert delivery failed for $UNIT" >&2
exit 1
