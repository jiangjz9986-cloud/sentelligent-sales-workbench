#!/usr/bin/env bash
# v0.8.0 draft: archive release bundles and acceptance evidence into the
# controlled server directory /opt/sentelligent-sales-workbench/backups/
# releases/<version>/ with per-file SHA-256 and a JSON manifest. The target
# version directory is immutable: re-running for an existing version fails.
# See docs/superpowers/research/2026-08-27-v080-backup-design.md.
set -Eeuo pipefail

umask 077

readonly PROJECT_ROOT="/opt/sentelligent-sales-workbench"
readonly BACKUP_CONTROLLED_ROOT="$PROJECT_ROOT/backups"
readonly RELEASE_ARCHIVE_ROOT="$BACKUP_CONTROLLED_ROOT/releases"
readonly ARCHIVE_LOCK="$PROJECT_ROOT/.archive-release-artifacts.lock"

RELEASE_VERSION="${RELEASE_VERSION:-}"
NODE_BIN="${NODE_BIN:-$PROJECT_ROOT/runtime/node-v24/bin/node}"

declare -a BUNDLE_FILES=()
declare -a EVIDENCE_DIRS=()

RUN_ID=""
STARTED_AT=""
TARGET_DIR=""
STAGING_DIR=""
MANIFEST_FILE=""
SHA256SUMS_FILE=""
ARCHIVE_LOCK_FD=""

archive_published=0

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy/archive-release-artifacts.sh [options]

Copies the given release bundle files and acceptance evidence directories
into /opt/sentelligent-sales-workbench/backups/releases/<version>/,
records SHA-256 for every archived file (SHA256SUMS + manifest.json), and
freezes the result as root-owned, mode 0700/0600. Existing version archives
are never overwritten.

Required:
  --version=<vX.Y.Z>       Release version, e.g. v0.8.0
  --bundle=<path>          Release bundle file (repeatable; at least one),
                           e.g. the immutable .tar.gz, SHA256SUMS,
                           release-result.json
  --evidence-dir=<path>    Acceptance evidence directory (repeatable; at
                           least one)

Optional:
  --node=<path>            Project Node.js 24+ executable
  --help                   Show this message

RELEASE_VERSION and NODE_BIN may also be supplied through the environment.
Bundle files and evidence directories must be passed as flags.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version=*) RELEASE_VERSION=${1#*=} ;;
      --version)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--version requires a value"
          return 1
        fi
        RELEASE_VERSION=$1
        ;;
      --bundle=*) BUNDLE_FILES+=("${1#*=}") ;;
      --bundle)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--bundle requires a value"
          return 1
        fi
        BUNDLE_FILES+=("$1")
        ;;
      --evidence-dir=*) EVIDENCE_DIRS+=("${1#*=}") ;;
      --evidence-dir)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--evidence-dir requires a value"
          return 1
        fi
        EVIDENCE_DIRS+=("$1")
        ;;
      --node=*) NODE_BIN=${1#*=} ;;
      --node)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--node requires a value"
          return 1
        fi
        NODE_BIN=$1
        ;;
      --help|-h)
        usage
        return 2
        ;;
      *)
        fail "Unknown argument: $1"
        return 1
        ;;
    esac
    shift
  done
}

validate_plain_absolute_path() {
  local path=$1
  local label=$2
  if [[ -z "$path" || "$path" != /* || "$path" == */ ||
    "$path" == *$'\n'* || "$path" == *$'\r'* || "$path" == *$'\t'* ||
    "$path" == *//* || "$path" == *'/./'* || "$path" == */. ||
    "$path" == *'/../'* || "$path" == */.. ]]; then
    fail "$label must be a normalized absolute path"
    return 1
  fi
}

validate_safe_basename() {
  local name=$1
  local label=$2
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
    fail "$label has an unsafe name: $name"
}

assert_no_symlinks_inside() {
  local directory=$1
  local label=$2
  if find "$directory" -type l -print -quit | grep -q .; then
    fail "$label contains a symbolic link"
  fi
}

