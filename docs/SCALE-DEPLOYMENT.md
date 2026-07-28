# Synapse — Production Scale Deployment Plan

## Target: 10,000 Concurrent User Sessions

---

## 1. Traffic Model

| Metric | Value | Derivation |
|--------|-------|-----------|
| Engineers | 10,000 |  |
| Active sessions/day | 60,000 | ~6 sessions per engineer per day |
| Peak concurrent sessions | 3,000 | 30% of daily users active simultaneously |
| Passive captures/minute (peak) | 500 | 1 capture per 6 minutes per active user |
| Search queries/minute (peak) | 2,000 | Context retrieval before every AI prompt |
| Reflect queries/minute (peak) | 200 | "Why?" questions |
| Ingestion tokens/day | 2B | ~33K tokens/session average |
| Facts extracted/day | 600,000 | ~10 facts per session |
| Storage growth/month | 500GB | Raw sessions + chunks + embeddings |

---

## 2. Architecture Overview

```
                           ┌─────────────────────────┐
                           │     Global DNS (Route53) │
                           │   synapse.company.com    │
                           └────────────┬────────────┘
                                        │
                           ┌────────────▼────────────┐
                           │    L7 Load Balancer      │
                           │  (ALB / Envoy / Traefik) │
                           │  TLS termination, WAF    │
                           │  Health-check routing    │
                           └─┬──────────┬──────────┬─┘
                             │          │          │
              ┌──────────────▼─┐  ┌─────▼──────┐  ┌▼──────────────┐
              │ API Cluster     │  │ API Cluster│  │ API Cluster    │
              │ (Zone A)        │  │ (Zone B)   │  │ (Zone C)       │
              │ 5 pods          │  │ 5 pods     │  │ 5 pods         │
              │ synapse serve   │  │            │  │                │
              └───────┬─────────┘  └─────┬──────┘  └──────┬─────────┘
                      │                  │                 │
         ┌────────────▼──────────────────▼─────────────────▼────────┐
         │                    DATA LAYER                              │
         │                                                           │
         │  ┌─────────────────┐  ┌──────────────┐  ┌─────────────┐ │
         │  │ PostgreSQL 16   │  │ Redis Cluster │  │ S3 / MinIO  │ │
         │  │ (Aurora / Patroni)│  │ (6-node HA) │  │ (replicated)│ │
         │  │ Primary + 2 Read│  │ 3 primary +  │  │             │ │
         │  │ Replicas        │  │ 3 replicas   │  │             │ │
         │  └─────────────────┘  └──────────────┘  └─────────────┘ │
         └──────────────────────────────────────────────────────────┘
                      │
         ┌────────────▼─────────────────────────────────────────────┐
         │                   WORKER LAYER                             │
         │                                                           │
         │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐ │
         │  │ Ingestion   │  │ Enrichment   │  │ Compaction      │ │
         │  │ Workers (20)│  │ Workers (10) │  │ CronJob (weekly)│ │
         │  │ synapse      │  │ synapse      │  │ synapse-compact │ │
         │  │ worker      │  │ worker       │  │                 │ │
         │  └─────────────┘  └──────────────┘  └─────────────────┘ │
         └──────────────────────────────────────────────────────────┘
                      │
         ┌────────────▼─────────────────────────────────────────────┐
         │                EMBEDDING / LLM LAYER                      │
         │                                                           │
         │  ┌─────────────────┐  ┌──────────────────────────────┐  │
         │  │ Embedding Svc   │  │ LLM Gateway                   │  │
         │  │ (TEI, 4 GPU)    │  │ (Claude/OpenAI, rate-limited) │  │
         │  │ or OpenAI API   │  │ Internal queue + retry         │  │
         │  └─────────────────┘  └──────────────────────────────┘  │
         └──────────────────────────────────────────────────────────┘
```

---

## 3. Component Specification

### 3.1 API Cluster (synapse serve)

| Property | Value |
|----------|-------|
| **Binary** | `synapse serve` (Go, 11MB) |
| **Instances** | 15 pods (5 per AZ, 3 AZs) |
| **Resources per pod** | 2 vCPU, 512MB RAM |
| **Throughput per pod** | 2,000 rps |
| **Total cluster capacity** | 30,000 rps |
| **Scaling** | HPA: CPU > 60% or latency p95 > 200ms |
| **Min replicas** | 6 (2 per AZ) |
| **Max replicas** | 30 |

**Load Balancing Strategy:**
- L7 ALB with least-connections routing
- Health check: `GET /health/ready` every 5s
- Unhealthy threshold: 3 consecutive failures → remove from pool
- Sticky sessions: NONE (stateless — all state in PG/Redis)
- Connection draining: 30s on scale-down

