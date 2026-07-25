#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Recall — Local Install Script (Proxmox LXC / Bare Metal / VM)
#
# Installs everything on a single machine for testing:
#   - Node.js 20
#   - Docker + Docker Compose (for Postgres, Redis, MinIO)
#   - Builds and starts the API, workers, dashboard
#   - Optionally installs Ollama for self-hosted embedding/LLM
#
# Requirements:
#   - Ubuntu 22.04+ or Debian 12+ (LXC container or VM)
#   - Minimum: 4 CPU, 8GB RAM, 50GB disk
#   - Recommended: 8 CPU, 16GB RAM, 100GB disk (for Ollama)
#   - Root or sudo access
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/.../scripts/install-local.sh | bash
#   # OR
#   chmod +x scripts/install-local.sh && ./scripts/install-local.sh
#
# After install:
#   - API:       http://<your-ip>:3000
#   - Dashboard: http://<your-ip>:3100
#   - MinIO:     http://<your-ip>:9001 (minioadmin/minioadmin)
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${BLUE}═══ $1 ═══${NC}\n"; }

# ─── Configuration ────────────────────────────────────────────────────────────

INSTALL_DIR="${INSTALL_DIR:-/opt/recall}"
REPO_URL="${REPO_URL:-}"  # Leave empty if already cloned
INSTALL_OLLAMA="${INSTALL_OLLAMA:-false}"
OLLAMA_EMBEDDING_MODEL="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}"
OLLAMA_LLM_MODEL="${OLLAMA_LLM_MODEL:-}"  # Empty = skip LLM (heuristic only)
NODE_VERSION="20"
HOST_IP=$(hostname -I | awk '{print $1}')

# ─── Pre-flight checks ───────────────────────────────────────────────────────

step "Pre-flight checks"

if [[ $EUID -ne 0 ]]; then
  warn "Not running as root. Will use sudo where needed."
  SUDO="sudo"
else
  SUDO=""
fi

# Check minimum resources
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
if [[ $TOTAL_MEM -lt 4000 ]]; then
  warn "Only ${TOTAL_MEM}MB RAM detected. Minimum 4GB recommended (8GB+ for Ollama)."
fi

log "Host IP: $HOST_IP"
log "Install directory: $INSTALL_DIR"
log "Ollama: $INSTALL_OLLAMA"

# ─── Install system dependencies ─────────────────────────────────────────────

step "Installing system dependencies"

$SUDO apt-get update -qq
$SUDO apt-get install -y -qq \
  curl wget git ca-certificates gnupg lsb-release \
  build-essential python3 jq unzip

log "System dependencies installed"

# ─── Install Docker ───────────────────────────────────────────────────────────

step "Installing Docker"

if command -v docker &>/dev/null; then
  log "Docker already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO usermod -aG docker "${USER:-root}" 2>/dev/null || true
  log "Docker installed"
fi

# Ensure Docker Compose plugin is available
if ! docker compose version &>/dev/null; then
  $SUDO apt-get install -y -qq docker-compose-plugin
fi
log "Docker Compose: $(docker compose version --short)"

# Start Docker if not running
$SUDO systemctl enable docker 2>/dev/null || true
$SUDO systemctl start docker 2>/dev/null || true

# ─── Install Node.js ──────────────────────────────────────────────────────────

step "Installing Node.js ${NODE_VERSION}"

if command -v node &>/dev/null && node -v | grep -q "v${NODE_VERSION}"; then
  log "Node.js already installed: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | $SUDO bash -
  $SUDO apt-get install -y -qq nodejs
  log "Node.js installed: $(node -v)"
fi

# ─── Install Ollama (optional) ────────────────────────────────────────────────

