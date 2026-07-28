# Synapse — System Architecture (v3)

## Overview

The Synapse is a **team-scale memory layer** for engineering organizations.
It combines intelligent memory extraction and consolidation with continuous background
capture, creating an ever-improving engineering knowledge base that all AI coding agents
draw from.

Instead of every future prompt re-uploading thousands of tokens, the organization builds
a shared memory that gets smaller, better, and faster over time.

---

## Design Principles

| Principle | Rationale |
|-----------|-----------|
| ADD-only memory | Never overwrite or delete facts; let retrieval handle "what's current" |
| Passive capture | Developers shouldn't need to click "save" — capture happens automatically |
| Fact-level granularity | Store atomic facts alongside full chunks; precision retrieval for quick answers |
| Consolidate where possible | Fewer moving parts = less operational overhead; Postgres does 4 jobs |
| Multi-signal retrieval | Semantic + keyword + entity + temporal + graph — fuse all signals |
| Progressive enrichment | Start with cheap heuristics; promote to LLM only when value justifies cost |
| Team-wide deduplication | Hundreds of engineers solving the same problem → one canonical answer |
| Temporal grounding | Everything is time-indexed; support "what changed?" queries (Pieces learning) |
| Strong governance | ACLs, PII detection, secret scanning before knowledge is searchable |

---

## High-Level Architecture (v3 — Intelligent Memory + Continuous Capture)

Key evolution:
- v1: Manual upload → full LLM pipeline → polyglot storage (5 datastores)
- v2: Tiered processing → consolidated Postgres → adaptive retrieval
- **v3: Passive capture + ADD-only fact extraction + entity memory + temporal queries**

Learnings incorporated:
- From **memory research**: Single-pass ADD-only extraction, entity linking, multi-signal fusion, <7K tokens/query
- From **Pieces**: Continuous background capture, temporal grounding, multi-modal input, cross-app linking

Key changes from v2:
- **Consolidated storage**: Postgres (pgvector + FTS) replaces separate OpenSearch + Vector DB
- **Tiered ingestion**: Cheap heuristic pass first; LLM only for high-value sessions
- **Event-driven graph**: organization-scoped relational graph tables in Postgres replace standalone Neo4j
- **Streaming dedup**: Bloom filter pre-check eliminates 80% of dedup candidates instantly
- **Adaptive retrieval**: Skip graph expansion when vector scores are high-confidence

```
┌──────────────────────────────────────────────────────────────────────┐
│                        AI IDE Plugins                                 │
│  (Cursor, Kiro, Copilot, Windsurf, Claude, GPT, custom CLI)          │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTPS (REST)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Gateway (Fastify + gRPC)                         │
│  • OAuth2 auth  • Rate limiting  • Schema validation                 │
│  • Writes raw → S3  • Publishes event to queue                       │
│  • Serves retrieval (< 200ms p99)                                    │
└──────────────┬─────────────────────────────────────┬─────────────────┘
               │ (write path)                        │ (read path)
               ▼                                     ▼
┌──────────────────────────┐         ┌─────────────────────────────────┐
│    Ingestion Pipeline    │         │       Retrieval Pipeline         │
│                          │         │                                  │
│  ┌─────────────────┐    │         │  Query → Embed → Parallel Search │
│  │  Tier 1: Fast   │    │         │    ├─ pgvector ANN (semantic)    │
│  │  (heuristic seg │    │         │    ├─ pg FTS (BM25 keyword)      │
│  │   + embed only) │    │         │    └─ graph expansion (opt.)     │
│  └────────┬────────┘    │         │         │                        │
│           │ promotes     │         │    ┌────▼──────────────────┐     │
│           ▼              │         │    │  RRF Fusion + Rerank  │     │
│  ┌─────────────────┐    │         │    └────┬──────────────────┘     │
│  │  Tier 2: Deep   │    │         │         │                        │
│  │  (LLM extract + │    │         │    ┌────▼──────────────────┐     │
│  │   dedup + graph)│    │         │    │  Ranking Engine        │     │
│  └─────────────────┘    │         │    └────┬──────────────────┘     │
└──────────────────────────┘         │         │                        │
               │                     │    ┌────▼──────────────────┐     │
               ▼                     │    │  Redis Cache           │     │
┌──────────────────────────────────┐ │    └────────────────────────┘     │
│        Storage Layer             │ └─────────────────────────────────┘
│                                  │
│  ┌────────────────────────────┐  │
│  │  PostgreSQL 16             │  │
│  │  • JSONB (metadata, ACLs) │  │
│  │  • pgvector (embeddings)  │  │
│  │  • tsvector (BM25 FTS)    │  │
│  │  • graph_nodes/_edges     │  │
│  │  • RLS (permissions)      │  │
│  └────────────────────────────┘  │
│  ┌─────────┐  ┌──────────────┐  │
│  │ S3      │  │ Redis 7      │  │
│  │ (raw)   │  │ (cache+queue)│  │
│  └─────────┘  └──────────────┘  │
└──────────────────────────────────┘
```

