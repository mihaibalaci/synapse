# <img src="docs/assets/logo.svg" width="36" height="36" align="top" /> Synapse

**The memory layer that learns.**

Hundreds of engineers, creating a neural network of knowledge.

A team-scale memory system that continuously captures AI coding sessions,
extracts atomic facts and knowledge, deduplicates across the organization, and provides
sub-200ms retrieval. Over time, the system *learns* — token usage per query decreases
as collective knowledge compacts into canonical answers, opinions strengthen with evidence,
and observations sharpen through reflection.

## Architecture

Single 11MB Go binary + Rust compute kernels + Flutter admin UI.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CAPTURE LAYER                                 │
│  IDE Plugins (MCP) │ CLI │ Slack Bot │ Terminal daemon │ Browser ext │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   SYNAPSE BINARY (Go, 11MB)                           │
│                                                                      │
│  API Server (chi)            Workers (goroutines)    MCP Server       │
│  ├─ JWT Auth                 ├─ Session processing   ├─ 7 tools      │
│  ├─ Rate limiting            ├─ Fact extraction      ├─ JSON-RPC     │
│  ├─ CORS                     ├─ Embedding            └─ stdin/stdout │
│  └─ 25+ endpoints            ├─ Dedup                                │
│                              └─ Graph indexing       CLI + Slack Bot  │
│                                                                      │
│  Retrieval Engine            Ingestion Pipeline      Learning Loop    │
│  ├─ 3-signal parallel        ├─ Parse + Segment      ├─ Reflect      │
│  ├─ RRF fusion               ├─ Embed + Store        ├─ Write-back   │
│  ├─ Composite ranking        ├─ Enrich (facts,       ├─ Reinforce    │
│  └─ Token-budget packing     │   knowledge, graph)   └─ Observe      │
│                              └─ Index                                 │
│  Storage Layer                                                        │
│  ├─ PostgreSQL (pgx pool)    ─── pgvector + FTS + graph + RLS       │
│  ├─ Redis (go-redis)         ─── cache + queues + rate limits        │
│  └─ S3 (HTTP)                ─── immutable raw sessions              │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                          ┌──────┴───────┐
                          ▼              ▼
┌────────────────────┐  ┌────────────────────────────┐
│  RUST COMPUTE      │  │  FLUTTER ADMIN UI          │
│  (napi-rs, 829KB)  │  │  (Material 3, dark theme)  │
│  ├─ RRF fusion     │  │  ├─ Live dashboard         │
│  ├─ MinHash dedup  │  │  ├─ Users & roles          │
│  ├─ Graph traverse │  │  ├─ System components      │
│  └─ Cosine sim     │  │  ├─ Activity log           │
│                    │  │  └─ Data sources            │
└────────────────────┘  └────────────────────────────┘
```

## Quick Start

```bash
# Deploy on any Linux server (single binary, no dependencies)
scp deploy/lxc/deploy-native.sh root@<server>:/root/
ssh root@<server> bash /root/deploy-native.sh

