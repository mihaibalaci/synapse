# <img src="docs/assets/logo.svg" width="36" height="36" align="top" /> Synapse

**The memory layer that learns.** A self-hosted knowledge system that captures AI engineering sessions, extracts atomic facts, builds a knowledge graph, detects contradictions, and provides sub-200ms 4-signal retrieval that improves with every interaction.

## What Synapse Does

| Capability | How |
|-----------|-----|
| **Capture** | Passive/active sessions, git PRs/commits, Slack, MCP, SDKs |
| **Extract** | Heuristic fact extraction → typed entities (decision, lesson, pattern, constraint, opinion) |
| **Graph** | Auto-populated knowledge graph with co-occurrence edges and importance scoring |
| **Search** | 4-signal hybrid: semantic (pgvector), keyword (FTS), entity overlap, graph neighbors |
| **Learn** | LLM-powered reflection, confidence calibration, contradiction detection, adaptive ranking |
| **Compact** | Automatic session summarization via LLM, cross-session deduplication |
| **Observe** | Prometheus `/metrics`, structured audit log, queue visibility, S3 garbage collection |

## Architecture

Single Go binary + Flutter admin UI + optional Rust compute kernels.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CAPTURE LAYER                                │
│  MCP │ Python SDK │ JS SDK │ CLI │ Git │ Slack │ REST API           │
└──────┬──────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────────┐
│                         API SERVER (Go)                              │
│  Auth (Login/OIDC/API Keys) │ Rate Limiting │ Webhooks              │
│  Search (4-signal) │ Reflect │ Admin │ Prometheus                   │
└──────┬──────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────────┐
│                         WORKER                                       │
│  Segment → Embed → Facts → Dedup → Graph → Contradictions → Index  │
│  Auto-compaction │ Confidence calibration │ Reaper recovery          │
└──────┬──────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────────┐
│  PostgreSQL 16       │  Redis 7          │  S3/MinIO                │
│  pgvector + FTS      │  Queues + Cache   │  Raw Objects             │
│  Knowledge Graph     │  Rate State       │  Session Payloads        │
└─────────────────────────────────────────────────────────────────────┘
```

![Data Flow Diagram](docs/assets/data-flow.svg)

## Quick Start

```bash
# Docker Compose (includes all dependencies)
docker compose -f infra/docker/docker-compose.yml up --build

# Bootstrap admin
docker compose exec api env AUTH_BOOTSTRAP_EMAIL=admin@synapse.local \
  AUTH_BOOTSTRAP_PASSWORD=ChangeMeNow123 /usr/local/bin/synapse auth-bootstrap

# Open UI
open http://localhost:8080
```

See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for native installation.

## Client SDKs

```python
# Python
from synapse_sdk import SynapseClient, SessionTracker
client = SynapseClient(token="sk_synapse_...")
results = client.search("How does our auth work?")
```

```javascript
// JavaScript (Node 18+)
const { SynapseClient } = require('@synapse/sdk');
const client = new SynapseClient({ token: 'sk_synapse_...' });
const results = await client.search('Redis caching strategy');
```

## MCP Tools (11 tools)

`search_knowledge` · `get_context` · `get_facts` · `get_fact_history` · `reflect_on_knowledge` · `save_session` · `save_insight` · `capture_git` · `graph_entity` · `graph_path` · `feedback`

## Admin Panel

The Flutter web UI provides: Dashboard, Users & Roles, System Health, Activity Metrics, Configuration (LLM), Memory Browser, Knowledge Search, Graph Explorer, API Keys, Operations (queues/audit/backup), and an Onboarding Wizard.

## Key Design Decisions

- **Embedded migrations** with advisory locking and checksums — schema is always reproducible
- **Request-context DI** — no mutable globals, testable handlers
- **Rotating refresh sessions** — HttpOnly cookies with replay revocation
- **Team/repo isolation** — enforced in SQL, not just UI
- **Temporal decay** — 30-day half-life keeps recent knowledge prominent
- **Contradiction detection** — cosine >0.85 + identical entities auto-supersedes

## Documentation

- [API Reference](docs/API.md)
- [Architecture](ARCHITECTURE.md)
- [Installation](docs/INSTALLATION.md)
- [Getting Started](docs/GETTING-STARTED.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Data Flow Diagrams](docs/diagrams/README.md)
- [Changelog](CHANGELOG.md)

## Version

**v1.0.0** — See [CHANGELOG.md](CHANGELOG.md) for full history.