---

## Memory Model (v3 — Hierarchical)

Our memory has **four layers**, each optimized for different query types:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: Canonical Articles                                 │
│  (weekly compaction: one answer per topic, 200-400 tokens)   │
│  Query: "How do we deploy?" → single authoritative answer    │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Knowledge Clusters                                 │
│  (deduplicated groups of related facts/chunks)               │
│  Query: "What approaches exist for X?" → multiple options    │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Chunks (800-1200 tokens)                          │
│  (topical segments of conversations — full context)          │
│  Query: "Show me the full discussion about X" → rich context │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Atomic Facts                                       │
│  (extracted preferences, decisions, patterns, lessons)       │
│  Query: "What database does team X use?" → instant answer    │
└─────────────────────────────────────────────────────────────┘
```

**Fact model:**
```
MemoryFact {
  content:    "Team uses Kafka for event streaming between services"
  type:       decision | preference | pattern | lesson | constraint
  entities:   ["Kafka", "event streaming"]
  temporal:   { validFrom: "2025-03-01", supersededBy: null }
  source:     → chunk_id (for full context)
  confidence: 0.92
}
```

**Key rule (ADD-only principle):**
When information changes, we ADD a new fact and mark the old one as superseded.
We never overwrite. This preserves history and enables temporal reasoning:
- "When did we switch from RabbitMQ to Kafka?" — both facts exist, linked by `supersededBy`
- "What was our auth strategy before the rewrite?" — retrieve facts with `validUntil` in the past

---

## Capture Model (v3 — Continuous, inspired by Pieces)

**Two capture modes operate simultaneously:**

| Mode | Trigger | Content | Quality |
|------|---------|---------|---------|
| **Passive** (default) | Auto on session end | Full AI conversation + terminal context | Good (no extra effort) |
| **Active** | Developer clicks "Save" or "This was useful" | Full session + metadata + manual tags | Best (intentional, often high-value) |
| **Ambient** (future) | Background daemon | Clipboard, browser tabs, meeting audio | Raw (needs more processing) |

**Passive capture solves the adoption problem:**
Pieces learned that requiring manual action kills adoption. Their LTM auto-captures
everything in the background. We apply the same principle to AI sessions: the IDE plugin
silently uploads every completed conversation. Developer does nothing.

**Active capture solves the quality problem:**
When a developer explicitly saves, they can add tags, flag as "high-value," link to a Jira
ticket, or annotate what was useful. These sessions get promoted to Tier 2 (deep processing).

---

## Data Flow

> **Implementation reference.** This section describes the intended design.
> For the flow as implemented — sequence diagrams, the transactional outbox and
> per-action reconciliation, measured latency percentiles, and an explicit list
> of what is not built — see [docs/DATA-FLOW.md](docs/DATA-FLOW.md).

### Ingestion Path (Write) — Tiered Processing

The v1 design processed every session through the full LLM extraction pipeline.
At ~$0.003 per 1K tokens with Claude Sonnet, that's ~$1,050/day for 350M tokens.
v2 introduces tiered processing to reduce LLM costs by 70%+ while maintaining quality.

**Tier 1: Fast Path (all sessions, <5 seconds)**
1. **Capture** — Passive (auto) or Active (manual) via Capture API → 202 Accepted.
2. **Persist** — Raw payload written to S3 (immutable).
3. **Parse** — Normalize messages, extract code blocks, detect languages.
4. **Segment** — Heuristic segmentation (embedding similarity between adjacent window pairs; no LLM needed for 80% of sessions).
5. **Embed** — Batch embed all chunks (cheap: ~$0.13/M tokens with text-embedding-3-small for indexing).
6. **Fact Extract (heuristic)** — Pattern-based extraction of atomic facts (no LLM). ← NEW
7. **Index** — Write to Postgres (chunks + facts + pgvector + tsvector). Searchable immediately.
8. **Bloom filter** — Register chunk fingerprint for O(1) dedup pre-check on future chunks.

**Tier 2: Deep Path (promoted sessions, async, minutes)**
Triggered when:
- Session contains code diffs (likely high-value debugging)
- Query hit rate for related topics exceeds threshold (demand signal)
- Manual flag by developer ("this was useful" / active capture with promoteTier2)
- Nightly batch job scans for un-extracted high-quality chunks

9. **LLM Fact Extraction** — Single-pass, ADD-only extraction of atomic facts with entity linking. ← NEW
10. **LLM Segmentation** — Refine chunk boundaries with topic detection.
11. **Knowledge Extraction** — Produce structured Problem/Solution/Decision records.
12. **Deduplication** — MinHash + cosine → cluster merging.
13. **Graph Indexing** — Update entity graph with relationships.
14. **Temporal Linking** — Detect superseded facts, build temporal chains. ← NEW

### Retrieval Path (Read) — 5-Signal Adaptive Pipeline (v3)

```
Query arrives
    │
    ├─ Cache hit? → return (<5ms)
    │
    ├─ Pre-process: embed query + extract entities (30ms)
    │
    ├─ PARALLEL (5 signals):
    │   ├─ Signal 1: pgvector ANN search (top 50)       (~25ms)
    │   ├─ Signal 2: pg tsvector FTS / BM25 (top 50)   (~15ms)
    │   └─ Signal 3: Entity match via fact layer         (~20ms) ← NEW
    │
    ├─ Signal 4: Temporal scoring (applied to all, 0ms — metadata only) ← NEW
    │
    ├─ RRF fusion → top 30 candidates
    │
    ├─ IF top semantic score < 0.85:
    │   └─ Signal 5: Relational graph expansion (add 20) (~30ms, conditional)
    │
    ├─ Permission filter (RLS, near-zero overhead)
    │
    ├─ Cross-encoder rerank (top 15 → top 5)           (~40ms)
    │
    ├─ Composite ranking (freshness + usage + entities + repo + quality)
    │
    └─ Return: facts (quick answers) + chunks (full context) + citations
