# Data Flow

How data actually moves through Recall. Everything here reflects the running
code, not intent. Where a step is unimplemented it is marked.

Related: [ARCHITECTURE.md](../ARCHITECTURE.md) for design rationale,
[DEPLOYMENT.md](DEPLOYMENT.md) for topology, [RUNBOOK.md](RUNBOOK.md) for
operations.

---

## 1. Node topology

```mermaid
flowchart TB
    subgraph clients["Clients"]
        IDE["IDE plugin / MCP server"]
        CLI["CLI"]
        SLACK["Slack bot"]
        DASH["Dashboard"]
    end

    ING["Ingress<br/>nginx / ALB / GCE<br/>TLS termination"]
    API["API pods (3-20)<br/>dist/index.js<br/>Fastify"]
    WRK["Worker pods (3-30)<br/>dist/worker-entry.js<br/>BullMQ consumers"]
    MIG["Migration Job<br/>pre-install / pre-upgrade"]

    PG[("PostgreSQL 16 + pgvector<br/>vectors, FTS, graph,<br/>outbox, RLS")]
    RD[("Redis<br/>BullMQ + cache<br/>noeviction")]
    OS[("Object storage<br/>immutable raw sessions")]
    EMB["Embedding server<br/>TEI / Ollama / OpenAI"]
    LLM["LLM<br/>Claude / Ollama / none"]

    clients -->|HTTPS + Bearer JWT| ING --> API
    API --> PG
    API --> RD
    API --> OS
    API --> EMB
    WRK --> PG
    WRK --> RD
    WRK --> OS
    WRK --> EMB
    WRK --> LLM
    MIG --> PG
```

Workers accept no inbound application traffic. They expose only
`:3001/health` and `:3001/health/ready` for probes. The migration Job runs
with a distinct, more privileged database credential than the runtime pods.

---

## 2. Write path: session upload

Synchronous portion ends at the 202. Everything after is durable and
asynchronous.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API pod
    participant O as Object storage
    participant P as PostgreSQL
    participant R as Redis / BullMQ
    participant W as Worker pod

    C->>A: POST /api/v1/sessions (Bearer JWT)
    A->>A: verify JWT, validate claims, rate limit
    A->>P: idempotency lookup (org, developer, client_id)
    Note over A,P: existing session short-circuits to 202
    A->>A: sessionId = uuidv5(org:developer:clientId)
    A->>O: PUT raw payload, IfNoneMatch '*'
    Note over A,O: retry reuses object only if SHA-256 matches
    A->>P: BEGIN<br/>INSERT sessions<br/>INSERT outbox_events(session.process)<br/>COMMIT
    A-->>C: 202 Accepted + trackingUrl

    loop every 1s
        W->>P: claim outbox batch (FOR UPDATE SKIP LOCKED)
        W->>R: publish with deterministic jobId
        W->>P: mark published
    end

    R->>W: session.process job
    W->>O: GET raw payload
    W->>W: parse, segment, deterministic chunk ids
    W->>W: governance scan / redact / classify
    W->>EMB: embed searchable chunks (1536-d)
    W->>P: BEGIN<br/>INSERT chunks<br/>INSERT chunk_processing_status per action<br/>INSERT outbox_events per action<br/>UPDATE session projection<br/>COMMIT

    par per-action enrichment
        W->>P: index -> search_index_entries
        W->>P: facts -> memory_facts
        W->>P: knowledge -> knowledge_records
        W->>P: deduplicate -> chunk_clusters
        W->>P: graph -> graph_nodes / graph_edges / chunk_entities
    end

    W->>P: lock chunk, mark action terminal, reconcile projection
    C->>A: GET /api/v1/sessions/:id/status (poll)
    A-->>C: searchableStatus + enrichmentStatus
