#!/usr/bin/env bash
# Synapse native installer for Debian/Ubuntu. Each component can be installed
# locally, connected as an external dependency, or skipped independently.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_FILE=/etc/synapse/install.conf
ENV_FILE=/etc/synapse/synapse.env
DRY_RUN=false
INTERACTIVE=false
CONFIG_FILE=
ONLY_COMPONENT=

log() { printf '[synapse-install] %s\n' "$*"; }
die() { printf '[synapse-install] ERROR: %s\n' "$*" >&2; exit 1; }
run() { if $DRY_RUN; then printf '+ '; printf '%q ' "$@"; printf '\n'; else "$@"; fi; }
backup_file() {
  local path=$1
  [[ -e "$path" ]] || return 0
  run cp -a "$path" "$path.backup.$(date -u +%Y%m%dT%H%M%SZ)"
}
usage() {
  cat <<'EOF'
Usage: sudo deploy/install.sh [options]
  --interactive             Prompt for every selected component and value
  --config FILE             Load a trusted install.env file
  --component NAME          Run one component: postgres|redis|s3|embedding|llm|api|worker|ui|nginx
  --dry-run                 Print actions without modifying the host
  --help

Actions are install, external, or skip and can be set in the config file as
POSTGRES_ACTION, REDIS_ACTION, S3_ACTION, EMBEDDING_ACTION, LLM_ACTION,
API_ACTION, WORKER_ACTION, UI_ACTION, and NGINX_ACTION.
EOF
}
while (($#)); do
  case "$1" in
    --interactive) INTERACTIVE=true ;;
    --config) shift; CONFIG_FILE=${1:?--config requires a path} ;;
    --component) shift; ONLY_COMPONENT=${1:?--component requires a name} ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

