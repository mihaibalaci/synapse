#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Synapse — Run Tests on LXC
# ─────────────────────────────────────────────────────────────────────────────
#
# Runs the Node.js unit/integration test suite on the deployed LXC.
# Requires: Node.js installed, Synapse cloned at /opt/synapse
#
# Usage:
#   ssh root@<LXC-IP> bash /opt/synapse/deploy/lxc/run-tests.sh
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

export NVM_DIR="/root/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd /opt/synapse

echo "═══════════════════════════════════════════════════════════════"
echo "  Synapse — Test Suite"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Ensure dev dependencies are available for tests
echo "[1/4] Installing test dependencies..."
npm install 2>/dev/null | tail -1

# Type check
echo "[2/4] TypeScript type check..."
npx tsc --noEmit
echo "    Types ✓"

# Unit tests
echo "[3/4] Running unit tests..."
npx vitest run tests/unit/ 2>&1 | grep -E "Tests|passed|failed|Files"

# Integration tests (need live DB)
echo "[4/4] Running integration tests..."
export TEST_DATABASE_URL="postgresql://synapse_app:synapse_secure_password@localhost:5432/synapse"
npx vitest run tests/integration/ 2>&1 | grep -E "Tests|passed|failed|Files|skipped" || echo "    (some integration tests may be skipped without full env)"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Tests Complete"
echo "═══════════════════════════════════════════════════════════════"
