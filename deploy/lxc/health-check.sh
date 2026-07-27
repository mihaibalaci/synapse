#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Synapse — Health Check
# ─────────────────────────────────────────────────────────────────────────────
#
# Quick verification that all services are running.
# Usage: bash /opt/synapse/deploy/lxc/health-check.sh
#
# ─────────────────────────────────────────────────────────────────────────────

echo "Synapse Health Check"
echo "────────────────────"

services=("postgresql" "redis-server" "minio" "synapse-api" "synapse-worker" "nginx")
all_ok=true

for svc in "${services[@]}"; do
  status=$(systemctl is-active "$svc" 2>/dev/null)
  if [ "$status" = "active" ]; then
    echo "  ✓ $svc"
  else
    echo "  ✗ $svc ($status)"
    all_ok=false
  fi
done

echo ""

# API health
echo "API Health:"
api_health=$(curl -s http://localhost:3000/health/ready 2>/dev/null)
if echo "$api_health" | grep -q '"ready"'; then
  echo "  ✓ API ready"
  echo "    $api_health"
else
  echo "  ✗ API not ready"
  echo "    $(curl -s http://localhost:3000/health 2>/dev/null || echo 'unreachable')"
  all_ok=false
fi

echo ""

# Worker health
worker_health=$(curl -s http://localhost:3001/health 2>/dev/null)
if echo "$worker_health" | grep -q '"healthy"'; then
  echo "  ✓ Worker healthy"
else
  echo "  ✗ Worker not responding"
  all_ok=false
fi

echo ""

# MinIO
mc_status=$(/usr/local/bin/mc ls local/synapse-raw 2>/dev/null && echo "ok" || echo "fail")
if [ "$mc_status" != "fail" ]; then
  echo "  ✓ MinIO bucket accessible"
else
  echo "  ✗ MinIO bucket not accessible"
  all_ok=false
fi

echo ""
echo "────────────────────"
if [ "$all_ok" = true ]; then
  echo "Status: ALL HEALTHY"
  exit 0
else
  echo "Status: DEGRADED"
  exit 1
fi
