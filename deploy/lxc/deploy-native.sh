#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Synapse — Native LXC Deployment (No Docker)
# ─────────────────────────────────────────────────────────────────────────────
#
# Deploys Synapse with all components as native systemd services:
#   - PostgreSQL 16 + pgvector (apt)
#   - Redis 7 (apt)
#   - MinIO (binary + systemd)
#   - Node.js 22 (nvm)
#   - Synapse API (systemd)
#   - Synapse Worker (systemd)
#   - Synapse Dashboard (nginx static)
#
# Usage:
#   scp deploy-native.sh root@<LXC-IP>:/root/
#   ssh root@<LXC-IP> bash /root/deploy-native.sh
#
# Prerequisites:
#   - Fresh Debian 12/13 LXC container
#   - At least 4GB RAM, 2 vCPUs, 20GB disk
#   - Internet connectivity
#
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SYNAPSE_REPO="https://github.com/mihaibalaci/synapse.git"
SYNAPSE_BRANCH="harden/production-readiness"
SYNAPSE_DIR="/opt/synapse"
MINIO_DATA="/var/lib/minio/data"
MINIO_USER="minioadmin"
MINIO_PASS="minioadmin"
PG_DB="synapse"
PG_USER="synapse_app"
PG_PASS="synapse_secure_password"
JWT_SECRET="synapse-$(openssl rand -hex 16)"

echo "═══════════════════════════════════════════════════════════════"
echo "  Synapse — Native LXC Deployment"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── 1. System Update ────────────────────────────────────────────────────────
echo "[1/9] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget gnupg lsb-release ca-certificates git build-essential nginx

# ─── 2. PostgreSQL 16 + pgvector ─────────────────────────────────────────────
echo "[2/9] Installing PostgreSQL 16 + pgvector..."

# Add PostgreSQL apt repo
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
  echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
fi

apt-get install -y -qq postgresql-16 postgresql-16-pgvector

# Start PostgreSQL
systemctl enable postgresql
systemctl start postgresql

# Create database and user
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE $PG_USER WITH LOGIN PASSWORD '$PG_PASS';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 || \
  sudo -u postgres createdb -O "$PG_USER" "$PG_DB"

# Enable extensions
sudo -u postgres psql -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"
sudo -u postgres psql -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# Allow local connections with password
grep -q "synapse_app" /etc/postgresql/16/main/pg_hba.conf || \
  echo "local   $PG_DB   $PG_USER   md5" >> /etc/postgresql/16/main/pg_hba.conf
systemctl reload postgresql

echo "    PostgreSQL 16 + pgvector ✓"

# ─── 3. Redis 7 ─────────────────────────────────────────────────────────────
echo "[3/9] Installing Redis..."
apt-get install -y -qq redis-server

# Configure Redis
sed -i 's/^supervised no/supervised systemd/' /etc/redis/redis.conf 2>/dev/null || true
sed -i 's/^# maxmemory .*/maxmemory 512mb/' /etc/redis/redis.conf
sed -i 's/^# maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf

systemctl enable redis-server
systemctl restart redis-server
echo "    Redis 7 ✓"

# ─── 4. MinIO (S3-compatible object storage) ────────────────────────────────
echo "[4/9] Installing MinIO..."

if [ ! -f /usr/local/bin/minio ]; then
  wget -q https://dl.min.io/server/minio/release/linux-amd64/minio -O /usr/local/bin/minio
  chmod +x /usr/local/bin/minio
fi

# Create data directory
mkdir -p "$MINIO_DATA"

# Create systemd service
cat > /etc/systemd/system/minio.service << EOF
[Unit]
Description=MinIO Object Storage
After=network.target

[Service]
Type=simple
User=root
Environment=MINIO_ROOT_USER=$MINIO_USER
Environment=MINIO_ROOT_PASSWORD=$MINIO_PASS
ExecStart=/usr/local/bin/minio server $MINIO_DATA --console-address :9001
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable minio
systemctl start minio

# Wait for MinIO to be ready and create bucket
sleep 3
if [ ! -f /usr/local/bin/mc ]; then
  wget -q https://dl.min.io/client/mc/release/linux-amd64/mc -O /usr/local/bin/mc
  chmod +x /usr/local/bin/mc
fi
/usr/local/bin/mc alias set local http://localhost:9000 "$MINIO_USER" "$MINIO_PASS" 2>/dev/null
/usr/local/bin/mc mb local/synapse-raw --ignore-existing 2>/dev/null || true
echo "    MinIO ✓"

# ─── 5. Node.js 22 ──────────────────────────────────────────────────────────
echo "[5/9] Installing Node.js 22..."

