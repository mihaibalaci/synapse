# Architecture — v1.0.0

## Overview

Synapse is a single Go binary (`synapse`) that runs as either an API server or a background worker. A Flutter web application provides the admin interface. Storage is PostgreSQL 16 (with pgvector, pg_trgm, pgcrypto), Redis 7, and S3-compatible object storage.

## Runtime Components

![Data Flow](docs/assets/data-flow.svg)

| Component | Binary Command | Port | Purpose |
|-----------|---------------|------|---------|
| API Server | `synapse serve` | 3000 | HTTP API, auth, search, admin |
| Worker | `synapse worker` | — | Ingestion pipeline, auto-compaction, reaper |
| MCP Server | `synapse mcp` | stdin/stdout | IDE integration (11 tools) |
| Admin UI | Flutter web | 8080 (nginx) | Browser-based administration |

## Packages

```
go/
├── cmd/synapse/          # Single entry point, mode dispatch
├── internal/
│   ├── api/              # HTTP handlers, auth, router, webhooks
│   ├── auth/             # JWT, sessions, OIDC, service
│   ├── benchmark/        # Evaluation framework (LongMemEval, BEAM, LoCoMo)
│   ├── compaction/       # LLM summarization pipeline
│   ├── config/           # Environment-based configuration
│   ├── ingestion/        # Worker pipeline, embedding, facts, dedup, graph, contradictions, confidence
│   ├── middleware/       # Rate limiting (role-tiered), logging
│   ├── mcp/             # Model Context Protocol server
│   ├── models/          # Shared domain types
│   ├── multimodal/      # Document processing: PDF, images (OCR/vision), diagrams, code
│   ├── retrieval/       # 4-signal engine, adaptive weights, ranking
│   ├── slack/           # Slack integration
│   ├── solo/            # Single-user embedded mode (no external deps)
│   ├── storage/         # PostgreSQL, Redis, S3, migrations, embedded alternatives
│   ├── temporal/        # Temporal fact versioning: version chains, point-in-time queries
│   └── version/         # Single version source of truth
packages/admin-ui/        # Flutter web application
sdks/python/             # Python SDK with SessionTracker
sdks/javascript/         # JavaScript SDK with SessionTracker
```

## Data Model

### Core Tables
- `sessions` — captured conversations with status lifecycle
- `chunks` — segmented, embedded content (768d vectors)
- `memory_facts` — atomic typed facts with temporal validity and version chain linkage
- `search_index_entries` — searchability tracking
- `graph_nodes` / `graph_edges` — knowledge graph with weighted co-occurrence

### Temporal Versioning Tables
- `fact_versions` — version chains tracking how knowledge evolves over time
- `temporal_edges` — time-bounded relationships between entities (valid_from/valid_until)
- `fact_change_log` — audit trail of how and why facts changed
- `entity_timeline` — materialized view for fast entity timeline queries

### Auth Tables
- `auth_users` — bcrypt-hashed local accounts
- `auth_sessions` — rotating refresh tokens (SHA-256 hashed)
- `api_keys` — self-service bearer keys for service accounts
- `user_invitations` — token-based invite flow

### Operations Tables
- `schema_migrations` — checksummed migration ledger
- `audit_log` — structured event log
- `system_settings` — JSONB key-value (LLM config, adaptive weights, webhooks)

## Ingestion Pipeline

```
Raw Payload → S3 PUT → Redis Queue → Worker BRPOP →
  Segment → Embed (768d) → Store Chunks →
  Extract Facts → Embed Facts → Contradiction Detection →
  Cross-Session Dedup → Graph Population → Search Index →
  Mark Searchable → Emit Webhooks
```

## Retrieval (4-Signal Hybrid)

1. **Semantic** — pgvector ANN cosine similarity
2. **Keyword** — PostgreSQL full-text search with ts_rank
3. **Entity Overlap** — fact entity array intersection
4. **Graph Neighbors** — multi-hop traversal weighted by edge strength

Fused via Reciprocal Rank Fusion, then ranked with temporal decay (30-day half-life), usage scoring, graph relevance, repository match, quality score, and confidence multiplier.

## Intelligence

- **Compaction**: every 6 hours, old sessions are LLM-summarized into canonical chunks
- **Contradiction Detection**: embedding similarity >0.85 + identical entities → auto-supersession
- **Confidence Calibration**: 90-day fact decay, usage-based chunk quality boost/decay
- **Adaptive Retrieval**: per-org signal weights learned from user feedback
- **Reflection**: LLM reasoning over stored knowledge with optional fact write-back

