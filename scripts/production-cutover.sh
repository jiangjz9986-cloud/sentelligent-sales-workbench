#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly PROJECT_ROOT="/opt/sentelligent-sales-workbench"
readonly RELEASES_ROOT="$PROJECT_ROOT/releases"
readonly CURRENT_LINK="$PROJECT_ROOT/current"
readonly SYSTEMD_UNIT_ROOT="/etc/systemd/system"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly DATABASE_ROOT="/var/lib/sentelligent-sales-workbench"
readonly FRONTEND_ENV="$PROJECT_ROOT/config/frontend.env"
readonly CUTOVER_LOCK="$PROJECT_ROOT/.production-cutover.lock"

readonly -a PROJECT_SERVICES=(
  "sentelligent-backend.service"
  "sentelligent-frontend.service"
  "sentelligent-weixin-agent.service"
)
readonly -a SYSTEMCTL_MUTATING_ACTIONS=(
  "stop"
  "restart"
)
readonly -a PROTECTED_SERVICES=(
  "sentelligent-caddy.service"
  "codex-account-vault-cloud.service"
  "qingyang-store.service"
  "codex-vault-mihomo.service"
)
readonly -a PROTECTED_PORTS=(
  "80"
  "443"
  "4876"
  "8797"
)

NEW_RELEASE="${NEW_RELEASE:-}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
DATABASE_PATH="${DATABASE_PATH:-}"
BACKUP_DIR="${BACKUP_DIR:-}"
EVIDENCE_DIR="${EVIDENCE_DIR:-}"
WEIXIN_SESSION_DIR="${WEIXIN_SESSION_DIR:-}"
NODE_BIN="${NODE_BIN:-$PROJECT_ROOT/runtime/node-v24/bin/node}"
PREFLIGHT_REPORT="${PREFLIGHT_REPORT:-}"
PREFLIGHT_REPORT_SHA256="${PREFLIGHT_REPORT_SHA256:-}"

OLD_RELEASE=""
RUN_ID=""
RUN_BACKUP_DIR=""
RUN_EVIDENCE_DIR=""
UNIT_BACKUP_DIR=""
STAGED_UNIT_DIR=""
CUTOVER_LOG=""
EVIDENCE_REPORT=""
FRONTEND_ENV_BACKUP=""
STAGED_FRONTEND_ENV=""
MAINTENANCE_LOCK=""
MAINTENANCE_LOCK_SHA=""
CURRENT_TEMPORARY=""
PROTECTED_BEFORE=""
PROTECTED_AFTER=""
PROTECTED_ROLLBACK=""
PROTECTED_BEFORE_SHA=""
PROTECTED_AFTER_SHA=""
FINAL_BACKUP=""
FINAL_BACKUP_SHA=""
WEIXIN_BACKUP=""
WEIXIN_BACKUP_SHA=""
STARTED_AT=""
FAILURE_LINE=""
CUTOVER_LOCK_FD=""

mutation_started=0
services_stopped=0
maintenance_lock_created=0
unit_backups_ready=0
unit_install_started=0
frontend_config_backup_ready=0
frontend_config_install_started=0
current_switched=0
protected_snapshot_ready=0
cutover_complete=0