```

Key invariants:

- **Nothing is enqueued in the request path.** Database state and queue intent
  commit in one transaction, so a Redis outage cannot lose accepted work.
- **Raw sessions are immutable.** They are the rebuild source for every derived
  artifact.
- **Identity is deterministic.** Session, chunk, fact, and knowledge ids are
  UUIDv5, so replay is idempotent rather than duplicating.
- **Governance is a hard gate.** Restricted chunks are stored redacted and
  owner-only with no embedding, no indexing, and no enrichment.
- **Every status transition locks the chunk row first.** Without it, concurrent
  action completions each fail to observe the others and the projection sticks
  at `processing` forever. Covered by
  `tests/integration/processing-status-concurrency.test.ts`.

---

## 3. Read path: search

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API pod
    participant R as Redis
    participant E as Embedding provider
    participant P as PostgreSQL

    C->>A: POST /api/v1/search (Bearer JWT)
    A->>A: CORS, jwtVerify(iss/aud/alg), claim schema
    A->>A: authContext -> AsyncLocalStorage, rate limit by userId
    A->>A: merge body with verified claims (body identity ignored)
    A->>R: GET search:<org>:<user>:<sha256(request+ACL)>
    alt cache hit
        R-->>A: cached response
        A-->>C: 200 (measured p95 ~13ms)
    else cache miss
        A->>A: extract query entities
        A->>E: embed query (in-process LRU first)
        par three signals, separate pooled connections
            A->>P: pgvector HNSW ANN, top 50
            A->>P: FTS ts_rank + pg_trgm, joined to search_index_entries
            A->>P: memory_facts by entity overlap
        end
        Note over A,P: each statement runs in its own transaction<br/>with SET LOCAL app.* so RLS applies
        A->>A: temporal scoring (metadata only)
        opt top semantic < 0.85 and repository context
            A->>P: recursive graph expansion
        end
        A->>P: batched hydration WHERE id = ANY(...)
        A->>A: RRF fusion, ACL filter, composite ranking, top-K
        A->>R: SETEX response, ZINCRBY popular query
        A-->>C: 200 (measured p95 113ms @ 16 concurrent)
    end
```

Two independent authorization layers apply: PostgreSQL row-level security using
the transaction-local claims, and an application ACL filter that also drops
`restricted` classifications. Cache keys hash the full request **including** ACL
context, so two users with different permissions can never share an entry.

### Measured retrieval performance

221-chunk corpus, single API process, cache cleared between runs:

| Concurrency | p50 | p95 | p99 | rps |
|---|---|---|---|---|
| 1 | 10.2ms | 13.1ms | 17.7ms | 95 |
| 8 | 40.0ms | 61.1ms | 76.1ms | 195 |
| 16 | 80.4ms | 113.1ms | 138.1ms | 198 |
| warm cache | 8.1ms | 12.8ms | — | ~1830 |

Throughput saturates near 198 rps per process. Beyond that, added latency is
event-loop queueing, so capacity comes from replicas. Reproduce with
`npm run load:retrieval`.

Retrieval deliberately **omits the embedding column** from its projections. A
1536-dimension vector is ~15KB of text per row and roughly 120 candidates are
hydrated per query; parsing them cost ~14ms of CPU per request and nothing
downstream reads them, since similarity is computed in SQL.

---

## 4. Status model

Searchability and enrichment advance independently, so content becomes
retrievable without waiting for deep processing.

```mermaid
stateDiagram-v2
    [*] --> uploaded
    uploaded --> parsing
    parsing --> segmenting
    segmenting --> pending: chunks + actions committed

    state "searchable_status" as S {
        pending --> processing: index action claimed
        processing --> searchable: index completed
        processing --> blocked: governance restricted
        processing --> failed: index failed
    }

    state "enrichment_status" as E {
        e_pending: pending
        e_pending --> e_processing: action claimed
        e_processing --> complete: all actions completed
        e_processing --> partial: some completed, some failed
        e_processing --> e_failed: all failed
        e_pending --> not_required: fast tier
    }
```

`blocked` is a success state for governance, not an error: the chunk is retained
redacted and owner-only.

---

## 5. Failure and recovery paths

```mermaid
flowchart LR
    subgraph detect["Detection"]
        AR["API /health/ready<br/>checks PG, Redis, bucket, queue"]
        WL["Worker /health<br/>dispatch heartbeat freshness"]
        WR["Worker /health/ready<br/>dependency checks"]
    end

    subgraph recover["Recovery"]
        OB["Outbox retry<br/>capped backoff, terminal at 10"]
        BQ["BullMQ retry<br/>3 attempts, exponential"]
        LS["Stale action lease<br/>reclaimed after 20s"]
        SW["Drift sweeper<br/>every 30s, repairs stuck projections"]
        RB["Replay from raw sessions<br/>rebuild all derived data"]
    end

    AR -->|503| K8S["Kubernetes stops routing"]
    WL --> |stale| RESTART["Pod restarted"]
    WR --> |503| K8S
    OB --> BQ --> LS --> SW
    SW --> RB
```

Verified behaviour: stopping PostgreSQL leaves worker liveness healthy while
readiness returns 503, and the worker recovers without a restart. A dependency
outage must never escalate to process death, which is why the dispatch tick
never rejects.

---

## 5. Knowledge compaction lifecycle

Runs weekly as a CronJob, separate from the ingestion workers.

