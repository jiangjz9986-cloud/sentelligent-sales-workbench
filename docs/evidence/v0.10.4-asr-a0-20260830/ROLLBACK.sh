#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  printf 'usage: %s INDEPENDENT_COPY_ROOT\n' "$0" >&2
  exit 64
fi

if [[ ! -d "$1" ]]; then
  printf 'rollback target is not a directory\n' >&2
  exit 66
fi

target_root="$(cd "$1" && pwd -P)"
source_root="$(cd "/Users/jiangjizhen/Documents/Codex/repos/sentelligent-sales-workbench/.worktrees/integrate-v0626-candidate" && pwd -P)"
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
diff_file="$script_dir/DIFF_FILE"
baseline_head="f7683591802ad30073b720da96a4e7a49f2e2605"
expected_diff_hash="ccb97483b23cacbb4de5992603bc95b2eb9a68e0d2b425250257bba08a4dd095"

if [[ "$target_root" == "$source_root" ]]; then
  printf 'rollback target must be an independent copy\n' >&2
  exit 65
fi

if ! git -C "$target_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'rollback target is not a git worktree\n' >&2
  exit 66
fi

if [[ "$(git -C "$target_root" rev-parse HEAD)" != "$baseline_head" ]]; then
  printf 'rollback target HEAD mismatch\n' >&2
  exit 67
fi

if [[ ! -f "$diff_file" ]]; then
  printf 'rollback diff is missing\n' >&2
  exit 66
fi

actual_diff_hash="$(shasum -a 256 "$diff_file" | awk '{print $1}')"
if [[ "$actual_diff_hash" != "$expected_diff_hash" ]]; then
  printf 'rollback diff hash mismatch\n' >&2
  exit 67
fi

if ! git -C "$target_root" diff --cached --quiet; then
  printf 'rollback target index must be clean\n' >&2
  exit 67
fi

expected_status="$(printf '%s\n' \
  ' M backend/src/db/migrate.js' \
  ' M backend/src/http/security.js' \
  ' M backend/src/server.js' \
  ' M backend/src/settings/repository.js' \
  ' M backend/src/settings/secretBox.js' \
  ' M backend/tests/http-security.test.js' \
  ' M backend/tests/migrations.test.js' \
  ' M backend/tests/settings-config-api.test.js' \
  '?? backend/src/db/migrations/0033_secure_settings_asr.mjs' \
  '?? backend/tests/v0103-forward-compat.test.js' | LC_ALL=C sort)"
actual_status="$(git -C "$target_root" status --porcelain=v1 --untracked-files=all | LC_ALL=C sort)"
if [[ "$actual_status" != "$expected_status" ]]; then
  printf 'rollback target must contain exactly the ten A0 path changes\n' >&2
  exit 67
fi

check_hash() {
  local relative_path="$1"
  local expected_hash="$2"
  local actual_hash
  if [[ ! -f "$target_root/$relative_path" ]]; then
    printf 'missing rollback precondition file: %s\n' "$relative_path" >&2
    exit 67
  fi
  actual_hash="$(shasum -a 256 "$target_root/$relative_path" | awk '{print $1}')"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    printf 'rollback precondition hash mismatch: %s\n' "$relative_path" >&2
    exit 67
  fi
}

check_hash "backend/src/db/migrations/0033_secure_settings_asr.mjs" "acada172a32c458427845fe973730bcbf4e8c6903547614fb19495131b663ed5"
check_hash "backend/src/db/migrate.js" "4ea5a3bb2834e673bf97cfaab7293c47e273f2c18fa732d04317a54c7eca71e8"
check_hash "backend/src/http/security.js" "56f8f624b5effdcfab3e53aeac95de60aff4aaebb7ffe79519e1cd5890d1f769"
check_hash "backend/src/server.js" "e8af93703027b834fb1849ca6e9ed531bc492024f151a9786f3213a8f399ce92"
check_hash "backend/src/settings/repository.js" "da6f77be81fb82cdf5748b8264fc0a92b8f740680d8ed20b24bededebbed835b"
check_hash "backend/src/settings/secretBox.js" "f8cc0ca5b061db04ee84f3f4466e295e284f13bc33f887978e8e4c22e8c2ba71"
check_hash "backend/tests/http-security.test.js" "cc26b5a30d60c17d55ea39016fae64b0b9c802f644bdb6ac328b10ba541149f1"
check_hash "backend/tests/migrations.test.js" "b7b3bb0e4374e53364524414932c6442963ebedc1e9611db827967b5c0f2d595"
check_hash "backend/tests/settings-config-api.test.js" "97c9f05d15c6654becf08046a59ccee7de591fcad7107b58323a43fadde71d0f"
check_hash "backend/tests/v0103-forward-compat.test.js" "c2092aee9df6dfa5b20eda4f2c5411887bad75fa9ceec0fab8ea4026f542503e"

git -C "$target_root" apply --unidiff-zero --reverse --check "$diff_file"
git -C "$target_root" apply --unidiff-zero --reverse "$diff_file"

check_hash "backend/src/db/migrate.js" "8c6c75ee76129a1026c1fb3fdef65041fbe8270468dbdcd15506b4a77fe52b85"
check_hash "backend/src/http/security.js" "7e05489fbb8634af7b7a17afbaa641449ed6659da99f1f76c6635aca27e0689c"
check_hash "backend/src/server.js" "697603d386ffba96509df61d60638abc76f8fbc3c11ea66ef36e94c11a8561d8"
check_hash "backend/src/settings/repository.js" "8374d306edc41e34b4e52bb3936b7f044f26bccc05d30d6c16ba88ed62b1d408"
check_hash "backend/src/settings/secretBox.js" "de99e3c639c7f96d7ecc223d100be96a81e8f319eb927010aa41561fb0a60277"
check_hash "backend/tests/http-security.test.js" "99a709c51e970aaa80328d63829e144cc3626da1df767dbfa45f4110d1ebb51f"
check_hash "backend/tests/migrations.test.js" "a4296a15ab7a917ad5c87b601ed5be44c7c22b02ec67a2468a8d86721e8d3df7"
check_hash "backend/tests/settings-config-api.test.js" "c6e3a5c8fd1d653b8328c74f2c570a096b033514c65d80e64f1f9f23e1a28297"

for removed_path in \
  "backend/src/db/migrations/0033_secure_settings_asr.mjs" \
  "backend/tests/v0103-forward-compat.test.js"; do
  if [[ -e "$target_root/$removed_path" ]]; then
    printf 'rollback did not remove new path: %s\n' "$removed_path" >&2
    exit 68
  fi
done

restored_status="$(git -C "$target_root" status --porcelain=v1 --untracked-files=all)"
if [[ -n "$restored_status" ]]; then
  printf 'rollback target is not clean after restore\n' >&2
  exit 68
fi

printf 'ROLLBACK_TARGET=%s\n' "$target_root"
printf 'ROLLBACK_RESULT=restored\n'
printf 'ROLLBACK_EXIT=0\n'
printf 'RESTORED_HEAD=%s\n' "$baseline_head"
printf 'RESTORED_PATHS=8 original hashes matched; 2 new paths absent; git status clean\n'
printf 'RESTORED_BEHAVIOR=0032 secure-settings schema, pre-ASR repository/API behavior, and pre-PUT CORS allow-methods restored.\n'