if ! $DRY_RUN && [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "run as root (or use --dry-run)"
fi
[[ -z "$ONLY_COMPONENT" || "$ONLY_COMPONENT" =~ ^(postgres|redis|s3|embedding|llm|api|worker|ui|nginx)$ ]] || die "invalid component: $ONLY_COMPONENT"

# Idempotent component runs inherit the last resolved values. Explicit config
# overrides state. Both files are shell syntax and must be trusted/root-only.
[[ -r "$STATE_FILE" ]] && source "$STATE_FILE"
[[ -z "$CONFIG_FILE" || -r "$CONFIG_FILE" ]] || die "cannot read config: $CONFIG_FILE"
[[ -z "$CONFIG_FILE" ]] || source "$CONFIG_FILE"

: "${POSTGRES_ACTION:=install}" "${REDIS_ACTION:=install}" "${S3_ACTION:=install}"
: "${EMBEDDING_ACTION:=install}" "${LLM_ACTION:=external}" "${API_ACTION:=install}"
: "${WORKER_ACTION:=install}" "${UI_ACTION:=install}" "${NGINX_ACTION:=install}"
: "${PG_HOST:=127.0.0.1}" "${PG_PORT:=5432}" "${PG_DATABASE:=synapse}" "${PG_USER:=synapse_app}" "${PG_PASSWORD:=}"
: "${POSTGRES_MAJOR:=16}" "${DATABASE_URL:=}" "${REDIS_HOST:=127.0.0.1}" "${REDIS_PORT:=6379}" "${REDIS_PASSWORD:=}" "${REDIS_URL:=}"
: "${S3_ENDPOINT:=http://127.0.0.1:9000}" "${S3_BUCKET:=synapse-raw}" "${S3_REGION:=us-east-1}"
: "${AWS_ACCESS_KEY_ID:=}" "${AWS_SECRET_ACCESS_KEY:=}" "${MINIO_CONSOLE_PORT:=9001}"
: "${MINIO_VERSION:=RELEASE.2025-04-22T22-12-26Z}" "${MC_VERSION:=RELEASE.2025-04-16T18-13-26Z}"
: "${EMBEDDING_PROVIDER:=ollama}" "${EMBEDDING_URL:=http://127.0.0.1:11434}"
: "${EMBEDDING_MODEL:=nomic-embed-text}" "${EMBEDDING_DIMENSIONS:=768}" "${EMBEDDING_NUM_THREADS:=4}"
: "${OLLAMA_VERSION:=0.32.5}" "${LLM_PROVIDER:=ollama}" "${LLM_BASE_URL:=http://127.0.0.1:11434}"
: "${LLM_MODEL:=}" "${OPENAI_API_KEY:=}" "${ANTHROPIC_API_KEY:=}" "${SYNAPSE_BINARY:=}"
: "${API_PORT:=3000}" "${API_HOST:=127.0.0.1}" "${WORKER_CONCURRENCY:=4}" "${LOG_LEVEL:=info}"
: "${AUTH_ISSUER:=https://auth.synapse.local}" "${AUTH_AUDIENCE:=synapse}" "${AUTH_JWT_SECRET:=}"
: "${RATE_LIMIT_MAX:=100}" "${RATE_LIMIT_WINDOW_MS:=60000}" "${ADMIN_UI_SOURCE:=}"
: "${ADMIN_PORT:=8080}" "${SERVER_NAME:=_}" "${NGINX_INJECT_ADMIN_JWT:=true}"
: "${ADMIN_TOKEN_TTL_DAYS:=30}" "${ADMIN_ORGANIZATION_ID:=default}" "${ADMIN_USER_ID:=admin}"
: "${ADMIN_BASIC_AUTH:=true}" "${ADMIN_BASIC_USER:=synapse-admin}" "${ADMIN_BASIC_PASSWORD:=}"

prompt() {
  local var=$1 label=$2 default=${3-} secret=${4-false} value
  [[ "$INTERACTIVE" == true ]] || return 0
  if [[ "$secret" == true ]]; then
    read -r -s -p "$label${default:+ [configured]}: " value; printf '\n'
  else
    read -r -p "$label${default:+ [$default]}: " value
  fi
  printf -v "$var" '%s' "${value:-$default}"
}
prompt_action() {
  local var=$1 label=$2 current=${!1} value
  [[ "$INTERACTIVE" == true ]] || return 0
  while true; do
    read -r -p "$label action (install/external/skip) [$current]: " value
    value=${value:-$current}
    [[ "$value" =~ ^(install|external|skip)$ ]] && { printf -v "$var" '%s' "$value"; return; }
    log "choose install, external, or skip"
  done
}
selected() { [[ -z "$ONLY_COMPONENT" || "$ONLY_COMPONENT" == "$1" ]]; }
validate_action() { [[ "$2" =~ ^(install|external|skip)$ ]] || die "$1 must be install, external, or skip"; }
for pair in POSTGRES:$POSTGRES_ACTION REDIS:$REDIS_ACTION S3:$S3_ACTION EMBEDDING:$EMBEDDING_ACTION LLM:$LLM_ACTION API:$API_ACTION WORKER:$WORKER_ACTION UI:$UI_ACTION NGINX:$NGINX_ACTION; do
  validate_action "${pair%%:*}_ACTION" "${pair#*:}"
done

apt_install() { run apt-get update; run apt-get install -y --no-install-recommends "$@"; }
ensure_layout() {
  run install -d -m 0750 /etc/synapse /var/lib/synapse
  if ! id synapse >/dev/null 2>&1; then run useradd --system --home /var/lib/synapse --shell /usr/sbin/nologin synapse; fi
  run chown synapse:synapse /var/lib/synapse
}
random_secret() {
  local bytes=$1
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
}
urlencode() {
  local value=$1 char i
  LC_ALL=C
  for ((i = 0; i < ${#value}; i++)); do
    char=${value:i:1}
    case "$char" in
      [A-Za-z0-9.~_-]) printf '%s' "$char" ;;
      *) printf '%%%02X' "'$char" ;;
    esac
  done
}

configure_postgres() {
  prompt_action POSTGRES_ACTION "PostgreSQL"
  [[ "$POSTGRES_ACTION" != skip ]] || return 0
  prompt PG_HOST "PostgreSQL host" "$PG_HOST"; prompt PG_PORT "PostgreSQL port" "$PG_PORT"
  prompt PG_DATABASE "Database name" "$PG_DATABASE"; prompt PG_USER "Database user" "$PG_USER"
  if [[ "$POSTGRES_ACTION" == install ]]; then
    [[ "$PG_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$PG_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "database/user must be simple SQL identifiers"
    [[ "$POSTGRES_MAJOR" =~ ^[0-9]+$ ]] || die "POSTGRES_MAJOR must be numeric"
    [[ -n "$PG_PASSWORD" ]] || PG_PASSWORD=$(random_secret 24)
    prompt PG_PASSWORD "Database password" "$PG_PASSWORD" true
    apt_install ca-certificates curl gnupg
    # Pin the PostgreSQL major and add PGDG only when the distribution does not
    # provide either the server or matching pgvector package.
    local postgres_package="postgresql-$POSTGRES_MAJOR"
    local pgvector_package="postgresql-$POSTGRES_MAJOR-pgvector"
    if ! apt-cache show "$postgres_package" >/dev/null 2>&1 || ! apt-cache show "$pgvector_package" >/dev/null 2>&1; then
      log "PostgreSQL $POSTGRES_MAJOR with pgvector is unavailable; adding the official PostgreSQL repository"
      if ! $DRY_RUN; then
        local distro_codename
        distro_codename=$(. /etc/os-release; printf '%s' "${VERSION_CODENAME:-}")
        [[ -n "$distro_codename" ]] || die "could not determine distribution codename for the PostgreSQL repository"
        curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/postgresql.asc
        gpg --dearmor --yes -o /usr/share/keyrings/postgresql.gpg /tmp/postgresql.asc
        printf 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$distro_codename" \
          >/etc/apt/sources.list.d/pgdg.list
        rm -f /tmp/postgresql.asc
        apt-get update
      fi
    fi
    run apt-get install -y --no-install-recommends "$postgres_package" postgresql-contrib "$pgvector_package"
    local escaped=${PG_PASSWORD//\'/\'\'}
    if $DRY_RUN; then
      log "would create/update PostgreSQL role $PG_USER, database $PG_DATABASE, and required extensions"
    else
      if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1; then
        runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "ALTER ROLE $PG_USER PASSWORD '$escaped';"
      else
        runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "CREATE ROLE $PG_USER LOGIN PASSWORD '$escaped';"
      fi
      if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DATABASE'" | grep -q 1; then
        runuser -u postgres -- createdb -O "$PG_USER" "$PG_DATABASE"
      fi
      runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d "$PG_DATABASE" -c \
        'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
    fi
    PG_HOST=127.0.0.1
  else
    prompt DATABASE_URL "Full PostgreSQL URL (optional if fields are set)" "$DATABASE_URL" true
    [[ -n "$DATABASE_URL" ]] || prompt PG_PASSWORD "Database password" "$PG_PASSWORD" true
  fi
  [[ -n "$DATABASE_URL" ]] || DATABASE_URL="postgresql://$(urlencode "$PG_USER"):$(urlencode "$PG_PASSWORD")@$PG_HOST:$PG_PORT/$PG_DATABASE"
}

configure_redis() {
  prompt_action REDIS_ACTION "Redis"
  [[ "$REDIS_ACTION" != skip ]] || return 0
  if [[ "$REDIS_ACTION" == install ]]; then
    apt_install redis-server
    run systemctl enable --now redis-server
    REDIS_HOST=127.0.0.1; REDIS_PORT=6379; REDIS_URL=redis://127.0.0.1:6379
  else
    prompt REDIS_URL "Redis URL" "$REDIS_URL" true
    if [[ -z "$REDIS_URL" ]]; then
      prompt REDIS_HOST "Redis host" "$REDIS_HOST"; prompt REDIS_PORT "Redis port" "$REDIS_PORT"
      prompt REDIS_PASSWORD "Redis password (optional)" "$REDIS_PASSWORD" true
      if [[ -n "$REDIS_PASSWORD" ]]; then REDIS_URL="redis://:$(urlencode "$REDIS_PASSWORD")@$REDIS_HOST:$REDIS_PORT"; else REDIS_URL="redis://$REDIS_HOST:$REDIS_PORT"; fi
    fi
  fi
}

configure_s3() {
  prompt_action S3_ACTION "S3 / MinIO"
  [[ "$S3_ACTION" != skip ]] || return 0
  prompt S3_BUCKET "S3 bucket" "$S3_BUCKET"; prompt S3_REGION "S3 region" "$S3_REGION"
  if [[ "$S3_ACTION" == install ]]; then
    apt_install ca-certificates curl
    [[ -n "$AWS_ACCESS_KEY_ID" ]] || AWS_ACCESS_KEY_ID=minio-$(random_secret 8)
    [[ -n "$AWS_SECRET_ACCESS_KEY" ]] || AWS_SECRET_ACCESS_KEY=$(random_secret 24)
    prompt AWS_ACCESS_KEY_ID "MinIO access key" "$AWS_ACCESS_KEY_ID" true
    prompt AWS_SECRET_ACCESS_KEY "MinIO secret key" "$AWS_SECRET_ACCESS_KEY" true
    local arch; arch=$(dpkg --print-architecture); [[ "$arch" == amd64 || "$arch" == arm64 ]] || die "MinIO install supports amd64/arm64"
    run curl -fL "https://dl.min.io/server/minio/release/linux-$arch/archive/minio.$MINIO_VERSION" -o /usr/local/bin/minio
    run curl -fL "https://dl.min.io/client/mc/release/linux-$arch/archive/mc.$MC_VERSION" -o /usr/local/bin/mc
    run chmod 0755 /usr/local/bin/minio /usr/local/bin/mc
    run install -d -o synapse -g synapse -m 0750 /var/lib/minio
    if ! $DRY_RUN; then
      cat >/etc/systemd/system/minio.service <<EOF
[Unit]
Description=MinIO
After=network-online.target
[Service]
User=synapse
Group=synapse
Environment=MINIO_ROOT_USER=$AWS_ACCESS_KEY_ID
Environment=MINIO_ROOT_PASSWORD=$AWS_SECRET_ACCESS_KEY
ExecStart=/usr/local/bin/minio server /var/lib/minio --address :9000 --console-address :$MINIO_CONSOLE_PORT
Restart=on-failure
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
    fi
    run systemctl daemon-reload; run systemctl enable --now minio
    S3_ENDPOINT=http://127.0.0.1:9000
    if ! $DRY_RUN; then
      for _ in {1..30}; do curl -fsS "$S3_ENDPOINT/minio/health/live" >/dev/null && break; sleep 1; done
      mc alias set synapse-local "$S3_ENDPOINT" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" >/dev/null
      mc mb --ignore-existing "synapse-local/$S3_BUCKET" >/dev/null
    fi
  else
    prompt S3_ENDPOINT "S3 endpoint URL" "$S3_ENDPOINT"
    prompt AWS_ACCESS_KEY_ID "S3 access key (empty for workload identity)" "$AWS_ACCESS_KEY_ID" true
    prompt AWS_SECRET_ACCESS_KEY "S3 secret key (empty for workload identity)" "$AWS_SECRET_ACCESS_KEY" true
  fi
}

install_ollama() {
  apt_install ca-certificates curl tar
  local arch; arch=$(dpkg --print-architecture); [[ "$arch" == amd64 || "$arch" == arm64 ]] || die "Ollama install supports amd64/arm64"
  local ollama_arch=$arch; [[ "$arch" == amd64 ]] && ollama_arch=amd64
  local tmp=/tmp/ollama-${OLLAMA_VERSION}.tgz
  run curl -fL "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/ollama-linux-$ollama_arch.tgz" -o "$tmp"
  run tar -xzf "$tmp" -C /usr/local
  if ! id ollama >/dev/null 2>&1; then run useradd --system --home /usr/share/ollama --shell /usr/sbin/nologin ollama; fi
  if ! $DRY_RUN; then
    cat >/etc/systemd/system/ollama.service <<'EOF'
[Unit]
Description=Ollama
After=network-online.target
[Service]
User=ollama
Group=ollama
Environment=OLLAMA_HOST=127.0.0.1:11434
ExecStart=/usr/local/bin/ollama serve
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
  fi
  run systemctl daemon-reload; run systemctl enable --now ollama
}

configure_embedding() {
  prompt_action EMBEDDING_ACTION "Embedding provider"
  [[ "$EMBEDDING_ACTION" != skip ]] || return 0
  if [[ "$EMBEDDING_ACTION" == install ]]; then
    install_ollama
    EMBEDDING_PROVIDER=ollama; EMBEDDING_URL=http://127.0.0.1:11434; EMBEDDING_MODEL=nomic-embed-text; EMBEDDING_DIMENSIONS=768
    run /usr/local/bin/ollama pull "$EMBEDDING_MODEL"
  else
    prompt EMBEDDING_PROVIDER "Embedding provider (ollama/openai/tei)" "$EMBEDDING_PROVIDER"
    prompt EMBEDDING_URL "Embedding base URL" "$EMBEDDING_URL"; prompt EMBEDDING_MODEL "Embedding model" "$EMBEDDING_MODEL"
    prompt EMBEDDING_DIMENSIONS "Embedding dimensions (must be 768)" "$EMBEDDING_DIMENSIONS"
  fi
  [[ "$EMBEDDING_DIMENSIONS" == 768 ]] || die "this schema requires 768-dimensional embeddings"
}

configure_llm() {
  prompt_action LLM_ACTION "Synthesis LLM"
  [[ "$LLM_ACTION" != skip ]] || { LLM_PROVIDER=none; return; }
  if [[ "$LLM_ACTION" == install ]]; then
    command -v ollama >/dev/null 2>&1 || install_ollama
    LLM_PROVIDER=ollama; LLM_BASE_URL=http://127.0.0.1:11434
    prompt LLM_MODEL "Ollama generation model to pull" "${LLM_MODEL:-qwen2.5:3b-instruct-q4_K_M}"
    run /usr/local/bin/ollama pull "$LLM_MODEL"
  else
    prompt LLM_PROVIDER "LLM provider (ollama/openai/anthropic/none)" "$LLM_PROVIDER"
    prompt LLM_BASE_URL "LLM base URL" "$LLM_BASE_URL"; prompt LLM_MODEL "LLM model" "$LLM_MODEL"
    [[ "$LLM_PROVIDER" != openai ]] || prompt OPENAI_API_KEY "OpenAI API key" "$OPENAI_API_KEY" true
    [[ "$LLM_PROVIDER" != anthropic ]] || prompt ANTHROPIC_API_KEY "Anthropic API key" "$ANTHROPIC_API_KEY" true
  fi
}

write_env_value() {
  local key=$1 value=$2 escaped
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$key must not contain newlines"
  escaped=${value//\\/\\\\}
  escaped=${escaped//\"/\\\"}
  printf '%s="%s"\n' "$key" "$escaped"
}
write_runtime_env() {
  [[ -n "$AUTH_JWT_SECRET" ]] || AUTH_JWT_SECRET=$(random_secret 32)
  [[ ${#AUTH_JWT_SECRET} -ge 32 ]] || die "AUTH_JWT_SECRET must be at least 32 characters"
  [[ -n "$DATABASE_URL" && -n "$REDIS_URL" && -n "$S3_ENDPOINT" ]] || die "database, Redis, and S3 configuration are required before API/worker installation"
  if $DRY_RUN; then log "would write redacted $ENV_FILE"; return; fi
  install -d -m 0750 /etc/synapse
  umask 077
  local NODE_ENV=production HOST=$API_HOST PORT=$API_PORT
  local vars=(NODE_ENV LOG_LEVEL HOST PORT DATABASE_URL REDIS_URL S3_BUCKET S3_REGION S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY EMBEDDING_PROVIDER EMBEDDING_URL EMBEDDING_MODEL EMBEDDING_DIMENSIONS EMBEDDING_NUM_THREADS LLM_PROVIDER LLM_BASE_URL LLM_MODEL OPENAI_API_KEY ANTHROPIC_API_KEY AUTH_ISSUER AUTH_AUDIENCE AUTH_JWT_SECRET RATE_LIMIT_MAX RATE_LIMIT_WINDOW_MS WORKER_CONCURRENCY)
  : >"$ENV_FILE"
  local var
  for var in "${vars[@]}"; do write_env_value "$var" "${!var}" >>"$ENV_FILE"; done
  chmod 0600 "$ENV_FILE"
}

install_binary() {
  ensure_layout
  local source=$SYNAPSE_BINARY
  if [[ -z "$source" ]]; then
    command -v go >/dev/null 2>&1 || die "Go is required to build; install Go or set SYNAPSE_BINARY"
    source=/tmp/synapse-install
    run env CGO_ENABLED=0 go build -trimpath -o "$source" ./cmd/synapse
  fi
  [[ "$DRY_RUN" == true || -x "$source" || -f "$source" ]] || die "binary not found: $source"
  backup_file /usr/local/bin/synapse
  run install -m 0755 "$source" /usr/local/bin/synapse
}
run_migrations() {
  if $DRY_RUN; then log "would run Synapse database migrations with $ENV_FILE"; return; fi
  env DATABASE_URL="$DATABASE_URL" LOG_LEVEL="$LOG_LEVEL" /usr/local/bin/synapse migrate
}
configure_api() {
  prompt_action API_ACTION "Synapse API"
  [[ "$API_ACTION" != skip ]] || return 0
  if [[ "$API_ACTION" == external ]]; then log "API marked external; no local service installed"; return; fi
  prompt API_PORT "API port" "$API_PORT"; prompt AUTH_JWT_SECRET "JWT HMAC secret" "$AUTH_JWT_SECRET" true
  write_runtime_env; (cd "$REPO_ROOT/go" && install_binary)
  run install -m 0644 "$SCRIPT_DIR/systemd/synapse-api.service" /etc/systemd/system/synapse-api.service
  run_migrations
  run systemctl daemon-reload; run systemctl enable --now synapse-api
}
configure_worker() {
  prompt_action WORKER_ACTION "Synapse worker"
  [[ "$WORKER_ACTION" != skip ]] || return 0
  if [[ "$WORKER_ACTION" == external ]]; then log "worker marked external"; return; fi
  prompt WORKER_CONCURRENCY "Worker concurrency" "$WORKER_CONCURRENCY"
  [[ -x /usr/local/bin/synapse || "$DRY_RUN" == true ]] || { write_runtime_env; (cd "$REPO_ROOT/go" && install_binary); }
  write_runtime_env
  run_migrations
  run install -m 0644 "$SCRIPT_DIR/systemd/synapse-worker.service" /etc/systemd/system/synapse-worker.service
  run systemctl daemon-reload; run systemctl enable --now synapse-worker
}
configure_ui() {
  prompt_action UI_ACTION "Flutter admin UI"
  [[ "$UI_ACTION" != skip ]] || return 0
  if [[ "$UI_ACTION" == external ]]; then log "admin UI marked external"; return; fi
  local source=${ADMIN_UI_SOURCE:-$REPO_ROOT/packages/admin-ui/build/web}
  if [[ ! -f "$source/index.html" ]]; then
    command -v flutter >/dev/null 2>&1 || die "Flutter build missing at $source; install Flutter/build it or set ADMIN_UI_SOURCE"
    (cd "$REPO_ROOT/packages/admin-ui" && run flutter build web --release)
  fi
  run install -d -m 0755 /opt/synapse-admin
  if $DRY_RUN; then log "would copy $source to /opt/synapse-admin"; else cp -a "$source/." /opt/synapse-admin/; fi
}
make_admin_jwt() {
  python3 - "$AUTH_JWT_SECRET" "$AUTH_ISSUER" "$AUTH_AUDIENCE" "$ADMIN_USER_ID" "$ADMIN_ORGANIZATION_ID" "$ADMIN_TOKEN_TTL_DAYS" <<'PY'
import base64,hashlib,hmac,json,sys,time
secret,iss,aud,sub,org,days=sys.argv[1:]
def b64(v): return base64.urlsafe_b64encode(json.dumps(v,separators=(',',':')).encode()).rstrip(b'=').decode()
head=b64({'alg':'HS256','typ':'JWT'})
now=int(time.time()); body=b64({'sub':sub,'organization_id':org,'roles':['admin'],'team_ids':[],'repository_access':[],'iss':iss,'aud':aud,'iat':now,'exp':now+int(days)*86400})
sig=base64.urlsafe_b64encode(hmac.new(secret.encode(),f'{head}.{body}'.encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
print(f'{head}.{body}.{sig}')
PY
}
configure_nginx() {
  prompt_action NGINX_ACTION "nginx"
  [[ "$NGINX_ACTION" != skip ]] || return 0
  if [[ "$NGINX_ACTION" == external ]]; then log "nginx marked external"; return; fi
  apt_install nginx apache2-utils python3 openssl
  prompt ADMIN_PORT "Admin UI port" "$ADMIN_PORT"
  local basic='# basic auth disabled' jwt='# browser must supply Authorization header'
  if [[ "$ADMIN_BASIC_AUTH" == true ]]; then
    [[ -n "$ADMIN_BASIC_PASSWORD" ]] || ADMIN_BASIC_PASSWORD=$(random_secret 16)
    prompt ADMIN_BASIC_PASSWORD "Admin Basic Auth password" "$ADMIN_BASIC_PASSWORD" true
    if ! $DRY_RUN; then printf '%s:%s\n' "$ADMIN_BASIC_USER" "$(openssl passwd -6 "$ADMIN_BASIC_PASSWORD")" >/etc/nginx/synapse.htpasswd; chmod 0600 /etc/nginx/synapse.htpasswd; fi
    basic='auth_basic "Synapse Admin"; auth_basic_user_file /etc/nginx/synapse.htpasswd;'
  fi
  if [[ "$NGINX_INJECT_ADMIN_JWT" == true ]]; then
    local token; token=$(make_admin_jwt)
    jwt="proxy_set_header Authorization \"Bearer $token\";"
  fi
  backup_file /etc/nginx/sites-available/synapse
  if ! $DRY_RUN; then
    sed -e "s/__ADMIN_PORT__/$ADMIN_PORT/g" -e "s/__API_PORT__/$API_PORT/g" -e "s/__SERVER_NAME__/$SERVER_NAME/g" \
      -e "s|__BASIC_AUTH__|$basic|g" -e "s|__JWT_HEADER__|$jwt|g" \
      "$SCRIPT_DIR/nginx/synapse.conf.template" >/etc/nginx/sites-available/synapse
    ln -sfn /etc/nginx/sites-available/synapse /etc/nginx/sites-enabled/synapse
    rm -f /etc/nginx/sites-enabled/default
  fi
  run nginx -t; run systemctl enable --now nginx; run systemctl reload nginx
}

save_state() {
  $DRY_RUN && return
  install -d -m 0750 /etc/synapse; umask 077
  local vars=(POSTGRES_ACTION REDIS_ACTION S3_ACTION EMBEDDING_ACTION LLM_ACTION API_ACTION WORKER_ACTION UI_ACTION NGINX_ACTION PG_HOST PG_PORT PG_DATABASE PG_USER PG_PASSWORD POSTGRES_MAJOR DATABASE_URL REDIS_HOST REDIS_PORT REDIS_PASSWORD REDIS_URL S3_ENDPOINT S3_BUCKET S3_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY MINIO_CONSOLE_PORT MINIO_VERSION MC_VERSION EMBEDDING_PROVIDER EMBEDDING_URL EMBEDDING_MODEL EMBEDDING_DIMENSIONS EMBEDDING_NUM_THREADS OLLAMA_VERSION LLM_PROVIDER LLM_BASE_URL LLM_MODEL OPENAI_API_KEY ANTHROPIC_API_KEY SYNAPSE_BINARY API_PORT API_HOST WORKER_CONCURRENCY LOG_LEVEL AUTH_ISSUER AUTH_AUDIENCE AUTH_JWT_SECRET RATE_LIMIT_MAX RATE_LIMIT_WINDOW_MS ADMIN_UI_SOURCE ADMIN_PORT SERVER_NAME NGINX_INJECT_ADMIN_JWT ADMIN_TOKEN_TTL_DAYS ADMIN_ORGANIZATION_ID ADMIN_USER_ID ADMIN_BASIC_AUTH ADMIN_BASIC_USER ADMIN_BASIC_PASSWORD)
  : >"$STATE_FILE"
  for var in "${vars[@]}"; do printf '%s=%q\n' "$var" "${!var}" >>"$STATE_FILE"; done
  chmod 0600 "$STATE_FILE"
}
summary() {
  log "configuration saved in $STATE_FILE (mode 0600); runtime environment: $ENV_FILE"
  log "API: http://$API_HOST:$API_PORT  Admin UI: http://<host>:$ADMIN_PORT"
  [[ "$ADMIN_BASIC_AUTH" != true ]] || log "Admin Basic Auth user: $ADMIN_BASIC_USER (password is only in the protected state file)"
  log "Checks: systemctl status synapse-api synapse-worker; journalctl -u synapse-api -u synapse-worker"
}

ensure_layout
selected postgres && configure_postgres
selected redis && configure_redis
selected s3 && configure_s3
selected embedding && configure_embedding
selected llm && configure_llm
selected api && configure_api
selected worker && configure_worker
selected ui && configure_ui
selected nginx && configure_nginx
save_state
summary
