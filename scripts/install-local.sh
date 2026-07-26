#!/usr/bin/env bash
# Recall local installer for Ubuntu 22.04+/Debian 12+ hosts and Proxmox LXC guests.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/recall}"
REPO_URL="${REPO_URL:-}"
COMPOSE_FILE="infra/docker/docker-compose.yml"

log() { printf '[recall] %s\n' "$1"; }
fail() { printf '[recall] ERROR: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || fail "This installer targets Linux; use Docker Compose directly on macOS."

if [[ -n "$REPO_URL" ]]; then
  command -v git >/dev/null || fail "git is required"
  [[ ! -e "$INSTALL_DIR" ]] || fail "$INSTALL_DIR already exists"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
elif [[ -f package.json ]]; then
  INSTALL_DIR="$(pwd)"
elif [[ -f "$INSTALL_DIR/package.json" ]]; then
  cd "$INSTALL_DIR"
else
  fail "Run from the Recall repository or set REPO_URL"
fi

if ! command -v docker >/dev/null; then
  log "Installing Docker Engine"
  command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl; }
  curl -fsSL https://get.docker.com | sh
fi

docker compose version >/dev/null || fail "Docker Compose plugin is required"
docker info >/dev/null || fail "Docker daemon is not available"

if [[ ! -f .env ]]; then
  cp infra/docker/.env.example .env
  log "Created .env; change local passwords and AUTH_JWT_SECRET before exposing this host"
fi

log "Validating Compose configuration"
docker compose -f "$COMPOSE_FILE" config --quiet

log "Building and starting PostgreSQL, Redis, MinIO, API, worker, and dashboard"
docker compose -f "$COMPOSE_FILE" up -d --build --wait

API_PORT="$(awk -F= '$1 == "API_PORT" { print $2 }' .env | tail -1)"
DASHBOARD_PORT="$(awk -F= '$1 == "DASHBOARD_PORT" { print $2 }' .env | tail -1)"
API_PORT="${API_PORT:-3000}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3100}"

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/health/ready" >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${API_PORT}/health/ready" >/dev/null \
  || fail "API did not become ready; inspect: docker compose -f $COMPOSE_FILE logs"

log "Recall is ready"
log "API: http://127.0.0.1:${API_PORT}"
log "Dashboard: http://127.0.0.1:${DASHBOARD_PORT}"
log "Run the end-to-end proof with: npm run smoke:local"
