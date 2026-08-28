#!/usr/bin/env bash
# Read-only drift check between scripts/deploy/server-config/ snapshots and
# the live production files. Run from the workstation:
#   SSH_TARGET=root@<host> SSH_KEY=<key> bash scripts/deploy/server-config-drift.sh
# Exit code 0 = no drift; non-zero prints one "DRIFT: <file>" line per finding.
# systemd units are compared after normalizing the per-release directory to
# the @RELEASE_DIR@ placeholder (cutover rewrites that path every version).
set -uo pipefail
: "${SSH_TARGET:?SSH_TARGET (for example root@host) is required}"
SSH=(ssh ${SSH_KEY:+-i "$SSH_KEY"} -o BatchMode=yes "$SSH_TARGET")
BASE="$(cd "$(dirname "$0")/server-config" && pwd)"
DRIFT=0
normalize() { sed -E 's#/releases/v[0-9A-Za-z._-]+#/releases/@RELEASE_DIR@#g'; }
for u in sentelligent-backend sentelligent-frontend sentelligent-weixin-agent sentelligent-caddy; do
  if [[ ! -f "$BASE/systemd/$u.service" ]]; then
    echo "DRIFT: $u.service (snapshot missing)"
    DRIFT=1
    continue
  fi
  "${SSH[@]}" "cat /etc/systemd/system/$u.service" | normalize \
    | diff -u "$BASE/systemd/$u.service" - >/dev/null || { echo "DRIFT: $u.service"; DRIFT=1; }
done
if [[ ! -f "$BASE/caddy/Caddyfile" ]]; then
  echo "DRIFT: Caddyfile (snapshot missing)"
  DRIFT=1
else
  "${SSH[@]}" "cat /etc/caddy/Caddyfile" | diff -u "$BASE/caddy/Caddyfile" - >/dev/null \
    || { echo "DRIFT: Caddyfile"; DRIFT=1; }
fi
exit $DRIFT