**Failover:**
- Pod crash → Kubernetes restarts in <5s
- AZ failure → ALB routes to remaining 2 AZs (10 pods still serve)
- Total capacity loss: 33% per AZ failure (acceptable: 20,000 rps remaining)

---

### 3.2 Worker Cluster (synapse worker)

| Property | Value |
|----------|-------|
| **Binary** | `synapse worker` (same Go binary) |
| **Instances** | 20 pods (ingestion) + 10 pods (enrichment) |
| **Resources per pod** | 2 vCPU, 1GB RAM |
| **Concurrency per pod** | 20 goroutines |
| **Total processing capacity** | 600 concurrent jobs |
| **Queue backend** | Redis Cluster (replicated lists) |

**Scaling Strategy:**
- Scale on queue depth: if `synapse:session` queue > 100 → add pods
- Scale on processing latency: if avg job time > 30s → add pods
- Scale down when queue is empty for 5 minutes

**Failover:**
- Worker crash → goroutines recover from panic (auto-restart)
- Pod crash → K8s restarts, jobs requeued (Redis is durable)
- No data loss: raw sessions in S3, jobs are idempotent (UUIDv5 dedup)

**Job Types & Priority:**
| Queue | Priority | SLA | Workers |
|-------|----------|-----|---------|
| `synapse:session` | High | < 10s | 20 pods |
| `synapse:facts` | Medium | < 30s | 10 pods |
| `synapse:knowledge` | Low | < 60s | 5 pods |
| `synapse:dedup` | Low | < 60s | 5 pods |
| `synapse:graph` | Low | < 60s | 5 pods |
| `synapse:index` | High | < 5s | 10 pods |

---

### 3.3 PostgreSQL (Primary Data Store)

| Property | Value |
|----------|-------|
| **Engine** | PostgreSQL 16 + pgvector 0.8 |
| **Topology** | 1 Primary + 2 Read Replicas (sync replication) |
| **Instance size** | r6g.4xlarge (16 vCPU, 128GB RAM) |
| **Storage** | 2TB gp3, 12,000 IOPS |
| **Extensions** | pgvector, uuid-ossp, pg_trgm |
| **Connection pooling** | PgBouncer (300 connections → 50 PG connections) |
| **Estimated rows (year 1)** | Chunks: 60M, Facts: 6M, Graph: 2M nodes |

**Read/Write Split:**
- Writes → Primary only (captures, facts, status updates)
- Reads → Read replicas (search queries, stats, fact lookups)
- Go binary uses separate connection pools for read/write

**Failover:**
- **AWS Aurora:** Automatic failover in <30s, reader promoted to primary
- **Self-hosted (Patroni):** 3-node cluster, automatic leader election via etcd
- **RPO:** 0 (synchronous replication)
- **RTO:** <30s (automated promotion)

**HNSW Index Tuning (pgvector):**
```sql
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
-- Query: SET hnsw.ef_search = 100; (latency vs recall tradeoff)
```

---

### 3.4 Redis Cluster (Cache + Queue)

| Property | Value |
|----------|-------|
| **Topology** | 6-node cluster (3 primary + 3 replicas) |
| **Instance size** | r6g.large (2 vCPU, 16GB RAM) per node |
| **Total memory** | 48GB usable (after replication overhead) |
| **Eviction policy** | `noeviction` (queue data must not be lost) |
| **Persistence** | AOF + RDB every 60s |

**Data Distribution:**
| Key pattern | Purpose | Estimated size |
|-------------|---------|-------|
| `search:<hash>` | Response cache | ~20GB (TTL: 5min) |
| `popular:<org>` | Query frequency | ~100MB |
| `synapse:*` | Job queues | ~2GB (transient) |
| `rate:<user>` | Rate limit counters | ~500MB (TTL: 60s) |

**Failover:**
- Node failure → Redis Cluster auto-promotes replica in <5s
- Partition: cluster continues with majority (4/6 nodes)
- Full cluster failure → API degrades gracefully (cache misses, no queue)

---

### 3.5 Object Storage (S3 / MinIO)

| Property | Value |
|----------|-------|
| **Backend** | AWS S3 (cloud) or MinIO cluster (on-prem) |
| **Bucket** | `synapse-raw` |
| **Storage class** | S3 Standard (first 90 days) → S3-IA (after) |
| **Estimated volume** | 10TB/year |
| **Replication** | Cross-region (DR) or erasure coding (MinIO) |

**Access Pattern:**
- Write once (at capture time), read rarely (on replay/reprocessing)
- No hot path dependency — failure means new captures queue, existing data serves

**Failover:**
- S3: 99.999999999% durability, cross-AZ by default
- MinIO: erasure coding with EC:4 (tolerates 4 drive failures)
- Degraded mode: API accepts captures but stores locally, syncs when S3 recovers

---

### 3.6 Embedding Service