```mermaid
flowchart TB
    CRON["CronJob (weekly)"] --> LOCK["pg_try_advisory_lock(org)"]
    LOCK -->|acquired| SYNTH
    LOCK -->|busy| SKIP["skip org"]

    subgraph SYNTH["Phase 1: Cluster Synthesis"]
        direction LR
        LOAD["Load clusters with ≥ 5 members"]
        HASH["Compute source hash"]
        IDEM{"synth:hash matches?"}
        LLM["LLM: synthesize canonical article"]
        REWRITE["Rewrite canonical chunk<br/>Re-embed 1536d<br/>Demote siblings"]
        LOAD --> HASH --> IDEM
        IDEM -->|yes| SKIP2["skip cluster"]
        IDEM -->|no| LLM --> REWRITE
    end

    SYNTH --> SUPER

    subgraph SUPER["Phase 2: Fact Supersession"]
        direction LR
        RECENT["Recent facts (7 days)"]
        SIM["Find similar older facts<br/>(embedding ≥ 0.88 + entity overlap ≥ 0.5)"]
        CONTRA["LLM: CONTRADICTS or COMPATIBLE?"]
        MARK["markSuperseded(old, new)<br/>sets temporal_valid_until"]
        RECENT --> SIM --> CONTRA -->|contradicts| MARK
    end

    SUPER --> PRUNE

    subgraph PRUNE["Phase 3: Stale Archival"]
        direction LR
        QUERY["Chunks: usageCount=0, age > 90d,<br/>qualityScore < 0.3, not canonical"]
        ARCHIVE["confidence = 'archived'<br/>excluded from search ranking"]
        QUERY --> ARCHIVE
    end

    PRUNE --> UNLOCK["pg_advisory_unlock(org)"]
    UNLOCK --> SUMMARY["Log JSON summary"]
```

Behaviour with no LLM configured (`LLM_PROVIDER=local-none`): synthesis uses
quality-based re-canonicalization only (no LLM call, picks highest-scored
member), and fact supersession is skipped entirely. Pruning still runs.

Idempotency: each synthesized canonical stores `linkedVersion = synth:<hash>`
where the hash covers all member chunk ids. Re-running against the same cluster
composition is a no-op. Fact supersession is append-only: the old fact stays,
it just gets a `temporal_valid_until` and a forward pointer.

Token compression over time:
- Deduplication (real-time) — prevents growth of identical chunks
- Synthesis (weekly) — replaces N member chunks with 1 canonical article
- Archival (weekly) — removes unused low-quality chunks from the ranking pool
- Result: retrieval gradually returns fewer, better results for the same query

---

## 6. Learning Loop data flow

The learning loop creates a closed cycle where the system gets smarter with
every interaction. Three mechanisms operate at different time scales.

### 6.1 Inline learning (at ingestion time)

Triggered on every fact extraction. New facts immediately evaluate against
existing opinions and schedule observation refresh.

```mermaid
sequenceDiagram
    autonumber
    participant W as Worker pod
    participant FE as Fact Extractor
    participant FR as Fact Repository
    participant OR as Opinion Reinforcement
    participant OQ as Observation Queue

    W->>FE: extract(chunk)
    FE->>FE: LLM extract OR heuristic fallback
    FE->>FR: createBatch(newFacts)

    loop for each new fact with entities
        FE->>OR: evaluateNewFact(fact, orgId)
        OR->>FR: findByType('opinion', orgId)
        OR->>OR: filter by entity overlap > 0.3
        opt overlapping opinions found (max 3)
            OR->>OR: LLM assess: REINFORCE / WEAKEN / CONTRADICT / NEUTRAL
            OR->>FR: updateOpinionConfidence(opinionId, newConfidence)
        end
    end

    loop for each entity in extracted facts
        FE->>OQ: enqueue observation refresh (30s delay)
    end
```

Latency impact: opinion reinforcement adds 0-3 LLM calls per chunk
(only for facts with entities overlapping existing opinions). These are
non-blocking — failures do not affect ingestion.

### 6.2 Reflect learning (at query time)

Triggered on every `POST /api/v1/reflect` call. High-confidence answers
generate new knowledge that feeds back into the memory graph.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API pod
    participant RE as Retrieval Engine
    participant RF as Reflect Engine
    participant LLM as LLM provider
    participant FR as Fact Repository
    participant OR as Observation Repo

    C->>A: POST /api/v1/reflect
    A->>RE: search(query, hybrid, 5-signal)
    RE-->>RF: ranked results + facts

    RF->>LLM: synthesize answer from memories
    LLM-->>RF: answer + confidence + reasoning

    alt confidence = high AND writeBack = true
        RF->>LLM: extract insights from answer
        LLM-->>RF: [insight1, insight2, ...]
        RF->>RF: embed insights, deduplicate
        RF->>FR: createBatch(newInsightFacts)
        Note over RF,FR: Learning loop closed:<br/>reflect → new facts → future retrieval
    end

    alt confidence = high OR medium
        RF->>FR: incrementUsage(sourceFactIds)
        Note over RF,FR: Source boosting:<br/>useful facts rank higher next time
    end

    opt entityFocus provided
        RF->>LLM: generate/refresh observation
        RF->>OR: upsert(observation)
    end

    RF-->>C: answer + sources + learnedInsights + observation