if [[ "$INSTALL_OLLAMA" == "true" ]]; then
  step "Installing Ollama (self-hosted embedding + LLM)"

  if command -v ollama &>/dev/null; then
    log "Ollama already installed"
  else
    curl -fsSL https://ollama.ai/install.sh | $SUDO sh
    log "Ollama installed"
  fi

  # Start Ollama service
  $SUDO systemctl enable ollama 2>/dev/null || true
  $SUDO systemctl start ollama 2>/dev/null || true

  # Wait for Ollama to be ready
  for i in {1..30}; do
    if curl -s http://localhost:11434/api/tags &>/dev/null; then
      break
    fi
    sleep 1
  done

  # Pull embedding model
  log "Pulling embedding model: $OLLAMA_EMBEDDING_MODEL"
  ollama pull "$OLLAMA_EMBEDDING_MODEL"

  # Pull LLM model (if specified)
  if [[ -n "$OLLAMA_LLM_MODEL" ]]; then
    log "Pulling LLM model: $OLLAMA_LLM_MODEL"
    ollama pull "$OLLAMA_LLM_MODEL"
  fi

  log "Ollama ready with models"
fi

# ─── Clone / Setup project ───────────────────────────────────────────────────

step "Setting up project"

if [[ -n "$REPO_URL" ]]; then
  $SUDO mkdir -p "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
elif [[ -d "$INSTALL_DIR/package.json" ]] || [[ -f "./package.json" ]]; then
  # Already in project directory or INSTALL_DIR exists
  if [[ -f "./package.json" ]]; then
    INSTALL_DIR="$(pwd)"
  fi
  cd "$INSTALL_DIR"
  log "Using existing project at $INSTALL_DIR"
else
  # Assume script is run from project root
  INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$INSTALL_DIR"
  log "Using project at $INSTALL_DIR"
fi

# ─── Start infrastructure (Docker Compose) ────────────────────────────────────

step "Starting infrastructure services"

cd "$INSTALL_DIR"

# Create .env if not exists
if [[ ! -f .env ]]; then
  cp .env.example .env
  log "Created .env from example"
fi

# Override for Ollama if installed
if [[ "$INSTALL_OLLAMA" == "true" ]]; then
  sed -i 's/EMBEDDING_PROVIDER=.*/EMBEDDING_PROVIDER=ollama/' .env
  sed -i 's|EMBEDDING_URL=.*|EMBEDDING_URL=http://localhost:11434|' .env 2>/dev/null || echo "EMBEDDING_URL=http://localhost:11434" >> .env
  sed -i "s/EMBEDDING_MODEL=.*/EMBEDDING_MODEL=${OLLAMA_EMBEDDING_MODEL}/" .env
  sed -i 's/EMBEDDING_DIMENSIONS=.*/EMBEDDING_DIMENSIONS=768/' .env

  if [[ -n "$OLLAMA_LLM_MODEL" ]]; then
    sed -i 's/LLM_PROVIDER=.*/LLM_PROVIDER=ollama/' .env
    sed -i "s/LLM_MODEL=.*/LLM_MODEL=${OLLAMA_LLM_MODEL}/" .env
    sed -i 's|LLM_URL=.*|LLM_URL=http://localhost:11434|' .env 2>/dev/null || echo "LLM_URL=http://localhost:11434" >> .env
  else
    sed -i 's/LLM_PROVIDER=.*/LLM_PROVIDER=local-none/' .env
  fi
  log "Configured .env for Ollama"
fi

# Start Postgres, Redis, MinIO
docker compose -f infra/docker/docker-compose.yml up -d

# Wait for services to be healthy
log "Waiting for services to be healthy..."
for i in {1..60}; do
  if docker compose -f infra/docker/docker-compose.yml ps | grep -q "(healthy)"; then
    break
  fi
  sleep 2
done

log "Infrastructure services running"

# ─── Install Node dependencies ────────────────────────────────────────────────

step "Installing Node.js dependencies"

cd "$INSTALL_DIR"
npm install

# Build main project
npm run build 2>/dev/null || log "Build skipped (dev mode will use tsx)"

