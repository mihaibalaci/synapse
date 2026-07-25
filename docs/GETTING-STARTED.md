# Getting Started

## Prerequisites

- Node.js 20+
- Docker + Docker Compose
- An OpenAI API key (for embeddings) — or use `EMBEDDING_PROVIDER=local` for dev

## Quick Start

```bash
# 1. Clone and install
cd recall
npm install

# 2. Start infrastructure
docker compose -f infra/docker/docker-compose.yml up -d

# 3. Configure environment
cp .env.example .env
# Edit .env if you want real embeddings (add OPENAI_API_KEY)

# 4. Start the application
npm run dev
```

The API is now running at `http://localhost:3000`.

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
| PostgreSQL | `localhost:5432` | Primary database (pgvector + FTS) |
| Redis | `localhost:6379` | Cache + queue |
| Neo4j Browser | `http://localhost:7474` | Graph visualization |
| OpenSearch | `http://localhost:9200` | Full-text search (v1 compat) |
| MinIO Console | `http://localhost:9001` | S3 browser (login: minioadmin/minioadmin) |

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
npm run dev          # Start API + workers (hot reload)
npm run build        # Compile TypeScript
npm run test         # Run tests (vitest)
npm run lint         # ESLint
npm run migrate      # Run database migrations
```

## Consumer Packages

After the control plane is running, set up the consumer layer:

```bash
# MCP Server (for IDE integration)
cd packages/mcp-server && npm install && npm run build

# CLI Tool
cd packages/cli && npm install && npm run build && npm link
# Now you can run: recall search "how do we deploy?"

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
helm install ctx ./deploy/helm/recall -f deploy/helm/recall/profiles/on-prem.yaml

# AWS (Terraform + Helm)
cd deploy/terraform && terraform apply -var-file=environments/aws-prod.tfvars

# GCP
cd deploy/terraform && terraform apply -var-file=environments/gcp-prod.tfvars

# Legacy AWS (CDK — deprecated)
cd infra/cdk && npx cdk deploy --all --context stage=dev
```
