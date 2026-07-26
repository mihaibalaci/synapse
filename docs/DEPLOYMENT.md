# Deployment Guide

Recall is a service with three mandatory stateful dependencies and two stateless
workloads.

| Component | Role |
|-----------|------|
| PostgreSQL 16 + pgvector | Vectors, full-text search, relational knowledge graph, outbox, RLS |
| Redis | BullMQ queues and search cache, `maxmemory-policy=noeviction` |
| S3-compatible object storage | Immutable raw session payloads |
| API (`dist/index.js`) | Upload, retrieval, facts, feedback |
| Worker (`dist/worker-entry.js`) | Pipeline, enrichment, search indexing, outbox dispatch |

OpenSearch and Neo4j are **not** used. PostgreSQL FTS/`pg_trgm` and the
relational `graph_nodes`/`graph_edges` tables replaced them.

---

## Deployment Methods

| Method | For | Tools |
|--------|-----|-------|
| Docker Compose | Local dev / single machine | Docker |
| Helm chart | Any Kubernetes cluster | Helm 3 |
| Terraform + Helm | AWS/GCP with managed data services | Terraform 1.8+, Helm 3 |

The application Helm chart deploys **only** the API, worker, and their
migration/backfill Jobs. PostgreSQL, Redis, object storage, and model serving
are separate lifecycle domains: use managed services or deploy Patroni/Redis/
MinIO independently. `postgresql.mode=internal` and `redis.mode=internal` are
rejected by the chart rather than silently rendering nothing.

---

## Prerequisites for every environment

Provide these in the runtime secret (`runtimeSecret.name`, default
`<release>-runtime`), either directly (`secrets.provider=env`), from an existing
secret (`existing`), or via External Secrets (`external-secrets`):

| Key | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL` | yes | Runtime role, **not** the migrator role |
| `REDIS_URL` | yes | Use `rediss://` when TLS is enabled |
| `AUTH_JWT_SECRET` or `AUTH_JWT_PUBLIC_KEY` | yes in production | HS256 secret (min 32 chars) or RS256 public key; the API refuses to start in production without one |
| `OPENAI_API_KEY` | if `embedding.provider=openai` | |
| `ANTHROPIC_API_KEY` | if `llm.provider=claude` | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | only without workload identity | Prefer IRSA / GKE Workload Identity |

A separate migrator secret (`migration.secretName`, default `recall-migrator`)
holds the elevated `DATABASE_URL` used by the migration Job only.

Embeddings are fixed at **1536 dimensions** for every provider. The chart fails
rendering if a profile sets anything else, and the service refuses to start.

---

## Option 1: On-premises Kubernetes

```bash
# 1. Build and push images with immutable tags (latest is rejected by the chart)
docker build -f infra/docker/Dockerfile.api -t registry.internal/recall/api:0.1.0 .
docker build -f infra/docker/Dockerfile.worker -t registry.internal/recall/worker:0.1.0 .
docker build -f deploy/patroni/Dockerfile -t registry.internal/recall/patroni:0.1.0 deploy/patroni/
docker push registry.internal/recall/api:0.1.0   # repeat for worker, patroni

# 2. Deploy Patroni, Redis, and MinIO first, then create the two secrets
#    (recall-runtime and recall-migrator).

# 3. Deploy the service
helm install recall ./deploy/helm/recall \
  -f ./deploy/helm/recall/profiles/on-prem.yaml \
  --set global.imageRegistry=registry.internal \
  --namespace recall --create-namespace
```

Air-gapped: pre-pull `recall/api`, `recall/worker`, `pgvector/pgvector:0.8.1-pg16`,
`redis:7.4.2-alpine`, `minio/minio`, and your embedding server image. Any
embedding model may be used **provided it emits 1536 dimensions**.

---

## Option 2 and 3: AWS or GCP

```bash
cd deploy/terraform
terraform init
terraform validate
terraform plan -var-file=environments/aws-prod.tfvars   # or gcp-prod.tfvars
terraform apply -var-file=environments/aws-prod.tfvars
```

Terraform provisions network, managed PostgreSQL, Redis with `noeviction`,
private object storage, the Kubernetes cluster, and the workload identity that
the Helm `serviceAccount` binds to. It does **not** install extensions or schema;
migrations own that.

Database credentials are never written to Terraform state: AWS uses
`manage_master_user_password` and GCP writes to Secret Manager. Feed those into
the runtime and migrator secrets, then deploy Helm with the matching profile.

---

## Database migrations

Migrations are ordered SQL files in `migrations/`, applied by
`scripts/migrate.mjs`:

