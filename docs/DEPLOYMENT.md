# Deployment Guide

The Recall can be deployed on any infrastructure:
- Your own datacenters (bare-metal Kubernetes)
- AWS (EKS + managed services)
- GCP (GKE + managed services)
- Hybrid (on-prem compute + cloud data)

---

## Deployment Methods

| Method | For | Tools |
|--------|-----|-------|
| Docker Compose | Local dev / single machine | Docker |
| Helm Chart | Any Kubernetes cluster | Helm 3 |
| Terraform + Helm | Cloud (AWS/GCP) with managed services | Terraform + Helm |
| CDK | AWS-only (legacy, ECS Fargate) | AWS CDK |

---

## Option 1: On-Premises (Kubernetes)

Everything runs inside your cluster. No cloud dependencies. Fully air-gapped capable.

**What gets deployed:**
- API + Worker pods (Node.js)
- Patroni PostgreSQL cluster (3-node HA, pgvector)
- Redis cluster (3-node)
- MinIO (S3-compatible, 4-node)
- HuggingFace TEI (embedding model on CPU/GPU)
- Ollama (LLM for extraction, optional)

**Steps:**

```bash
# 1. Build container images
docker build -f infra/docker/Dockerfile.api -t recall/api .
docker build -f infra/docker/Dockerfile.worker -t recall/worker .
docker build -f deploy/patroni/Dockerfile -t recall/patroni deploy/patroni/

# 2. Push to your internal registry
docker tag recall/api registry.internal.com/recall/api:latest
docker push registry.internal.com/recall/api:latest
# ... repeat for worker, patroni

# 3. Deploy via Helm
helm install ctx ./deploy/helm/recall \
  -f ./deploy/helm/recall/profiles/on-prem.yaml \
  --set global.imageRegistry=registry.internal.com/ \
  --set postgresql.password=<secure-password> \
  --namespace recall \
  --create-namespace
```

**Air-gapped notes:**
- Pre-pull images: `recall/api`, `recall/worker`, `pgvector/pgvector:pg16`, `redis:7-alpine`, `minio/minio`, `ghcr.io/huggingface/text-embeddings-inference:cpu-latest`, `ollama/ollama`
- Pre-download embedding model: `nomic-ai/nomic-embed-text-v1.5` (mount as volume)
- Set `embedding.provider=tei` and `llm.provider=ollama` (or `local-none` to disable LLM entirely)

---

## Option 2: AWS

Uses managed services for operational simplicity: Aurora PostgreSQL, ElastiCache, S3.

**Steps:**

```bash
# 1. Provision infrastructure with Terraform
cd deploy/terraform
terraform init
terraform plan -var-file=environments/aws-prod.tfvars
terraform apply -var-file=environments/aws-prod.tfvars

# 2. Get outputs
export DB_HOST=$(terraform output -raw database_endpoint)
export REDIS_HOST=$(terraform output -raw redis_endpoint)
export BUCKET=$(terraform output -raw storage_bucket)

# 3. Deploy application with Helm
helm install ctx ./deploy/helm/recall \
  -f ./deploy/helm/recall/profiles/cloud-aws.yaml \
  --set postgresql.host=$DB_HOST \
  --set redis.host=$REDIS_HOST \
  --set objectStorage.bucket=$BUCKET \
  --set embedding.openai.apiKey=<key> \
  --set llm.apiKey=<anthropic-key>
```

**IAM notes:**
- Use IRSA (IAM Roles for Service Accounts) for S3 access — no access keys needed
- Store API keys in AWS Secrets Manager, reference via `external-secrets` operator

---

## Option 3: GCP

Uses Cloud SQL, Memorystore, GCS.

```bash
# 1. Provision
cd deploy/terraform
terraform apply -var-file=environments/gcp-prod.tfvars

# 2. Deploy
helm install ctx ./deploy/helm/recall \
  -f ./deploy/helm/recall/profiles/cloud-gcp.yaml \
  --set postgresql.host=<cloud-sql-ip> \
  --set redis.host=<memorystore-ip>
```

---

## Option 4: Hybrid

On-prem compute (low latency to developers) with cloud-managed data services (operational simplicity).

```bash
helm install ctx ./deploy/helm/recall \
  -f ./deploy/helm/recall/profiles/hybrid.yaml \
  --set postgresql.host=<cloud-db-via-vpn> \
  --set objectStorage.bucket=<s3-bucket> \
  --set embedding.selfHosted.deploy=true
```

---

## Configuration Knobs

All configurable via `values.yaml` overrides or `--set` flags:

