# Installation Guide — v1.0.0

## Component Installer

The native installer supports individual component provisioning:

```bash
sudo deploy/install.sh --interactive
# Or with a config file:
sudo deploy/install.sh --config /root/synapse-install.env
# Single component:
sudo deploy/install.sh --config /root/synapse-install.env --component postgres
```

Components: `postgres`, `redis`, `s3`, `embedding`, `llm`, `api`, `worker`, `ui`, `nginx`

Each component supports three modes:
- **install** — provision locally
- **external** — connect to existing infrastructure
- **skip** — don't install or configure

## Prerequisites

- Debian 12+ or Ubuntu 22.04+
- Root access for systemd/package installation
- 2+ CPU cores, 4GB+ RAM (8GB recommended for LLM)
- Go 1.22+ (only if building from source without SYNAPSE_BINARY)

## Admin Authentication

After installation, bootstrap the first administrator:

```bash
AUTH_BOOTSTRAP_EMAIL=admin@synapse.local \
AUTH_BOOTSTRAP_PASSWORD="$(openssl rand -base64 18)" \
synapse auth-bootstrap
```

Record the password securely. The UI has a login page — no nginx JWT injection is needed.

## Session Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ACCESS_TTL_MINUTES` | 15 | Access token lifetime (1–60) |
| `AUTH_REFRESH_TTL_DAYS` | 7 | Refresh session lifetime (1–90) |
| `AUTH_COOKIE_SECURE` | true | Set `false` for HTTP-only deployments |

## LLM Configuration (optional)

Required for compaction, reflection, and contradiction detection:

| Variable | Example |
|----------|---------|
| `LLM_PROVIDER` | `ollama`, `openai`, `anthropic` |
| `LLM_BASE_URL` | `http://127.0.0.1:11434` |
| `LLM_MODEL` | `qwen2.5:3b-instruct-q4_K_M` |

## OIDC Configuration (optional)

| Variable | Description |
|----------|-------------|
| `OIDC_ISSUER` | e.g. `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | OAuth client ID |
| `OIDC_CLIENT_SECRET` | OAuth client secret |
| `OIDC_REDIRECT_URI` | e.g. `http://your-host:8080/api/v1/auth/oidc/callback` |

## Performance Tuning

After installation, run the resource tuning script to automatically configure PostgreSQL and Redis based on available RAM:

```bash
sudo deploy/tune-resources.sh           # Apply optimal settings
sudo deploy/tune-resources.sh --dry-run # Preview without changes
```

### Worker Concurrency

Controls how many sessions are processed in parallel. Set in `/etc/synapse/synapse.env`:

```bash
WORKER_CONCURRENCY=6    # parallel ingestion pipelines
EMBEDDING_NUM_THREADS=4 # CPU threads per embedding call
```

| Deployment | Recommended Workers | Why |
|-----------|--------------------:|-----|
| CPU-only Ollama (default) | 4–8 | Embedding at ~600ms/call saturates CPU |
| GPU Ollama | 8–16 | GPU handles parallel inference |
| Remote embedding (TEI/OpenAI) | 16–32 | Network latency is the ceiling |

`EMBEDDING_NUM_THREADS` should match your container's allocated CPU cores (not host total). In an LXC with 4 cores, set to 4. Too high causes thread thrashing.

### RAM Allocation (auto-tuned)
- **PostgreSQL shared_buffers**: 25% of RAM (keeps vector indexes in memory)
- **PostgreSQL effective_cache_size**: 60% of RAM (better query plans)
- **PostgreSQL work_mem**: 16–128 MB (avoids disk spills)
- **Redis maxmemory**: 5% of RAM with LRU eviction (longer cache retention)
- **Remainder**: available for Ollama models and OS page cache

| Total RAM | PG shared_buffers | PG effective_cache | Redis | Ollama + OS |
|-----------|-------------------|-------------------|-------|-------------|
| 4 GB | 1 GB | 2.4 GB | 200 MB | ~1.4 GB |
| 8 GB | 2 GB | 4.8 GB | 400 MB | ~5.2 GB |
| 16 GB | 4 GB | 9.6 GB | 800 MB | ~11.2 GB |
| 32 GB | 8 GB | 19.2 GB | 1.6 GB | ~22.4 GB |

## Database Upgrades

Migrations run via `synapse migrate` before API/worker startup. They are forward-only with advisory locking and SHA-256 checksums.

## Validate

```bash
systemctl status synapse-api synapse-worker
curl -fsS http://127.0.0.1:3000/health/ready
curl -fsS http://127.0.0.1:3000/metrics | head -5
journalctl -u synapse-api --since '5 minutes ago'
```

## CLI Commands

```
synapse serve              # API server
synapse worker             # Worker + auto-compaction
synapse migrate            # Apply migrations
synapse auth-bootstrap     # Create first admin
synapse compact            # Manual compaction
synapse detect-contradictions  # Batch contradiction scan
synapse s3-gc              # Garbage collect S3 orphans
synapse embed-backfill     # Fill missing embeddings
synapse verify-storage     # Check S3 consistency
synapse mcp                # MCP server
```