# Or run locally
cd go && go build -o synapse ./cmd/synapse/
./synapse serve
```

## Connecting Your IDE

### MCP (works with Kiro, Cursor, Windsurf, Claude Desktop, Cline)

```json
{
  "mcpServers": {
    "synapse": {
      "command": "/path/to/synapse",
      "args": ["mcp"],
      "env": {
        "SYNAPSE_API_URL": "http://your-server:3000",
        "SYNAPSE_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

7 tools auto-activate: `search_knowledge`, `get_context`, `get_facts`, `get_fact_history`, `reflect_on_knowledge`, `save_session`, `save_insight`.

### CLI

```bash
export SYNAPSE_API_URL=http://your-server:3000
export SYNAPSE_TOKEN=your-jwt-token

synapse search "how do we handle auth?"
synapse facts --entity Kafka
synapse history PostgreSQL
synapse reflect "why did we switch to Kafka?"
synapse insight "We decided to use gRPC" --type decision
synapse status
```

### Slack Bot

```bash
synapse slack  # Starts bot on port 3001
```

- `/synapse <question>` — Search from any channel
- `@synapse <question>` — Get answers in-thread
- `/synapse-save` — Capture a thread

## Performance

### API Latency (Go binary on 4-core LXC)

| Metric | Value |
|--------|-------|
| Cold start | **~50ms** (vs 2s with Node.js) |
| Health check | **<1ms** |
| Search (cache hit) | **<5ms** |
| Search (cache miss) | **<120ms** p95 |
| Memory usage | **~30MB** (vs 150MB Node.js) |
| Binary size | **11MB** (vs 500MB node_modules) |
| Concurrent requests | **2000+ rps** per process |

### Native Compute (Rust, parallel via Rayon)

| Operation | Performance |
|-----------|-------------|
| Rank 1000 candidates | **4.8ms** |
| Graph traversal (1000 nodes, 5000 edges) | **3.5ms** |
| MinHash 1000 texts (128 hashes) | **<500ms** |
| Local embed 100 texts × 1536 dim | **8.3ms** |
| Batch cosine similarity (1000 vectors) | **<5ms** |

### Test Results

```
Go tests:              21 passed (auth, retrieval, ingestion)
Rust native tests:     74 passed (retrieval, dedup, graph)
Flutter widget tests:  24 passed (dashboard, users, system, activity)
Node.js legacy tests: 103 passed (reference — no longer in runtime)
────────────────────────────────────────────────
Total:                222 tests
```

## Learning Loop

The system gets smarter with every interaction:

```
RETAIN → EXTRACT → REINFORCE → OBSERVE → RECALL → REFLECT → WRITE-BACK → RETAIN
```

| Speed | When | What Happens |
|-------|------|------|
| **Inline** | Every fact extraction | New facts evaluate against existing opinions. Observations queued for refresh. |
| **On reflect** | Every `/api/v1/reflect` call | High-confidence answers → extract insights → store as new facts. |
| **Batch** | Weekly (Go compaction binary) | Full opinion reinforcement. Stale observations refreshed. Clusters synthesized. |

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/capture/passive` | Auto-upload session (no user action) |
| POST | `/api/v1/capture/active` | Explicit save with tags/annotation |
| POST | `/api/v1/capture/event` | Ambient events (terminal, browser) |
| POST | `/api/v1/search` | 5-signal hybrid search |
| POST | `/api/v1/context` | Token-budget-aware context for AI prompts |
| GET | `/api/v1/facts` | Query atomic facts by entity/time/type |
| GET | `/api/v1/facts/{entity}/history` | Temporal evolution |
| POST | `/api/v1/reflect` | Retrieve + reason + learn |
| GET | `/api/v1/observations/{entity}` | Pre-computed entity summary |
| GET | `/api/v1/stats` | System metrics |
| GET | `/api/v1/stats/learning` | Learning loop health |
| POST | `/api/v1/feedback` | Retrieval feedback |
| GET | `/health` | Health check |
| GET | `/health/ready` | Readiness (PG + Redis + S3) |

## Tech Stack

| Layer | Component | Technology |
|-------|-----------|-----------|
| **Core Binary** | API + Workers + CLI + MCP + Slack | Go 1.26 (chi, pgx, go-redis) |
| **Compute Kernels** | Ranking, Dedup, Graph | Rust (napi-rs, Rayon) |
| **Compaction** | Parallel batch jobs | Go (goroutines, bounded concurrency) |
| **Admin UI** | Dashboard | Flutter/Dart (Material 3, dark theme) |
| **Database** | Primary store | PostgreSQL 16 (pgvector, tsvector, RLS) |
| **Cache + Queue** | Hot data + jobs | Redis 7 |
| **Object Storage** | Raw sessions | S3 / MinIO |
| **Embedding** | Vector generation | OpenAI / Ollama / TEI / local |
| **LLM** | Fact extraction + reflect | Claude / OpenAI / Ollama / disabled |

## Project Structure

```
synapse/
├── go/                           # PRIMARY — Go binary (replaces TypeScript)
│   ├── cmd/synapse/             #   Entry point (serve|worker|mcp|slack|cli)
│   └── internal/
│       ├── api/                 #   HTTP router, handlers, app wiring
│       ├── auth/                #   JWT middleware
│       ├── config/              #   Environment configuration
│       ├── retrieval/           #   5-signal search, RRF, ranking
│       ├── ingestion/           #   Worker pool, pipeline, embedding, facts
│       ├── storage/             #   PostgreSQL, Redis, S3 repositories
│       ├── models/              #   Core data types
│       ├── middleware/          #   Rate limiting, logging
│       ├── mcp/                 #   MCP protocol server (JSON-RPC)
│       ├── cli/                 #   CLI subcommands
│       └── slack/               #   Slack bot
├── packages/
│   ├── retrieval-engine/        #   Rust native module (napi-rs)
│   │   ├── src/lib.rs          #     RRF, ranking, temporal, cosine
│   │   ├── src/dedup.rs        #     MinHash, Jaccard, validation
│   │   └── src/graph.rs        #     Spreading activation
│   ├── compaction-go/           #   Go compaction binary
│   └── admin-ui/                #   Flutter web dashboard
├── deploy/
│   ├── lxc/                     #   Native deployment scripts (no Docker)
│   ├── helm/synapse/            #   Kubernetes Helm chart
│   └── terraform/               #   Multi-cloud IaC
├── docs/                        #   API reference, data flow, architecture
└── src/                         #   Legacy TypeScript (reference, not in runtime)
```

## Deployment

```bash
# Single server (recommended for <100 engineers)
synapse serve                    # API on :3000

# With workers (for larger teams)
synapse serve &                  # API
synapse worker &                 # Background processing

# Kubernetes
helm install synapse ./deploy/helm/synapse -f profiles/on-prem.yaml
```

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, learning loop, native compute |
| [docs/API.md](docs/API.md) | REST API reference |
| [docs/DATA-FLOW.md](docs/DATA-FLOW.md) | Request flows with sequence diagrams |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment guide (LXC, K8s, AWS, GCP) |
| [docs/ADR-004](docs/ADR-004-hindsight-inspired-improvements.md) | Learning loop design (Hindsight-inspired) |

## License

MIT License — see [LICENSE](LICENSE) for details.