```

**Latency budget (v3):**
- Cache hit: **<5ms**
- Warm (3 signals, no graph): **<120ms** p99
- Cold (5 signals, with graph): **<180ms** p99
- Average: **~95ms** (60% of queries resolve at 3 signals)

---

## Core Components

### 1. Capture API (v3 — Pieces-inspired)

| Property | Value |
|----------|-------|
| Passive endpoint | `POST /api/v1/capture/passive` — auto-upload, minimal payload |
| Active endpoint | `POST /api/v1/capture/active` — explicit save with tags/annotation |
| Ambient endpoint | `POST /api/v1/capture/event(s)` — terminal, browser, meeting events |
| Legacy compat | `POST /api/v1/sessions` — still works (maps to active capture) |
| Auth | OAuth2 with org-scoped tokens |
| Rate limit | 100 req/s per developer, 50,000 req/s global |
| Payload limit | 10 MB per session |
| Response | 202 Accepted (async processing) |

### 2. Ingestion Pipeline (v3 — with Fact Extraction)

- **Parser Workers** — Normalize provider-specific formats into unified schema.
- **Semantic Segmenter** — Hybrid: embedding similarity (Tier 1) + LLM topic detection (Tier 2).
- **Fact Extractor (NEW)** — ADD-only, single-pass extraction of atomic facts:
  - Heuristic mode (Tier 1): Pattern matching for decisions, lessons, patterns, constraints.
  - LLM mode (Tier 2): Full extraction with entity linking and confidence scoring.
  - Never overwrites existing facts. New facts ADD alongside old ones.
  - Deduplicates via embedding similarity (>0.95 = skip).
- **Knowledge Extractor** — LLM pass producing structured Problem/Solution/Decision records (Tier 2 only).
- **Deduplication Engine** — MinHash + cosine → cluster merging.
- **Compaction Engine** — Weekly synthesis of cluster canonical articles.

### 3. Storage Layer (v3 — Consolidated + Fact Layer)

| Store | Technology | Purpose |
|-------|-----------|---------|
| Primary DB | PostgreSQL 16 + extensions | Facts, chunks, metadata, vectors, FTS, graph, ACLs |
| Object Storage | S3 | Raw immutable sessions, exports |
| Cache + Queue | Redis 7 | Hot results, BullMQ jobs, Bloom filters, rate limits |

**Tables:**
| Table | Records | Purpose |
|-------|---------|---------|
| `memory_facts` | Atomic facts | Precise retrieval, entity queries, temporal chains |
| `chunks` | Conversation segments | Full context retrieval |
| `sessions` | Upload metadata | Processing state, ownership |
| `chunk_clusters` | Dedup groups | Canonical representatives |
| `knowledge_records` | Structured extraction | Problem/Solution/Decision records |
| `capture_events` | Ambient events | Terminal, browser, meeting captures |
| `feedback_events` | Usage signals | Ranking improvement |
| `audit_log` | Access log | Compliance |

**Postgres extensions:**
- `pgvector` (HNSW) — vector ANN on both facts and chunks
- `tsvector` + GIN — weighted full-text search
- `apache-age` — property graph (entity relationships)
- RLS — permission enforcement at query level

### 4. Retrieval API

| Property | Value |
|----------|-------|
| Latency target | < 200 ms p99 |
| Protocol | REST + gRPC |
| Auth | Same OAuth2 tokens as upload |
| Output | Ranked list of chunks with scores, citations, metadata |

### 5. Ranking Engine (v2 — with learned weights and explanation)

```
FinalScore = w1 * SemanticSimilarity
           + w2 * KeywordScore         ← NEW: explicit keyword signal
           + w3 * Freshness
           + w4 * RepositoryMatch
           + w5 * AuthorReputation
           + w6 * UsageCount
           + w7 * Upvotes
           + w8 * AcceptedSolution
           + w9 * ClickThrough
           + w10 * LLMQualityScore
           - penalty_stale * ConfidenceDecay   ← NEW: multiplicative penalty
           - penalty_cluster * ClusterDuplication ← NEW: diversity enforcement
