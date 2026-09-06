#!/usr/bin/env bash
# v0.8.0 draft: daily online SQLite backup for the production sales workbench.
# Designed to run as a root oneshot service triggered by
# sentelligent-daily-backup.timer at 02:30 Asia/Shanghai. See
# docs/superpowers/research/2026-08-27-v080-backup-design.md for the full
# installation, acceptance, and rollback procedure.
set -Eeuo pipefail

umask 077

readonly PROJECT_ROOT="/opt/sentelligent-sales-workbench"
readonly DATABASE_ROOT="/var/lib/sentelligent-sales-workbench"
readonly BACKUP_CONTROLLED_ROOT="$PROJECT_ROOT/backups"
readonly DEFAULT_DATABASE_PATH="$DATABASE_ROOT/sales-workbench.sqlite"
readonly DEFAULT_BACKUP_ROOT="$BACKUP_CONTROLLED_ROOT/daily"
readonly DEFAULT_RETENTION_DAYS=14
readonly BACKUP_BASENAME_PREFIX="sales-workbench-daily-"
readonly BACKUP_BASENAME_SUFFIX=".sqlite"
readonly DAILY_BACKUP_LOCK="$PROJECT_ROOT/.daily-db-backup.lock"

DATABASE_PATH="${DATABASE_PATH:-$DEFAULT_DATABASE_PATH}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEFAULT_BACKUP_ROOT}"
RETENTION_DAYS="${RETENTION_DAYS:-$DEFAULT_RETENTION_DAYS}"
NODE_BIN="${NODE_BIN:-$PROJECT_ROOT/runtime/node-v24/bin/node}"

RUN_ID=""
STARTED_AT=""
BACKUP_FILE=""
BACKUP_SHA256=""
BACKUP_SIZE_BYTES=""
MANIFEST_FILE=""
PRUNED_COUNT=0
DAILY_BACKUP_LOCK_FD=""

backup_verified=0

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy/daily-db-backup.sh [options]

Creates one online consistency snapshot of the production SQLite database
(VACUUM INTO over a read-only node:sqlite connection), verifies its
integrity, records SHA-256 plus a JSON manifest, and prunes snapshots older
than the retention window.

Optional:
  --database=<path>        Live SQLite database
                           (default /var/lib/sentelligent-sales-workbench/sales-workbench.sqlite)
  --backup-dir=<path>      Backup output directory under the controlled
                           backups root (default /opt/sentelligent-sales-workbench/backups/daily)
  --retention-days=<n>     Days of daily snapshots to keep (default 14)
  --node=<path>            Project Node.js 24+ executable
  --help                   Show this message

The same values may be supplied through DATABASE_PATH, BACKUP_ROOT,
RETENTION_DAYS, and NODE_BIN.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --database=*) DATABASE_PATH=${1#*=} ;;
      --database)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--database requires a value"
          return 1
        fi
        DATABASE_PATH=$1
        ;;
      --backup-dir=*) BACKUP_ROOT=${1#*=} ;;
      --backup-dir)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--backup-dir requires a value"
          return 1
        fi
        BACKUP_ROOT=$1
        ;;
      --retention-days=*) RETENTION_DAYS=${1#*=} ;;
      --retention-days)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--retention-days requires a value"
          return 1
        fi
        RETENTION_DAYS=$1
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