usage() {
  cat <<'EOF'
Usage: bash scripts/production-cutover.sh [options]

Required:
  --new-release=<path>       Immutable release directory
  --expected-commit=<sha>    Exact 40-character lowercase Git commit
  --database=<path>          Live SQLite database
  --backup-dir=<path>        Controlled backup output root
  --evidence-dir=<path>      Controlled evidence output root
  --weixin-session-dir=<path> WeChat session state directory
  --preflight-report=<path>  Fresh passed 24/24 production preflight report
  --preflight-report-sha256=<sha256> Exact report SHA-256

Optional:
  --node=<path>              Project Node.js 24+ executable
  --help                     Show this message

The same values may be supplied through NEW_RELEASE, EXPECTED_COMMIT,
DATABASE_PATH, BACKUP_DIR, EVIDENCE_DIR, WEIXIN_SESSION_DIR, NODE_BIN,
PREFLIGHT_REPORT, and PREFLIGHT_REPORT_SHA256.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

array_contains() {
  local expected=$1
  shift
  local item
  for item in "$@"; do
    if [[ "$item" == "$expected" ]]; then
      return 0
    fi
  done
  return 1
}

systemctl_mutate() {
  local action=${1:-}
  local service=${2:-}
  if ! array_contains "$action" "${SYSTEMCTL_MUTATING_ACTIONS[@]}" ||
    ! array_contains "$service" "${PROJECT_SERVICES[@]}"; then
    fail "Refusing systemctl mutation: action=${action:-missing} unit=${service:-missing}"
    return 1
  fi
  if [[ $# -ne 2 ]]; then
    fail "Refusing systemctl mutation with extra arguments"
    return 1
  fi
  systemctl "$action" "$service"
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --new-release=*) NEW_RELEASE=${1#*=} ;;
      --new-release)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--new-release requires a value"
          return 1
        fi
        NEW_RELEASE=$1
        ;;
      --expected-commit=*) EXPECTED_COMMIT=${1#*=} ;;
      --expected-commit)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--expected-commit requires a value"
          return 1
        fi
        EXPECTED_COMMIT=$1
        ;;
      --database=*) DATABASE_PATH=${1#*=} ;;
      --database)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--database requires a value"
          return 1
        fi
        DATABASE_PATH=$1
        ;;
      --backup-dir=*) BACKUP_DIR=${1#*=} ;;
      --backup-dir)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--backup-dir requires a value"
          return 1
        fi
        BACKUP_DIR=$1
        ;;
      --evidence-dir=*) EVIDENCE_DIR=${1#*=} ;;
      --evidence-dir)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--evidence-dir requires a value"
          return 1
        fi
        EVIDENCE_DIR=$1
        ;;
      --weixin-session-dir=*) WEIXIN_SESSION_DIR=${1#*=} ;;
      --weixin-session-dir)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--weixin-session-dir requires a value"
          return 1
        fi
        WEIXIN_SESSION_DIR=$1
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
      --preflight-report=*) PREFLIGHT_REPORT=${1#*=} ;;
      --preflight-report)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--preflight-report requires a value"
          return 1
        fi
        PREFLIGHT_REPORT=$1
        ;;
      --preflight-report-sha256=*) PREFLIGHT_REPORT_SHA256=${1#*=} ;;
      --preflight-report-sha256)
        shift
        if [[ $# -eq 0 ]]; then
          fail "--preflight-report-sha256 requires a value"
          return 1
        fi
        PREFLIGHT_REPORT_SHA256=$1
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

validate_release_path_syntax() {
  local candidate=$1
  validate_plain_absolute_path "$candidate" "Release path" || return 1
  if [[ "$candidate" != "$RELEASES_ROOT/"* ]]; then
    fail "Release path must be under the releases root"
    return 1
  fi
  local release_name=${candidate#"$RELEASES_ROOT/"}
  if [[ -z "$release_name" || "$release_name" == */* ||
    ! "$release_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    fail "Release path must be a safe direct child of the releases root"
    return 1
  fi
}

validate_controlled_output_path() {
  local path=$1
  local root=$2
  local label=$3
  validate_plain_absolute_path "$path" "$label" || return 1
  if [[ "$path" != "$root" && "$path" != "$root/"* ]]; then
    fail "$label must remain under $root"
    return 1
  fi
}

paths_overlap() {
  local first=$1
  local second=$2
  [[ "$first" == "$second" || "$first" == "$second/"* || "$second" == "$first/"* ]]
}

validate_state_path_isolation() {
  if paths_overlap "$BACKUP_DIR" "$EVIDENCE_DIR" ||
    paths_overlap "$BACKUP_DIR" "$WEIXIN_SESSION_DIR" ||
    paths_overlap "$EVIDENCE_DIR" "$WEIXIN_SESSION_DIR"; then
    fail "Backup, evidence, and WeChat state paths overlap"
    return 1
  fi
}

validate_arguments() {
  [[ -n "$NEW_RELEASE" ]] || fail "NEW_RELEASE is required"
  [[ -n "$EXPECTED_COMMIT" ]] || fail "EXPECTED_COMMIT is required"
  [[ -n "$DATABASE_PATH" ]] || fail "DATABASE_PATH is required"
  [[ -n "$BACKUP_DIR" ]] || fail "BACKUP_DIR is required"
  [[ -n "$EVIDENCE_DIR" ]] || fail "EVIDENCE_DIR is required"
  [[ -n "$WEIXIN_SESSION_DIR" ]] || fail "WEIXIN_SESSION_DIR is required"
  [[ -n "$NODE_BIN" ]] || fail "NODE_BIN is required"
  [[ -n "$PREFLIGHT_REPORT" ]] || fail "PREFLIGHT_REPORT is required"
  [[ -n "$PREFLIGHT_REPORT_SHA256" ]] || fail "PREFLIGHT_REPORT_SHA256 is required"

  validate_release_path_syntax "$NEW_RELEASE"
  [[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] ||
    fail "EXPECTED_COMMIT must be exactly 40 lowercase hexadecimal characters"
  validate_plain_absolute_path "$DATABASE_PATH" "Database path"
  [[ "$DATABASE_PATH" == "$DATABASE_ROOT/"* ]] ||
    fail "Database path must remain under $DATABASE_ROOT"
  validate_controlled_output_path "$BACKUP_DIR" "$PROJECT_ROOT/backups" "Backup directory"
  validate_controlled_output_path "$EVIDENCE_DIR" "$PROJECT_ROOT/evidence" "Evidence directory"
  validate_plain_absolute_path "$WEIXIN_SESSION_DIR" "WeChat session directory"
  [[ "$WEIXIN_SESSION_DIR" == "$PROJECT_ROOT/"* ]] ||
    fail "WeChat session directory must remain under the project root"
  [[ "$WEIXIN_SESSION_DIR" != "$RELEASES_ROOT/"* &&
    "$WEIXIN_SESSION_DIR" != "$CURRENT_LINK" &&
    "$WEIXIN_SESSION_DIR" != "$CURRENT_LINK/"* ]] ||
    fail "WeChat session directory cannot be release-owned"
  validate_state_path_isolation
  validate_plain_absolute_path "$NODE_BIN" "Node executable"
  [[ "$NODE_BIN" == "$PROJECT_ROOT/runtime/"* ]] ||
    fail "Node executable must remain under the project runtime"
  validate_controlled_output_path \
    "$PREFLIGHT_REPORT" "$PROJECT_ROOT/evidence" "Preflight report"
  [[ "$PREFLIGHT_REPORT_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    fail "PREFLIGHT_REPORT_SHA256 must be exactly 64 lowercase hexadecimal characters"
}

systemctl_property() {
  local service=$1
  local property=$2
  systemctl show "$service" "--property=$property" |
    sed -n "s/^${property}=//p"
}

assert_clean_systemd_execution_surface() {
  local service=$1
  local property value
  local -a empty_properties=(
    ExecCondition ExecStartPre ExecStartPost ExecStop ExecReload DropInPaths
    Environment RootDirectory RootImage BindPaths BindReadOnlyPaths
    ReadWritePaths ReadOnlyPaths InaccessiblePaths ExecPaths NoExecPaths
    TemporaryFileSystem
  )
  for property in "${empty_properties[@]}"; do
    value="$(systemctl_property "$service" "$property")"
    [[ -z "$value" ]] ||
      fail "$service has an unexpected systemd $property execution surface"
  done

  for property in ProtectSystem ProtectHome; do
    value="$(systemctl_property "$service" "$property")"
    [[ "$value" == "no" ]] ||
      fail "$service has an unexpected systemd $property value"
  done
  for property in PrivateTmp PrivateDevices DynamicUser; do
    value="$(systemctl_property "$service" "$property")"
    [[ "$value" == "no" ]] ||
      fail "$service has an unexpected systemd $property value"
  done

  value="$(systemctl_property "$service" EnvironmentFiles)"
  if [[ "$service" == "sentelligent-frontend.service" ]]; then
    [[ -z "$value" ]] ||
      fail "$service must not consume the private backend environment"
  else
    [[ -n "$value" && "$value" != *$'\n'* ]] ||
      fail "$service must identify exactly one production EnvironmentFile"
  fi
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

verify_preflight_report() {
  PREFLIGHT_REPORT_PATH="$PREFLIGHT_REPORT" \
  PREFLIGHT_REPORT_EXPECTED_SHA256="$PREFLIGHT_REPORT_SHA256" \
  PREFLIGHT_EXPECTED_RELEASE="$OLD_RELEASE" \
  PREFLIGHT_EXPECTED_DATABASE="$DATABASE_PATH" \
    "$NODE_BIN" --input-type=module --eval '
      import { createHash } from "node:crypto";
      import {
        closeSync,
        constants,
        fstatSync,
        lstatSync,
        openSync,
        readFileSync,
        realpathSync,
      } from "node:fs";
      import { resolve } from "node:path";

      const requestedPath = resolve(process.env.PREFLIGHT_REPORT_PATH);
      const normalize = (value) =>
        process.platform === "win32" ? resolve(value).toLowerCase() : value;
      const lexical = lstatSync(requestedPath, { bigint: true });
      if (!lexical.isFile() || lexical.isSymbolicLink()) {
        throw new Error("Preflight report must be a regular non-symbolic file");
      }
      const realPath = realpathSync.native(requestedPath);
      if (normalize(realPath) !== normalize(requestedPath)) {
        throw new Error("Preflight report path must be canonical");
      }
      const descriptor = openSync(
        realPath,
        Number(constants.O_RDONLY) | Number(constants.O_NOFOLLOW ?? 0),
      );
      let content;
      let before;
      try {
        before = fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) {
          throw new Error("Preflight report must be a single-link regular file");
        }
        if (process.platform !== "win32" && (before.mode & 0o077n) !== 0n) {
          throw new Error("Preflight report must not be accessible by group or other");
        }
        content = readFileSync(descriptor);
        if (BigInt(content.length) !== before.size) {
          throw new Error("Preflight report changed while it was read");
        }
        const actualSha256 = createHash("sha256").update(content).digest("hex");
        if (
          !/^[a-f0-9]{64}$/.test(process.env.PREFLIGHT_REPORT_EXPECTED_SHA256 ?? "") ||
          actualSha256 !== process.env.PREFLIGHT_REPORT_EXPECTED_SHA256
        ) {
          throw new Error("Preflight report SHA-256 mismatch");
        }
      } finally {
        closeSync(descriptor);
      }

      const report = JSON.parse(content.toString("utf8"));
      const requiredChecks = [
        "release.identity",
        "node.version",
        "env.production",
        "env.authRequired",
        "env.authHash",
        "env.sessionSecret",
        "env.secureCookie",
        "env.cors",
        "env.solutionWrites",
        "env.aiModel",
        "env.icostWebhook",
        "env.icostIsolation",
        "env.invoiceExtraction",
        "database.environmentBinding",
        "database.quickCheck",
        "database.foreignKeys",
        "backup.identity",
        "backup.sha256",
        "backup.quickCheck",
        "backup.foreignKeys",
        "services.snapshot",
        "services.project",
        "services.commands",
        "services.unrelatedProtection",
      ].sort();
      const generatedAt = Date.parse(report.generatedAt ?? "");
      const age = Date.now() - generatedAt;
      if (!Number.isFinite(generatedAt) || age < -5 * 60_000 || age > 15 * 60_000) {
        throw new Error("Preflight report is not fresh enough for cutover");
      }
      if (
        report.schemaVersion !== 2 ||
        report.product !== "sentelligent-sales-workbench" ||
        report.status !== "passed" ||
        report.summary?.total !== 24 ||
        report.summary?.passed !== 24 ||
        report.summary?.failed !== 0
      ) {
        throw new Error("Preflight report must be an exact passed 24/24 result");
      }
      if (!Array.isArray(report.checks) || report.checks.length !== 24) {
        throw new Error("Preflight report must contain exactly 24 checks");
      }
      const observedChecks = report.checks.map((check) => check?.id).sort();
      if (
        report.checks.some((check) => check?.status !== "passed") ||
        JSON.stringify(observedChecks) !== JSON.stringify(requiredChecks)
      ) {
        throw new Error("Preflight report check identities or statuses are invalid");
      }
      if (
        report.scope?.releasePath !== process.env.PREFLIGHT_EXPECTED_RELEASE ||
        !/^[a-f0-9]{40}$/.test(String(report.scope?.expectedCommit ?? "")) ||
        report.scope?.databasePath !== process.env.PREFLIGHT_EXPECTED_DATABASE ||
        typeof report.scope?.hostname !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(report.scope.hostname) ||
        !/^[a-f0-9]{64}$/.test(String(report.scope?.machineIdSha256 ?? ""))
      ) {
        throw new Error("Preflight report scope does not match the current release, database, or host identity");
      }
      const after = lstatSync(realPath, { bigint: true });
      for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
        if (after[field] !== before[field]) {
          throw new Error("Preflight report identity changed during validation");
        }
      }
    '
}

transform_frontend_config() {
  local source_path=$1
  local output_path=$2
  local old_release=$3
  local new_release=$4
  local old_dist="DIST_PATH=$old_release/outputs/product-design-prototype/dist"
  local new_dist="DIST_PATH=$new_release/outputs/product-design-prototype/dist"
  local expected_count dist_count

  [[ -f "$source_path" && ! -L "$source_path" ]] ||
    fail "Frontend environment source must be a regular file"
  [[ ! -e "$output_path" && ! -L "$output_path" ]] ||
    fail "Frontend environment output already exists"
  expected_count="$(grep -Fxc "$old_dist" "$source_path" || true)"
  dist_count="$(grep -c '^DIST_PATH=' "$source_path" || true)"
  if [[ "$expected_count" -ne 1 || "$dist_count" -ne 1 ]]; then
    fail "Frontend environment must contain exactly one expected DIST_PATH"
    return 1
  fi

  awk -v expected="$old_dist" -v replacement="$new_dist" '
    $0 == expected { print replacement; next }
    { print }
  ' "$source_path" > "$output_path"
  [[ "$(grep -Fxc "$new_dist" "$output_path" || true)" -eq 1 ]] ||
    fail "Candidate frontend DIST_PATH transformation failed"
  [[ "$(grep -c '^DIST_PATH=' "$output_path" || true)" -eq 1 ]] ||
    fail "Candidate frontend environment contains duplicate DIST_PATH entries"
}

atomic_replace_file() {
  local source_path=$1
  local target_path=$2
  local suffix=$3
  local target_directory target_name temporary target_mode target_uid target_gid

  [[ -f "$source_path" && ! -L "$source_path" ]] || fail "Atomic source is not a regular file"
  [[ -f "$target_path" && ! -L "$target_path" ]] || fail "Atomic target is not a regular file"
  target_directory="$(dirname "$target_path")"
  target_name="$(basename "$target_path")"
  [[ "$(realpath -e "$target_directory")" == "$target_directory" ]] ||
    fail "Atomic target directory is not canonical"
  temporary="$target_directory/.$target_name.${RUN_ID:-manual}-${suffix}-$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || fail "Atomic temporary file already exists"
  target_mode="$(stat -c '%a' "$target_path")"
  target_uid="$(stat -c '%u' "$target_path")"
  target_gid="$(stat -c '%g' "$target_path")"

  cp -- "$source_path" "$temporary"
  chown "$target_uid:$target_gid" "$temporary"
  chmod "$target_mode" "$temporary"
  mv -Tf "$temporary" "$target_path"
  cmp --silent "$source_path" "$target_path"
}

acquire_cutover_lock() {
  command -v flock >/dev/null || fail "Required executable is missing: flock"
  [[ -d "$PROJECT_ROOT" && ! -L "$PROJECT_ROOT" ]] || fail "Project root is unavailable"
  [[ ! -L "$CUTOVER_LOCK" ]] || fail "Production cutover lock must not be a symlink"
  if [[ -e "$CUTOVER_LOCK" && ! -f "$CUTOVER_LOCK" ]]; then
    fail "Production cutover lock must be a regular file"
    return 1
  fi
  exec 9>> "$CUTOVER_LOCK"
  CUTOVER_LOCK_FD=9
  [[ -f "$CUTOVER_LOCK" && ! -L "$CUTOVER_LOCK" ]] ||
    fail "Production cutover lock identity is unsafe"
  [[ "$CUTOVER_LOCK" -ef "/proc/$$/fd/$CUTOVER_LOCK_FD" ]] ||
    fail "Production cutover lock identity changed while opening"
  [[ "$(stat -L -c '%h' "/proc/$$/fd/$CUTOVER_LOCK_FD")" -eq 1 ]] ||
    fail "Production cutover lock must not be hard linked"
  chmod 0600 "/proc/$$/fd/$CUTOVER_LOCK_FD"
  flock -n "$CUTOVER_LOCK_FD" || fail "Another production cutover is already running"
}

remove_owned_maintenance_lock() {
  local lock_path=$1
  local expected_sha=$2
  local actual_sha
  [[ -f "$lock_path" && ! -L "$lock_path" ]] ||
    fail "Maintenance lock is unavailable for owned removal"
  actual_sha="$(sha256_file "$lock_path")"
  [[ "$actual_sha" == "$expected_sha" ]] ||
    fail "Maintenance lock identity changed; refusing removal"
  rm -f -- "$lock_path"
}

wait_for_url() {
  local url=$1
  local attempts=${2:-80}
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --silent --show-error --fail --max-time 2 "$url" >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  curl --silent --show-error --fail --max-time 2 "$url" >/dev/null
}

validate_frontend_health_payload() {
  local expected_release=$1
  EXPECTED_FRONTEND_DIST="$expected_release/outputs/product-design-prototype/dist" \
    "$NODE_BIN" --input-type=module --eval '
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      const health = JSON.parse(input);
      if (
        health?.status !== "ok" ||
        health?.distPath !== process.env.EXPECTED_FRONTEND_DIST
      ) {
        throw new Error("Frontend health release mismatch");
      }
    '
}

assert_frontend_release_health() {
  local expected_release=$1
  curl --silent --show-error --fail --max-time 3 \
    "http://127.0.0.1:8088/_health" |
    validate_frontend_health_payload "$expected_release"
}

set_current_atomic() {
  local target=$1
  local suffix=$2
  CURRENT_TEMPORARY="$PROJECT_ROOT/.current-${RUN_ID}-${suffix}-$$"
  [[ ! -e "$CURRENT_TEMPORARY" && ! -L "$CURRENT_TEMPORARY" ]] ||
    fail "Temporary current link already exists"
  [[ -L "$CURRENT_LINK" ]] || fail "Current release marker is no longer a symlink"
  ln -s "$target" "$CURRENT_TEMPORARY"
  mv -Tf "$CURRENT_TEMPORARY" "$CURRENT_LINK"
  CURRENT_TEMPORARY=""
  [[ "$(readlink -f "$CURRENT_LINK")" == "$target" ]] ||
    fail "Atomic current link verification failed"
}

assert_project_services_ready() {
  local expected_release=$1
  local service active enabled fragment working_directory exec_start
  for service in "${PROJECT_SERVICES[@]}"; do
    active="$(systemctl is-active "$service")"
    enabled="$(systemctl is-enabled "$service")"
    [[ "$active" == "active" ]] || fail "$service is not active"
    [[ "$enabled" == "enabled" ]] || fail "$service is not enabled"
    fragment="$(systemctl_property "$service" FragmentPath)"
    [[ "$fragment" == "$SYSTEMD_UNIT_ROOT/$service" ]] ||
      fail "$service has an unexpected FragmentPath"
    [[ -f "$fragment" && ! -L "$fragment" ]] ||
      fail "$service unit is not a regular installed file"
    grep -Fq "$expected_release" "$fragment" ||
      fail "$service unit is not pinned to the expected release"
    if grep -Fq "$CURRENT_LINK" "$fragment"; then
      fail "$service unit must not reference current"
    fi
    working_directory="$(systemctl_property "$service" WorkingDirectory)"
    exec_start="$(systemctl_property "$service" ExecStart)"
    [[ "$working_directory" == "$expected_release" ||
      "$working_directory" == "$expected_release/"* ]] ||
      fail "$service WorkingDirectory is outside the expected release"
    [[ "$exec_start" == *"$expected_release/"* ]] ||
      fail "$service ExecStart is outside the expected release"
    assert_clean_systemd_execution_surface "$service"
  done
}

normalize_listener_rows() {
  local port=$1
  awk -v port="$port" '
    {
      protocol = $1
      if (protocol !~ /^(tcp|udp)/) next
      for (field = 2; field <= NF; field += 1) {
        if ($field ~ (":" port "$")) {
          print protocol "|" $field
          next
        }
      }
    }
  '
}

capture_protected_snapshot() {
  local output_path=$1
  local temporary="${output_path}.tmp.$$"
  local service active enabled pid entered fragment unit_sha
  local port listener_rows row caddy_sha
  [[ ! -e "$temporary" ]] || fail "Protected snapshot temporary file exists"
  : > "$temporary"

  for service in "${PROTECTED_SERVICES[@]}"; do
    active="$(systemctl is-active "$service")"
    enabled="$(systemctl is-enabled "$service")"
    [[ "$active" == "active" ]] || fail "Protected unit $service is not active"
    [[ "$enabled" == "enabled" ]] || fail "Protected unit $service is not enabled"
    pid="$(systemctl_property "$service" MainPID)"
    entered="$(systemctl_property "$service" ActiveEnterTimestamp)"
    fragment="$(systemctl_property "$service" FragmentPath)"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "Protected unit $service has no MainPID"
    [[ -n "$entered" ]] || fail "Protected unit $service has no activation timestamp"
    [[ -f "$fragment" && ! -L "$fragment" ]] ||
      fail "Protected unit $service has an invalid unit file"
    unit_sha="$(sha256_file "$fragment")"
    printf 'service\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$service" "$active" "$enabled" "$pid" "$entered" "$fragment" "$unit_sha" \
      >> "$temporary"
  done

  [[ -f "$CADDYFILE" && ! -L "$CADDYFILE" ]] || fail "Caddyfile is unavailable"
  caddy_sha="$(sha256_file "$CADDYFILE")"
  printf 'caddyfile\t%s\t%s\n' "$CADDYFILE" "$caddy_sha" >> "$temporary"

  for port in "${PROTECTED_PORTS[@]}"; do
    listener_rows="$(
      ss -H -lntu |
        normalize_listener_rows "$port" |
        LC_ALL=C sort -u
    )"
    [[ -n "$listener_rows" ]] || fail "Protected listener $port is missing"
    while IFS= read -r row; do
      printf 'listener\t%s\t%s\n' "$port" "$row" >> "$temporary"
    done <<< "$listener_rows"
  done

  chmod 0600 "$temporary"
  mv -f "$temporary" "$output_path"
  chmod 0600 "$output_path"
}

assert_protected_unchanged() {
  local before_path=$1
  local after_path=$2
  if ! cmp --silent "$before_path" "$after_path"; then
    printf 'Protected state changed between %s and %s\n' "$before_path" "$after_path" >&2
    return 1
  fi
}

verify_release_manifest() {
  RELEASE_DIRECTORY="$NEW_RELEASE" EXPECTED_RELEASE_COMMIT="$EXPECTED_COMMIT" \
    "$NODE_BIN" --input-type=module --eval '
      import { createHash } from "node:crypto";
      import { lstatSync, readFileSync } from "node:fs";
      import { isAbsolute, relative, resolve, sep } from "node:path";

      const root = resolve(process.env.RELEASE_DIRECTORY);
      const manifestPath = resolve(root, "release-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const expectedCommit = process.env.EXPECTED_RELEASE_COMMIT;
      const sha256 = (content) => createHash("sha256").update(content).digest("hex");
      const expectedUnits = [
        "sentelligent-backend.service",
        "sentelligent-frontend.service",
        "sentelligent-weixin-agent.service",
      ];

      if (
        manifest.schemaVersion !== 3 ||
        manifest.product !== "sentelligent-sales-workbench" ||
        manifest.source?.commit !== expectedCommit ||
        manifest.source?.clean !== true
      ) {
        throw new Error("Candidate release identity mismatch");
      }
      if (JSON.stringify(manifest.rollback?.serviceUnits) !== JSON.stringify(expectedUnits)) {
        throw new Error("Candidate release service-unit contract mismatch");
      }

      const groups = [
        ["build", manifest.buildHashes],
        ["migration", manifest.migrationChecksums],
        ["production dependency", manifest.productionDependencyHashes],
        ["source", manifest.sourceHashes],
      ];
      const allFiles = new Set();
      for (const [name, group] of groups) {
        if (group?.algorithm !== "sha256" || !group.files || typeof group.files !== "object") {
          throw new Error(`${name} checksums are unavailable`);
        }
        const entries = Object.entries(group.files);
        if (entries.length === 0) throw new Error(`${name} checksums are empty`);
        for (const [file, expectedHash] of entries) {
          if (
            typeof file !== "string" ||
            isAbsolute(file) ||
            file.includes("\\") ||
            file.split("/").some((part) => part === "" || part === "." || part === "..") ||
            !/^[0-9a-f]{64}$/.test(expectedHash)
          ) {
            throw new Error(`Unsafe ${name} checksum entry`);
          }
          const fullPath = resolve(root, ...file.split("/"));
          const fromRoot = relative(root, fullPath);
          if (fromRoot.startsWith(`..${sep}`) || fromRoot === "..") {
            throw new Error(`Checksum path escaped release: ${file}`);
          }
          const stats = lstatSync(fullPath);
          if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error(`Release entry is not a regular file: ${file}`);
          }
          if (sha256(readFileSync(fullPath)) !== expectedHash) {
            throw new Error(`Release checksum mismatch: ${file}`);
          }
          allFiles.add(file);
        }
      }

      const sourceIndex = Object.entries(manifest.sourceHashes.files)
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([file, hash]) => `${hash}  ${file}\n`)
        .join("");
      if (sha256(Buffer.from(sourceIndex, "utf8")) !== manifest.sourceHashes.treeSha256) {
        throw new Error("Candidate source tree checksum mismatch");
      }
      const dependencyIndex = Object.entries(manifest.productionDependencyHashes.files)
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([file, hash]) => `${hash}  ${file}\n`)
        .join("");
      if (
        sha256(Buffer.from(dependencyIndex, "utf8")) !==
        manifest.productionDependencyHashes.treeSha256
      ) {
        throw new Error("Candidate production dependency tree checksum mismatch");
      }
      const migrationFiles = Object.keys(manifest.migrationChecksums.files);
      if (!migrationFiles.every((file) => manifest.sourceHashes.files[file])) {
        throw new Error("Migration checksums are not bound to source checksums");
      }
      if (manifest.archive?.packagedFiles !== allFiles.size + 1) {
        throw new Error("Candidate archive file count mismatch");
      }
    '
}

freeze_candidate_release() {
  [[ "$mutation_started" -eq 0 && "$services_stopped" -eq 0 &&
    "$unit_install_started" -eq 0 && "$current_switched" -eq 0 ]] ||
    fail "Candidate release must be frozen before production mutation"

  if find "$NEW_RELEASE" -type l -print -quit | grep -q .; then
    fail "Candidate release contains a symbolic link"
  fi
  if find "$NEW_RELEASE" -type f -links +1 -print -quit | grep -q .; then
    fail "Candidate release contains a hard-linked file"
  fi

  chown -R root:root "$NEW_RELEASE"
  find "$NEW_RELEASE" -type d -exec chmod go-w {} +
  find "$NEW_RELEASE" -type f -exec chmod go-w {} +

  local entry metadata uid gid mode links file_type numeric_mode
  while IFS= read -r -d '' entry; do
    metadata="$(stat -c '%u:%g:%a:%h:%F' "$entry")"
    IFS=: read -r uid gid mode links file_type <<< "$metadata"
    [[ "$uid" == "0" && "$gid" == "0" ]] ||
      fail "Candidate release ownership is not root:root"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] ||
      fail "Candidate release mode is invalid"
    numeric_mode=$((8#$mode))
    (( (numeric_mode & 0022) == 0 )) ||
      fail "Candidate release remains writable by a runtime identity"
    if [[ "$file_type" == "regular file" ]]; then
      [[ "$links" == "1" ]] ||
        fail "Candidate release file is hard linked"
    elif [[ "$file_type" != "directory" ]]; then
      fail "Candidate release contains an unsupported entry type"
    fi
  done < <(find "$NEW_RELEASE" -xdev -print0)
}

stage_project_units() {
  UNIT_BACKUP_DIR="$RUN_BACKUP_DIR/systemd-pre-cutover"
  STAGED_UNIT_DIR="$RUN_BACKUP_DIR/systemd-candidate"
  install -d -o root -g root -m 0700 "$UNIT_BACKUP_DIR" "$STAGED_UNIT_DIR"
  FRONTEND_ENV_BACKUP="$RUN_BACKUP_DIR/frontend.env-pre-cutover"
  STAGED_FRONTEND_ENV="$RUN_BACKUP_DIR/frontend.env-candidate"

  local service installed backup staged fragment
  for service in "${PROJECT_SERVICES[@]}"; do
    installed="$SYSTEMD_UNIT_ROOT/$service"
    backup="$UNIT_BACKUP_DIR/$service"
    staged="$STAGED_UNIT_DIR/$service"
    fragment="$(systemctl_property "$service" FragmentPath)"
    [[ "$fragment" == "$installed" ]] || fail "$service FragmentPath is not controlled"
    [[ -f "$installed" && ! -L "$installed" ]] || fail "$service unit is not a regular file"
    assert_clean_systemd_execution_surface "$service"
    grep -Fq "$OLD_RELEASE" "$installed" || fail "$service unit is not pinned to the old release"
    if grep -Fq "$CURRENT_LINK" "$installed"; then
      fail "$service unit references current"
    fi
    cp -a "$installed" "$backup"
    chmod 0600 "$backup"
    sed "s|$OLD_RELEASE|$NEW_RELEASE|g" "$installed" > "$staged"
    if grep -Fq "$OLD_RELEASE" "$staged"; then
      fail "$service staged unit still references the old release"
    fi
    grep -Fq "$NEW_RELEASE" "$staged" || fail "$service staged unit misses the new release"
    if grep -Fq "$CURRENT_LINK" "$staged"; then
      fail "$service staged unit references current"
    fi
    chmod 0600 "$staged"
  done
  unit_backups_ready=1
  systemd-analyze verify "$STAGED_UNIT_DIR"/*.service

  cp -a -- "$FRONTEND_ENV" "$FRONTEND_ENV_BACKUP"
  chmod 0600 "$FRONTEND_ENV_BACKUP"
  cmp --silent "$FRONTEND_ENV" "$FRONTEND_ENV_BACKUP"
  frontend_config_backup_ready=1
  transform_frontend_config \
    "$FRONTEND_ENV" "$STAGED_FRONTEND_ENV" "$OLD_RELEASE" "$NEW_RELEASE"
  chmod 0600 "$STAGED_FRONTEND_ENV"
}

stop_writers_and_lock_database() {
  local service state
  mutation_started=1
  systemctl_mutate stop sentelligent-weixin-agent.service
  systemctl_mutate stop sentelligent-backend.service
  systemctl_mutate stop sentelligent-frontend.service

  for service in "${PROJECT_SERVICES[@]}"; do
    state="$(systemctl is-active "$service" 2>/dev/null || true)"
    [[ "$state" == "inactive" || "$state" == "failed" ]] ||
      fail "$service did not stop"
  done
  services_stopped=1

  if (
    set -o noclobber
    printf '{"runId":"%s","pid":%s,"purpose":"controlled-production-cutover"}\n' \
      "$RUN_ID" "$$" > "$MAINTENANCE_LOCK"
  ) 2>/dev/null; then
    maintenance_lock_created=1
    chmod 0600 "$MAINTENANCE_LOCK"
    MAINTENANCE_LOCK_SHA="$(sha256_file "$MAINTENANCE_LOCK")"
  else
    fail "Unable to acquire database maintenance lock"
  fi

  if find "$(dirname "$DATABASE_PATH")" -maxdepth 1 \
    -name ".$(basename "$DATABASE_PATH").opening-*" -print -quit | grep -q .; then
    fail "A database connection is still opening after maintenance lock acquisition"
  fi
  if fuser "$DATABASE_PATH" "${DATABASE_PATH}-wal" "${DATABASE_PATH}-shm" 2>/dev/null; then
    fail "Database files are still open after stopping write services"
  fi
  for port in 8088 8897; do
    if ss -H -lnt | awk -v port="$port" '
      {
        for (field = 1; field <= NF; field += 1) {
          if ($field ~ (":" port "$")) { print; exit }
        }
      }
    ' | grep -q .; then
      fail "Project listener $port remained open after stop"
    fi
  done
}

backup_weixin_session() {
  local parent directory_name
  parent="$(dirname "$WEIXIN_SESSION_DIR")"
  directory_name="$(basename "$WEIXIN_SESSION_DIR")"
  WEIXIN_BACKUP="$RUN_BACKUP_DIR/weixin-session.tar.gz"
  [[ ! -e "$WEIXIN_BACKUP" ]] || fail "WeChat backup already exists"
  tar -czf "$WEIXIN_BACKUP" -C "$parent" "$directory_name"
  chmod 0600 "$WEIXIN_BACKUP"
  [[ -s "$WEIXIN_BACKUP" ]] || fail "WeChat backup is empty"
  tar -tzf "$WEIXIN_BACKUP" >/dev/null
  WEIXIN_BACKUP_SHA="$(sha256_file "$WEIXIN_BACKUP")"
  [[ "$WEIXIN_BACKUP_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "WeChat backup hash failed"
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

rehearse_candidate_migrations() {
  [[ "$mutation_started" -eq 0 && "$services_stopped" -eq 0 &&
    "$unit_install_started" -eq 0 && "$current_switched" -eq 0 ]] ||
    fail "Candidate migration rehearsal must run before production mutation"

  local verified_backup="$RUN_BACKUP_DIR/database-pre-cutover-verified.sqlite"
  local rehearsal_database="$RUN_BACKUP_DIR/database-migration-rehearsal.sqlite"
  [[ ! -e "$verified_backup" && ! -L "$verified_backup" ]] ||
    fail "Pre-cutover migration backup already exists"
  [[ ! -e "$rehearsal_database" && ! -L "$rehearsal_database" ]] ||
    fail "Migration rehearsal database already exists"

  SOURCE_DATABASE="$DATABASE_PATH" TARGET_DATABASE="$verified_backup" \
    "$NODE_BIN" --input-type=module --eval '
      import { DatabaseSync } from "node:sqlite";
      const source = new DatabaseSync(process.env.SOURCE_DATABASE, { readOnly: true });
      try {
        source.prepare("VACUUM INTO ?").run(process.env.TARGET_DATABASE);
      } finally {
        source.close();
      }
    '
  [[ -s "$verified_backup" && ! -L "$verified_backup" ]] ||
    fail "Pre-cutover migration backup is unavailable"
  chmod 0600 "$verified_backup"
  [[ ! "$DATABASE_PATH" -ef "$verified_backup" ]] ||
    fail "Pre-cutover migration backup is not isolated from production"
  verify_sqlite_integrity "$verified_backup" "Pre-cutover migration backup"

  SOURCE_DATABASE="$verified_backup" TARGET_DATABASE="$rehearsal_database" \
    "$NODE_BIN" --input-type=module --eval '
      import { closeSync, constants, copyFileSync, fsyncSync, openSync } from "node:fs";
      copyFileSync(
        process.env.SOURCE_DATABASE,
        process.env.TARGET_DATABASE,
        constants.COPYFILE_EXCL,
      );
      const descriptor = openSync(process.env.TARGET_DATABASE, "r+");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    '
  chmod 0600 "$rehearsal_database"
  [[ -f "$rehearsal_database" && ! -L "$rehearsal_database" ]] ||
    fail "Migration rehearsal database is unavailable"
  [[ ! "$DATABASE_PATH" -ef "$rehearsal_database" ]] ||
    fail "Migration rehearsal database is not isolated from production"
  [[ ! "$verified_backup" -ef "$rehearsal_database" ]] ||
    fail "Migration rehearsal database is not isolated from its verified backup"
  cmp --silent "$verified_backup" "$rehearsal_database"

  (
    cd "$NEW_RELEASE/backend"
    unset DATABASE_PATH
    NODE_ENV=test databaseUrl="$rehearsal_database" DATABASE_URL="$rehearsal_database" \
      "$NODE_BIN" src/db.js --migrate
  )

  MIGRATION_DATABASE="$rehearsal_database" "$NODE_BIN" --input-type=module --eval '
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.MIGRATION_DATABASE);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(checkpoint.busy) !== 0) {
        throw new Error("Migration rehearsal WAL checkpoint remained busy");
      }
      const journalMode = database.prepare("PRAGMA journal_mode = DELETE").get().journal_mode;
      if (String(journalMode).toLowerCase() !== "delete") {
        throw new Error(`Unexpected migration rehearsal journal mode: ${journalMode}`);
      }
    } finally {
      database.close();
    }
  '
  local suffix
  for suffix in -wal -shm -journal; do
    [[ ! -e "${rehearsal_database}${suffix}" ]] ||
      fail "Migration rehearsal SQLite sidecar remained after checkpoint"
  done
  verify_sqlite_integrity "$rehearsal_database" "Migrated rehearsal database"
}

backup_sqlite_offline() {
  DATABASE_FILE="$DATABASE_PATH" "$NODE_BIN" --input-type=module --eval '
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.DATABASE_FILE);
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(checkpoint.busy) !== 0) throw new Error("WAL checkpoint remained busy");
      const journalMode = database.prepare("PRAGMA journal_mode = DELETE").get().journal_mode;
      if (String(journalMode).toLowerCase() !== "delete") {
        throw new Error(`Unexpected journal mode: ${journalMode}`);
      }
    } finally {
      database.close();
    }
  '

  local suffix
  for suffix in -wal -shm -journal; do
    [[ ! -e "${DATABASE_PATH}${suffix}" ]] || fail "SQLite sidecar remained after checkpoint"
  done
  if fuser "$DATABASE_PATH" 2>/dev/null; then
    fail "Database remained occupied after checkpoint"
  fi

  FINAL_BACKUP="$RUN_BACKUP_DIR/database-final-offline.sqlite"
  [[ ! -e "$FINAL_BACKUP" ]] || fail "Final database backup already exists"
  SOURCE_DATABASE="$DATABASE_PATH" TARGET_DATABASE="$FINAL_BACKUP" \
    "$NODE_BIN" --input-type=module --eval '
      import { closeSync, constants, copyFileSync, fsyncSync, openSync } from "node:fs";
      import { dirname } from "node:path";
      copyFileSync(process.env.SOURCE_DATABASE, process.env.TARGET_DATABASE, constants.COPYFILE_EXCL);
      for (const path of [process.env.TARGET_DATABASE, dirname(process.env.TARGET_DATABASE)]) {
        const descriptor = openSync(path, "r");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
    '
  chmod 0600 "$FINAL_BACKUP"
  cmp --silent "$DATABASE_PATH" "$FINAL_BACKUP"

  VERIFY_DATABASE="$FINAL_BACKUP" "$NODE_BIN" --input-type=module --eval '
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.VERIFY_DATABASE, { readOnly: true });
    try {
      const quick = database.prepare("PRAGMA quick_check").all();
      const foreign = database.prepare("PRAGMA foreign_key_check").all();
      if (quick.length !== 1 || quick[0].quick_check !== "ok" || foreign.length !== 0) {
        throw new Error("Final offline database backup failed integrity verification");
      }
    } finally {
      database.close();
    }
  '
  FINAL_BACKUP_SHA="$(sha256_file "$FINAL_BACKUP")"
  [[ "$FINAL_BACKUP_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "Database backup hash failed"
}

install_candidate_units() {
  local service staged installed
  frontend_config_install_started=1
  atomic_replace_file "$STAGED_FRONTEND_ENV" "$FRONTEND_ENV" candidate
  unit_install_started=1
  for service in "${PROJECT_SERVICES[@]}"; do
    staged="$STAGED_UNIT_DIR/$service"
    installed="$SYSTEMD_UNIT_ROOT/$service"
    install -o root -g root -m 0644 "$staged" "$installed"
  done
  systemctl daemon-reload
  for service in "${PROJECT_SERVICES[@]}"; do
    cmp --silent "$STAGED_UNIT_DIR/$service" "$SYSTEMD_UNIT_ROOT/$service" ||
      fail "$service installed unit differs from the verified candidate"
  done
}

restart_candidate_services() {
  systemctl_mutate restart sentelligent-backend.service
  wait_for_url "http://127.0.0.1:8897/api/health"
  systemctl_mutate restart sentelligent-frontend.service
  wait_for_url "http://127.0.0.1:8088/_health"
  assert_frontend_release_health "$NEW_RELEASE"
  systemctl_mutate restart sentelligent-weixin-agent.service
  sleep 1
  assert_project_services_ready "$NEW_RELEASE"
}

write_evidence() {
  local status=$1
  local exit_code=$2
  local rollback_status=$3
  local temporary="${EVIDENCE_REPORT}.tmp.$$"
  CUTOVER_STATUS="$status" CUTOVER_EXIT_CODE="$exit_code" \
  ROLLBACK_STATUS="$rollback_status" CUTOVER_RUN_ID="$RUN_ID" \
  CUTOVER_STARTED_AT="$STARTED_AT" CUTOVER_FAILURE_LINE="$FAILURE_LINE" \
  CUTOVER_OLD_RELEASE="$OLD_RELEASE" CUTOVER_NEW_RELEASE="$NEW_RELEASE" \
  CUTOVER_EXPECTED_COMMIT="$EXPECTED_COMMIT" CUTOVER_DATABASE="$DATABASE_PATH" \
  CUTOVER_FINAL_BACKUP="$FINAL_BACKUP" CUTOVER_FINAL_BACKUP_SHA="$FINAL_BACKUP_SHA" \
  CUTOVER_WEIXIN_BACKUP="$WEIXIN_BACKUP" CUTOVER_WEIXIN_BACKUP_SHA="$WEIXIN_BACKUP_SHA" \
  CUTOVER_PROTECTED_BEFORE="$PROTECTED_BEFORE" \
  CUTOVER_PROTECTED_BEFORE_SHA="$PROTECTED_BEFORE_SHA" \
  CUTOVER_PROTECTED_AFTER="$PROTECTED_AFTER" \
  CUTOVER_PROTECTED_AFTER_SHA="$PROTECTED_AFTER_SHA" \
  CUTOVER_LOG_PATH="$CUTOVER_LOG" \
    "$NODE_BIN" --input-type=module --eval '
      const number = (value) => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
      };
      const optional = (value) => value || null;
      const report = {
        schemaVersion: 1,
        product: "sentelligent-sales-workbench",
        runId: process.env.CUTOVER_RUN_ID,
        startedAt: process.env.CUTOVER_STARTED_AT,
        completedAt: new Date().toISOString(),
        status: process.env.CUTOVER_STATUS,
        exitCode: number(process.env.CUTOVER_EXIT_CODE),
        rollbackStatus: process.env.ROLLBACK_STATUS,
        failureLine: number(process.env.CUTOVER_FAILURE_LINE),
        release: {
          previous: process.env.CUTOVER_OLD_RELEASE,
          candidate: process.env.CUTOVER_NEW_RELEASE,
          expectedCommit: process.env.CUTOVER_EXPECTED_COMMIT,
        },
        database: {
          source: process.env.CUTOVER_DATABASE,
          offlineBackup: optional(process.env.CUTOVER_FINAL_BACKUP),
          offlineBackupSha256: optional(process.env.CUTOVER_FINAL_BACKUP_SHA),
        },
        weixinSession: {
          backup: optional(process.env.CUTOVER_WEIXIN_BACKUP),
          backupSha256: optional(process.env.CUTOVER_WEIXIN_BACKUP_SHA),
        },
        protectedState: {
          before: optional(process.env.CUTOVER_PROTECTED_BEFORE),
          beforeSha256: optional(process.env.CUTOVER_PROTECTED_BEFORE_SHA),
          after: optional(process.env.CUTOVER_PROTECTED_AFTER),
          afterSha256: optional(process.env.CUTOVER_PROTECTED_AFTER_SHA),
        },
        log: process.env.CUTOVER_LOG_PATH,
      };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    ' > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$EVIDENCE_REPORT"
  chmod 0600 "$EVIDENCE_REPORT"
}

rollback_cutover() {
  local observed_status=$?
  local exit_code=${1:-$observed_status}
  local rollback_failed=0
  local service
  FAILURE_LINE=${BASH_LINENO[0]:-0}
  trap - ERR HUP INT TERM
  set +e

  printf 'CUTOVER_FAILED_EXIT=%s\n' "$exit_code" >&2
  if [[ "$mutation_started" -eq 1 ]]; then
    for service in "${PROJECT_SERVICES[@]}"; do
      systemctl_mutate stop "$service" || rollback_failed=1
    done
  fi

  if [[ "$unit_install_started" -eq 1 && "$unit_backups_ready" -eq 1 ]]; then
    for service in "${PROJECT_SERVICES[@]}"; do
      cp -a "$UNIT_BACKUP_DIR/$service" "$SYSTEMD_UNIT_ROOT/$service" || rollback_failed=1
      chmod 0644 "$SYSTEMD_UNIT_ROOT/$service" || rollback_failed=1
    done
    systemctl daemon-reload || rollback_failed=1
  fi

  if [[ "$frontend_config_install_started" -eq 1 &&
    "$frontend_config_backup_ready" -eq 1 ]]; then
    atomic_replace_file "$FRONTEND_ENV_BACKUP" "$FRONTEND_ENV" rollback ||
      rollback_failed=1
  fi

  if [[ "$mutation_started" -eq 1 ]]; then
    if [[ -n "$CURRENT_TEMPORARY" ]]; then
      rm -f -- "$CURRENT_TEMPORARY" || rollback_failed=1
      CURRENT_TEMPORARY=""
    fi
    local current_target
    current_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
    if [[ "$current_target" != "$OLD_RELEASE" ]]; then
      set_current_atomic "$OLD_RELEASE" rollback || rollback_failed=1
    fi
    current_switched=0
  fi

  if [[ "$maintenance_lock_created" -eq 1 ]]; then
    if remove_owned_maintenance_lock "$MAINTENANCE_LOCK" "$MAINTENANCE_LOCK_SHA"; then
      maintenance_lock_created=0
    else
      rollback_failed=1
    fi
  fi

  if [[ "$mutation_started" -eq 1 ]]; then
    systemctl_mutate restart sentelligent-backend.service || rollback_failed=1
    wait_for_url "http://127.0.0.1:8897/api/health" 80 || rollback_failed=1
    systemctl_mutate restart sentelligent-frontend.service || rollback_failed=1
    wait_for_url "http://127.0.0.1:8088/_health" 80 || rollback_failed=1
    assert_frontend_release_health "$OLD_RELEASE" || rollback_failed=1
    systemctl_mutate restart sentelligent-weixin-agent.service || rollback_failed=1
    sleep 1
    assert_project_services_ready "$OLD_RELEASE" || rollback_failed=1
  fi

  if [[ "$protected_snapshot_ready" -eq 1 ]]; then
    PROTECTED_ROLLBACK="$RUN_EVIDENCE_DIR/protected-rollback.tsv"
    capture_protected_snapshot "$PROTECTED_ROLLBACK" || rollback_failed=1
    assert_protected_unchanged "$PROTECTED_BEFORE" "$PROTECTED_ROLLBACK" || rollback_failed=1
  fi

  local rollback_status=passed
  if [[ "$mutation_started" -eq 0 ]]; then
    rollback_status=not-required
  elif [[ "$rollback_failed" -ne 0 ]]; then
    rollback_status=failed
  fi
  write_evidence failed "$exit_code" "$rollback_status" || rollback_failed=1

  if [[ "$rollback_failed" -eq 0 ]]; then
    printf 'APPLICATION_ROLLBACK_STATUS=%s\n' "$rollback_status" >&2
    exit "$exit_code"
  fi
  printf 'APPLICATION_ROLLBACK_STATUS=failed\n' >&2
  exit 90
}

prepare_runtime() {
  local executable releases_real new_real old_real node_real database_real session_real
  local -a required_commands=(
    awk basename chown cmp cp curl date find flock fuser grep id install ln mv readlink
    realpath sed sha256sum sort ss stat systemctl systemd-analyze tar tee
  )
  [[ "$(id -u)" -eq 0 ]] || fail "Production cutover must run as root"
  for executable in "${required_commands[@]}"; do
    command -v "$executable" >/dev/null || fail "Required executable is missing: $executable"
  done
  acquire_cutover_lock

  releases_real="$(realpath -e "$RELEASES_ROOT")"
  [[ "$releases_real" == "$RELEASES_ROOT" ]] || fail "Releases root must not be redirected"
  [[ -d "$NEW_RELEASE" && ! -L "$NEW_RELEASE" ]] || fail "Candidate release is unavailable"
  new_real="$(realpath -e "$NEW_RELEASE")"
  [[ "$new_real" == "$NEW_RELEASE" ]] || fail "Candidate release path is not canonical"
  [[ "$(dirname "$new_real")" == "$RELEASES_ROOT" ]] ||
    fail "Candidate release escaped the releases root"

  [[ -L "$CURRENT_LINK" ]] || fail "Current release marker must be a symbolic link"
  old_real="$(readlink -f "$CURRENT_LINK")"
  validate_release_path_syntax "$old_real"
  [[ -d "$old_real" && ! -L "$old_real" ]] || fail "Previous release is unavailable"
  [[ "$old_real" != "$new_real" ]] || fail "Candidate release is already current"
  OLD_RELEASE=$old_real

  [[ -f "$FRONTEND_ENV" && ! -L "$FRONTEND_ENV" ]] ||
    fail "Frontend environment is unavailable"
  [[ "$(realpath -e "$FRONTEND_ENV")" == "$FRONTEND_ENV" ]] ||
    fail "Frontend environment path is not canonical"

  [[ -f "$DATABASE_PATH" && ! -L "$DATABASE_PATH" ]] || fail "Database is unavailable"
  database_real="$(realpath -e "$DATABASE_PATH")"
  [[ "$database_real" == "$DATABASE_PATH" ]] || fail "Database path is not canonical"
  [[ ! -e "$DATABASE_PATH.maintenance-lock" ]] || fail "Database maintenance lock already exists"
  MAINTENANCE_LOCK="$DATABASE_PATH.maintenance-lock"

  [[ -d "$WEIXIN_SESSION_DIR" && ! -L "$WEIXIN_SESSION_DIR" ]] ||
    fail "WeChat session directory is unavailable"
  session_real="$(realpath -e "$WEIXIN_SESSION_DIR")"
  [[ "$session_real" == "$WEIXIN_SESSION_DIR" ]] ||
    fail "WeChat session directory is not canonical"

  [[ -x "$NODE_BIN" ]] || fail "Project Node executable is unavailable"
  node_real="$(realpath -e "$NODE_BIN")"
  [[ "$node_real" == "$PROJECT_ROOT/runtime/"* ]] ||
    fail "Project Node executable resolved outside the runtime"
  NODE_BIN=$node_real
  local node_major
  node_major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
  [[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 24 ]] ||
    fail "Project Node.js 24 or newer is required"

  [[ -f "$NEW_RELEASE/release-manifest.json" ]] || fail "Candidate manifest is missing"
  [[ -f "$NEW_RELEASE/backend/src/server.js" ]] || fail "Candidate backend entry is missing"
  [[ -f "$NEW_RELEASE/backend/src/weixin/worker.js" ]] || fail "Candidate WeChat entry is missing"
  [[ -f "$NEW_RELEASE/outputs/product-design-prototype/scripts/static-server.mjs" ]] ||
    fail "Candidate frontend entry is missing"
  [[ -f "$NEW_RELEASE/outputs/product-design-prototype/dist/index.html" ]] ||
    fail "Candidate frontend build is missing"

  install -d -o root -g root -m 0700 "$BACKUP_DIR" "$EVIDENCE_DIR"
  [[ "$(realpath -e "$BACKUP_DIR")" == "$BACKUP_DIR" ]] ||
    fail "Backup directory is not canonical"
  [[ "$(realpath -e "$EVIDENCE_DIR")" == "$EVIDENCE_DIR" ]] ||
    fail "Evidence directory is not canonical"

  STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"
  RUN_BACKUP_DIR="$BACKUP_DIR/$RUN_ID"
  RUN_EVIDENCE_DIR="$EVIDENCE_DIR/$RUN_ID"
  [[ ! -e "$RUN_BACKUP_DIR" && ! -e "$RUN_EVIDENCE_DIR" ]] ||
    fail "Cutover run directory already exists"
  install -d -o root -g root -m 0700 "$RUN_BACKUP_DIR" "$RUN_EVIDENCE_DIR"
  CUTOVER_LOG="$RUN_EVIDENCE_DIR/cutover.log"
  EVIDENCE_REPORT="$RUN_EVIDENCE_DIR/cutover-report.json"
  PROTECTED_BEFORE="$RUN_EVIDENCE_DIR/protected-before.tsv"
  PROTECTED_AFTER="$RUN_EVIDENCE_DIR/protected-after.tsv"
  : > "$CUTOVER_LOG"
  chmod 0600 "$CUTOVER_LOG"
  exec > >(tee -a "$CUTOVER_LOG") 2>&1
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
  verify_preflight_report

  trap rollback_cutover ERR
  trap 'rollback_cutover 129' HUP
  trap 'rollback_cutover 130' INT
  trap 'rollback_cutover 143' TERM

  verify_release_manifest
  freeze_candidate_release
  assert_project_services_ready "$OLD_RELEASE"
  assert_frontend_release_health "$OLD_RELEASE"
  capture_protected_snapshot "$PROTECTED_BEFORE"
  PROTECTED_BEFORE_SHA="$(sha256_file "$PROTECTED_BEFORE")"
  protected_snapshot_ready=1
  rehearse_candidate_migrations
  stage_project_units
  stop_writers_and_lock_database
  backup_weixin_session
  backup_sqlite_offline
  install_candidate_units
  set_current_atomic "$NEW_RELEASE" candidate
  current_switched=1

  remove_owned_maintenance_lock "$MAINTENANCE_LOCK" "$MAINTENANCE_LOCK_SHA"
  maintenance_lock_created=0
  [[ ! -e "$MAINTENANCE_LOCK" ]] || fail "Maintenance lock removal failed"

  restart_candidate_services
  capture_protected_snapshot "$PROTECTED_AFTER"
  PROTECTED_AFTER_SHA="$(sha256_file "$PROTECTED_AFTER")"
  assert_protected_unchanged "$PROTECTED_BEFORE" "$PROTECTED_AFTER"
  write_evidence passed 0 not-required

  cutover_complete=1
  trap - ERR HUP INT TERM
  printf 'CUTOVER_STATUS=passed\n'
  printf 'CURRENT_RELEASE=%s\n' "$(readlink -f "$CURRENT_LINK")"
  printf 'FINAL_BACKUP=%s\n' "$FINAL_BACKUP"
  printf 'FINAL_BACKUP_SHA256=%s\n' "$FINAL_BACKUP_SHA"
  printf 'WEIXIN_BACKUP=%s\n' "$WEIXIN_BACKUP"
  printf 'WEIXIN_BACKUP_SHA256=%s\n' "$WEIXIN_BACKUP_SHA"
  printf 'EVIDENCE_REPORT=%s\n' "$EVIDENCE_REPORT"
  printf 'CUTOVER_LOG=%s\n' "$CUTOVER_LOG"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
