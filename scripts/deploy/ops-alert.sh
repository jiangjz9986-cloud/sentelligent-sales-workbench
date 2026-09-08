#!/usr/bin/env bash
# v0.9.0 ops failure alert. $1 = failed unit name (from sentelligent-ops-alert@%i).
# Runs as root, installed 0700 at /opt/sentelligent-sales-workbench/tools/ops-alert.sh.
# The only external delivery is WeChat Clawbot. The script posts to the durable
# backend outbox endpoint; if the backend itself is unavailable, it fails and
# leaves diagnosis in the systemd journal instead of using a second provider.
# JSON is assembled by python3 with an explicit fsencode/UTF-8 round trip:
# systemd runs this under the C locale, where sys.argv arrives surrogate-escaped
# and naive json.dumps would emit mojibake for the Chinese summary.
set -uo pipefail
UNIT="${1:-unknown-unit}"
ENV_FILE="/opt/sentelligent-sales-workbench/config/backend.env"
env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
OPS_BEARER="$(env_value OPS_ALERT_TOKEN)"
DETAIL="$(journalctl -u "$UNIT" -n 20 --no-pager -o cat 2>/dev/null | tail -c 1500)"
SUMMARY="systemd 单元失败：$UNIT"
json_utf8() { # argv -> UTF-8-safe JSON object per the calling template
  python3 -c '
import json, os, sys
argv = [os.fsencode(value).decode("utf-8", "replace") for value in sys.argv[2:]]
body = {"source": argv[0], "severity": "critical", "summary": argv[1], "detail": argv[2]}
print(json.dumps(body))
' "$@"
}
post_endpoint() {
  [[ -n "$OPS_BEARER" ]] || return 1
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $OPS_BEARER" -H 'Content-Type: application/json' \
    --data "$(json_utf8 alert "systemd:$UNIT" "$SUMMARY" "$DETAIL")" \
    http://127.0.0.1:8897/api/integrations/ops-alerts | grep -qE '^2'
}
post_endpoint && exit 0
echo "ops-alert delivery failed for $UNIT" >&2
exit 1
