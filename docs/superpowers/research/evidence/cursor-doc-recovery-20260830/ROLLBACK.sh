#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if (( $# > 1 )); then
  printf 'usage: %s [repository-root-or-test-copy]\n' "$0" >&2
  exit 64
fi

if (( $# == 1 )); then
  ROOT="$1"
else
  ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
fi

FILES=(
  "docs/superpowers/research/2026-08-28-audit-architecture-backend.md"
  "docs/superpowers/research/2026-08-28-audit-feature-matrix.md"
  "docs/superpowers/research/2026-08-28-audit-frontend-ux.md"
  "docs/superpowers/research/2026-08-28-multi-account-design.md"
)

HASHES=(
  "28a874555a9b428f5703ad75e6eea3d220de6d24572f15154a167e545085d11f"
  "9fea6d8512fb1acbbd8656586c36bc55d47a5ec010b9fdf10ef2db8004089505"
  "3d969d646867eae78838be42c71dca716ac71c7cf7c68c42afbf779009604f8d"
  "dead6d38db4c091f08aee970e2fe305cf14dcdf1aec8676cbb951b628c4e5183"
)

printf 'ROLLBACK_ROOT=%s\n' "$ROOT"

for index in "${!FILES[@]}"; do
  relative_path="${FILES[$index]}"
  expected_sha="${HASHES[$index]}"
  absolute_path="$ROOT/$relative_path"
  if [[ ! -f "$absolute_path" ]]; then
    printf 'ROLLBACK_ABORT=missing:%s\n' "$relative_path" >&2
    exit 3
  fi
  actual_sha="$(shasum -a 256 "$absolute_path" | awk '{print $1}')"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    printf 'ROLLBACK_ABORT=hash-mismatch:%s:%s\n' "$relative_path" "$actual_sha" >&2
    exit 4
  fi
  printf 'ROLLBACK_INPUT_OK=%s:%s\n' "$relative_path" "$actual_sha"
done

for relative_path in "${FILES[@]}"; do
  python3 - "$ROOT/$relative_path" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).unlink()
PY
done

remaining=0
for relative_path in "${FILES[@]}"; do
  if [[ -e "$ROOT/$relative_path" ]]; then
    remaining=$((remaining + 1))
  fi
done

printf 'ROLLBACK_REMOVED=%d/4\n' "$((4 - remaining))"
printf 'ROLLBACK_RESTORED_BEHAVIOR=pre-recovery-paths-absent\n'
printf 'ROLLBACK_STASH_ACTION=none\n'
[[ "$remaining" -eq 0 ]]