assert_no_secret_like_files() {
  local directory=$1
  local label=$2
  local match
  match="$(find "$directory" -type f \( \
    -name 'backend.env' -o -name 'frontend.env' -o -name '*.env' \
    -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \
    -o -name 'id_rsa*' -o -name 'id_ed25519*' \
    \) -print -quit)"
  [[ -z "$match" ]] ||
    fail "$label contains a secret-like file; sanitize evidence first: $match"
}

validate_arguments() {
  [[ -n "$RELEASE_VERSION" ]] || fail "RELEASE_VERSION is required"
  [[ "$RELEASE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail "RELEASE_VERSION must look like v0.8.0"
  [[ "${#BUNDLE_FILES[@]}" -ge 1 ]] || fail "At least one --bundle is required"
  [[ "${#EVIDENCE_DIRS[@]}" -ge 1 ]] || fail "At least one --evidence-dir is required"
  [[ -n "$NODE_BIN" ]] || fail "NODE_BIN is required"
  validate_plain_absolute_path "$NODE_BIN" "Node executable"
  [[ "$NODE_BIN" == "$PROJECT_ROOT/runtime/"* ]] ||
    fail "Node executable must remain under the project runtime"

  local path base seen_names=" "
  for path in "${BUNDLE_FILES[@]}"; do
    validate_plain_absolute_path "$path" "Bundle file"
    base="$(basename "$path")"
    validate_safe_basename "$base" "Bundle file"
    if [[ "$seen_names" == *" bundle:$base "* ]]; then
      fail "Duplicate bundle name: $base"
      return 1
    fi
    seen_names="${seen_names}bundle:$base "
  done
  for path in "${EVIDENCE_DIRS[@]}"; do
    validate_plain_absolute_path "$path" "Evidence directory"
    base="$(basename "$path")"
    validate_safe_basename "$base" "Evidence directory"
    if [[ "$seen_names" == *" evidence:$base "* ]]; then
      fail "Duplicate evidence directory name: $base"
      return 1
    fi
    seen_names="${seen_names}evidence:$base "
  done
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

acquire_archive_lock() {
  command -v flock >/dev/null || fail "Required executable is missing: flock"
  [[ -d "$PROJECT_ROOT" && ! -L "$PROJECT_ROOT" ]] || fail "Project root is unavailable"
  [[ ! -L "$ARCHIVE_LOCK" ]] || fail "Archive lock must not be a symlink"
  if [[ -e "$ARCHIVE_LOCK" && ! -f "$ARCHIVE_LOCK" ]]; then
    fail "Archive lock must be a regular file"
    return 1
  fi
  exec 9>> "$ARCHIVE_LOCK"
  ARCHIVE_LOCK_FD=9
  [[ -f "$ARCHIVE_LOCK" && ! -L "$ARCHIVE_LOCK" ]] ||
    fail "Archive lock identity is unsafe"
  [[ "$ARCHIVE_LOCK" -ef "/proc/$$/fd/$ARCHIVE_LOCK_FD" ]] ||
    fail "Archive lock identity changed while opening"
  chmod 0600 "/proc/$$/fd/$ARCHIVE_LOCK_FD"
  flock -n "$ARCHIVE_LOCK_FD" || fail "Another artifact archive run is in progress"
}

prepare_runtime() {
  local executable path real node_real node_major
  local -a required_commands=(
    awk basename cmp cp date diff dirname find flock grep install mv
    realpath rm sha256sum sort stat
  )
  [[ "$(id -u)" -eq 0 ]] || fail "Release artifact archiving must run as root"
  for executable in "${required_commands[@]}"; do
    command -v "$executable" >/dev/null || fail "Required executable is missing: $executable"
  done
  acquire_archive_lock

  [[ -x "$NODE_BIN" ]] || fail "Project Node executable is unavailable"
  node_real="$(realpath -e "$NODE_BIN")"
  [[ "$node_real" == "$PROJECT_ROOT/runtime/"* ]] ||
    fail "Project Node executable resolved outside the runtime"
  NODE_BIN=$node_real
  node_major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
  [[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 24 ]] ||
    fail "Project Node.js 24 or newer is required"

  for path in "${BUNDLE_FILES[@]}"; do
    [[ -f "$path" && ! -L "$path" ]] || fail "Bundle file is unavailable: $path"
    real="$(realpath -e "$path")"
    [[ "$real" == "$path" ]] || fail "Bundle path is not canonical: $path"
    [[ -s "$path" ]] || fail "Bundle file is empty: $path"
  done
  for path in "${EVIDENCE_DIRS[@]}"; do
    [[ -d "$path" && ! -L "$path" ]] || fail "Evidence directory is unavailable: $path"
    real="$(realpath -e "$path")"
    [[ "$real" == "$path" ]] || fail "Evidence path is not canonical: $path"
    [[ "$path" != "$RELEASE_ARCHIVE_ROOT" &&
      "$path" != "$RELEASE_ARCHIVE_ROOT/"* ]] ||
      fail "Evidence directory must not live inside the archive root"
    assert_no_symlinks_inside "$path" "Evidence directory $path"
    assert_no_secret_like_files "$path" "Evidence directory $path"
  done

  install -d -o root -g root -m 0700 "$RELEASE_ARCHIVE_ROOT"
  [[ "$(realpath -e "$RELEASE_ARCHIVE_ROOT")" == "$RELEASE_ARCHIVE_ROOT" ]] ||
    fail "Release archive root is not canonical"

  STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"
  TARGET_DIR="$RELEASE_ARCHIVE_ROOT/$RELEASE_VERSION"
  [[ ! -e "$TARGET_DIR" && ! -L "$TARGET_DIR" ]] ||
    fail "Version archive already exists and is immutable: $TARGET_DIR"
  STAGING_DIR="$RELEASE_ARCHIVE_ROOT/.${RELEASE_VERSION}.staging-${RUN_ID}"
  [[ ! -e "$STAGING_DIR" && ! -L "$STAGING_DIR" ]] ||
    fail "Staging directory already exists: $STAGING_DIR"
}

stage_bundles() {
  local path base source_sha copy_sha target
  install -d -o root -g root -m 0700 "$STAGING_DIR/bundle"
  BUNDLE_MANIFEST_ROWS=""
  for path in "${BUNDLE_FILES[@]}"; do
    base="$(basename "$path")"
    target="$STAGING_DIR/bundle/$base"
    source_sha="$(sha256_file "$path")"
    cp -- "$path" "$target"
    chmod 0600 "$target"
    cmp --silent "$path" "$target" || fail "Bundle copy verification failed: $base"
    copy_sha="$(sha256_file "$target")"
    [[ "$copy_sha" == "$source_sha" ]] ||
      fail "Bundle hash changed during archiving: $base"
    BUNDLE_MANIFEST_ROWS+="$base"$'\t'"$path"$'\t'"$copy_sha"$'\t'"$(stat -c '%s' "$target")"$'\n'
  done
}

stage_evidence_directories() {
  local path base target
  install -d -o root -g root -m 0700 "$STAGING_DIR/evidence"
  EVIDENCE_MANIFEST_ROWS=""
  for path in "${EVIDENCE_DIRS[@]}"; do
    base="$(basename "$path")"
    target="$STAGING_DIR/evidence/$base"
    cp -R -- "$path" "$target"
    diff -r -q -- "$path" "$target" >/dev/null ||
      fail "Evidence copy verification failed: $base"
    assert_no_symlinks_inside "$target" "Staged evidence $base"
    EVIDENCE_MANIFEST_ROWS+="$base"$'\t'"$path"$'\n'
  done
}

freeze_staging_tree() {
  chown -R root:root "$STAGING_DIR"
  find "$STAGING_DIR" -type d -exec chmod 0700 {} +
  find "$STAGING_DIR" -type f -exec chmod 0600 {} +
}

write_sha256sums() {
  local temporary relative_file
  SHA256SUMS_FILE="$STAGING_DIR/SHA256SUMS"
  temporary="$STAGING_DIR/.SHA256SUMS.tmp.$$"
  [[ ! -e "$temporary" ]] || fail "SHA256SUMS temporary file already exists"
  : > "$temporary"
  chmod 0600 "$temporary"
  (
    cd "$STAGING_DIR"
    while IFS= read -r -d '' relative_file; do
      sha256sum "$relative_file" >> "$temporary"
    done < <(find bundle evidence -type f -print0 | LC_ALL=C sort -z)
  )
  [[ -s "$temporary" ]] || fail "SHA256SUMS generation produced no entries"
  mv -f "$temporary" "$SHA256SUMS_FILE"
  chmod 0600 "$SHA256SUMS_FILE"
}

write_archive_manifest() {
  MANIFEST_FILE="$STAGING_DIR/manifest.json"
  [[ ! -e "$MANIFEST_FILE" ]] || fail "Archive manifest already exists"
  MANIFEST_TARGET="$MANIFEST_FILE" ARCHIVE_STAGING_DIR="$STAGING_DIR" \
  ARCHIVE_VERSION="$RELEASE_VERSION" ARCHIVE_STARTED_AT="$STARTED_AT" \
  ARCHIVE_RUN_ID="$RUN_ID" ARCHIVE_TARGET_DIR="$TARGET_DIR" \
  ARCHIVE_SHA256SUMS="$SHA256SUMS_FILE" \
  BUNDLE_ROWS="$BUNDLE_MANIFEST_ROWS" EVIDENCE_ROWS="$EVIDENCE_MANIFEST_ROWS" \
    "$NODE_BIN" --input-type=module --eval '
      import {
        closeSync,
        fsyncSync,
        lstatSync,
        openSync,
        readFileSync,
        writeFileSync,
      } from "node:fs";
      import { join, relative } from "node:path";

      const stagingRoot = process.env.ARCHIVE_STAGING_DIR;
      const shaListPath = process.env.ARCHIVE_SHA256SUMS;
      const parseRows = (raw, fields) =>
        String(raw ?? "")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const parts = line.split("\t");
            if (parts.length !== fields.length) {
              throw new Error("Manifest source row is malformed");
            }
            return Object.fromEntries(
              fields.map((field, index) => [field, parts[index]]),
            );
          });
      const bundles = parseRows(process.env.BUNDLE_ROWS, [
        "name",
        "sourcePath",
        "sha256",
        "sizeBytes",
      ]).map((row) => ({
        name: row.name,
        sourcePath: row.sourcePath,
        sha256: row.sha256,
        sizeBytes: Number(row.sizeBytes),
      }));
      if (bundles.length === 0) throw new Error("Bundle inventory is empty");
      for (const bundle of bundles) {
        if (
          !/^[0-9a-f]{64}$/.test(bundle.sha256) ||
          !Number.isSafeInteger(bundle.sizeBytes) ||
          bundle.sizeBytes <= 0
        ) {
          throw new Error(`Bundle inventory entry is invalid: ${bundle.name}`);
        }
      }
      const evidenceDirs = parseRows(process.env.EVIDENCE_ROWS, [
        "name",
        "sourcePath",
      ]);
      if (evidenceDirs.length === 0) {
        throw new Error("Evidence inventory is empty");
      }

      const shaPattern = /^([0-9a-f]{64})  (\S.*)$/;
      const files = [];
      let totalBytes = 0;
      for (const line of readFileSync(shaListPath, "utf8").split("\n")) {
        if (line.length === 0) continue;
        const match = shaPattern.exec(line);
        if (!match) throw new Error("SHA256SUMS entry is malformed");
        const [, sha256, relativePath] = match;
        const fullPath = join(stagingRoot, relativePath);
        if (relative(stagingRoot, fullPath).startsWith("..")) {
          throw new Error(`SHA256SUMS entry escaped the archive: ${relativePath}`);
        }
        const stats = lstatSync(fullPath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`Archived entry is not a regular file: ${relativePath}`);
        }
        files.push({ path: relativePath, sha256, sizeBytes: stats.size });
        totalBytes += stats.size;
      }
      if (files.length === 0) throw new Error("Archive inventory is empty");

      const manifest = {
        schemaVersion: 1,
        product: "sentelligent-sales-workbench",
        kind: "release-artifact-archive",
        version: process.env.ARCHIVE_VERSION,
        runId: process.env.ARCHIVE_RUN_ID,
        archivedAt: process.env.ARCHIVE_STARTED_AT,
        archiveDir: process.env.ARCHIVE_TARGET_DIR,
        sources: { bundles, evidenceDirs },
        totals: { fileCount: files.length, totalBytes },
        sha256sums: "SHA256SUMS",
        files,
      };
      writeFileSync(
        process.env.MANIFEST_TARGET,
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      for (const path of [process.env.MANIFEST_TARGET, stagingRoot]) {
        const descriptor = openSync(path, "r");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
    '
  chmod 0600 "$MANIFEST_FILE"
}

publish_archive() {
  [[ ! -e "$TARGET_DIR" && ! -L "$TARGET_DIR" ]] ||
    fail "Version archive appeared during staging: $TARGET_DIR"
  mv -T "$STAGING_DIR" "$TARGET_DIR"
  archive_published=1
  SYNC_TARGET="$TARGET_DIR" "$NODE_BIN" --input-type=module --eval '
    import { closeSync, fsyncSync, openSync } from "node:fs";
    import { dirname } from "node:path";
    for (const path of [process.env.SYNC_TARGET, dirname(process.env.SYNC_TARGET)]) {
      const descriptor = openSync(path, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
  '
  MANIFEST_FILE="$TARGET_DIR/manifest.json"
  SHA256SUMS_FILE="$TARGET_DIR/SHA256SUMS"
  [[ -f "$MANIFEST_FILE" && -f "$SHA256SUMS_FILE" ]] ||
    fail "Published archive is missing its manifest inventory"
}

on_error() {
  local observed_status=$?
  local exit_code=${1:-$observed_status}
  local failure_line=${BASH_LINENO[0]:-0}
  trap - ERR HUP INT TERM
  set +e
  if [[ "$exit_code" -eq 0 ]]; then
    exit_code=1
  fi
  if [[ "$archive_published" -eq 0 && -n "$STAGING_DIR" && -d "$STAGING_DIR" &&
    "$STAGING_DIR" == "$RELEASE_ARCHIVE_ROOT/."*".staging-"* ]]; then
    rm -rf -- "$STAGING_DIR"
    printf 'CLEANED_STAGING_DIR=%s\n' "$STAGING_DIR" >&2
  fi
  printf 'ERROR: release artifact archiving failed at line %s (exit=%s)\n' \
    "$failure_line" "$exit_code" >&2
  printf 'ARCHIVE_STATUS=failed\n' >&2
  exit "$exit_code"
}

main() {
  local parse_status=0
  parse_arguments "$@" || parse_status=$?
  if [[ "$parse_status" -eq 2 ]]; then
    return 0
  fi
  [[ "$parse_status" -eq 0 ]] || return "$parse_status"
  validate_arguments
  prepare_runtime

  trap on_error ERR
  trap 'on_error 129' HUP
  trap 'on_error 130' INT
  trap 'on_error 143' TERM

  install -d -o root -g root -m 0700 "$STAGING_DIR"
  stage_bundles
  stage_evidence_directories
  freeze_staging_tree
  write_sha256sums
  write_archive_manifest
  publish_archive

  trap - ERR HUP INT TERM
  printf 'ARCHIVE_STATUS=passed\n'
  printf 'STARTED_AT=%s\n' "$STARTED_AT"
  printf 'ARCHIVE_DIR=%s\n' "$TARGET_DIR"
  printf 'BUNDLE_COUNT=%s\n' "${#BUNDLE_FILES[@]}"
  printf 'EVIDENCE_DIR_COUNT=%s\n' "${#EVIDENCE_DIRS[@]}"
  printf 'SHA256SUMS=%s\n' "$SHA256SUMS_FILE"
  printf 'MANIFEST=%s\n' "$MANIFEST_FILE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
