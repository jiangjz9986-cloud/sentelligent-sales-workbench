#!/usr/bin/env bash
set -euo pipefail

umask 077

TARGET_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/ai-platform/check-artifact.sh --path=<directory-or-tar>

Rejects release/artifact inputs that contain AI platform runtime state,
SQLite databases, logs, backup directories, environment files, or common
credential/key filenames. The check inspects names and archive members only;
it never extracts or modifies the input.

Options:
  --path=<path>       Directory or .tar/.tar.gz/.tgz artifact to inspect
  --help              Show this message
EOF
}

fail() {
  printf 'ARTIFACT_CHECK_STATUS=failed\nARTIFACT_CHECK_ERROR=%s\n' "$*" >&2
  return 1
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --path=*) TARGET_PATH=${1#*=} ;;
      --path)
        shift
        [[ $# -gt 0 ]] || { fail "--path requires a value"; return 1; }
        TARGET_PATH=$1
        ;;
      --help|-h)
        usage
        return 2
        ;;
      *)
        fail "unknown argument: $1"
        return 1
        ;;
    esac
    shift
  done
}

unsafe_member() {
  local member=$1
  local normalized basename
  normalized=$(printf '%s' "$member" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  basename=${normalized##*/}
  [[ "$member" != /* ]] || return 0
  [[ "$member" != *"../"* && "$member" != *"/.." && "$member" != ".." ]] || return 0
  # A locked dependency may legitimately ship runtime helpers below
  # `node_modules/**/runtime/**`; reject project runtime state everywhere else.
  if [[ "$normalized" =~ (^|/)(\.runtime|logs?|backups?)(/|$) ]]; then
    return 0
  fi
  if [[ "$normalized" =~ (^|/)runtime(/|$) ]] && [[ ! "$normalized" =~ (^|/)node_modules/.*/runtime(/|$) ]]; then
    return 0
  fi
  [[ ! "$normalized" =~ (^|/)(\.env|backend\.env|frontend\.env|[^/]+\.(sqlite|sqlite3|db|sqlite-wal|sqlite-shm|log|out|pem|key|p12|pfx))$ ]] || return 0

  # Source identifiers such as `shortcut_webhook_tokens.mjs` are not secret
  # files. Keep name-only rejection for non-source credential artifacts and
  # let the release content scanner inspect source contents separately.
  case "$basename" in
    *.c|*.cc|*.cpp|*.cjs|*.css|*.go|*.h|*.hpp|*.html|*.java|*.js|*.jsx|*.kt|*.mjs|*.php|*.py|*.rb|*.rs|*.sh|*.sql|*.swift|*.ts|*.tsx|*.vue|*.zsh)
      return 1
      ;;
  esac

  [[ ! "$normalized" =~ (^|/)[^/]*(secret|credential|token|api[-_]?key)[^/]*$ ]] || return 0
  return 1
}

check_directory() {
  local entry relative_entry
  while IFS= read -r -d '' entry; do
    [[ ! -L "$entry" ]] || fail "symbolic link is not allowed in artifact input: $entry"
    relative_entry=${entry#"$TARGET_PATH"/}
    [[ "$relative_entry" != "$entry" ]] || relative_entry=$(basename "$entry")
    if unsafe_member "$relative_entry"; then
      fail "forbidden runtime or secret-like artifact member: $relative_entry"
    fi
  done < <(find "$TARGET_PATH" -mindepth 1 -print0)
}

check_archive() {
  local entry listing
  command -v tar >/dev/null 2>&1 || fail "tar is required to inspect archive inputs"
  listing="$(mktemp "${TMPDIR:-/tmp}/ai-platform-artifact.XXXXXX")" || fail "unable to create temporary archive listing"
  if ! tar -tf "$TARGET_PATH" > "$listing"; then
    rm -f -- "$listing"
    fail "unable to list archive members: $TARGET_PATH"
  fi
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    if unsafe_member "$entry"; then
      rm -f -- "$listing"
      fail "forbidden runtime or secret-like archive member: $entry"
    fi
  done < "$listing"
  rm -f -- "$listing"
}

main() {
  local parse_status=0
  parse_arguments "$@" || parse_status=$?
  [[ "$parse_status" -eq 0 ]] || {
    [[ "$parse_status" -eq 2 ]] && return 0
    return "$parse_status"
  }
  [[ -n "$TARGET_PATH" ]] || { usage >&2; fail "--path is required"; }
  TARGET_PATH=${TARGET_PATH%/}
  [[ -n "$TARGET_PATH" ]] || TARGET_PATH=/
  [[ -e "$TARGET_PATH" && ! -L "$TARGET_PATH" ]] || fail "artifact input is unavailable or a symlink: $TARGET_PATH"
  if [[ -d "$TARGET_PATH" ]]; then
    check_directory
  elif [[ -f "$TARGET_PATH" ]]; then
    case "$TARGET_PATH" in
      *.tar|*.tar.gz|*.tgz) check_archive ;;
      *) fail "artifact file must be a tar archive (.tar, .tar.gz, or .tgz): $TARGET_PATH" ;;
    esac
  else
    fail "artifact input must be a regular file or directory: $TARGET_PATH"
  fi
  printf 'ARTIFACT_CHECK_STATUS=passed\nARTIFACT_PATH=%s\n' "$TARGET_PATH"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