| Property | Value |
|----------|-------|
| **Provider** | HuggingFace TEI (self-hosted) or OpenAI API |
| **Model** | text-embedding-3-small (1536d) or gte-Qwen2-1.5B |
| **Instances** | 4 GPU nodes (T4/A10G) for self-hosted |
| **Throughput** | ~5,000 embeddings/second (batched) |
| **Latency** | ~20ms per batch of 32 texts |

**Scaling:**
- Auto-scale GPU nodes based on queue depth of embedding requests
- Fallback: if self-hosted is overloaded, route to OpenAI API

**Failover:**
- Primary: TEI cluster (4 GPUs)
- Fallback: OpenAI API (rate-limited, higher cost)
- Emergency: local pseudo-embeddings (deterministic, no ML — for ingestion continuity)

---

### 3.7 LLM Gateway

| Property | Value |
|----------|-------|
| **Providers** | Claude Sonnet (primary), GPT-4o (fallback) |
| **Use cases** | Fact extraction (Tier 2), reflect, compaction |
| **Rate limit** | 1,000 requests/min (Claude), 500/min (OpenAI) |
| **Cost budget** | ~$500/day at scale |

**Architecture:**
- Internal queue for LLM requests (prevents overload)
- Priority: reflect > fact extraction > compaction
- Circuit breaker: if provider returns 5xx for 30s → failover to next provider

**Failover chain:**
1. Claude Sonnet → 2. GPT-4o → 3. Local Ollama (degraded quality) → 4. Skip LLM (heuristic only)

---

### 3.8 Load Balancer

| Property | Value |
|----------|-------|
| **Type** | L7 (HTTP/HTTPS) |
| **Provider** | AWS ALB / Envoy / Traefik |
| **TLS** | TLS 1.3, certificate via ACM/Let's Encrypt |
| **WAF** | Rate limiting, SQL injection, request size limits |

**Routing Rules:**
| Path | Target | Strategy |
|------|--------|----------|
| `/health*` | API pods | Round-robin |
| `/api/v1/search`, `/api/v1/context` | API pods (read-optimized) | Least-connections |
| `/api/v1/capture/*` | API pods (write-optimized) | Round-robin |
| `/api/v1/reflect` | API pods (long-running) | Least-connections, 30s timeout |
| `/*` (admin UI) | Nginx/CDN | Static serve |

**Health Checks:**
- Path: `/health/ready`
- Interval: 5s
- Healthy threshold: 2 consecutive 200s
- Unhealthy threshold: 3 consecutive non-200s
- Timeout: 3s

---

## 4. Failover Matrix

| Component | Failure Mode | Detection | Recovery | RTO | Data Loss |
|-----------|-------------|-----------|----------|-----|-----------|
| API pod | Crash/OOM | K8s liveness probe | Pod restart | 5s | None |
| API AZ | AZ outage | ALB health check | Route to other AZs | 10s | None |
| Worker pod | Panic/crash | K8s restart + self-heal | Auto-restart goroutine | 5s | None (idempotent) |
| PostgreSQL primary | Node failure | Patroni/Aurora detection | Promote replica | 30s | 0 (sync repl) |
| PostgreSQL replica | Node failure | Connection error | Remove from pool, use other replica | 5s | None |
| Redis node | Node failure | Cluster detection | Auto-promote replica | 5s | Possible cache loss |
| Redis cluster | Full outage | API connection timeout | Graceful degradation (no cache) | Immediate | Cache cold |
| S3 | Unavailable | HTTP 5xx | Queue captures locally | Immediate | None (eventual) |
| Embedding | Overloaded | Queue depth > 1000 | Fallback to OpenAI/local | Immediate | None |
| LLM | Provider down | HTTP 5xx for 30s | Circuit breaker → next provider | 30s | Quality degradation |
| DNS | Resolver failure | External monitor | Failover DNS record | 60s | None |

---

## 5. Scaling Triggers

| Metric | Threshold | Action |
|--------|-----------|--------|
| API p95 latency | > 200ms | Scale API pods +50% |
| API CPU | > 60% | Scale API pods +25% |
| Worker queue depth | > 100 jobs | Scale workers +50% |
| Worker job latency | > 30s average | Scale workers +25% |
| PG connection count | > 80% pool | Add read replica |
| PG replication lag | > 5s | Alert + investigate |
| Redis memory | > 80% | Scale node size or evict stale cache |
| Embedding queue | > 1000 pending | Add GPU node or enable OpenAI fallback |
| S3 put latency | > 5s | Switch to local buffer + async sync |
| Error rate | > 1% of requests | Alert + auto-rollback last deploy |

---

## 6. Deployment Topology Options

### Option A: AWS (recommended for cloud)