```

**Weight learning:**
- Initial weights set by engineering judgment
- After 10K feedback events: gradient descent on binary relevance (click vs dismiss)
- Periodic re-calibration every 2 weeks using offline evaluation (held-out test set)
- A/B framework: 10% of traffic sees experimental weights, compare MRR@5

**Explanation support (NEW):**
Every result includes a `scoreExplanation` field showing why it ranked high:
```json
{
  "scoreExplanation": {
    "primary_factor": "semantic_similarity (0.92)",
    "boosted_by": ["same_repository", "recently_used_by_3_engineers"],
    "penalized_by": ["aging_content (120 days old)"]
  }
}
```
This builds developer trust and helps debug ranking issues.

### 6. Feedback Loop

Every retrieval event captures:
- Was the chunk shown to the user?
- Was it clicked/expanded?
- Was code copied?
- Did the downstream AI conversation succeed?
- Did the developer give a thumbs-up/down?

This feeds back into the ranking engine (online learning) and triggers periodic
re-evaluation of low-scoring chunks.

---

## Scale Estimates

| Metric | Value |
|--------|-------|
| Engineers | Hundreds |
| Sessions/day | 24,000 |
| Tokens/day (ingestion) | ~350M |
| Chunks/day (after segmentation) | ~240,000 (avg 10 chunks/session) |
| Chunks/year | ~60M |
| Embeddings storage (1536-dim float32) | ~350 GB/year |
| Vector search index (HNSW) | ~50 GB hot (fits in RAM on r6g.2xlarge) |
| Object storage | ~2 TB/year (raw sessions) |
| Postgres total (data + indexes) | ~200 GB year 1, ~800 GB year 3 |

### Cost Optimization (v2 improvements)

| Cost Category | v1 Estimate | v2 Estimate | Savings |
|--------------|------------|------------|---------|
| LLM extraction (all sessions) | $1,050/day | $210/day | 80% (tiered) |
| Embedding (1536d all chunks and queries) | $45/day | $18/day | 60% (single compatible model across providers) |
| Neo4j cluster | $2,000/mo | $0 | 100% (relational graph in Postgres) |
| OpenSearch cluster | $1,500/mo | $0 | 100% (pg tsvector) |
| Postgres (Aurora r6g.xl) | $800/mo | $1,200/mo | -50% (larger, but handles more) |
| Redis | $300/mo | $300/mo | — |
| **Total infra/month** | **~$38K** | **~$13K** | **~65% savings** |

### Embedding Optimization: Matryoshka + Quantization

Use one globally compatible 1536-dimensional embedding space:
- **Cloud**: OpenAI `text-embedding-3-small` with `dimensions: 1536`
- **Self-hosted**: TEI/vLLM with a 1536-dimensional model such as `Alibaba-NLP/gte-Qwen2-1.5B-instruct`
- **Validation**: Reject provider responses that do not contain exactly 1536 finite values

Changing models requires creating a versioned embedding column/index and completing a full re-embedding migration before switching reads.

---

## Permissions Model

```
┌─────────────────────────────────────────┐
│           Access Control List            │
├─────────────────────────────────────────┤
│  organization_id   (required)           │
│  team_ids[]        (optional)           │
│  repository_ids[]  (optional)           │
│  classification    (public|internal|    │
│                     confidential|       │
│                     restricted)         │
│  owner_id          (creator)           │
│  shared_with[]     (explicit grants)   │
└─────────────────────────────────────────┘
```

Enforcement happens at two levels:
1. **Pre-filter** — Metadata filter in vector search query (fast, reduces candidate set).
2. **Post-filter** — Row-level security check on final results (guarantees correctness).

---

## Knowledge Lifecycle

```
Session → Chunks → Clusters → Validated Knowledge → Canonical Articles
   │                                                        │
   │          Confidence decays with code changes           │
   │◄──────────────────────────────────────────────────────►│
   │                                                        │
   └── Revalidation trigger (major refactor, version bump) ─┘
