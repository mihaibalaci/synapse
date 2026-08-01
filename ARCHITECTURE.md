# Synapse Architecture

This document describes the tracked Go implementation. Planned features are separated explicitly.

## Design goals

1. Preserve the verbatim source before accepting a capture.
2. Keep the runtime small: one Go binary, PostgreSQL, Redis, and S3-compatible storage.
3. Make asynchronous work recoverable and bounded.
4. Keep failures diagnosable with structured logs, explicit status, dead letters, and dependency readiness.
5. Keep schema changes reproducible through embedded migrations.

## Runtime components

| Component | Implementation | Responsibility |
|---|---|---|
| API | `synapse serve`, chi | JWT validation, capture, retrieval, facts, admin APIs |
| Worker | `synapse worker` | Redis queue consumption, segmentation, embeddings, heuristic facts, indexing, recovery |
| Migrator | `synapse migrate` | Advisory-locked, checksummed SQL migrations |
| MCP | `synapse mcp` | JSON-RPC/stdio adapter to the HTTP API |
| Admin UI | Flutter web + nginx | Metrics and LLM settings |
| PostgreSQL | pgvector + FTS | Durable metadata, chunks, facts, indexes, settings |
| Redis | lists, strings, sorted sets | Work queues, dead letters, response cache, popular-query counts |
| S3/MinIO | S3 API | Verbatim raw session JSON |
| Embedding provider | Ollama/OpenAI/TEI/local | 768-dimensional vectors |

The Rust package is not linked into the Go request path. It is an optional experimental/benchmark package, not a production dependency.

## Storage ownership

- **Object storage is the rebuild source.** `sessions.raw_storage_key` points to immutable raw JSON.
- **PostgreSQL is the query source.** It stores lossy chunks and extracted facts; these do not replace raw JSON.
- **Redis is operational state.** Cache loss is harmless. Queue loss delays work, but the PostgreSQL reaper can reconstruct session jobs from raw object pointers.

## Authentication and authorization

The API accepts HS256 JWTs with the configured issuer and audience. `sub` and `organization_id` are mandatory. Capture attribution always uses claims; body identity is ignored. Admin APIs additionally require the `admin` role.

Current queries scope by `organization_id`. The tracked Go code does **not** configure PostgreSQL RLS and does not yet enforce `team_ids`, repository ACLs, or search filters in SQL. Those are known gaps; do not describe the system as RLS-protected.

## Schema and embeddings

Migrations live under `go/internal/storage/migrations` and are embedded into the binary. Startup verifies that all migrations are applied; deployment must run `synapse migrate` first. Migrations use a PostgreSQL advisory lock and checksum ledger.

The schema uses `vector(768)` for chunks and facts. Migration `003` clears vectors from incompatible legacy spaces before changing dimensions, then recreates HNSW indexes. Run `synapse embed-backfill` afterward. Mixing models in one vector column is unsupported even when dimensions match.

## Reliability boundaries

- Capture only returns 202 after the S3 PUT and session INSERT succeed.
- Redis enqueue failure does not reject an already durable capture; the reaper later reconstructs it.
- Redis `BRPOP` removes a job before processing. A crash can therefore strand work; the reaper addresses this after the session queue drains.
- Jobs retry four total attempts with bounded exponential delay and then enter `synapse:dead`; failed session jobs mark `sessions.status='failed'`.
- Embedding failure is non-fatal: keyword retrieval still works and backfill repairs vectors.
- Fact extraction failure is logged and does not prevent chunk indexing.
- API readiness checks PostgreSQL, Redis, and object storage. Worker liveness is process-level; it currently has no HTTP health server.

## Retrieval

A miss runs semantic, keyword, and entity signals concurrently, fuses candidates with reciprocal-rank fusion, applies ranking/diversity, and packs by token budget or top-K. Responses are cached for five minutes. Cache keys include the entire request and authorization context. There is no write invalidation, request coalescing, stale-while-revalidate, or popular-query prewarmer.

## Deliberately not implemented

- Reflect synthesis/write-back and consumption of saved LLM settings by a reasoning path.
- Structured knowledge extraction, deduplication, graph indexing, observations, feedback learning, and user persistence.
- Real compaction (`synapse compact` is a no-op); Helm scheduling is disabled by default.
- Distributed metrics/tracing and alerting. Some metrics are process-local; cache/object-store metrics are sampled or Redis-backed.
- Queue admission control and per-tenant quotas.
- Encryption of API keys stored in `system_settings`; use a restricted database and prefer secret references for production.

These boundaries are also listed in [docs/API.md](docs/API.md) and [docs/DATA-FLOW.md](docs/DATA-FLOW.md).
