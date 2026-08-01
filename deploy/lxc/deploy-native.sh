#!/usr/bin/env bash
# Compatibility entry point. The componentized installer supersedes the old
# Node.js-based LXC script.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/../install.sh" --interactive "$@"