export NVM_DIR="/root/.nvm"
if [ ! -d "$NVM_DIR" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 22 2>/dev/null || true
nvm use 22

NODE_PATH="$(which node)"
NPM_PATH="$(which npm)"
NODE_DIR="$(dirname $NODE_PATH)"
echo "    Node.js $(node --version) ✓"

# ─── 6. Clone and Build Synapse ──────────────────────────────────────────────
echo "[6/9] Cloning and building Synapse..."

if [ -d "$SYNAPSE_DIR/.git" ]; then
  cd "$SYNAPSE_DIR"
  git fetch origin
  git checkout "$SYNAPSE_BRANCH"
  git reset --hard "origin/$SYNAPSE_BRANCH"
else
  git clone --branch "$SYNAPSE_BRANCH" "$SYNAPSE_REPO" "$SYNAPSE_DIR"
  cd "$SYNAPSE_DIR"
fi

"$NPM_PATH" install --omit=dev 2>/dev/null
"$NPM_PATH" install pino-pretty 2>/dev/null  # needed for dev transport fallback
"$NODE_DIR/npx" tsc 2>/dev/null || "$NPM_PATH" run build:core
echo "    Synapse built ✓"

# ─── 7. Configure Synapse ────────────────────────────────────────────────────
echo "[7/9] Configuring Synapse..."

cat > "$SYNAPSE_DIR/.env" << EOF
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# PostgreSQL (native, no Docker)
DATABASE_URL=postgresql://$PG_USER:$PG_PASS@localhost:5432/$PG_DB

# Redis (native, no Docker)
REDIS_URL=redis://localhost:6379

# MinIO (native, no Docker)
S3_BUCKET=synapse-raw
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=$MINIO_USER
AWS_SECRET_ACCESS_KEY=$MINIO_PASS
AWS_EC2_METADATA_DISABLED=true

# Embedding (local mode — no external API calls)
EMBEDDING_PROVIDER=local
EMBEDDING_MODEL=synapse-local-1536
EMBEDDING_DIMENSIONS=1536

# LLM (disabled by default; set to openai/claude to enable learning loop)
LLM_PROVIDER=local-none
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-...

# Auth
AUTH_ISSUER=https://auth.synapse.local
AUTH_AUDIENCE=synapse
AUTH_JWT_SECRET=$JWT_SECRET

# Rate limits
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
EOF

echo "    Configuration ✓"
echo "    JWT Secret: $JWT_SECRET"

# ─── 8. Systemd Services ────────────────────────────────────────────────────
echo "[8/9] Creating systemd services..."

# Synapse API
cat > /etc/systemd/system/synapse-api.service << EOF
[Unit]
Description=Synapse API Server
After=network.target postgresql.service redis-server.service minio.service
Requires=postgresql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=$SYNAPSE_DIR
EnvironmentFile=$SYNAPSE_DIR/.env
Environment=PATH=$NODE_DIR:/usr/bin:/bin
ExecStart=$NODE_PATH $SYNAPSE_DIR/dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Synapse Worker
cat > /etc/systemd/system/synapse-worker.service << EOF
[Unit]
Description=Synapse Worker (ingestion + enrichment)
After=network.target postgresql.service redis-server.service synapse-api.service
Requires=postgresql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=$SYNAPSE_DIR
EnvironmentFile=$SYNAPSE_DIR/.env
Environment=PATH=$NODE_DIR:/usr/bin:/bin
ExecStart=$NODE_PATH $SYNAPSE_DIR/dist/worker-entry.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Nginx for admin UI (static files)
cat > /etc/nginx/sites-available/synapse << 'EOF'
server {
    listen 8080;
    server_name _;
    root /opt/synapse-admin;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API calls to Synapse backend
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /health {
        proxy_pass http://127.0.0.1:3000;
    }
}
EOF

ln -sf /etc/nginx/sites-available/synapse /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

systemctl daemon-reload
systemctl enable synapse-api synapse-worker nginx
echo "    Systemd services ✓"

# ─── 9. Start Everything ─────────────────────────────────────────────────────
echo "[9/9] Starting services..."

systemctl start synapse-api
sleep 3
systemctl start synapse-worker
systemctl restart nginx

# Verify
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deployment Complete!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Services:"
echo "    PostgreSQL:  $(systemctl is-active postgresql)"
echo "    Redis:       $(systemctl is-active redis-server)"
echo "    MinIO:       $(systemctl is-active minio)"
echo "    Synapse API: $(systemctl is-active synapse-api)"
echo "    Synapse Worker: $(systemctl is-active synapse-worker)"
echo "    Nginx:       $(systemctl is-active nginx)"
echo ""
echo "  Endpoints:"
echo "    API:         http://$(hostname -I | awk '{print $1}'):3000"
echo "    Admin UI:    http://$(hostname -I | awk '{print $1}'):8080"
echo "    MinIO:       http://$(hostname -I | awk '{print $1}'):9001"
echo ""
echo "  Health check:"
curl -s http://localhost:3000/health || echo "    (API not yet ready, wait a few seconds)"
echo ""
echo ""
echo "  JWT Secret (save this): $JWT_SECRET"
echo ""
echo "  To enable the Learning Loop, add your LLM key to $SYNAPSE_DIR/.env:"
echo "    LLM_PROVIDER=openai"
echo "    OPENAI_API_KEY=sk-..."
echo "    Then: systemctl restart synapse-api synapse-worker"
echo ""
echo "  View logs:"
echo "    journalctl -u synapse-api -f"
echo "    journalctl -u synapse-worker -f"
echo ""
echo "═══════════════════════════════════════════════════════════════"
