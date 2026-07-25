# ADR-001: Consolidate Storage Layer to PostgreSQL

## Status

Accepted (v2)

## Context

The v1 architecture used 5 separate datastores:
- PostgreSQL (metadata, ACLs)
- pgvector/Pinecone (embeddings)
- Neo4j (knowledge graph)
- OpenSearch (BM25 full-text search)
- Redis (cache + queue)

Each added operational overhead: separate clusters, backup strategies, monitoring,
connection pooling, failover procedures, and version upgrades. For a team of 600 engineers
generating ~60M chunks/year, this complexity was not justified by the performance gains.

## Decision

Consolidate to 3 stores:
1. **PostgreSQL 16** (Aurora) — handles metadata, vectors, FTS, and graph in one database
2. **S3** — raw immutable session storage
3. **Redis 7** — cache, BullMQ queues, Bloom filters

PostgreSQL replaces Neo4j, OpenSearch, and standalone vector DB via extensions:
- `pgvector` with HNSW index → vector ANN search
- Built-in `tsvector` with GIN index → BM25-equivalent full-text search
- `apache-age` extension → property graph queries (Cypher-compatible)
- Row-Level Security (RLS) → permission enforcement at query level

## Rationale

**Performance is sufficient at our scale:**
- pgvector HNSW handles 60M vectors with <30ms p99 on r6g.2xlarge (64GB RAM)
- Postgres tsvector with GIN matches OpenSearch quality for <500M documents
- Apache AGE provides 80% of Neo4j's graph query capability for our use cases

**Operational benefits:**
- Single backup/restore strategy (Aurora automated backups + PITR)
- Single connection pool (PgBouncer)
- Atomic transactions across metadata + vector + FTS writes
- One set of monitoring alerts
- Familiar technology for most engineers

**Cost savings:**
- Neo4j Enterprise: ~$2,000/month (eliminated)
- OpenSearch 3-node: ~$1,500/month (eliminated)
- Larger Postgres instance: +$400/month
- Net savings: ~$3,100/month

## Consequences

**Positive:**
- 65% reduction in infrastructure cost
- Simpler deployment, fewer failure modes
- ACID guarantees across all data types
- Permission enforcement via RLS (zero application-level filtering needed)

**Negative:**
- No native Cypher IDE tooling (use AGE Viewer or raw SQL)
- pgvector recall at 60M scale requires tuning (ef_search, m parameters)
- Cannot independently scale search and vector workloads (shared Postgres resources)
- If we exceed 500M chunks, may need to re-introduce OpenSearch

**Mitigations:**
- Monitor pgvector recall with weekly offline evaluation
- Aurora read replicas separate retrieval load from ingestion writes
- If graph queries become complex, evaluate Neptune as a future upgrade
- Keep storage abstractions in code so swapping backends requires only adapter changes

## Alternatives Considered

1. **Keep all 5 stores** — Maximum performance, maximum complexity. Rejected: ops burden too high for team size.
2. **Postgres + OpenSearch (drop Neo4j)** — Graph is the least-used feature. Considered but AGE is good enough and eliminates another cluster.
3. **Postgres + Pinecone (managed vector)** — Would remove pgvector tuning burden but adds vendor lock-in and network latency for vector search. Rejected: pgvector performance is sufficient with proper indexing.
