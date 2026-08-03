#!/usr/bin/env bash
# Synapse resource tuning script. Detects available RAM and applies optimal
# PostgreSQL and Redis settings proportionally.
#
# Usage:
#   sudo deploy/tune-resources.sh           # Apply settings
#   sudo deploy/tune-resources.sh --dry-run # Show what would be applied
#
set -Eeuo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

log() { printf '[synapse-tune] %s\n' "$*"; }

# ─── Detect available RAM ─────────────────────────────────────────────────────

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
TOTAL_RAM_GB=$((TOTAL_RAM_MB / 1024))

log "Detected RAM: ${TOTAL_RAM_MB} MB (${TOTAL_RAM_GB} GB)"

# ─── Calculate allocations ────────────────────────────────────────────────────
#
# Strategy (proportional to total RAM):
#   PostgreSQL shared_buffers: 25% of RAM (capped at 8GB)
#   PostgreSQL effective_cache_size: 60% of RAM
#   PostgreSQL work_mem: scaled 16MB–128MB
#   PostgreSQL maintenance_work_mem: 5% of RAM (capped at 2GB)
#   Redis maxmemory: 5% of RAM (min 64MB, max 2GB)
#   Ollama/OS: remainder

PG_SHARED=$((TOTAL_RAM_MB / 4))
[[ $PG_SHARED -gt 8192 ]] && PG_SHARED=8192
[[ $PG_SHARED -lt 128 ]] && PG_SHARED=128

PG_EFFECTIVE=$((TOTAL_RAM_MB * 60 / 100))
[[ $PG_EFFECTIVE -lt 512 ]] && PG_EFFECTIVE=512

if [[ $TOTAL_RAM_MB -ge 16384 ]]; then
  PG_WORK_MEM=128
elif [[ $TOTAL_RAM_MB -ge 8192 ]]; then
  PG_WORK_MEM=64
elif [[ $TOTAL_RAM_MB -ge 4096 ]]; then
  PG_WORK_MEM=32
else
  PG_WORK_MEM=16
fi

PG_MAINTENANCE=$((TOTAL_RAM_MB * 5 / 100))
[[ $PG_MAINTENANCE -gt 2048 ]] && PG_MAINTENANCE=2048
[[ $PG_MAINTENANCE -lt 64 ]] && PG_MAINTENANCE=64

REDIS_MEM=$((TOTAL_RAM_MB * 5 / 100))
[[ $REDIS_MEM -gt 2048 ]] && REDIS_MEM=2048
[[ $REDIS_MEM -lt 64 ]] && REDIS_MEM=64

# WAL buffers: 1/32 of shared_buffers, capped at 64MB
PG_WAL=$((PG_SHARED / 32))
[[ $PG_WAL -gt 64 ]] && PG_WAL=64
[[ $PG_WAL -lt 8 ]] && PG_WAL=8

# ─── Display plan ─────────────────────────────────────────────────────────────

log ""
log "═══ Resource Allocation Plan ═══"
log ""
log "Total RAM:                   ${TOTAL_RAM_MB} MB"
log ""
log "PostgreSQL:"
log "  shared_buffers:            ${PG_SHARED} MB (25% of RAM)"
log "  effective_cache_size:      ${PG_EFFECTIVE} MB (60% of RAM)"
log "  work_mem:                  ${PG_WORK_MEM} MB"
log "  maintenance_work_mem:      ${PG_MAINTENANCE} MB (5% of RAM)"
log "  wal_buffers:               ${PG_WAL} MB"
log "  random_page_cost:          1.1"
log "  effective_io_concurrency:  200"
log ""
log "Redis:"
log "  maxmemory:                 ${REDIS_MEM} MB (5% of RAM)"
log "  maxmemory-policy:          allkeys-lru"
log ""
log "Remaining for Ollama + OS:   ~$((TOTAL_RAM_MB - PG_SHARED - REDIS_MEM)) MB"
log ""

if $DRY_RUN; then
  log "DRY RUN — no changes applied."
  exit 0
fi

# ─── Apply PostgreSQL settings ────────────────────────────────────────────────

PG_CONF=$(find /etc/postgresql -name postgresql.conf 2>/dev/null | head -1)
if [[ -z "$PG_CONF" ]]; then
  log "WARNING: postgresql.conf not found; skipping PostgreSQL tuning"
else
  # Remove any previous synapse tuning block
  sed -i '/# Synapse performance tuning/,/^$/d' "$PG_CONF"

  cat >> "$PG_CONF" <<EOF

# Synapse performance tuning (auto-applied $(date +%Y-%m-%d), ${TOTAL_RAM_MB}MB RAM detected)
shared_buffers = '${PG_SHARED}MB'
effective_cache_size = '${PG_EFFECTIVE}MB'
work_mem = '${PG_WORK_MEM}MB'
maintenance_work_mem = '${PG_MAINTENANCE}MB'
wal_buffers = '${PG_WAL}MB'
random_page_cost = 1.1
effective_io_concurrency = 200
max_wal_size = '2GB'

EOF

  log "PostgreSQL config updated: $PG_CONF"

  if systemctl is-active --quiet postgresql; then
    systemctl restart postgresql
    log "PostgreSQL restarted"
  else
    log "PostgreSQL not running; config will apply on next start"
  fi
fi

# ─── Apply Redis settings ─────────────────────────────────────────────────────

if command -v redis-cli >/dev/null 2>&1 && redis-cli ping >/dev/null 2>&1; then
  redis-cli CONFIG SET maxmemory "${REDIS_MEM}mb" >/dev/null
  redis-cli CONFIG SET maxmemory-policy allkeys-lru >/dev/null
  redis-cli CONFIG REWRITE >/dev/null 2>&1 || true
  log "Redis configured: maxmemory=${REDIS_MEM}MB, policy=allkeys-lru"
else
  log "WARNING: Redis not reachable; skipping Redis tuning"
fi

# ─── Restart Synapse to reconnect with tuned services ─────────────────────────

if systemctl is-active --quiet synapse-api; then
  systemctl restart synapse-api synapse-worker
  sleep 2
  log "Synapse services restarted"
fi

log ""
log "═══ Tuning complete ═══"
log ""

# ─── Verify ──────────────────────────────────────────────────────────────────

if command -v psql >/dev/null 2>&1; then
  DB_URL=$(sed -n 's/^DATABASE_URL=//p' /etc/synapse/synapse.env 2>/dev/null | tail -n 1)
  DB_URL=${DB_URL#\"}; DB_URL=${DB_URL%\"}
  if [[ -n "$DB_URL" ]]; then
    log "Verifying PostgreSQL settings:"
    PGCONNECT_TIMEOUT=5 psql "$DB_URL" -X -A -t -c "SELECT 'shared_buffers=' || current_setting('shared_buffers'); SELECT 'effective_cache_size=' || current_setting('effective_cache_size'); SELECT 'work_mem=' || current_setting('work_mem');" 2>/dev/null | sed 's/^/  /'
  fi
fi

if command -v redis-cli >/dev/null 2>&1; then
  log "Verifying Redis settings:"
  printf "  maxmemory=%s\n" "$(redis-cli CONFIG GET maxmemory | tail -1)"
  printf "  policy=%s\n" "$(redis-cli CONFIG GET maxmemory-policy | tail -1)"
fi
