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

## 6. Not implemented

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
- **Compaction and pruning are partial.** `runMonthlyPruning` and
  `getCompactionMetrics` return stubs, and there are no `/internal/jobs/*`
  endpoints.
