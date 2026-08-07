# Capacity Test Results — v1.2.0

**Date:** August 2026  
**Test type:** Burst capture (2000 sessions) + latency measurement  
**Environment:** LXC container, 8.9 GB RAM, Intel Xeon E5-2683 v4 (32 vCPUs), PostgreSQL 16, Redis 8, Ollama CPU-only

## Results Summary

| Metric | Default Config | After Tuning | Warm System |
|--------|---------------|--------------|-------------|
| **Cold search** | 1,200ms | 808ms (-33%) | **408ms (-66%)** |
| **Cached search** | <2ms | <2ms | **<1ms** |
| **Cached context** | 4ms | 1.5ms | **1.4ms** |
| **Burst throughput** | 133/sec | 153/sec | 142/sec |
| **Capture latency** | 32ms | 50ms | 39ms |
| **Errors** | 0 | 0 | 0 |

## Tuning Applied

| Setting | Before | After |
|---------|--------|-------|
| PG `shared_buffers` | 128 MB | 2 GB |
| PG `effective_cache_size` | 4 GB | 6 GB |
| PG `work_mem` | 4 MB | 64 MB |
| Redis `maxmemory` | unlimited | 512 MB |
| Redis `maxmemory-policy` | noeviction | allkeys-lru |

## Latency Breakdown (cold search)

```
Total cold search: 408ms (warm) / 808ms (cold)
  └── Ollama embedding: ~600ms (cold) / ~200ms (warm, 75% of total)
  └── PostgreSQL pgvector ANN: ~150ms
  └── FTS + entity + graph: ~50ms
  └── Fusion + ranking: ~8ms
```

## Key Findings

1. **Cold search improved 66%** (1,200ms → 408ms) after tuning + warm cache. HNSW vector index fully resident in shared_buffers eliminates disk I/O.
2. **Cached context retrieval improved 50%** — Redis LRU keeps hot results longer.
3. **Burst throughput improved 15%** — tuned WAL/buffers handle concurrent inserts faster.
4. **Main bottleneck is Ollama CPU inference** — a GPU reduces the 600ms embedding call to ~20ms, making cold search ~210ms.
5. **Zero errors across all runs** — no dead letters, no restarts, no data loss.

## Scaling Recommendations

1. **GPU for Ollama** — Cold search: 808ms → ~210ms; ingestion: 3/sec → ~50/sec
2. **Read replicas** — For search-heavy workloads beyond 500 concurrent users
3. **Dedicated embedding server** — TEI on GPU for batch embedding
4. **More workers** — With faster embedding, scale workers to saturate PostgreSQL
5. **Separate MinIO** — If raw storage grows beyond 100GB, move to dedicated node

---

*Tests conducted on Synapse v1.2.0, branch `harden/production-readiness`.*
