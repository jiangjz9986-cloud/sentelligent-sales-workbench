#!/bin/sh
set -eu

# Reverses only the cleanup-slice patch.  It refuses a copy whose base object
# is unavailable and relies on git apply --reverse --check before changing any
# bytes, so an unrelated dirty file is never overwritten.
BASE_SHA='0aadabc7cde716b090b0aa1532f5486a4f23defc'
BASE_TREE='35c84cd577120569a48f3cba436550cc56cb8e8f'
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

git -C "$TARGET" apply --reverse --check "$PATCH_FILE"
git -C "$TARGET" apply --reverse "$PATCH_FILE"

if [ ! -f "$TARGET/package.json" ] || [ -L "$TARGET/package.json" ]; then
  printf 'ROLLBACK_RESULT=FAILED PATH=package.json REASON=BASE_FILE_TYPE_MISMATCH\n' >&2
  exit 1
fi
if [ "$(git -C "$TARGET" hash-object -- package.json)" != "$(git -C "$TARGET" rev-parse "$BASE_SHA:package.json")" ]; then
  printf 'ROLLBACK_RESULT=FAILED PATH=package.json REASON=BASE_BLOB_MISMATCH\n' >&2
  exit 1
fi
for path in scripts/asr-runtime-cleanup.mjs scripts/asr-runtime-cleanup.test.mjs; do
  if [ -e "$TARGET/$path" ] || [ -L "$TARGET/$path" ]; then
    printf 'ROLLBACK_RESULT=FAILED PATH=%s REASON=BASE_PATH_SHOULD_BE_ABSENT\n' "$path" >&2
    exit 1
  fi
  printf 'ROLLBACK_PATH=%s RESULT=RESTORED\n' "$path"
done
printf 'ROLLBACK_PATH=package.json RESULT=RESTORED\n'
git -C "$TARGET" diff --no-ext-diff --exit-code "$BASE_SHA" -- package.json scripts/asr-runtime-cleanup.mjs scripts/asr-runtime-cleanup.test.mjs >/dev/null
printf 'ROLLBACK_RESULT=RESTORED BASE_SHA=%s BASE_TREE=%s PATHS=3\n' "$BASE_SHA" "$BASE_TREE"