# Build consumer packages
cd packages/mcp-server && npm install && npm run build && cd "$INSTALL_DIR"
cd packages/cli && npm install && npm run build && npm link 2>/dev/null || true && cd "$INSTALL_DIR"
cd packages/dashboard && npm install && cd "$INSTALL_DIR"

log "All dependencies installed"

# ─── Create systemd services ─────────────────────────────────────────────────

step "Creating systemd services"

# API Service
$SUDO tee /etc/systemd/system/recall-api.service > /dev/null <<EOF
[Unit]
Description=Recall API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=$(which npx) tsx src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Dashboard Service
$SUDO tee /etc/systemd/system/recall-dashboard.service > /dev/null <<EOF
[Unit]
Description=Recall Dashboard
After=recall-api.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/packages/dashboard
Environment=NEXT_PUBLIC_API_URL=http://localhost:3000
ExecStart=$(which npx) next dev --port 3100 --hostname 0.0.0.0
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable recall-api recall-dashboard
$SUDO systemctl start recall-api
sleep 3
$SUDO systemctl start recall-dashboard

log "Services created and started"

# ─── Verify everything is running ─────────────────────────────────────────────

step "Verifying installation"

sleep 5

# Check API
if curl -s http://localhost:3000/health | jq -r '.status' 2>/dev/null | grep -q "healthy"; then
  log "API is healthy at http://${HOST_IP}:3000"
else
  warn "API may still be starting. Check: journalctl -u recall-api -f"
fi

# Check Dashboard
if curl -s http://localhost:3100 &>/dev/null; then
  log "Dashboard running at http://${HOST_IP}:3100"
else
  warn "Dashboard may still be building. Check: journalctl -u recall-dashboard -f"
fi

# Check Ollama
if [[ "$INSTALL_OLLAMA" == "true" ]]; then
  if curl -s http://localhost:11434/api/tags | jq -r '.models[].name' 2>/dev/null | grep -q "$OLLAMA_EMBEDDING_MODEL"; then
    log "Ollama running with $OLLAMA_EMBEDDING_MODEL"
  fi
fi

# Check Docker services
log "Docker services:"
docker compose -f "$INSTALL_DIR/infra/docker/docker-compose.yml" ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null || true

# ─── Print summary ────────────────────────────────────────────────────────────

step "Installation Complete!"

cat <<EOF

╔══════════════════════════════════════════════════════════════╗
║           Recall — Local Installation             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  API:        http://${HOST_IP}:3000                          ║
║  Dashboard:  http://${HOST_IP}:3100                          ║
║  MinIO UI:   http://${HOST_IP}:9001  (minioadmin/minioadmin) ║
║  Health:     http://${HOST_IP}:3000/health                   ║
║                                                              ║
║  CLI:        recall search "how do we deploy?"                  ║
║  MCP:        See docs/IDE-SETUP.md                           ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  Services:                                                   ║
║    systemctl status recall-api                               ║
║    systemctl status recall-dashboard                         ║
║    journalctl -u recall-api -f        (API logs)             ║
║    journalctl -u recall-dashboard -f  (Dashboard logs)       ║
║                                                              ║
║  Docker:                                                     ║
║    docker compose -f infra/docker/docker-compose.yml ps      ║
║    docker compose -f infra/docker/docker-compose.yml logs -f ║
║                                                              ║
║  Restart:                                                    ║
║    systemctl restart recall-api                              ║
║    systemctl restart recall-dashboard                        ║
║                                                              ║
║  Uninstall:                                                  ║
║    systemctl stop recall-api recall-dashboard                ║
║    docker compose -f infra/docker/docker-compose.yml down -v ║
╚══════════════════════════════════════════════════════════════╝

Next steps:
  1. Open http://${HOST_IP}:3100 to see the dashboard
  2. Test the API: curl http://${HOST_IP}:3000/health
  3. Upload a test session: see docs/API.md for examples
  4. Connect your IDE: see docs/IDE-SETUP.md
  5. Set MCP server URL to: http://${HOST_IP}:3000

EOF