- one advisory lock, so concurrent runners cannot race
- checksummed in `schema_migrations`; editing an applied file is an error
- each file applied in a single transaction with a `lock_timeout`
- pre-existing databases are baselined at `001` and converged by `002`
- re-running is a no-op

They run as a Helm `pre-install,pre-upgrade` hook Job using the migrator
credential. Migrations do **not** run on API or worker startup.

```bash
# Manual / out-of-band
MIGRATION_DATABASE_URL=postgresql://recall_migrator:...@host/recall npm run migrate
```

**`helm rollback` does not revert schema.** Use expand/contract: deploy the
additive migration, then the code, and only remove columns in a later release.

### Embedding backfill

Changing embedding model or version requires re-embedding. The backfill is
resumable, advisory-locked, and batched:

```bash
EMBEDDING_VERSION=2 BACKFILL_BATCH_SIZE=50 npm run backfill:embeddings
```

Or enable the Job: `--set embeddingBackfill.enabled=true --set embeddingBackfill.targetVersion=2`.

---

## Health and probes

| Workload | Liveness | Readiness |
|----------|----------|-----------|
| API | `GET /health` | `GET /health/ready` — checks PostgreSQL, Redis, bucket, queue; returns 503 when any fails |
| Worker | `GET :3001/health` — fails if the outbox dispatch loop has not completed within `worker.heartbeatStaleMs` | `GET :3001/health/ready` — same dependency checks |

On `SIGTERM` the worker fails its health checks first, then drains in-flight
jobs before closing queues and the pool.

---

## Configuration knobs

| Knob | Options | Effect |
|------|---------|--------|
| `secrets.provider` | `env` / `existing` / `external-secrets` | How the runtime secret is produced |
| `objectStorage.provider` | `minio` / `s3` / `gcs-s3-interop` / `ceph` | S3-API backend. GCS requires HMAC interop keys |
| `embedding.provider` | `openai` / `ollama` / `vllm` / `tei` / `local` | Must emit 1536 dimensions. `local` is dev/test only |
| `llm.provider` | `claude` / `openai` / `ollama` / `vllm` / `local-none` | `local-none` disables Tier 2 LLM extraction |
| `migration.enabled` | `true` / `false` | Pre-upgrade migration Job |
| `worker.autoscaling.queueMetric.enabled` | `true` / `false` | Scale on queue depth via an external metric (KEDA/adapter) instead of CPU |
| `availability.podDisruptionBudget.enabled` | `true` / `false` | PDBs for API and worker |
| `networkPolicy.enabled` | `true` / `false` | Restrict API ingress; deny all worker ingress |
| `serviceMesh.enabled` | `true` / `false` | Istio mTLS, outlier detection, worker ingress deny |

---

## High availability

**PostgreSQL (on-prem):** Patroni with `synchronous_mode` and
`synchronous_mode_strict` enabled, SCRAM-SHA-256, TLS with client certificate
verification, REST API authentication, and WAL archiving via pgBackRest.

```
deploy/patroni/
├── patroni.yaml      # cluster config; all credentials/paths injected via env
├── pgbackrest.conf   # WAL archive + retention; repository injected via PGBACKREST_*
├── post-init.sh      # creates recall database, recall_migrator and recall_app roles, extensions
└── Dockerfile        # postgres 16.9 + pgvector + pinned Patroni + pgBackRest
```

`post-init.sh` requires `RECALL_APP_PASSWORD` and `RECALL_MIGRATOR_PASSWORD`.
`pgbackrest.conf` has **no repository configured by default** — set
`PGBACKREST_REPO1_*` before claiming any RPO/RTO.

**Redis:** `noeviction` is mandatory. BullMQ state must never be evicted.

**API:** minimum 3 replicas, PDB, topology spread across zones and hosts, HPA
on CPU/memory, `maxUnavailable: 0` during rollout.

---

## Not yet implemented

Do not assume these exist:

- **No metrics or tracing.** There is no `/metrics` endpoint and no
  OpenTelemetry SDK. `OTEL_EXPORTER_OTLP_ENDPOINT` is not consumed by any code.
  Latency and queue-depth SLOs cannot currently be measured or alerted on.
- **No terminal-failure surface.** Outbox events go `failed` after 10 attempts
  and `chunk_processing_status` rows can end `failed`; nothing alerts on or
  drains them.
- **No ingestion backpressure.** Uploads are accepted with 202 without
  per-tenant quotas or queue-depth admission control. Combined with
  `noeviction`, a sustained burst can exhaust Redis memory and fail writes.
- **No load test.** Retrieval latency at target volume is unmeasured.
- **No failover or restore drill.** Patroni failover and pgBackRest restore have
  never been exercised.