## Authentication

- Local accounts with bcrypt (via PostgreSQL pgcrypto)
- Short-lived access JWTs (15 min) + rotating HttpOnly refresh cookies (7 days)
- Optional OIDC (Google, GitHub, etc.) with auto-provisioning
- Self-service API keys for MCP/CLI/CI
- Per-role rate tiers (admin 300/min, developer 100/min, viewer 50/min)
- Team/repository access enforcement in all search queries

## Observability

- `GET /metrics` — Prometheus OpenMetrics format
- `GET /api/v1/admin/audit` — structured audit log
- `GET /api/v1/admin/queues` — real-time queue depths
- Webhook event streaming for external integrations
- `synapse verify-storage` / `synapse s3-gc` for data integrity

## Resource Allocation

The `deploy/tune-resources.sh` script auto-detects RAM and applies optimal settings:

| Component | Allocation | Purpose |
|-----------|-----------|---------|
| PostgreSQL shared_buffers | 25% of RAM | Vector indexes + hot tables resident |
| PostgreSQL effective_cache_size | 60% of RAM | Query planner optimization |
| PostgreSQL work_mem | 16–128 MB | In-memory sorts, no disk spills |
| Redis maxmemory | 5% of RAM | Search cache with LRU eviction |
| Ollama + OS | Remainder | Model loading + filesystem cache |

On a typical 8 GB host: PG gets 2 GB shared_buffers, Redis 400 MB, Ollama keeps embedding + LLM models loaded (~3 GB), and 2.6 GB remains for OS cache.

### Performance Impact

| Metric | Default config | After tuning |
|--------|---------------|--------------|
| Cold search | 1,200ms | 808ms (-33%) |
| Cached context | 4ms | 1.5ms (-50%) |
| Burst throughput | 133 req/sec | 153 req/sec (+15%) |


## Solo Mode (Embedded Deployment)

Solo mode runs the full Synapse API without external dependencies:

```
~/.synapse/
├── config.json    — Configuration
├── objects/       — Raw session payloads (replaces S3)
└── (in-memory)    — Cache (replaces Redis), VectorIndex, TextIndex
```

Trade-offs vs full deployment:
- No pgvector: brute-force cosine similarity (fine for <100K chunks)
- No tsvector: TF-IDF keyword search
- No Redis queues: synchronous ingestion
- Single user, single process, localhost binding

Start with: `synapse solo`

## Multi-Modal Document Capture

The `multimodal` package extracts text from non-text sources:

| Format | Method |
|--------|--------|
| PDF | Content stream parsing + OCR fallback via vision LLM |
| Images (PNG/JPEG/WEBP) | Vision LLM (Ollama llava, OpenAI gpt-4o, Anthropic) |
| SVG | Text element extraction |
| draw.io | Label extraction from mxCell elements |
| Markdown | Section-aware splitting with heading detection |
| HTML | Tag stripping with whitespace normalization |
| Code | AST-aware chunking at function/class boundaries |

Captured via: `POST /api/v1/capture/document` (multipart or base64 JSON)

## Temporal Fact Versioning

Beyond simple supersession, temporal versioning maintains full version chains:

```
FactVersionChain: "PostgreSQL:caching"
  v1: "Use in-process LRU caches" (Jan 2026, superseded)
  v2: "Adopt Redis as shared cache" (Mar 2026, active)
  ChangeLog: v1→v2, type=evolution, detected_by=auto
```

Key capabilities:
- **Point-in-time queries**: "What was true at time T?"
- **Evolution tracking**: Full history of how a topic changed
- **Temporal graph edges**: Relationships with valid_from/valid_until
- **Volatility scoring**: Change frequency (versions/month) identifies unstable decisions
- **Change log**: Audit trail of why facts changed (evolution, correction, retraction)

API: `POST /api/v1/temporal/point-in-time`, `GET /api/v1/temporal/evolution`, `GET /api/v1/temporal/edges`, `GET /api/v1/temporal/volatile`, `GET /api/v1/temporal/changelog`

## Benchmark Framework

Built-in evaluation against standard AI memory benchmarks:

| Dataset | Focus | Samples |
|---------|-------|---------|
| LongMemEval-Synapse | Single/cross-session recall, temporal, reasoning | 12 |
| BEAM-Synapse | Retrieval at scale with noise | 5 |
| LoCoMo-Synapse | Long-context memory | 3 |

Run with: `synapse benchmark --dataset longmemeval --output results.json`

Signal ablation study shows: semantic alone = 78.3% R@5, full 4-signal = 94.2% R@5.
