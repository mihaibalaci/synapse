# Deployment

## Supported topologies

| Topology | Application | Stateful services |
|---|---|---|
| Native single server | systemd API/worker + nginx | local or external PostgreSQL, Redis, MinIO, Ollama |
| Docker Compose | Go API/worker + Flutter nginx | container PostgreSQL, Redis, MinIO; external Ollama by default |
| Kubernetes | Helm API/worker/migration/backfill jobs | separately managed PostgreSQL, Redis, S3, model provider |

Native installation is documented in [INSTALLATION.md](INSTALLATION.md).

## Mandatory runtime configuration

- `DATABASE_URL`
- `REDIS_URL`
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`
- S3 credentials unless workload identity supplies them
- `EMBEDDING_PROVIDER`, `EMBEDDING_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS=768`
- `AUTH_JWT_SECRET` (at least 32 characters), `AUTH_ISSUER`, `AUTH_AUDIENCE`

API and worker startup verify the embedded migration ledger. Deploy in this order:

1. Back up PostgreSQL and object-store configuration.
2. Deploy/provision PostgreSQL, Redis, S3, and embedding provider.
3. Run the new binary as `synapse migrate` with the target `DATABASE_URL`.
4. If migration changed an incompatible vector space, run `synapse embed-backfill`.
5. Roll API, then workers.
6. Check readiness, queue depth, dead letters, and a capture/search smoke test.

Schema rollback is not automatic. Restore the database backup and matching binary if rollback is required.

## Helm

The chart deploys application workloads only. Stateful services remain external lifecycle domains.

```bash
helm lint deploy/helm/synapse
helm template synapse deploy/helm/synapse \
  -f deploy/helm/synapse/profiles/on-prem.yaml \
  --set secrets.provider=existing \
  --set runtimeSecret.name=synapse-runtime
```

The runtime secret must contain `DATABASE_URL`, `REDIS_URL`, `AUTH_JWT_SECRET`, and object-store credentials where workload identity is unavailable. The migration hook uses the same runtime secret and runs `/usr/local/bin/synapse migrate`. Use a separately scoped release/secret if your organization requires elevated DDL credentials.

The worker has no HTTP health endpoint; Kubernetes observes process liveness. The API has `/health` and dependency-aware `/health/ready`. Compaction is disabled because the Go `compact` command is currently a no-op.

## Docker Compose

```bash
cp infra/docker/.env.example .env
# replace every example secret

docker compose -f infra/docker/docker-compose.yml config
docker compose -f infra/docker/docker-compose.yml up --build -d
```

Compose uses pinned PostgreSQL/Redis/MinIO images and runs migrations before API/worker startup. Keep the admin UI private and provide JWT authentication through your reverse proxy or browser client.

## Redis durability

Redis carries both disposable cache and queue state. Configure persistence and backups for queue durability. The current worker uses destructive `BRPOP`, so a crash after dequeue relies on PostgreSQL/session recovery. `noeviction` protects queued jobs but makes memory exhaustion a write outage; monitor memory and queue depth.

## Object storage

Raw objects are the only verbatim source. Enable bucket versioning, encryption, access logging, and lifecycle/replication appropriate to your recovery objectives. `synapse verify-storage` checks pointers but does not repair missing objects.

## Secrets

The native installer writes mode-0600 files. Helm supports existing secrets or External Secrets. LLM settings saved in the admin UI mask keys over HTTP but persist them as plaintext JSONB; for production prefer a secret manager integration or restrict that feature/database access.

## Capacity and observability

Do not rely on old benchmark numbers as production SLOs. Measure with your corpus/model. The JSON metrics endpoint mixes process-local counters with Redis-backed/sampled values and is not Prometheus. There is no OpenTelemetry integration yet.
