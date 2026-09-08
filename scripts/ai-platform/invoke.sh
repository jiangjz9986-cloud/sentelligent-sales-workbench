#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ $# -lt 1 ]]; then
  printf 'ERROR: an AI platform operations command is required\n' >&2
  exit 2
fi

readonly COMMAND="$1"
shift

NODE_BIN="${AI_PLATFORM_OPS_NODE:-}"
previous_was_node=0
for argument in "$@"; do
  if [[ "$previous_was_node" -eq 1 ]]; then
    NODE_BIN="$argument"
    previous_was_node=0
    continue
  fi
  case "$argument" in
    --node=*) NODE_BIN="${argument#*=}" ;;
    --node) previous_was_node=1 ;;
  esac
done

if [[ "$previous_was_node" -eq 1 ]]; then
  printf 'ERROR: --node requires a value\n' >&2
  exit 2
fi

if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  printf 'ERROR: an executable Node.js 24+ runtime is required\n' >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 24 ]]; then
  printf 'ERROR: Node.js 24+ is required (found major=%s)\n' "${NODE_MAJOR:-unknown}" >&2
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/ops.mjs" "$COMMAND" "$@"