```

Latency budget:
- Retrieval: ~100ms
- Answer synthesis: ~1-3s (LLM-bound)
- Insight extraction (parallel with response): ~500ms-1s
- Total: 1.5-4s typical

### 6.3 Batch learning (weekly compaction)

Runs as a CronJob. Performs full-sweep opinion reinforcement, observation
refresh, and discovery of new entities needing observations.

```mermaid
flowchart TB
    CRON["CronJob (weekly)"] --> P1

    subgraph P1["Phase 1: Cluster Synthesis"]
        SYNTH["Synthesize canonical articles from clusters"]
    end

    P1 --> P2

    subgraph P2["Phase 2: Fact Supersession"]
        CONTRA["Detect contradicting facts, mark superseded"]
    end

    P2 --> P3

    subgraph P3["Phase 3: Opinion Reinforcement"]
        direction LR
        LOAD_OP["Load all current opinions"]
        LOAD_EV["Load recent non-opinion facts (7d)"]
        ASSESS["LLM assess: reinforce/weaken/contradict"]
        UPDATE["Update opinion confidence scores"]
        LOAD_OP --> LOAD_EV --> ASSESS --> UPDATE
    end

    P3 --> P4

    subgraph P4["Phase 4: Stale Pruning"]
        ARCHIVE["Archive unused, low-quality chunks"]
    end

    P4 --> P5

    subgraph P5["Phase 5: Observation Refresh"]
        direction LR
        STALE["Refresh stale observations (>7d old)"]
        DISCOVER["Discover entities with ≥3 facts, no observation"]
        GENERATE["LLM synthesize entity summaries"]
        STALE --> GENERATE
        DISCOVER --> GENERATE
    end

    P5 --> DONE["Log metrics, exit"]
```

### 6.4 Learning loop metrics

The system tracks whether it is actively learning via
`GET /api/v1/stats/learning`:

| Indicator | Healthy Sign | Unhealthy Sign |
|-----------|-------------|----------------|
| `isLearning` | Insights written in last 7 days | No insights generated |
| `confidenceTrend` | Average opinion confidence > 0.5 | Confidence trending to 0 |
| `observationCoverage` | Growing % of entities have observations | Stalled at 0% |
| `factsExtracted` | Growing steadily | Dropped to zero |

### 6.5 The complete cycle (conceptual)

```mermaid
flowchart LR
    RETAIN["RETAIN<br/>(capture sessions)"]
    EXTRACT["EXTRACT<br/>(facts + narratives)"]
    REINFORCE["REINFORCE<br/>(opinion confidence)"]
    OBSERVE["OBSERVE<br/>(entity summaries)"]
    RECALL["RECALL<br/>(5-signal retrieval)"]
    REFLECT["REFLECT<br/>(LLM reasoning)"]
    WRITEBACK["WRITE-BACK<br/>(new insights)"]

    RETAIN --> EXTRACT --> REINFORCE --> OBSERVE
    OBSERVE --> RECALL --> REFLECT --> WRITEBACK
    WRITEBACK --> RETAIN
    REFLECT -->|source boost| RECALL
```

Each node feeds into the next. The write-back arrow from REFLECT to RETAIN is
what closes the loop — without it, the system only retrieves and never learns.

---

## 7. Not implemented

Do not infer these from the diagrams:

- **No metrics or tracing.** No `/metrics` endpoint, no OpenTelemetry SDK.
  `OTEL_EXPORTER_OTLP_ENDPOINT` is injected but unread. Every operational check
  in the runbook is manual.
- **No alerting on terminal failures.** Outbox events go `failed` after 10
  attempts and action rows can end `failed`; the sweeper repairs stuck
  projections but nothing pages anyone about genuine failures.
- **No ingestion backpressure.** Uploads are accepted 202 with no per-tenant
  quota or queue-depth admission control. With `noeviction`, a sustained burst
  exhausts Redis memory and writes begin to fail. This has been reproduced:
  a load test filled a 256MB instance and produced 6,168 silent cache-write
  failures.
- **No cross-region DR.** No replica promotion, no bucket replication, no DNS
  failover. Recovery relies on replaying immutable raw sessions.
- **Compaction metrics stub.** `getCompactionMetrics` returns zeros. There are
  no `/internal/jobs/*` HTTP endpoints; compaction runs only as a CronJob.
  Observation is via Job pod logs (`JSON.stringify` summary at exit).