```
Region: us-east-1 (primary), eu-west-1 (DR)

EKS Cluster:
  - Node group: API (c6g.xlarge × 15, spot + on-demand mix)
  - Node group: Workers (c6g.2xlarge × 30, spot)
  - Node group: GPU (g4dn.xlarge × 4, on-demand)

Data:
  - Aurora PostgreSQL 16 (db.r6g.4xlarge, Multi-AZ)
  - ElastiCache Redis Cluster (r6g.large × 6)
  - S3 Standard + Lifecycle to S3-IA

Networking:
  - VPC with 3 AZs
  - ALB with WAF
  - Private subnets for data layer
  - VPC endpoints for S3 (no NAT cost)
```

**Estimated cost: ~$12,000/month**

### Option B: On-Premises (Kubernetes)

```
Cluster: 3 control-plane + 12 worker nodes

Hardware:
  - API/Worker nodes: 12× (16 vCPU, 64GB RAM, NVMe)
  - DB nodes: 3× (32 vCPU, 256GB RAM, NVMe RAID)
  - GPU nodes: 4× (16 vCPU, 64GB RAM, T4 GPU)
  - Storage: Ceph cluster (100TB raw, erasure coded)

Software:
  - K3s or RKE2
  - Patroni for PostgreSQL HA
  - Redis Cluster (Helm chart)
  - MinIO for S3
  - Istio service mesh (mTLS, traffic management)
  - Prometheus + Grafana for monitoring
```

**Estimated cost: ~$8,000/month (amortized hardware)**

### Option C: Hybrid (compute on-prem, data in cloud)

```
On-prem: K8s cluster for API + Workers (latency-sensitive)
Cloud: Aurora + ElastiCache + S3 (managed data, no ops burden)
Connection: AWS Direct Connect or VPN

Best of both: low-latency compute, managed data layer.
```

---

## 7. Disaster Recovery

| Scenario | Strategy | RPO | RTO |
|----------|----------|-----|-----|
| Pod failure | K8s auto-restart | 0 | 5s |
| AZ failure | Multi-AZ deployment | 0 | 10s |
| Region failure | Cross-region Aurora + S3 replication | <1min | 15min |
| Data corruption | Point-in-time recovery (Aurora) or WAL replay | 0 | 30min |
| Full cluster loss | Rebuild from S3 raw sessions (source of truth) | 0 | 2-4 hours |

**The immutable S3 layer is the ultimate backup**: every raw session is preserved. All derived data (chunks, facts, clusters, graphs) can be rebuilt by replaying ingestion from S3.

---

## 8. Monitoring & Observability

| Layer | Tool | Metrics |
|-------|------|---------|
| Infrastructure | Prometheus + Node Exporter | CPU, memory, disk, network |
| Application | OpenTelemetry → Tempo | Request traces, spans, latency |
| Logs | Loki / CloudWatch | Structured JSON logs (slog) |
| Dashboards | Grafana | Real-time overview, SLO tracking |
| Alerts | Alertmanager / PagerDuty | p95 > 200ms, error rate > 1%, queue depth |
| SLO | 99.9% availability, p95 < 200ms | Error budget: 43min/month downtime |

**Key SLIs:**
- Availability: % of successful requests (2xx/3xx) over 5-minute windows
- Latency: p50, p95, p99 for search and capture endpoints
- Throughput: requests/second, sessions processed/minute
- Learning: insights written back / week (system is getting smarter)

---

## 9. Security

| Concern | Implementation |
|---------|---------------|
| Authentication | JWT (HS256/RS256), per-org tokens |
| Authorization | RBAC (admin, team_lead, developer, viewer) + PostgreSQL RLS |
| Encryption at rest | AES-256 (S3 SSE, Aurora encryption, Redis TLS) |
| Encryption in transit | TLS 1.3 everywhere (mTLS between services via Istio) |
| Secrets management | AWS Secrets Manager / HashiCorp Vault |
| PII detection | Governance scanner in ingestion pipeline |
| Network isolation | Private subnets, security groups, no public DB access |
| Audit log | All admin actions logged to immutable audit table |

---

## 10. Capacity Planning (12-month projection)

| Month | Engineers | Sessions/day | Facts | Storage | API pods | Workers |
|-------|-----------|-------------|-------|---------|----------|---------|
| 1 | 1,000 | 6,000 | 60K | 50GB | 3 | 5 |
| 3 | 3,000 | 18,000 | 180K | 200GB | 6 | 10 |
| 6 | 6,000 | 36,000 | 360K | 500GB | 10 | 20 |
| 9 | 8,000 | 48,000 | 480K | 800GB | 12 | 25 |
| 12 | 10,000 | 60,000 | 600K | 1.2TB | 15 | 30 |

**Cost scaling**: approximately linear with engineers. The compaction pipeline ensures storage grows sub-linearly (canonical articles replace duplicate chunks).