```

- **Fresh** — Created within last 30 days, code unchanged. Full confidence.
- **Aging** — 30-180 days, or minor code changes. Slight confidence decay.
- **Stale** — >180 days, or major refactor in linked repository. Flagged for revalidation.
- **Archived** — Superseded by newer canonical knowledge. Still searchable but ranked low.

---

## Token Optimization Over Time

The core value proposition: as knowledge accumulates, token usage per query decreases.

```
Month 1:   Avg context per query = 12,000 tokens (raw session replay)
Month 3:   Avg context per query =  4,000 tokens (segmented chunks)
Month 6:   Avg context per query =  2,500 tokens (deduplicated + summarized)
Month 12:  Avg context per query =  1,500 tokens (canonical knowledge articles)
Month 24:  Avg context per query =    800 tokens (highly compressed, validated)
```

This is achieved through:
1. Segmentation — Only relevant chunks, not entire conversations.
2. Deduplication — One canonical answer per topic, not 500 copies.
3. Summarization — AI-generated executive summaries replace verbose discussions.
4. Ranking — Only top-K most relevant chunks included (not everything that matches).
5. Compression — Nightly jobs distill clusters into concise canonical articles.

---

## Native Compute Layer (Rust + Go)

CPU-bound operations are delegated to native code for parallel execution:

| Module | Language | Functions | Performance |
|--------|----------|-----------|-------------|
| Retrieval Engine | Rust (napi-rs) | RRF fusion, composite ranking, temporal scoring, token packing | 1000 candidates in 4.8ms |
| Dedup Pipeline | Rust (napi-rs) | MinHash (128 hashes), Jaccard, vector validation, local embeddings | 1000 texts MinHash in <500ms |
| Graph Traversal | Rust (napi-rs) | Spreading activation, connectivity scoring | 1000-node/5000-edge in 3.5ms |
| Compaction | Go (binary) | Parallel cluster synthesis, fact supersession, opinion reinforcement | 15x faster than serial Node.js |

All Rust functions use Rayon for data parallelism across all available CPU cores.
The Go compaction binary uses goroutines with bounded concurrency (configurable workers).

Integration: Node.js handles I/O (DB, HTTP, cache) → calls Rust for compute → returns results.
Fallback: if the native `.node` binary isn't available, the system falls back to pure JS automatically.

---

## Technology Choices (v3 — Multi-Provider)

| Component | Cloud Option | Self-Hosted Option |
|-----------|-------------|-------------------|
| API + Workers | ECS Fargate / GKE / AKS | Any Kubernetes (Helm chart) |
| Embedding | OpenAI text-embedding-3 | Ollama, vLLM, HuggingFace TEI |
| LLM | Claude Sonnet, GPT-4o | Ollama (llama3), vLLM, or disabled |
| Database | Aurora PostgreSQL, Cloud SQL | Patroni cluster (3-node HA, pgvector) |
| Cache + Queue | ElastiCache, Memorystore | Redis cluster (in-cluster) |
| Object Storage | S3, GCS | MinIO, Ceph |
| Secrets | Secrets Manager, Secret Manager | HashiCorp Vault, Sealed Secrets |
| Service Mesh | App Mesh, Anthos | Istio (mTLS, traffic policies) |
| Monitoring | CloudWatch, Grafana Cloud | OpenTelemetry → self-hosted Grafana |
| IaC | Terraform (AWS/GCP modules) | Helm chart (cloud-agnostic) |

All providers are configurable at deploy time via Helm values. No code changes required.

---

## Deployment (v3 — Distributed, Any Infrastructure)

The system is designed for modular, distributed deployment:

```
deploy/
├── helm/synapse/       # Kubernetes Helm chart (primary method)
│   ├── values.yaml              # All configurable knobs
│   └── profiles/
│       ├── on-prem.yaml         # Air-gapped: Patroni + MinIO + TEI + Ollama
│       ├── cloud-aws.yaml       # Aurora + ElastiCache + S3 + OpenAI + Claude
│       ├── cloud-gcp.yaml       # Cloud SQL + Memorystore + GCS
│       └── hybrid.yaml          # On-prem compute + cloud data
├── terraform/                   # Cloud resource provisioning
│   ├── modules/                 # networking, postgres, redis, storage, compute
│   └── environments/            # aws-prod, gcp-prod, on-prem tfvars
├── patroni/                     # Postgres HA for on-prem (3-node sync repl)
└── (infra/cdk/)                 # Legacy AWS-only CDK (deprecated by Terraform)
```

**Deployment profiles:**

| Profile | Postgres | Redis | Storage | Embedding | LLM | Mesh |
|---------|----------|-------|---------|-----------|-----|------|
| on-prem | Patroni (internal) | Internal | MinIO | TEI (GPU/CPU) | Ollama | Istio |
| cloud-aws | Aurora (managed) | ElastiCache | S3 | OpenAI | Claude | Off |
| cloud-gcp | Cloud SQL (managed) | Memorystore | GCS | OpenAI | Claude | Off |
| hybrid | Managed (via VPN) | Internal | S3 | TEI (on-prem GPU) | Claude | Istio |

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full instructions.

---

## Optimizations Summary (v1 → v2)

| Area | v1 Problem | v2 Solution | Impact |
|------|-----------|-------------|--------|
| Storage complexity | 5 separate datastores | 3 stores (Postgres does 4 jobs) | -60% ops overhead |
| LLM cost | All sessions through Sonnet | Tiered: heuristic → Haiku → Sonnet | -80% LLM spend |
| Embedding cost | Mixed incompatible dimensions | Single 1536d space across indexing and queries | Correct pgvector operations |
| Retrieval latency | Sequential: embed → vector → filter → graph → rerank | Parallel within PG + conditional graph | -40ms p99 |
| Dedup overhead | Full cosine on all candidates | Bloom filter pre-check eliminates 80% | -70% dedup compute |
| Permission model | Post-filter (load then discard) | RLS pre-filter (never loads unauthorized rows) | -30% memory, stronger security |
| Graph infrastructure | Standalone Neo4j cluster | Relational graph tables in Postgres | $0 additional infra |
| Search infrastructure | Standalone OpenSearch cluster | Postgres tsvector + GIN | $0 additional infra |
| Segmentation | LLM for all sessions | Embedding similarity (cheap) with LLM promotion | -90% segmentation cost |
| Cache utilization | 1hr flat TTL | Adaptive TTL based on query frequency + staleness | +25% hit rate |

---

## Project Structure

```
synapse/
├── src/                          # Control Plane
│   ├── api/                      #   Capture + Retrieval + Feedback endpoints
│   ├── ingestion/                #   Parser, Segmenter, Fact Extractor, Dedup, Compaction
│   ├── retrieval/                #   5-Signal Engine, Ranking, Permission Filter
│   ├── storage/                  #   Postgres (facts, chunks, sessions), S3, Graph, Cache
│   ├── models/                   #   Zod schemas (MemoryFact, Chunk, Session, CaptureEvent)
│   ├── utils/                    #   Embedding (multi-provider), LLM client, Logger, Governance
│   └── config/                   #   Environment configuration
├── packages/                     # Consumer Layer
│   ├── mcp-server/               #   MCP tools for AI agents (6 tools)
│   ├── cli/                      #   `ctx` terminal tool (search, facts, history, capture)
│   ├── slack-bot/                #   Slack integration (/ctx, @mention, 📌 reaction)
│   └── dashboard/                #   Next.js web UI (search, facts, analytics)
├── deploy/                       # Deployment (any infrastructure)
│   ├── helm/synapse/    #   Kubernetes Helm chart + profiles
│   │   ├── templates/            #     K8s manifests (API, worker, ingress, HPA, mesh)
│   │   └── profiles/             #     on-prem, cloud-aws, cloud-gcp, hybrid
│   ├── terraform/                #   Multi-cloud IaC modules (AWS, GCP, on-prem)
│   └── patroni/                  #   Postgres HA for on-prem (Dockerfile + config)
├── infra/                        # Legacy / Local Dev
│   ├── cdk/                      #   AWS CDK stacks (deprecated by Terraform)
│   └── docker/                   #   Docker Compose for local development
├── docs/
│   ├── DEPLOYMENT.md             #   Deployment guide (on-prem, AWS, GCP, hybrid)
│   ├── IDE-SETUP.md              #   IDE connection guide
│   ├── API.md, GETTING-STARTED.md, RUNBOOK.md
│   └── ADR-001/002/003.md
├── tests/
├── package.json
├── tsconfig.json
├── README.md
└── ARCHITECTURE.md
```

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Retrieval latency (p99) | < 180 ms (warm), < 5 ms (cached) | OpenTelemetry traces |
| Retrieval relevance (MRR@5) | > 0.75 by month 3 | Offline eval on labeled set |
| Token savings vs raw replay | > 70% by month 6 | Compare avg tokens/query over time |
| Developer adoption | > 80% saving sessions by month 3 | Plugin telemetry |
| Knowledge reuse rate | > 40% queries served from existing knowledge | Cache hit + known-answer rate |
| Deduplication ratio | > 60% reduction vs naive | Cluster metrics |
| System availability | 99.99% | ALB + Aurora health |
| Infra cost per engineer | < $25/month | AWS Cost Explorer |
| LLM cost per session | < $0.01 avg (tiered) | Token metering |
| Embedding cost per session | < $0.002 | API billing |

---

## Knowledge Compaction Loop (NEW in v2)

The most important long-term optimization. Over time, the system should produce
fewer, better, shorter knowledge articles — not an ever-growing pile of chunks.

```
Weekly Compaction Job:
  1. Find clusters with >5 members and no canonical summary
  2. Load all member chunks
  3. LLM synthesis: produce ONE concise canonical article (200-400 tokens)
  4. Replace cluster members in search results with the canonical
  5. Members remain searchable but ranked below canonical
  6. Track: did retrieval quality improve? (A/B on compacted vs raw)

