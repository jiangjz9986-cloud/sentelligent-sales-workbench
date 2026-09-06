#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIGINAL_FILE="${SCRIPT_DIR}/ORIGINAL_v0.10.3.md"
DEFAULT_TARGET="${SCRIPT_DIR}/../../v0.10.3.md"
TARGET="${1:-${DEFAULT_TARGET}}"
EXPECTED_ORIGINAL_SHA256="a61eaeb099cdf50aef18f01f2a879065acc989c870da312a2b6a52cc0439d04c"
EXPECTED_MODIFIED_SHA256="fa3222ed8ebe369bef7b227d30586ace29849b47afa13d1bbcc6cbd7b23e7de9"

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

if [[ ! -f "${ORIGINAL_FILE}" ]]; then
  echo "ROLLBACK_ERROR=original artifact missing" >&2
  exit 2
fi
if [[ ! -f "${TARGET}" ]]; then
  echo "ROLLBACK_ERROR=target missing: ${TARGET}" >&2
  exit 3
fi

original_hash="$(sha256_file "${ORIGINAL_FILE}")"
before_hash="$(sha256_file "${TARGET}")"

echo "ROLLBACK_TARGET=${TARGET}"
echo "ROLLBACK_INPUT_EXPECTED_MODIFIED_SHA256=${EXPECTED_MODIFIED_SHA256}"
echo "ROLLBACK_BEFORE_SHA256=${before_hash}"
echo "ROLLBACK_EXPECTED_ORIGINAL_SHA256=${EXPECTED_ORIGINAL_SHA256}"

if [[ "${original_hash}" != "${EXPECTED_ORIGINAL_SHA256}" ]]; then
  echo "ROLLBACK_ERROR=original artifact hash mismatch" >&2
  exit 4
fi
if [[ "${before_hash}" != "${EXPECTED_MODIFIED_SHA256}" ]]; then
  echo "ROLLBACK_ERROR=target is not the verified modified document" >&2
  exit 5
fi

tmp="$(mktemp "${TARGET}.rollback.XXXXXX")"
cleanup() {
  if [[ -e "${tmp}" ]]; then
    unlink "${tmp}"
  fi
}
trap cleanup EXIT

cp "${ORIGINAL_FILE}" "${tmp}"
chmod 0644 "${tmp}"
mv "${tmp}" "${TARGET}"
trap - EXIT

after_hash="$(sha256_file "${TARGET}")"
set +e
cmp -s "${TARGET}" "${ORIGINAL_FILE}"
cmp_exit=$?
set -e

echo "ROLLBACK_AFTER_SHA256=${after_hash}"
echo "ROLLBACK_CMP_EXIT=${cmp_exit}"
if [[ "${after_hash}" != "${EXPECTED_ORIGINAL_SHA256}" || "${cmp_exit}" -ne 0 ]]; then
  echo "ROLLBACK_ERROR=restored target verification failed" >&2
  exit 6
fi

echo "RESTORED_BEHAVIOR=release document returned to the frozen pre-evidence state with deployment and production-acceptance placeholders"
echo "RESTORED_STATUS=original release document restored byte-for-byte"
echo "FORMAL_FILE_STATUS=unchanged unless it was supplied as the rollback target"
echo "EXIT_STATUS=0"
