# Recall

**The memory layer for AI first engineering teams.**

AI context, stored. Knowledge, recalled.

A company-scale memory system that continuously captures AI coding sessions from 1000+ engineers,
extracts atomic facts and knowledge, deduplicates across the organization, and provides
sub-200ms retrieval. Over time, token usage per query *decreases* as the system compacts
collective knowledge into canonical answers.

## The Problem

Every AI coding session (Claude, GPT, Cursor, Kiro, Copilot) generates valuable context:
debugging insights, architecture decisions, code patterns. Today, this knowledge is lost
after the session ends. Tomorrow's developer re-uploads thousands of tokens to solve the
same problem someone else already solved.

## The Solution

**Capture** (like Pieces): Passively record every AI session in the background — no developer action needed.

**Remember**: Extract atomic facts, link entities, build temporal chains. ADD-only — never overwrite history.

**Share** (unique to us): Deduplicate across 600 engineers. One canonical answer per topic instead of 500 copies.

**Compress** (unique to us): Weekly compaction turns clusters into concise canonical articles. Knowledge gets *smaller and better* over time.

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
    "recall": {
      "command": "node",
      "args": ["<path-to>/packages/mcp-server/dist/index.js"],
      "env": {
        "RECALL_API_URL": "https://ctx.internal.company.com",
        "RECALL_TOKEN": "your-token",
        "DEVELOPER_ID": "your-id",
        "ORGANIZATION_ID": "your-org"
      }
    }
  }
}
```

That's it. Your AI agent now has 6 tools: `search_knowledge`, `get_context`, `get_facts`, `get_fact_history`, `save_session`, `save_insight`. It uses them automatically when relevant.

### Option B: CLI (for terminal workflows)

```bash
cd packages/cli && npm install && npm run build
export RECALL_API_URL=https://ctx.internal.company.com
export RECALL_TOKEN=your-token

recall search "how do we handle auth?"
recall facts --entity Lambda --type lesson
recall history Kafka
recall insight "We decided to use gRPC for service-to-service" --type decision
```

### Option C: Slack (for team knowledge sharing)

Deploy the Slack bot and engineers get:
- `/recall <question>` — Search from any channel
- `@recall-bot <question>` — Get answers in-thread
- 📌 reaction — Capture any message to the knowledge base
- `/recall-save` — Capture a full discussion thread

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
│  ├─ Segmenter                │  (pgvector+FTS+AGE) ├─ Entity Linker │
│  ├─ Embedding                ├─ S3 (raw)           ├─ Temporal Chain │
│  ├─ Deduplication            └─ Redis (cache+queue)├─ Compaction    │
│  └─ Tier classifier                                └─ Dedup Engine  │
│                                                                      │
│  5-Signal Retrieval: Semantic + Keyword + Entity + Temporal + Graph  │
│  Ranking Engine: learned weights + cross-encoder rerank              │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ /search, /context, /facts
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

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system design (v3), memory model, data flow |
| [docs/IDE-SETUP.md](docs/IDE-SETUP.md) | How to connect any IDE (Kiro, Cursor, Windsurf, VS Code, CLI) |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deployment guide (on-prem, AWS, GCP, hybrid) |
| [docs/API.md](docs/API.md) | REST API reference with examples |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Local development setup |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operational procedures and troubleshooting |
| [docs/ADR-001](docs/ADR-001-storage-consolidation.md) | Storage consolidation decision |
| [docs/ADR-002](docs/ADR-002-tiered-ingestion.md) | Tiered ingestion decision |
| [docs/ADR-003](docs/ADR-003-memory-architecture-synthesis.md) | Memory architecture synthesis (v3) |
| [packages/mcp-server/README.md](packages/mcp-server/README.md) | MCP Server setup + tool reference |

## Packages

| Package | Purpose | Run |
|---------|---------|-----|
| `src/` | Control plane (API + ingestion + retrieval) | `npm run dev` |
| `packages/mcp-server` | MCP tools for AI agents | Add to IDE mcp.json |
| `packages/cli` | Terminal search + capture (`ctx`) | `recall search "query"` |
| `packages/slack-bot` | Slack integration | `npm start` (port 3001) |
| `packages/dashboard` | Web UI (search, facts, analytics) | `npm run dev` (port 3100) |

## Deployment

| Target | Method | Command |
|--------|--------|---------|
| **Local dev** | Docker Compose | `docker compose -f infra/docker/docker-compose.yml up -d` |
| **On-prem K8s** | Helm + Patroni | `helm install ctx ./deploy/helm/recall -f profiles/on-prem.yaml` |
| **AWS** | Terraform + Helm | `terraform apply -var-file=environments/aws-prod.tfvars` |
| **GCP** | Terraform + Helm | `terraform apply -var-file=environments/gcp-prod.tfvars` |
| **Hybrid** | Helm | `helm install ctx ... -f profiles/hybrid.yaml` |

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
| POST | `/api/v1/feedback` | Record retrieval feedback |
| POST | `/api/v1/sessions` | Legacy session upload (active capture) |
| GET | `/api/v1/sessions/:id/status` | Check processing status |
| GET | `/health` | Health check |

## Tech Stack

| Layer | Component | Technology |
|-------|-----------|-----------|
| Control Plane | API | Node.js, Fastify, Zod |
| | Queue | BullMQ (Redis-backed) |
| | Database | PostgreSQL 16 (pgvector, tsvector, Apache AGE, RLS) |
| | Object Storage | S3 / GCS / MinIO / Ceph (configurable) |
| | Cache | Redis 7 |
| | Embeddings | OpenAI, Ollama, vLLM, or HuggingFace TEI (configurable) |
| | LLM | Claude, OpenAI, Ollama, vLLM, or disabled (configurable) |
| | Retrieval | 5-signal fusion (semantic + keyword + entity + temporal + graph) |
| Consumer | MCP Server | @modelcontextprotocol/sdk (stdio transport) |
| | CLI | Commander + Chalk + Ora |
| | Slack Bot | @slack/bolt (Socket Mode + HTTP) |
| | Dashboard | Next.js 14, React 18, Tailwind CSS |
| Infrastructure | Helm Chart | Kubernetes (any distro: EKS, GKE, AKS, bare-metal) |
| | Terraform | Multi-cloud modules (AWS, GCP, on-prem) |
| | Postgres HA | Patroni (for on-prem/self-managed) or Aurora/Cloud SQL |
| | Service Mesh | Istio (mTLS, traffic policies, observability) |
| | Monitoring | OpenTelemetry → Grafana / Prometheus |

## Cost at Scale

For 600 engineers, 24K sessions/day:
- Infrastructure: ~$13K/month (vs $38K in v1)
- LLM: ~$6.3K/month (vs $31.5K in v1)
- Cost per engineer: **~$32/month**
- Token savings for AI usage: estimated **$50K+/month** in reduced prompt costs

## License

Internal / Proprietary