Monthly Pruning Job:
  1. Find chunks with 0 usage in 90 days + quality_score < 0.3
  2. Archive (remove from vector index, keep in cold storage)
  3. Find knowledge records that are superseded (newer canonical exists)
  4. Demote to archived confidence

Result: Index size grows sub-linearly even as sessions grow linearly.
```

---

## Automatic Learning Loop (v3 — Hindsight-inspired)

The most important architectural addition in v3: the system forms a **closed learning cycle** where every interaction makes it smarter. Inspired by Hindsight's retain/recall/reflect paradigm, adapted for team-scale organizational memory.

### The Core Principle

Previous versions had a linear flow: capture → extract → store → retrieve. The learning loop closes this into a cycle by adding:
1. **Inline reinforcement** — new facts immediately evaluate against existing opinions
2. **Reflect write-back** — high-confidence reasoning produces new insights stored as facts
3. **Source boosting** — useful memories rank higher in future retrieval

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        LEARNING LOOP                                      │
│                                                                          │
│  ┌──────────┐    ┌───────────┐    ┌───────────────┐    ┌──────────┐    │
│  │  RETAIN  │───▶│  EXTRACT  │───▶│   REINFORCE   │───▶│  OBSERVE │    │
│  │ (capture)│    │(facts+nar)│    │(opinion conf.)│    │(summaries)│    │
│  └──────────┘    └───────────┘    └───────────────┘    └─────┬─────┘    │
│       ▲                                                       │          │
│       │                                                       ▼          │
│  ┌────┴─────┐    ┌───────────┐    ┌───────────────┐    ┌──────────┐    │
│  │WRITE-BACK│◀───│  REFLECT  │◀───│    RECALL     │◀───│  QUERY   │    │
│  │(insights)│    │(LLM reason)│    │(5-signal fuse)│    │          │    │
│  └──────────┘    └───────────┘    └───────────────┘    └──────────┘    │
│       │                │                                                 │
│       │                └── source boost ──▶ ranking weights              │
│       └────────────────────────────────────────────────────────▶ RETAIN  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Three Learning Speeds

| Speed | Trigger | Latency | What Happens |
|-------|---------|---------|------|
| **Inline** | Every fact extraction | +0-3 LLM calls | New facts evaluate against existing opinions (reinforce/weaken/contradict). Observation refresh queued. |
| **On reflect** | Every reflect API call | +500ms-1s | High-confidence answers → extract insights → store as new facts. Source facts get usage boost. |
| **Batch** | Weekly compaction CronJob | Minutes | Full opinion reinforcement sweep. All stale observations refreshed. New entities discovered. |

### Key Components

| Component | File | Role |
|-----------|------|------|
| ReflectEngine | `src/retrieval/reflect.ts` | Retrieves → reasons → writes back insights |
| OpinionReinforcementEngine | `src/ingestion/opinion-reinforcement.ts` | Evaluates evidence against opinions, updates confidence |
| ObservationGenerator | `src/ingestion/observation-generator.ts` | Synthesizes entity summaries from underlying facts |
| LearningLoop | `src/ingestion/learning-loop.ts` | Orchestrator, metrics, health checks |
| Fact Extractor (enhanced) | `src/ingestion/fact-extractor.ts` | Triggers inline reinforcement + observation queue |

### Safety Controls

The loop has built-in controls to prevent runaway growth or contamination:

- **Write-back only on high confidence** — prevents LLM hallucinations from polluting memory
- **Max 3 insights per reflect** — bounds the growth rate
- **Deduplication before write-back** — if an insight is already known (>0.92 cosine similarity), skip it
- **Opinion confidence bounds** — opinions can't exceed 0.95 or fall below 0.1 (never fully certain or fully abandoned)
- **Non-blocking failures** — all learning operations fail open; ingestion and retrieval are never blocked

### Metrics

Monitor via `GET /api/v1/stats/learning`:
- `isLearning` — has the system written any insights in the last 7 days?
- `confidenceTrend` — are opinions getting more or less confident over time?
- `observationCoverage` — what % of frequent entities have pre-computed summaries?

---

## Future Considerations

- **Multi-modal**: Index screenshots, diagrams, terminal recordings (store in S3, summarize with vision models, embed the summary).
- **Cross-org knowledge marketplace**: Opt-in sharing of non-confidential knowledge between orgs.
- **Agent integration**: Instead of returning raw chunks, have an LLM synthesize a direct answer from retrieved context (RAG as a service).
- **Real-time streaming**: WebSocket API for live session ingestion (process as conversation happens, not after).
- **Fine-tuned embeddings**: Train domain-specific embedding model on company's code + conversations for better retrieval.
- **Speculative prefetch**: Predict what context a developer will need next based on file they're editing + recent Git activity.