validate_arguments() {
  [[ -n "$DATABASE_PATH" ]] || fail "DATABASE_PATH is required"
  [[ -n "$BACKUP_ROOT" ]] || fail "BACKUP_ROOT is required"
  [[ -n "$RETENTION_DAYS" ]] || fail "RETENTION_DAYS is required"
  [[ -n "$NODE_BIN" ]] || fail "NODE_BIN is required"

  validate_plain_absolute_path "$DATABASE_PATH" "Database path"
  [[ "$DATABASE_PATH" == "$DATABASE_ROOT/"* ]] ||
    fail "Database path must remain under $DATABASE_ROOT"
  validate_plain_absolute_path "$BACKUP_ROOT" "Backup directory"
  [[ "$BACKUP_ROOT" == "$BACKUP_CONTROLLED_ROOT" ||
    "$BACKUP_ROOT" == "$BACKUP_CONTROLLED_ROOT/"* ]] ||
    fail "Backup directory must remain under $BACKUP_CONTROLLED_ROOT"
  [[ "$RETENTION_DAYS" =~ ^[1-9][0-9]{0,3}$ ]] ||
    fail "RETENTION_DAYS must be a positive integer"
  validate_plain_absolute_path "$NODE_BIN" "Node executable"
  [[ "$NODE_BIN" == "$PROJECT_ROOT/runtime/"* ]] ||
    fail "Node executable must remain under the project runtime"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

acquire_backup_lock() {
  command -v flock >/dev/null || fail "Required executable is missing: flock"
  [[ -d "$PROJECT_ROOT" && ! -L "$PROJECT_ROOT" ]] || fail "Project root is unavailable"
  [[ ! -L "$DAILY_BACKUP_LOCK" ]] || fail "Daily backup lock must not be a symlink"
  if [[ -e "$DAILY_BACKUP_LOCK" && ! -f "$DAILY_BACKUP_LOCK" ]]; then
    fail "Daily backup lock must be a regular file"
    return 1
  fi
  exec 9>> "$DAILY_BACKUP_LOCK"
  DAILY_BACKUP_LOCK_FD=9
  [[ -f "$DAILY_BACKUP_LOCK" && ! -L "$DAILY_BACKUP_LOCK" ]] ||
    fail "Daily backup lock identity is unsafe"
  [[ "$DAILY_BACKUP_LOCK" -ef "/proc/$$/fd/$DAILY_BACKUP_LOCK_FD" ]] ||
    fail "Daily backup lock identity changed while opening"
  chmod 0600 "/proc/$$/fd/$DAILY_BACKUP_LOCK_FD"
  flock -n "$DAILY_BACKUP_LOCK_FD" || fail "Another daily backup is already running"
}

prepare_runtime() {
  local executable database_real node_real node_major
  local -a required_commands=(
    awk basename date df dirname find flock grep install mv
    readlink realpath rm sha256sum sort stat
  )
  [[ "$(id -u)" -eq 0 ]] || fail "Daily database backup must run as root"
  for executable in "${required_commands[@]}"; do
    command -v "$executable" >/dev/null || fail "Required executable is missing: $executable"
  done
  acquire_backup_lock

  [[ -f "$DATABASE_PATH" && ! -L "$DATABASE_PATH" ]] || fail "Database is unavailable"
  database_real="$(realpath -e "$DATABASE_PATH")"
  [[ "$database_real" == "$DATABASE_PATH" ]] || fail "Database path is not canonical"
  [[ ! -e "$DATABASE_PATH.maintenance-lock" ]] ||
    fail "Database maintenance lock exists; refusing to back up during maintenance"

  [[ -x "$NODE_BIN" ]] || fail "Project Node executable is unavailable"
  node_real="$(realpath -e "$NODE_BIN")"
  [[ "$node_real" == "$PROJECT_ROOT/runtime/"* ]] ||
    fail "Project Node executable resolved outside the runtime"
  NODE_BIN=$node_real
  node_major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
  [[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 24 ]] ||
    fail "Project Node.js 24 or newer is required"

  install -d -o root -g root -m 0700 "$BACKUP_ROOT"
  [[ "$(realpath -e "$BACKUP_ROOT")" == "$BACKUP_ROOT" ]] ||
    fail "Backup directory is not canonical"

  STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  BACKUP_FILE="$BACKUP_ROOT/${BACKUP_BASENAME_PREFIX}${RUN_ID}${BACKUP_BASENAME_SUFFIX}"
  MANIFEST_FILE="$BACKUP_ROOT/manifest.json"
  [[ ! -e "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] ||
    fail "Backup target already exists: $BACKUP_FILE"
}

assert_disk_headroom() {
  local database_bytes free_kib needed_kib
  database_bytes="$(stat -c '%s' "$DATABASE_PATH")"
  [[ "$database_bytes" =~ ^[0-9]+$ ]] || fail "Unable to determine database size"
  free_kib="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
  [[ "$free_kib" =~ ^[0-9]+$ ]] ||
    fail "Unable to determine free disk space for $BACKUP_ROOT"
  needed_kib=$(( database_bytes / 1024 * 2 + 51200 ))
  [[ "$free_kib" -ge "$needed_kib" ]] ||
    fail "Insufficient disk space for backup: need ${needed_kib} KiB, have ${free_kib} KiB"
}

create_online_snapshot() {
  # Same online consistency snapshot the cutover rehearsal takes against the
  # live WAL database: read-only node:sqlite connection plus VACUUM INTO.
  SOURCE_DATABASE="$DATABASE_PATH" TARGET_DATABASE="$BACKUP_FILE" \
    "$NODE_BIN" --input-type=module --eval '
      import { DatabaseSync } from "node:sqlite";
      const source = new DatabaseSync(process.env.SOURCE_DATABASE, { readOnly: true });
      try {
        source.exec("PRAGMA busy_timeout = 5000");
        source.prepare("VACUUM INTO ?").run(process.env.TARGET_DATABASE);
      } finally {
        source.close();
      }
    '
  [[ -s "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] || fail "Backup snapshot is unavailable"
  chmod 0600 "$BACKUP_FILE"
  [[ ! "$DATABASE_PATH" -ef "$BACKUP_FILE" ]] ||
    fail "Backup snapshot is not isolated from production"
}

verify_sqlite_integrity() {
  local database_path=$1
  local label=$2
  VERIFY_DATABASE="$database_path" VERIFY_DATABASE_LABEL="$label" \
    "$NODE_BIN" --input-type=module --eval '
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(process.env.VERIFY_DATABASE, { readOnly: true });
      try {
        const quick = database.prepare("PRAGMA quick_check").all();
        const foreign = database.prepare("PRAGMA foreign_key_check").all();
        if (quick.length !== 1 || quick[0].quick_check !== "ok") {
          throw new Error(`${process.env.VERIFY_DATABASE_LABEL} quick_check integrity verification failed`);
        }
        if (foreign.length !== 0) {
          throw new Error(`${process.env.VERIFY_DATABASE_LABEL} foreign key integrity verification failed`);
        }
      } finally {
        database.close();
      }
    '
}

fsync_path_and_parent() {
  SYNC_TARGET="$1" "$NODE_BIN" --input-type=module --eval '
    import { closeSync, fsyncSync, openSync } from "node:fs";
    import { dirname } from "node:path";
    for (const path of [process.env.SYNC_TARGET, dirname(process.env.SYNC_TARGET)]) {
      const descriptor = openSync(path, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
  '
}

record_backup_hash() {
  local sidecar temporary
  BACKUP_SHA256="$(sha256_file "$BACKUP_FILE")"
  [[ "$BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "Backup hash failed"
  BACKUP_SIZE_BYTES="$(stat -c '%s' "$BACKUP_FILE")"
  sidecar="${BACKUP_FILE}.sha256"
  temporary="${sidecar}.tmp.$$"
  [[ ! -e "$temporary" ]] || fail "Hash sidecar temporary file already exists"
  printf '%s  %s\n' "$BACKUP_SHA256" "$(basename "$BACKUP_FILE")" > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$sidecar"
  chmod 0600 "$sidecar"
}

prune_expired_backups() {
  local cutoff_date entry base name_body entry_date
  cutoff_date="$(date -u -d "$RETENTION_DAYS days ago" +%Y-%m-%d)" ||
    fail "GNU date is required to compute the retention cutoff"
  [[ "$cutoff_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
    fail "Retention cutoff date is invalid"

  PRUNED_COUNT=0
  while IFS= read -r -d '' entry; do
    base="$(basename "$entry")"
    name_body="${base#"$BACKUP_BASENAME_PREFIX"}"
    entry_date="${name_body:0:10}"
    if [[ ! "$entry_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      printf 'WARNING: skipping unrecognized backup name: %s\n' "$base" >&2
      continue
    fi
    if [[ "$entry_date" < "$cutoff_date" ]]; then
      rm -f -- "$entry" "${entry}.sha256"
      PRUNED_COUNT=$((PRUNED_COUNT + 1))
      printf 'PRUNED_BACKUP=%s\n' "$base"
    fi
  done < <(find "$BACKUP_ROOT" -maxdepth 1 -type f \
    -name "${BACKUP_BASENAME_PREFIX}*${BACKUP_BASENAME_SUFFIX}" -print0 |
    LC_ALL=C sort -z)
}

write_backup_manifest() {
  local temporary="${MANIFEST_FILE}.tmp.$$"
  [[ ! -e "$temporary" ]] || fail "Manifest temporary file already exists"
  MANIFEST_TARGET="$temporary" BACKUP_ROOT_DIR="$BACKUP_ROOT" \
  BACKUP_PREFIX="$BACKUP_BASENAME_PREFIX" BACKUP_SUFFIX="$BACKUP_BASENAME_SUFFIX" \
  LATEST_BACKUP_NAME="$(basename "$BACKUP_FILE")" SOURCE_DATABASE="$DATABASE_PATH" \
  MANIFEST_GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  MANIFEST_RETENTION_DAYS="$RETENTION_DAYS" \
    "$NODE_BIN" --input-type=module --eval '
      import { createHash } from "node:crypto";
      import {
        closeSync,
        fsyncSync,
        lstatSync,
        openSync,
        readFileSync,
        readSync,
        readdirSync,
        writeFileSync,
      } from "node:fs";
      import { join } from "node:path";

      const root = process.env.BACKUP_ROOT_DIR;
      const prefix = process.env.BACKUP_PREFIX;
      const suffix = process.env.BACKUP_SUFFIX;
      const retentionDays = Number(process.env.MANIFEST_RETENTION_DAYS);
      if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
        throw new Error("Manifest retention days are invalid");
      }
      const hashFile = (path) => {
        const hash = createHash("sha256");
        const descriptor = openSync(path, "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let bytes;
          while ((bytes = readSync(descriptor, buffer, 0, buffer.length)) > 0) {
            hash.update(buffer.subarray(0, bytes));
          }
        } finally {
          closeSync(descriptor);
        }
        return hash.digest("hex");
      };
      const entries = [];
      for (const name of readdirSync(root).sort().reverse()) {
        if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
        const path = join(root, name);
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`Backup entry is not a regular file: ${name}`);
        }
        let sha256 = null;
        try {
          const sidecar = readFileSync(`${path}.sha256`, "utf8");
          const match = /^([0-9a-f]{64})[ \t]/.exec(sidecar);
          if (match) sha256 = match[1];
        } catch {
          sha256 = null;
        }
        if (!sha256) sha256 = hashFile(path);
        entries.push({
          file: name,
          sizeBytes: stats.size,
          sha256,
          modifiedAt: stats.mtime.toISOString(),
        });
      }
      const latest = entries.find(
        (entry) => entry.file === process.env.LATEST_BACKUP_NAME,
      );
      if (!latest) {
        throw new Error("Latest backup is missing from the manifest inventory");
      }
      const manifest = {
        schemaVersion: 1,
        product: "sentelligent-sales-workbench",
        kind: "daily-database-backup-manifest",
        generatedAt: process.env.MANIFEST_GENERATED_AT,
        database: process.env.SOURCE_DATABASE,
        backupRoot: root,
        retentionDays,
        latest,
        entries,
      };
      writeFileSync(
        process.env.MANIFEST_TARGET,
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      const descriptor = openSync(process.env.MANIFEST_TARGET, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    '
  chmod 0600 "$temporary"
  mv -f "$temporary" "$MANIFEST_FILE"
  chmod 0600 "$MANIFEST_FILE"
  fsync_path_and_parent "$MANIFEST_FILE"
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
  if [[ -n "$BACKUP_FILE" && "$backup_verified" -eq 0 && -f "$BACKUP_FILE" ]]; then
    rm -f -- "$BACKUP_FILE" "${BACKUP_FILE}.sha256"
    printf 'CLEANED_PARTIAL_BACKUP=%s\n' "$BACKUP_FILE" >&2
  fi
  printf 'ERROR: daily database backup failed at line %s (exit=%s)\n' \
    "$failure_line" "$exit_code" >&2
  printf 'DAILY_BACKUP_STATUS=failed\n' >&2
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

  assert_disk_headroom
  create_online_snapshot
  verify_sqlite_integrity "$BACKUP_FILE" "Daily database backup"
  fsync_path_and_parent "$BACKUP_FILE"
  record_backup_hash
  backup_verified=1
  prune_expired_backups
  write_backup_manifest

  trap - ERR HUP INT TERM
  printf 'DAILY_BACKUP_STATUS=passed\n'
  printf 'STARTED_AT=%s\n' "$STARTED_AT"
  printf 'BACKUP_FILE=%s\n' "$BACKUP_FILE"
  printf 'BACKUP_SHA256=%s\n' "$BACKUP_SHA256"
  printf 'BACKUP_SIZE_BYTES=%s\n' "$BACKUP_SIZE_BYTES"
  printf 'PRUNED_COUNT=%s\n' "$PRUNED_COUNT"
  printf 'MANIFEST=%s\n' "$MANIFEST_FILE"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
