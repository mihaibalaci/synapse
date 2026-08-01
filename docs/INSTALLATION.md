# Component-by-Component Installation

`deploy/install.sh` installs Synapse natively on Debian/Ubuntu. It can provision local dependencies or connect to services you already operate. It does not run Terraform or change cloud resources.

## Safety and prerequisites

- Run from a trusted checkout on the target host.
- Review the script and config before running as root.
- Back up PostgreSQL and `/etc/synapse` before upgrading an existing server.
- Use least-privilege external credentials. Treat unlabelled resources as production.
- The config and generated state contain secrets; keep them mode `0600` and never commit them.
- Local provisioning supports Debian/Ubuntu with systemd, amd64 or arm64 for MinIO/Ollama.
- Building the API requires Go or a prebuilt `SYNAPSE_BINARY`; building the UI requires Flutter or `ADMIN_UI_SOURCE`.

## Modes

```bash
# Interactive: asks action and values for every component
sudo deploy/install.sh --interactive

# Repeatable config-driven install
cp deploy/install.env.example /root/synapse-install.env
chmod 600 /root/synapse-install.env
sudo deploy/install.sh --config /root/synapse-install.env

# Inspect actions only
sudo deploy/install.sh --config /root/synapse-install.env --dry-run

# Provision/connect one component at a time
sudo deploy/install.sh --config /root/synapse-install.env --component postgres
sudo deploy/install.sh --config /root/synapse-install.env --component redis
sudo deploy/install.sh --config /root/synapse-install.env --component s3
sudo deploy/install.sh --config /root/synapse-install.env --component embedding
sudo deploy/install.sh --config /root/synapse-install.env --component llm
sudo deploy/install.sh --config /root/synapse-install.env --component api
sudo deploy/install.sh --config /root/synapse-install.env --component worker
sudo deploy/install.sh --config /root/synapse-install.env --component ui
sudo deploy/install.sh --config /root/synapse-install.env --component nginx
```

Resolved state is saved to `/etc/synapse/install.conf` and loaded by later component runs. Runtime variables are written to `/etc/synapse/synapse.env`. Both are root-readable only.

## Actions

Each `*_ACTION` is one of:

- `install`: provision and configure a local component.
- `external`: record/test connection details without provisioning it.
- `skip`: leave it untouched. This does not make a mandatory API dependency optional.

| Component | `install` | `external` values |
|---|---|---|
| PostgreSQL | packages, role, database, pgvector | `DATABASE_URL` or host/port/database/user/password |
| Redis | `redis-server` with systemd | `REDIS_URL` or host/port/password |
| S3 | pinned MinIO server/client, bucket | endpoint, region, bucket, access credentials/workload identity |
| Embedding | pinned Ollama + `nomic-embed-text` | provider, URL, model; must emit 768 dimensions |
| LLM | Ollama + chosen generation model | provider, base URL, model, provider API key |
| API | build/copy Go binary, migrate, systemd | no local installation |
| Worker | same binary, migrations, systemd | no local installation |
| UI | copy/build Flutter web output | no local installation |
| nginx | same-origin UI/API proxy, optional Basic Auth/JWT | no local installation |

## Database upgrades

`API_ACTION=install` and `WORKER_ACTION=install` run `synapse migrate` before starting services. You can run it explicitly:

```bash
set -a
source /etc/synapse/synapse.env
set +a
/usr/local/bin/synapse migrate
```

Migration `003_embedding_dimensions_768.sql` clears incompatible legacy embeddings. After migration:

```bash
sudo -u synapse bash -c 'set -a; source /etc/synapse/synapse.env; set +a; /usr/local/bin/synapse embed-backfill'
```

Take a database backup first. Schema migrations are forward-only; rollback means restoring a backup and deploying the matching older binary.

## Admin UI authentication

The Flutter admin UI has a built-in login page. On first deployment, bootstrap the initial administrator:

```bash
AUTH_BOOTSTRAP_EMAIL=admin@synapse.local \
AUTH_BOOTSTRAP_PASSWORD="$(openssl rand -base64 18)" \
synapse auth-bootstrap
```

Record the generated password securely. The password must be at least 12 characters.

The UI stores short-lived access tokens only in browser memory and uses a rotating `HttpOnly` refresh cookie. Logout revokes the server-side session. Optional nginx Basic Auth can remain as an additional perimeter control but is no longer required for authentication.

Environment variables for tuning session behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ACCESS_TTL_MINUTES` | 15 | Access token lifetime (1–60 min) |
| `AUTH_REFRESH_TTL_DAYS` | 7 | Refresh session lifetime (1–90 days) |
| `AUTH_COOKIE_SECURE` | true | Set to `false` for HTTP-only deployments |

## Validate

```bash
systemctl status postgresql redis-server minio ollama synapse-api synapse-worker nginx
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/health/ready
journalctl -u synapse-api -u synapse-worker --since '10 minutes ago'
redis-cli LLEN synapse:session
redis-cli LLEN synapse:dead
```

For external S3/Redis/PostgreSQL, validate connectivity with provider-native tools before starting the API. The API refuses to start if migrations are missing, embedding dimensions are not 768, or the JWT secret is shorter than 32 characters.

## Uninstall

There is intentionally no automatic destructive uninstall. Stop/disable the relevant systemd units, archive `/etc/synapse`, and remove stateful data only after explicit backup and confirmation.
