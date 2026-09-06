#!/bin/sh
set -eu
BASE_SHA='4073d079453a187ffadf2264f4f6139313610edb'
BASE_TREE='d078859548a3272e09f9eae66b916658c50ab553'
TARGET_PATH='outputs/product-design-prototype/package.json'
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
expected=$(git -C "$TARGET" rev-parse "$BASE_SHA:$TARGET_PATH")
if [ ! -f "$TARGET/$TARGET_PATH" ] || [ -L "$TARGET/$TARGET_PATH" ]; then
  printf 'ROLLBACK_RESULT=FAILED PATH=%s REASON=BASE_FILE_TYPE_MISMATCH\n' "$TARGET_PATH" >&2
  exit 1
fi
actual=$(git -C "$TARGET" hash-object -- "$TARGET/$TARGET_PATH")
if [ "$actual" != "$expected" ]; then
  printf 'ROLLBACK_RESULT=FAILED PATH=%s REASON=BASE_BLOB_MISMATCH\n' "$TARGET_PATH" >&2
  exit 1
fi
git -C "$TARGET" diff --no-ext-diff --exit-code "$BASE_SHA" -- "$TARGET_PATH" >/dev/null
printf 'ROLLBACK_PATH=%s RESULT=RESTORED\n' "$TARGET_PATH"
printf 'ROLLBACK_RESULT=RESTORED BASE_SHA=%s BASE_TREE=%s PATHS=1\n' "$BASE_SHA" "$BASE_TREE"
