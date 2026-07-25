#!/bin/bash
# Uninstall Recall from local machine

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/recall}"
SUDO=""
[[ $EUID -ne 0 ]] && SUDO="sudo"

echo "Stopping services..."
$SUDO systemctl stop recall-api recall-dashboard 2>/dev/null || true
$SUDO systemctl disable recall-api recall-dashboard 2>/dev/null || true
$SUDO rm -f /etc/systemd/system/recall-api.service /etc/systemd/system/recall-dashboard.service
$SUDO systemctl daemon-reload

echo "Stopping Docker containers..."
cd "$INSTALL_DIR" 2>/dev/null && docker compose -f infra/docker/docker-compose.yml down -v 2>/dev/null || true

echo "Done. Project files remain at $INSTALL_DIR (remove manually if desired)."
