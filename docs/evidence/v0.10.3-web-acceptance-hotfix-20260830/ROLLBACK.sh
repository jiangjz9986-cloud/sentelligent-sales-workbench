#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf 'Usage: %s TARGET_ROOT\n' "$0" >&2
  exit 64
fi

TARGET_ROOT=$1
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIFF_ARCHIVE="$SCRIPT_DIR/DIFF_FILE"
EXPECTED_DIFF_ARCHIVE_SHA256='f2e64152b06845f40e8a6cb1a0acda43b36d5a94b4ace4d95cec3adaf0a59eb1'
EXPECTED_RAW_PATCH_SHA256='bc39553b0f82a530d9eb3e0f5d95a178168188730bf950b1bab1a0b8ca21096c'
RAW_PATCH=$(mktemp "${TMPDIR:-/tmp}/v0103-web-hotfix-rollback.XXXXXX")
trap 'rm -f "$RAW_PATCH"' EXIT HUP INT TERM

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_hash() {
  relative_path=$1
  expected=$2
  actual=$(sha256_file "$TARGET_ROOT/$relative_path")
  if [ "$actual" != "$expected" ]; then
    printf 'HASH_MISMATCH path=%s expected=%s actual=%s\n' "$relative_path" "$expected" "$actual" >&2
    exit 65
  fi
}

archive_sha=$(sha256_file "$DIFF_ARCHIVE")
if [ "$archive_sha" != "$EXPECTED_DIFF_ARCHIVE_SHA256" ]; then
  printf 'DIFF_ARCHIVE_HASH_MISMATCH expected=%s actual=%s\n' "$EXPECTED_DIFF_ARCHIVE_SHA256" "$archive_sha" >&2
  exit 66
fi
gzip -t "$DIFF_ARCHIVE"
gzip -dc "$DIFF_ARCHIVE" > "$RAW_PATCH"
raw_patch_sha=$(sha256_file "$RAW_PATCH")
if [ "$raw_patch_sha" != "$EXPECTED_RAW_PATCH_SHA256" ]; then
  printf 'RAW_PATCH_HASH_MISMATCH expected=%s actual=%s\n' "$EXPECTED_RAW_PATCH_SHA256" "$raw_patch_sha" >&2
  exit 67
fi

verify_hash 'backend/src/assistant/router.js' 'dbebde83ec6d0249576f386ad99ccb4697ec071ab11407e24be30713fa9f7f63'
verify_hash 'backend/src/assistant/webChannel.js' '378e60c706e861a3d53e0ba23f2373577e4b27b2256d7f2dcc3ec924980a156f'
verify_hash 'outputs/product-design-prototype/src/app/useAssistantChat.js' 'fb71fd1d74ed4c17e15393201b9e1ca22b6f2874bd7e9dc1d3ee47095f1a9897'
verify_hash 'backend/tests/assistant-router.test.js' 'ac5f3ca33f7af73f4d9e03190829e539be52f3fd0c485f2e79add58be0a95f4a'
verify_hash 'backend/tests/assistant-web-http-integration.test.js' '9633f4494b20fa4ffa2c1d452374ca7d2718689da01795d770e20f46fc828982'
verify_hash 'backend/tests/assistant-web-orchestrator.test.js' '478725f3adc4aff4980717689dfee469827f11ffa965683cc08f320cb9559a38'
verify_hash 'outputs/product-design-prototype/scripts/assistant-chat.test.mjs' 'a3dfa363f90c26ac451c0a53c71106c32acf9cba25dc74bd3272fd5b5fadf6d9'

(
  cd "$TARGET_ROOT"
  git apply --no-index --reverse --check --whitespace=nowarn "$RAW_PATCH"
  git apply --no-index --reverse --whitespace=nowarn "$RAW_PATCH"
)

verify_hash 'backend/src/assistant/router.js' '7c10ff6a0544b7b9e9a89cd2e56cebba40c46aed76aafe6274fc5058e67b3277'
verify_hash 'backend/src/assistant/webChannel.js' 'c38a631ae480be58420683457dd9c498a2a61e9f2265a3ad2c384ddd6f2ff5d3'
verify_hash 'outputs/product-design-prototype/src/app/useAssistantChat.js' 'c65a22b8d04c70fd304e533a4feaa31ffccc3a68a96510987fd6ae595b511ba9'
verify_hash 'backend/tests/assistant-router.test.js' '29ab624381673c6b592e1d3d0366c0dbeffbcacdf6ce5aa97f734cc6769f2155'
verify_hash 'backend/tests/assistant-web-http-integration.test.js' '2cd25cb0bc30fb12c3a71ffb36091ca4febedda4784243b493f2ab06d1a215dc'
verify_hash 'backend/tests/assistant-web-orchestrator.test.js' '03317beb17dcf86c6736c7b41fc25ff43decda468badcfb22be0a04144a03d7c'
verify_hash 'outputs/product-design-prototype/scripts/assistant-chat.test.mjs' 'b16fd756f05d185604e8ea0557b46fc1dda7d390d8dfad774ee71bcd47214624'

printf '%s\n' \
  'ROLLBACK_OK restored=7/7' \
  "DIFF_ARCHIVE_SHA256=$archive_sha" \
  "RAW_PATCH_SHA256=$raw_patch_sha" \
  'RESTORED_BEHAVIOR=original v0.10.3 routing, web allow decision, nested response shape, and toast-only 403 behavior' \
  "TARGET_ROOT=$TARGET_ROOT"
