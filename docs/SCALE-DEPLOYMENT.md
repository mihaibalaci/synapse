# Scaling Guidance

This is guidance, not a capacity claim. Benchmark the Go binary with your corpus and embedding provider before setting replica counts or SLOs.

## Bottlenecks

1. **Embedding throughput** dominates ingestion on CPU-only Ollama.
2. **Redis queue depth/memory** grows when captures exceed worker throughput. With `noeviction`, memory exhaustion becomes a write outage.
3. **PostgreSQL vector/FTS queries** depend on corpus size, HNSW residency, connection pool, and I/O.
4. **S3 latency** is on the synchronous capture path by design.

## Horizontal application scaling

API replicas are stateless apart from process-local rate limits/metrics. Workers share Redis queues. Scale workers gradually and ensure the embedding service and PostgreSQL can absorb the added concurrency.

Suggested signals:

| Signal | Scale/act when |
|---|---|
| `synapse:session` depth | grows continuously for multiple sampling windows |
| Oldest pending session | exceeds processing objective after excluding current backlog |
| Redis memory | approaches the configured safe ceiling |
| Embedding latency/errors | rises as worker concurrency increases |
| PostgreSQL pool acquired/max | remains near saturation |
| API readiness/5xx | any sustained dependency failures |

The chart can scale on CPU. Queue-based HPA requires an external metrics adapter; no exporter is included.

## Data services

- PostgreSQL: use pgvector-capable PostgreSQL, tested backup/PITR, connection pooling, and monitor HNSW indexes. Both vector columns are 768-dimensional.
- Redis: enable persistence if queue RPO matters. Cache and queues currently share a database, so never use `FLUSHDB`.
- S3/MinIO: use versioning and independent backup/replication. Raw objects are the only verbatim rebuild source.

## Important limitations at scale

- `BRPOP` is destructive; crash recovery waits for the session queue to drain before reaping old sessions.
- No queue admission control, per-tenant quota, distributed rate limiter, or request coalescing exists.
- Metrics are not fully distributed and there is no Prometheus/OpenTelemetry exporter.
- Search filters/team/repository ACL claims are not enforced beyond organization scoping.
- Compaction/dedup/graph enrichment do not reduce corpus growth today.

Do not plan 10,000-user production capacity from historical README numbers. Run capture and retrieval load tests against production-like data, model latency, failure scenarios, backup restore, and worker crash recovery.
