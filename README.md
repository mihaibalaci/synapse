# <img src="docs/assets/logo.svg" width="36" height="36" align="top" /> Synapse

**The memory layer that learns.**

Hundreds of engineers, creating a neural network of knowledge.

A team-scale memory system that continuously captures AI coding sessions,
extracts atomic facts and knowledge, deduplicates across the organization, and provides
sub-200ms retrieval. Over time, the system *learns*,  token usage per query decreases
as collective knowledge compacts into canonical answers, opinions strengthen with evidence,
and observations sharpen through reflection.

## The Problem

Every AI coding session (Claude, GPT, Cursor, Kiro, Copilot) generates valuable context:
debugging insights, architecture decisions, code patterns. Today, this knowledge is lost
after the session ends. Tomorrow's developer re-uploads thousands of tokens to solve the
same problem someone else already solved.

## The Solution

**Capture**: Passively record every AI session in the background — no developer action needed.

**Remember**: Extract atomic facts, link entities, build temporal chains. ADD-only — never overwrite history.

**Share**: Deduplicate across entire engineering organizations. One canonical answer per topic instead of hundreds of copies.

**Learn**: The system gets smarter with every interaction. Reflect produces insights, opinions evolve with evidence, observations sharpen over time.

```
Month 1:  12,000 tokens/query (raw replay — no system)
Month 3:   4,000 tokens/query (segmented chunks)
Month 6:   2,500 tokens/query (deduplicated + facts layer)
Month 12:  1,500 tokens/query (compacted canonical articles)
Month 24:    800 tokens/query (highly compressed, fact-level answers)
```

## Quick Start

```bash
npm install
docker compose -f infra/docker/docker-compose.yml up -d
cp .env.example .env
npm run dev
```

See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for details.

## Connecting Your IDE

### Option A: MCP (recommended — works with Kiro, Cursor, Windsurf, Claude Desktop, Cline)

