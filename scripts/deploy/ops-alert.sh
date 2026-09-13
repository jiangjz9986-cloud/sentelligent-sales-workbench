#!/usr/bin/env bash
# v0.9.1 ops failure alert and deferred-delivery queue.
#
# The only external delivery is WeChat Clawbot through the Backend durable
# outbox endpoint. When Backend is down, this script atomically spools the
# bounded JSON request under a root-only directory. ops-inspect.sh calls this
# script with --drain after Backend recovers; there is no second notification
# provider and no direct WeChat call from this root helper.
#
# The defaults are production paths. Environment overrides exist only so the
# shell behavior can be integration-tested without touching /opt or systemd.
# JSON is assembled by python3 with an explicit fsencode/UTF-8 round trip:
# systemd runs this under the C locale, where sys.argv arrives surrogate-escaped
# and naive json.dumps would emit mojibake for the Chinese summary.
set -uo pipefail

ROOT="${SENTELLIGENT_ROOT:-/opt/sentelligent-sales-workbench}"
ENV_FILE="${OPS_ALERT_ENV_FILE:-$ROOT/config/backend.env}"
SPOOL_DIR="${OPS_ALERT_SPOOL_DIR:-$ROOT/tools/ops-alert-spool}"
ENDPOINT="${OPS_ALERT_ENDPOINT:-http://127.0.0.1:8897/api/integrations/ops-alerts}"
JOURNALCTL="${OPS_ALERT_JOURNALCTL:-journalctl}"
MAX_SPOOL_FILES="${OPS_ALERT_MAX_SPOOL_FILES:-1000}"
MAX_PAYLOAD_BYTES="${OPS_ALERT_MAX_PAYLOAD_BYTES:-32768}"

env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }
OPS_BEARER="$(env_value OPS_ALERT_TOKEN)"

json_utf8() { # argv -> UTF-8-safe JSON object per the calling template
  python3 -c '
import json, os, sys
argv = [os.fsencode(value).decode("utf-8", "replace") for value in sys.argv[2:]]
if len(argv) != 6:
    raise SystemExit("ops-alert: expected source, severity, summary, detail, eventId, occurredAt")
body = {"source": argv[0], "severity": argv[1], "summary": argv[2], "detail": argv[3], "eventId": argv[4], "occurredAt": argv[5]}
print(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
' "$@"
}

payload_size_ok() {
  local payload="$1"
  [[ "$(printf '%s' "$payload" | wc -c | tr -d ' ')" -le "$MAX_PAYLOAD_BYTES" ]]
}

post_payload() {
  local payload="$1" http_code
  [[ -n "$OPS_BEARER" ]] || return 1
  payload_size_ok "$payload" || return 1
  http_code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $OPS_BEARER" -H 'Content-Type: application/json' \
    --data "$payload" "$ENDPOINT" 2>/dev/null)" || return 1
  [[ "$http_code" =~ ^2[0-9][0-9]$ ]]
}

spool_payload() {
  local payload="$1" tmp="" file="" count=0
  payload_size_ok "$payload" || return 1
  mkdir -p "$SPOOL_DIR" 2>/dev/null || return 1
  chmod 700 "$SPOOL_DIR" 2>/dev/null || return 1
  count="$(find "$SPOOL_DIR" -maxdepth 1 -type f -name '*.json' -print 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$count" -lt "$MAX_SPOOL_FILES" ]] || return 1
  tmp="$SPOOL_DIR/.pending.$$.$RANDOM"
  file="$SPOOL_DIR/$(date -u +%Y%m%dT%H%M%S)-$$-$RANDOM.json"
  umask 077
  if ! printf '%s\n' "$payload" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! mv "$tmp" "$file"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$file" 2>/dev/null || {
    rm -f "$file"
    return 1
  }
  return 0
}

emit_or_spool() {
  local payload="$1"
  if post_payload "$payload"; then
    return 0
  fi
  if spool_payload "$payload"; then
    echo "ops-alert deferred: Backend/Clawbot outbox unavailable; payload spooled" >&2
    return 0
  fi
  echo "ops-alert delivery failed and local spool is unavailable" >&2
  return 1
}

drain_spool() {
  local file payload drained=0 failed=0
  [[ -d "$SPOOL_DIR" ]] || return 0
  while IFS= read -r file; do
    [[ -f "$file" ]] || continue
    payload="$(cat "$file" 2>/dev/null)" || { failed=1; continue; }
    if post_payload "$payload"; then
      rm -f "$file" || failed=1
      drained=$((drained + 1))
    else
      failed=1
    fi
  done < <(find "$SPOOL_DIR" -maxdepth 1 -type f -name '*.json' -print 2>/dev/null | sort)
  if [[ "$drained" -gt 0 ]]; then
    echo "ops-alert spool drained: $drained" >&2
  fi
  [[ "$failed" -eq 0 ]]
}

case "${1:-}" in
  --drain)
    drain_spool
    exit $?
    ;;
  --emit)
    if [[ "$#" -ne 5 ]]; then
      echo "usage: $0 --emit SOURCE SEVERITY SUMMARY DETAIL" >&2
      exit 2
    fi
    event_id="${OPS_ALERT_EVENT_ID:-$2:$(date -u +%Y%m%dT%H)}"
    occurred_at="${OPS_ALERT_OCCURRED_AT:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"
    emit_or_spool "$(json_utf8 alert "$2" "$3" "$4" "$5" "$event_id" "$occurred_at")"
    exit $?
    ;;
esac

UNIT="${1:-unknown-unit}"
DETAIL="$("$JOURNALCTL" -u "$UNIT" -n 20 --no-pager -o cat 2>/dev/null | tail -c 1500)"
SUMMARY="systemd 单元失败：$UNIT"
EVENT_ID="${OPS_ALERT_EVENT_ID:-systemd:$UNIT:${INVOCATION_ID:-$(date -u +%Y%m%dT%H%M%S)-$$-$RANDOM}}"
OCCURRED_AT="${OPS_ALERT_OCCURRED_AT:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"
emit_or_spool "$(json_utf8 alert "systemd:$UNIT" critical "$SUMMARY" "$DETAIL" "$EVENT_ID" "$OCCURRED_AT")"
exit $?
