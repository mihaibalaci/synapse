# Getting Started

## Prerequisites

- Node.js 20+
- Docker + Docker Compose
- An OpenAI API key (for embeddings) — or use `EMBEDDING_PROVIDER=local` for dev

## Quick Start

```bash
# 1. Clone and install
cd synapse
npm install

# 2. Start infrastructure
docker compose -f infra/docker/docker-compose.yml up -d

# 3. Configure environment
cp .env.example .env
# Edit .env if you want real embeddings (add OPENAI_API_KEY)

# 4. Start the API and the workers (separate processes)
npm run dev          # API
npm run dev:worker   # workers, in a second terminal
```

The API is now running at `http://localhost:3000`.

`docker compose up` already builds and runs the API, worker, and dashboard, so
steps 3 and 4 are only needed when running the service from source.

Every endpoint except `/health` and `/health/ready` requires a bearer JWT whose
issuer and audience match `AUTH_ISSUER`/`AUTH_AUDIENCE` and which carries `sub`,
`organization_id`, `team_ids`, `roles`, and `repository_access`. Identity comes
from verified claims only; request-body identity fields are ignored.
`npm run smoke:local` mints a valid local token and exercises the full
upload-to-search path.

## Verify It Works

```bash
# Health check
curl http://localhost:3000/health

# Upload a test session
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "00000000-0000-0000-0000-000000000001",
    "developerId": "dev-test",
    "organizationId": "org-test",
    "messages": [
      {
        "id": "00000000-0000-0000-0000-000000000010",
        "role": "user",
        "content": "How do I fix a Lambda timeout in a VPC?",
        "codeBlocks": [],
        "timestamp": "2025-07-25T10:00:00Z",
        "tokenCount": 15,
        "toolCalls": []
      },
      {
        "id": "00000000-0000-0000-0000-000000000011",
        "role": "assistant",
        "content": "Lambda timeouts in VPCs are usually caused by DNS resolution delays. Use a VPC endpoint for the service you are calling, or move the Lambda to a public subnet with a NAT gateway.",
        "codeBlocks": [],
        "timestamp": "2025-07-25T10:00:05Z",
        "tokenCount": 50,
        "toolCalls": []
      }
    ],
    "metadata": {
      "project": "my-service",
      "language": "python",
      "languages": ["python"],
      "frameworks": ["aws-lambda"],
      "aiProvider": "claude",
      "aiModel": "claude-sonnet-4-20250514",
      "tags": ["lambda", "vpc", "timeout"]
    },
    "startedAt": "2025-07-25T10:00:00Z",
    "endedAt": "2025-07-25T10:01:00Z",
    "totalTokens": 65
  }'

# Search for it
curl -X POST http://localhost:3000/api/v1/context \
  -H "Content-Type: application/json" \
  -d '{
    "query": "lambda timeout vpc",
    "developerId": "dev-test",
    "organizationId": "org-test"
  }'
```

## Local Services

After `docker compose up`, these services are available:

| Service | URL | Purpose |
|---------|-----|---------|
| PostgreSQL | `localhost:5432` | Vectors, FTS, relational graph, outbox |
| Redis | `localhost:6379` | BullMQ queues + cache (`noeviction`) |
| MinIO Console | `http://localhost:9001` | S3 browser (login: minioadmin/minioadmin) |
| API | `http://localhost:3000` | `/health`, `/health/ready`, `/api/v1/*` |
| Worker health | `http://localhost:3001/health` | Liveness via dispatch heartbeat |
| Dashboard | `http://localhost:3100` | Web UI |

There is no Neo4j and no OpenSearch. PostgreSQL FTS/`pg_trgm` and the relational
`graph_nodes`/`graph_edges` tables replaced both.

## Project Structure

```
src/
├── api/           → REST endpoints (upload, search, feedback)
├── ingestion/     → Pipeline: parser, segmenter, extractor, deduplication, compaction
├── retrieval/     → Hybrid search engine, ranking, permissions, feedback
├── storage/       → Database, S3, graph, search index, cache adapters
├── models/        → Zod schemas (session, chunk, knowledge, retrieval, permissions, graph)
├── utils/         → Embedding client, logger, governance scanner
└── config/        → Environment config with validation
```

## Key Concepts

**Session** — A complete AI coding conversation (uploaded by IDE plugin)

**Chunk** — A topically coherent segment of a session (800-1200 tokens). The atomic unit of retrieval.

**Knowledge Record** — Structured extraction from a chunk (Problem/Solution, Architecture Decision, Best Practice, How-To)

**Cluster** — A group of near-duplicate chunks about the same topic. Has one canonical representative.

**Tier 1 / Tier 2** — Processing depth. Tier 1 = fast (embed + index). Tier 2 = deep (LLM extract + dedup + graph).

## Configuration

Key environment variables (see `.env.example` for all):

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `local` | `local` for dev, `openai` for real embeddings |
| `OPENAI_API_KEY` | — | Required if EMBEDDING_PROVIDER=openai |
| `LLM_PROVIDER` | `claude` | For Tier 2 knowledge extraction |
| `QUEUE_CONCURRENCY` | `5` | Parallel ingestion workers |
| `DATABASE_URL` | `postgresql://...` | Postgres connection string |

## Development Workflow

```bash
npm run dev                  # API only (hot reload)
npm run dev:worker           # All workers (hot reload)
npm run build                # Compile core + workspaces
npm run test                 # Run tests (vitest)
npm run lint                 # ESLint
npm run migrate              # Apply ordered migrations (advisory-locked, idempotent)
npm run backfill:embeddings  # Resumable re-embedding backfill
npm run smoke:local          # Authenticated upload → search proof against Compose
npm run load:retrieval       # Seed a corpus and measure retrieval p50/p95/p99
npm run test:concurrency     # Concurrency regression test (needs TEST_DATABASE_URL)
```

Migrations never run automatically on startup. Apply them explicitly, or let the
Helm pre-upgrade Job do it.

`npm test` skips the concurrency regression test unless a real database is
supplied, because the race it guards cannot be reproduced with mocks:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/synapse \
  npm run test:concurrency
```

See [DATA-FLOW.md](DATA-FLOW.md) for how a request moves through the system.

## Consumer Packages

After the control plane is running, set up the consumer layer:

```bash
# MCP Server (for IDE integration)
cd packages/mcp-server && npm install && npm run build

# CLI Tool
cd packages/cli && npm install && npm run build && npm link
# Now you can run: synapse search "how do we deploy?"

# Slack Bot
cd packages/slack-bot && npm install && npm run dev

# Web Dashboard
cd packages/dashboard && npm install && npm run dev
# Open http://localhost:3100
```

See [docs/IDE-SETUP.md](IDE-SETUP.md) for connecting your specific IDE.

## Deployment

For production deployment on any infrastructure, see [DEPLOYMENT.md](DEPLOYMENT.md).

**Quick reference:**

```bash
# On-prem Kubernetes
helm install synapse ./deploy/helm/synapse -f deploy/helm/synapse/profiles/on-prem.yaml

# AWS (Terraform + Helm)
cd deploy/terraform && terraform apply -var-file=environments/aws-prod.tfvars

# GCP
cd deploy/terraform && terraform apply -var-file=environments/gcp-prod.tfvars
```

The AWS CDK stacks were removed: they provisioned OpenSearch and pointed at
Neo4j, neither of which the service uses. Terraform plus Helm is the only
supported cloud path.