Add to your MCP configuration (e.g. `.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["<path-to>/packages/mcp-server/dist/index.js"],
      "env": {
        "SYNAPSE_API_URL": "https://synapse.internal.company.com",
        "SYNAPSE_TOKEN": "your-token",
        "DEVELOPER_ID": "your-id",
        "ORGANIZATION_ID": "your-org"
      }
    }
  }
}
```

Your AI agent now has 7 tools: `search_knowledge`, `get_context`, `get_facts`, `get_fact_history`, `reflect_on_knowledge`, `save_session`, `save_insight`. They activate automatically when relevant.

### Option B: CLI (for terminal workflows)

```bash
cd packages/cli && npm install && npm run build
export SYNAPSE_API_URL=https://synapse.internal.company.com
export SYNAPSE_TOKEN=your-token

synapse search "how do we handle auth?"
synapse facts --entity Lambda --type lesson
synapse history Kafka
synapse reflect "why did we switch to Kafka?"
synapse insight "We decided to use gRPC for service-to-service" --type decision
```

### Option C: Slack (for team knowledge sharing)

Deploy the Slack bot and engineers get:
- `/synapse <question>` — Search from any channel
- `@synapse <question>` — Get answers in-thread
- 📌 reaction — Capture any message to the knowledge base
- `/synapse-save` — Capture a full discussion thread

### Option D: Dashboard (for browsing and analytics)

```bash
cd packages/dashboard && npm install && npm run dev
# Open http://localhost:3100
```

Browse all knowledge, view facts, check entity history, see analytics.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CAPTURE LAYER                                 │
│  IDE Plugins (MCP) │ CLI │ Slack Bot │ Terminal daemon │ Browser ext │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ /capture/passive, /capture/active, /capture/event
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CONTROL PLANE (Fastify API)                     │
│                                                                      │
│  Ingestion Pipeline          Storage Layer         Memory Engine     │
│  ├─ Parser                   ├─ PostgreSQL 16      ├─ Fact Extractor │
│  ├─ Segmenter                │  (pgvector+FTS+graph)├─ Entity Linker│
│  ├─ Embedding                ├─ S3 (raw)           ├─ Temporal Chain │
│  ├─ Deduplication            └─ Redis (cache+queue)├─ Compaction    │
│  └─ Tier classifier                                └─ Learning Loop │
│                                                                      │
│  5-Signal Retrieval: Semantic + Keyword + Entity + Temporal + Graph  │
│  Ranking Engine: learned weights + cross-encoder rerank              │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ /search, /context, /facts, /reflect
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        CONSUMER LAYER                                 │
│  MCP Server │ CLI Tool │ Slack Bot │ Web Dashboard │ IDE Plugins     │
└─────────────────────────────────────────────────────────────────────┘
```

Full design: [ARCHITECTURE.md](ARCHITECTURE.md)

## Key Design Decisions

- **Passive capture** — Auto-upload every AI session. No developer action needed. Solves adoption. [ADR-003](docs/ADR-003-memory-architecture-synthesis.md)
- **ADD-only facts** — Never overwrite memory. New facts live alongside old ones. Enables "what changed?" queries. [ADR-003](docs/ADR-003-memory-architecture-synthesis.md)
- **Hierarchical memory** — Facts (instant answers) + Chunks (full context) + Clusters (deduplicated) + Canonicals (compacted)
- **5-signal retrieval** — Semantic + Keyword + Entity + Temporal + Graph, fused with learned weights
- **Consolidated storage** — Postgres handles vectors, full-text, graph, and metadata in one DB. [ADR-001](docs/ADR-001-storage-consolidation.md)
- **Tiered ingestion** — Cheap heuristic path for all; LLM extraction only for high-value (~20%). [ADR-002](docs/ADR-002-tiered-ingestion.md)
- **Knowledge compaction** — Weekly job synthesizes cluster canonical articles. Index grows sub-linearly.
- **Automatic Learning Loop** — Closed-cycle intelligence: reflect produces insights → stored as facts → influence future retrieval → better answers. [ADR-004](docs/ADR-004-hindsight-inspired-improvements.md)

## Learning Loop

The system gets smarter with every interaction through a closed learning cycle:

```
RETAIN → EXTRACT → REINFORCE → OBSERVE → RECALL → REFLECT → WRITE-BACK → RETAIN
```

| Speed | When | What Happens |
|-------|------|------|
| **Inline** | Every fact extraction | New facts evaluate against existing opinions (reinforce/weaken/contradict). Observations queued for refresh. |
| **On reflect** | Every `/api/v1/reflect` call | High-confidence answers → extract insights → store as new facts. Source facts get usage boost. |
| **Batch** | Weekly compaction | Full opinion reinforcement sweep. All stale observations refreshed. New entities discovered. |

Monitor learning health: `GET /api/v1/stats/learning`

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system design (v3), memory model, data flow, learning loop |
| [docs/IDE-SETUP.md](docs/IDE-SETUP.md) | How to connect any IDE (Kiro, Cursor, Windsurf, VS Code, CLI) |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment guide (on-prem, AWS, GCP, hybrid) |
| [docs/API.md](docs/API.md) | REST API reference with examples |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Local development setup |
| [docs/DATA-FLOW.md](docs/DATA-FLOW.md) | Request, write, and failure flows with diagrams and measured latency |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operational procedures and troubleshooting |
| [docs/ADR-001](docs/ADR-001-storage-consolidation.md) | Storage consolidation decision |
| [docs/ADR-002](docs/ADR-002-tiered-ingestion.md) | Tiered ingestion decision |
| [docs/ADR-003](docs/ADR-003-memory-architecture-synthesis.md) | Memory architecture synthesis (v3) |
| [docs/ADR-004](docs/ADR-004-hindsight-inspired-improvements.md) | Hindsight-inspired improvements (learning loop, reflect, observations) |
| [packages/mcp-server/README.md](packages/mcp-server/README.md) | MCP Server setup + tool reference |

## Packages

| Package | Purpose | Language | Run |
|---------|---------|----------|-----|
| `src/` | Control plane (API + ingestion + retrieval) | TypeScript | `npm run dev` |
| `packages/retrieval-engine` | Native compute (ranking, dedup, graph) | Rust | `npx napi build --release` |
| `packages/compaction-go` | Parallel compaction binary | Go | `synapse-compaction --org=all` |
| `packages/mcp-server` | MCP tools for AI agents | TypeScript | Add to IDE mcp.json |
| `packages/cli` | Terminal search + capture | TypeScript | `synapse search "query"` |
| `packages/slack-bot` | Slack integration | TypeScript | `npm start` (port 3001) |
| `packages/admin-ui` | Admin dashboard (Flutter web) | Dart | `flutter build web` |
| `packages/dashboard` | Legacy Next.js dashboard | TypeScript | `npm run dev` (port 3100) |

## Deployment

| Target | Method | Command |
|--------|--------|---------|
| **Local dev** | Docker Compose | `docker compose -f infra/docker/docker-compose.yml up -d` |
| **On-prem K8s** | Helm + Patroni | `helm install synapse ./deploy/helm/synapse -f profiles/on-prem.yaml` |
| **AWS** | Terraform + Helm | `terraform apply -var-file=environments/aws-prod.tfvars` |
| **GCP** | Terraform + Helm | `terraform apply -var-file=environments/gcp-prod.tfvars` |
| **Hybrid** | Helm | `helm install synapse ... -f profiles/hybrid.yaml` |

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full instructions.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/capture/passive` | Auto-upload session (no user action) |
| POST | `/api/v1/capture/active` | Explicit save with tags/annotation |
| POST | `/api/v1/capture/event(s)` | Ambient events (terminal, browser, meetings) |
| POST | `/api/v1/context` | Get context for AI prompt (primary plugin endpoint) |
| POST | `/api/v1/search` | Advanced search with 5-signal fusion |
| GET | `/api/v1/facts` | Query atomic facts by entity/time/type |
| GET | `/api/v1/facts/:entity/history` | Temporal evolution of an entity |
| POST | `/api/v1/reflect` | Reflect: retrieve + reason + learn (learning loop) |
| GET | `/api/v1/observations/:entity` | Get pre-computed entity summary |
| GET | `/api/v1/stats/learning` | Learning loop health and metrics |
| POST | `/api/v1/feedback` | Record retrieval feedback |
| POST | `/api/v1/sessions` | Legacy session upload (active capture) |
| GET | `/api/v1/sessions/:id/status` | Check processing status |
| GET | `/health` | Health check |

## Performance

Measured on a 120-chunk corpus (120 searchable sessions, 88 facts, local
`EMBEDDING_PROVIDER=local`), single API process, Docker Compose on macOS,
cache cleared between runs except where noted. Reproduce with
`npm run load:retrieval`.

| Concurrency | Requests | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|---|
| 1 | 1,939 | 9.8ms | 13.2ms | 20.5ms | 97 rps |
| 4 | 3,567 | 21.1ms | 34.4ms | 46.5ms | 178 rps |
| 8 | 4,087 | 38.1ms | 58.5ms | 72.3ms | 204 rps |
| 16 | 3,777 | 80.6ms | 134.0ms | 176.7ms | 188 rps |
| 32 | 3,962 | 159.2ms | 223.9ms | 263.3ms | 197 rps |
| **warm cache (c=16)** | **36,378** | **8.5ms** | **11.8ms** | **15.3ms** | **1,818 rps** |

### Native Performance (Rust)

Compute-heavy operations run in Rust via napi-rs with parallel execution (Rayon):

| Operation | Before (Node.js) | After (Rust) | Speedup |
|-----------|-------------------|--------------|---------|
| Rank 1000 candidates | ~40ms | 4.8ms | **8x** |
| Graph traversal (1000 nodes, 5000 edges) | ~30ms | 3.5ms | **9x** |
| MinHash 1000 texts (128 hashes) | seconds | <500ms | **>5x** |
| Local embed 100 texts × 1536 dim | ~200ms | 8.3ms | **24x** |
| Batch cosine similarity (1000 vectors) | ~50ms | <5ms | **10x** |
| Compaction (full org, Go parallel) | 30 min | ~2 min | **15x** |

### Test Results

```
Node.js unit tests:     103 passed (11 files)
Flutter widget tests:    24 passed
Rust native tests:       74 passed (retrieval + dedup + graph)
Total:                  201 tests, all passing
```

See [docs/DATA-FLOW.md](docs/DATA-FLOW.md) for the full request and failure
paths with sequence diagrams.

## Tech Stack

| Layer | Component | Technology |
|-------|-----------|-----------|
| Control Plane | API | Node.js, Fastify, Zod |
| | Queue | BullMQ (Redis-backed) |
| | Database | PostgreSQL 16 (pgvector, tsvector, pg_trgm, relational graph tables, RLS) |
| | Object Storage | S3 / GCS / MinIO / Ceph (configurable) |
| | Cache | Redis 7 |
| | Embeddings | OpenAI, Ollama, vLLM, or HuggingFace TEI (configurable) |
| | LLM | Claude, OpenAI, Ollama, vLLM, or disabled (configurable) |
| | Retrieval | 5-signal fusion (semantic + keyword + entity + temporal + graph) |
| Native Compute | Retrieval Engine | Rust (napi-rs, Rayon) — ranking, RRF, cosine, entity overlap |
| | Dedup Pipeline | Rust (napi-rs, Rayon) — MinHash, Jaccard, vector validation |
| | Graph Traversal | Rust (napi-rs) — spreading activation, connectivity scoring |
| | Compaction | Go — parallel cluster synthesis, fact supersession, observation refresh |
| Consumer | MCP Server | @modelcontextprotocol/sdk (stdio transport) |
| | CLI | Commander + Chalk + Ora |
| | Slack Bot | @slack/bolt (Socket Mode + HTTP) |
| | Dashboard | Flutter Web (Material 3, dark theme) |
| Infrastructure | Helm Chart | Kubernetes (any distro: EKS, GKE, AKS, bare-metal) |
| | Terraform | Multi-cloud modules (AWS, GCP, on-prem) |
| | Postgres HA | Patroni (for on-prem/self-managed) or Aurora/Cloud SQL |
| | Service Mesh | Istio (mTLS, traffic policies, observability) |
| | Monitoring | OpenTelemetry → Grafana / Prometheus |

## License

Built by MihaiBalaci
