#!/bin/sh
set -eu
TARGET_ROOT=${1:?usage: ROLLBACK.sh TARGET_ROOT}
RELATIVE_PATH='docs/superpowers/plans/2026-08-30-v0104-server-asr-design.md'
EXPECTED_MODIFIED_SHA256='b826b98fb3b4344ef5dfbd392234bfa7ed230ddb86394b2795f0ab7abf1ad204'
ORIGINAL_SHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
TARGET="$TARGET_ROOT/$RELATIVE_PATH"
if [ -L "$TARGET" ] || [ ! -f "$TARGET" ]; then
  printf 'ROLLBACK_ERROR target_not_regular=%s\n' "$TARGET" >&2
  exit 4
fi
actual=$(shasum -a 256 "$TARGET" | awk '{print $1}')
if [ "$actual" != "$EXPECTED_MODIFIED_SHA256" ]; then
  printf 'ROLLBACK_ERROR hash_mismatch expected=%s actual=%s\n' "$EXPECTED_MODIFIED_SHA256" "$actual" >&2
  exit 5
fi
rm -- "$TARGET"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  printf 'ROLLBACK_ERROR target_still_exists=%s\n' "$TARGET" >&2
  exit 6
fi
printf 'ROLLBACK_OK restored_status=absent original_sha256=%s target=%s\n' "$ORIGINAL_SHA256" "$TARGET"
