#!/bin/sh
set -eu

BASE_SHA='7ff9e4cce204074ffdb584b1ea04630e5343f79c'
BASE_TREE='e1cde860912d6d1d2e98b1b2a8a64563825fed6b'
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PATCH_FILE="$SCRIPT_DIR/DIFF_FILE"

if [ "$#" -ne 1 ]; then
  printf 'usage: %s TARGET_REPOSITORY_COPY\n' "$0" >&2
  exit 64
fi
if [ ! -f "$PATCH_FILE" ]; then
  printf 'ROLLBACK_RESULT=FAILED REASON=DIFF_FILE_MISSING\n' >&2
  exit 66
fi
TARGET=$(CDPATH= cd -- "$1" && pwd -P)
if ! git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'ROLLBACK_RESULT=FAILED REASON=TARGET_NOT_GIT_WORKTREE\n' >&2
  exit 65
fi
if ! git -C "$TARGET" cat-file -e "$BASE_SHA^{commit}" 2>/dev/null; then
  printf 'ROLLBACK_RESULT=FAILED REASON=BASE_COMMIT_UNAVAILABLE\n' >&2
  exit 65
fi
if [ "$(git -C "$TARGET" rev-parse "$BASE_SHA^{tree}")" != "$BASE_TREE" ]; then
  printf 'ROLLBACK_RESULT=FAILED REASON=BASE_TREE_MISMATCH\n' >&2
  exit 65
fi

set -- \
  'backend/src/asr/contracts.js' \
  'backend/src/asr/audioValidation.js' \
  'backend/src/config.js' \
  'backend/.env.example' \
  'backend/tests/asr-config.test.js' \
  'backend/tests/asr-validation.test.js' \
  'scripts/release-package.mjs' \
  'scripts/release-package.test.mjs'

git -C "$TARGET" apply --reverse --check "$PATCH_FILE"
git -C "$TARGET" apply --reverse "$PATCH_FILE"

for path do
  if git -C "$TARGET" cat-file -e "$BASE_SHA:$path" 2>/dev/null; then
    expected=$(git -C "$TARGET" rev-parse "$BASE_SHA:$path")
    if [ ! -f "$TARGET/$path" ] || [ -L "$TARGET/$path" ]; then
      printf 'ROLLBACK_RESULT=FAILED PATH=%s REASON=BASE_FILE_TYPE_MISMATCH\n' "$path" >&2
      exit 1
    fi
    actual=$(git -C "$TARGET" hash-object -- "$TARGET/$path")
    if [ "$actual" != "$expected" ]; then
      printf 'ROLLBACK_RESULT=FAILED PATH=%s REASON=BASE_BLOB_MISMATCH\n' "$path" >&2
      exit 1
    fi
  else
    if [ -e "$TARGET/$path" ] || [ -L "$TARGET/$path" ]; then
      printf 'ROLLBACK_RESULT=FAILED PATH=%s REASON=BASE_PATH_SHOULD_BE_ABSENT\n' "$path" >&2
      exit 1
    fi
  fi
  printf 'ROLLBACK_PATH=%s RESULT=RESTORED\n' "$path"
done

git -C "$TARGET" diff --no-ext-diff --exit-code "$BASE_SHA" -- "$@" >/dev/null
printf 'ROLLBACK_RESULT=RESTORED BASE_SHA=%s BASE_TREE=%s PATHS=8\n' "$BASE_SHA" "$BASE_TREE"
