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
