#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/invoke.sh" backup "$@"