| Knob | Options | Effect |
|------|---------|--------|
| `postgresql.mode` | `internal` / `managed` | Deploy Patroni cluster or use external DB |
| `redis.mode` | `internal` / `managed` | In-cluster Redis or external service |
| `objectStorage.provider` | `minio` / `s3` / `gcs` / `ceph` | Object storage backend |
| `embedding.provider` | `openai` / `ollama` / `vllm` / `tei` / `local` | Where embeddings are computed |
| `llm.provider` | `claude` / `openai` / `ollama` / `vllm` / `local-none` | LLM for Tier 2 extraction |
| `secrets.provider` | `env` / `vault` / `sealed-secrets` / `external-secrets` | How secrets are injected |
| `serviceMesh.enabled` | `true` / `false` | Enable Istio mTLS + traffic policies |
| `serviceMesh.mtls.mode` | `STRICT` / `PERMISSIVE` | mTLS enforcement level |
| `api.autoscaling.enabled` | `true` / `false` | HPA for API pods |
| `worker.autoscaling.enabled` | `true` / `false` | HPA for worker pods |

---

## Self-Hosted Models

For air-gapped or privacy-sensitive deployments, all AI processing runs locally:

### Embedding (required)

| Provider | Model | Hardware | Config |
|----------|-------|----------|--------|
| HuggingFace TEI | nomic-embed-text-v1.5 | 4 CPU / 4GB RAM (CPU) or 1 GPU | `embedding.provider=tei` |
| Ollama | nomic-embed-text | 4 CPU / 4GB RAM | `embedding.provider=ollama` |
| vLLM | any embed model | 1 GPU | `embedding.provider=vllm` |

### LLM (optional — Tier 2 extraction only)

| Provider | Model | Hardware | Config |
|----------|-------|----------|--------|
| Ollama | llama3.1:8b | 16GB RAM + 1 GPU | `llm.provider=ollama` |
| vLLM | any chat model | 1-2 GPUs | `llm.provider=vllm` |
| Disabled | — | — | `llm.provider=local-none` (heuristic extraction only) |

Setting `llm.provider=local-none` disables LLM-based extraction entirely. The system still works — it uses heuristic pattern matching for fact extraction (Tier 1) and skips Tier 2 deep processing. Retrieval quality is slightly lower but the system remains fully functional.

---

## High Availability

### Postgres HA (on-prem)

Uses Patroni with synchronous replication:
- 3 nodes (1 leader + 2 replicas)
- Automatic failover in <30 seconds
- Zero data loss (synchronous_mode=true)
- pgvector + pg_trgm pre-installed

```
deploy/patroni/
├── patroni.yaml    # Cluster config
├── post-init.sh    # Extension installation
└── Dockerfile      # postgres:16 + pgvector + patroni
```

### Redis HA (on-prem)

Redis Sentinel or cluster mode with 3 nodes. Configured via Helm `redis.internal.replicas=3`.

### API HA

- Minimum 3 replicas behind load balancer / ingress
- HPA scales to 20 pods on CPU/request targets
- Readiness probes prevent traffic to unhealthy pods

---

## Service Mesh (Istio)

When `serviceMesh.enabled=true`, the Helm chart deploys:

| Resource | Purpose |
|----------|---------|
| PeerAuthentication | Enforce mTLS between all pods |
| DestinationRule | Connection pooling, outlier detection |
| VirtualService | Retry policies, timeouts |
| AuthorizationPolicy | Restrict who can call worker pods |
| ServiceEntry | Allow egress to OpenAI/Anthropic (if using cloud models) |

Enable with: `--set serviceMesh.enabled=true --set serviceMesh.mtls.mode=STRICT`

---

## Monitoring

All deployments emit OpenTelemetry traces and Prometheus metrics:

```yaml
observability:
  otel:
    enabled: true
    endpoint: "http://otel-collector:4317"
  metrics:
    enabled: true
    serviceMonitor: true  # For Prometheus Operator
```

Key metrics to monitor:
- `retrieval_latency_p99` — target <180ms
- `ingestion_queue_depth` — scale workers if >1000
- `fact_extraction_rate` — facts/minute
- `cache_hit_rate` — target >30%
- `embedding_latency_p99` — depends on provider

---

## Upgrading

```bash
# Update image tags
helm upgrade ctx ./deploy/helm/recall \
  --set api.image.tag=v0.2.0 \
  --set worker.image.tag=v0.2.0

# Rolling restart (zero downtime)
kubectl rollout restart deployment/ctx-api
kubectl rollout restart deployment/ctx-worker
```

Database migrations run automatically on API startup. For breaking schema changes, run migrations manually first:
```bash
kubectl exec -it deployment/ctx-api -- npm run migrate
```
