# Operational Runbook

## Service Overview

Recall runs as two Kubernetes Deployments (Helm chart `deploy/helm/recall`):

- **API** — uploads, retrieval, facts, feedback. Behind an Ingress.
- **Worker** — pipeline, fact/knowledge/dedup/graph enrichment, search indexing,
  and the transactional outbox dispatcher. No inbound traffic; health only.

Dependencies: PostgreSQL 16 + pgvector, Redis (`noeviction`), S3-compatible
object storage. There is no OpenSearch and no Neo4j.

> **Observability gap.** There is no `/metrics` endpoint and no tracing yet, so
> every check below is manual. Alert thresholds in this document are targets,
> not implemented alerts.

---

## Common Operations

### Check health

```bash
# API readiness (503 when any dependency is down)
kubectl exec deploy/recall-api -- wget -qO- http://127.0.0.1:3000/health/ready

# Worker liveness — heartbeatAgeMs proves the dispatch loop is running
kubectl exec deploy/recall-worker -- wget -qO- http://127.0.0.1:3001/health
kubectl exec deploy/recall-worker -- wget -qO- http://127.0.0.1:3001/health/ready

# Queue depth per queue
redis-cli -u "$REDIS_URL" LLEN bull:session-processing:wait
redis-cli -u "$REDIS_URL" LLEN bull:chunk-facts:wait

# Active database connections
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"
```

### Find stalled work

Searchability and enrichment are tracked independently; `status` is legacy.

```bash
psql "$DATABASE_URL" -c "
  SELECT id, searchable_status, enrichment_status, processing_attempts, last_error
  FROM sessions
  WHERE searchable_status NOT IN ('searchable','blocked')
    AND updated_at < NOW() - INTERVAL '30 minutes'
  ORDER BY updated_at LIMIT 50;"
```

### Terminal failures (not alerted — check deliberately)

Outbox events stop retrying after 10 attempts, and per-action rows can end
`failed`. Nothing drains these automatically, so enrichment silently stays
incomplete until someone looks.

```bash
# Outbox events that gave up
psql "$DATABASE_URL" -c "
  SELECT event_type, count(*), max(updated_at) AS latest
  FROM outbox_events WHERE status = 'failed' GROUP BY event_type;"

# Chunk actions that gave up
psql "$DATABASE_URL" -c "
  SELECT action, count(*) FROM chunk_processing_status
  WHERE status = 'failed' GROUP BY action;"
```

To retry after fixing the root cause, return events to `pending`. This is safe:
publication is idempotent via `deduplication_key`, and workers claim per action.

```bash
psql "$DATABASE_URL" -c "
  UPDATE outbox_events
  SET status = 'pending', available_at = NOW(), attempts = 0, updated_at = NOW()
  WHERE status = 'failed' AND event_type = 'chunk.facts';"
```

### Reprocess failed sessions

Session identity is deterministic (UUIDv5 over org/developer/client id) and
chunk/fact ids are derived, so replay is idempotent rather than duplicating.

```bash
psql "$DATABASE_URL" -c "
  UPDATE sessions SET searchable_status = 'pending', last_error = NULL, updated_at = NOW()
  WHERE searchable_status = 'failed' AND processing_attempts < 5;"
```

Then re-emit the outbox event for those sessions (`event_type='session.process'`)
as shown above.

### Scale workers

```bash
kubectl scale deployment/recall-worker --replicas=15
```

HPA handles steady state. By default it scales on CPU; set
`worker.autoscaling.queueMetric.enabled=true` with a queue-depth external metric
for load-proportional scaling.

### Clear cache

Cache keys are SHA-256 digests over the full request and ACL context, so they
cannot be pattern-matched by organization. Invalidation uses `SCAN` + `UNLINK`
inside the application.

```bash
# Prefer the application path. If you must intervene manually, use SCAN —
# never KEYS (blocks the server) and never FLUSHDB (destroys queue state).
redis-cli -u "$REDIS_URL" --scan --pattern 'search:*' | \
  xargs -r -n 500 redis-cli -u "$REDIS_URL" UNLINK
```

> `FLUSHDB` would delete BullMQ queues and in-flight jobs. Do not run it.

---

## Monitoring targets

| Signal | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| API p99 latency | < 200ms | > 500ms | > 2s |
| Queue depth | < 1,000 | > 5,000 | > 20,000 |
| Redis memory used | < 60% | > 75% | > 90% |
| DB connections | < 80% pool | > 90% pool | Pool exhausted |
| 5xx rate | < 0.1% | > 1% | > 5% |
| Worker `heartbeatAgeMs` | < 5s | > 30s | > 60s (probe restarts pod) |
| Failed outbox events | 0 | any sustained | growing |

**Redis memory is a hard outage risk.** With `noeviction`, reaching `maxmemory`
makes writes fail rather than evicting. There is no ingestion admission control
yet, so a sustained upload burst can cause this. Watch memory, and scale Redis
before it saturates.

### Alert response

**High queue depth:** check worker logs; check whether the embedding provider is
rate-limiting (429s); scale workers; verify `heartbeatAgeMs` is fresh.

**High API latency:**
```sql
SELECT pid, now() - query_start AS duration, query FROM pg_stat_activity
WHERE state <> 'idle' AND now() - query_start > interval '5 seconds';
SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
WHERE indexrelname LIKE '%hnsw%';
```

**Worker unhealthy:** a stale heartbeat means the event loop is blocked or
PostgreSQL is unreachable. Kubernetes restarts the pod; confirm the database is
healthy before assuming a code hang.

---

## Maintenance

### Re-embedding after a model or version change

```bash
EMBEDDING_VERSION=2 BACKFILL_BATCH_SIZE=50 \
  MIGRATION_DATABASE_URL="$DATABASE_URL" npm run backfill:embeddings
```

Resumable, advisory-locked, and batched per transaction. Re-running continues
where it stopped. Or run the Helm Job with
`embeddingBackfill.enabled=true` and `embeddingBackfill.targetVersion=2`.

There is no worker that picks up chunks by `embedding_version` on its own; the
backfill is the mechanism.

### Compaction and pruning

`CompactionEngine` exists but `runMonthlyPruning` and `getCompactionMetrics` are
not implemented, and there are **no** internal HTTP job endpoints. Do not expect
`/internal/jobs/*` to exist. Weekly compaction is invocable only in-process.

---

## Disaster recovery

Current, honest state:

| Scenario | Status |
|----------|--------|
| Managed PostgreSQL failover (AWS/GCP) | Provider-automatic; app reconnects via pool. Not drilled. |
| Patroni failover (on-prem) | Configured with strict synchronous replication. **Never exercised.** |
| PostgreSQL restore | pgBackRest configured for WAL archive/restore, but **no repository is set by default** and no restore has been performed. RPO/RTO are undefined until drilled. |
| Redis loss | Queue state is lost unless persistence/snapshots are configured. Raw sessions in object storage remain, so work can be re-driven from the outbox. Cache loss is harmless. |
| Object storage loss | Bucket is versioned and private. Cross-region replication is **not** provisioned. |
| Region failure | No DR region, no replica promotion, and no DNS failover are provisioned. |

Because raw session payloads are immutable and stored with hash verification,
chunks, facts, and knowledge can be rebuilt by replaying sessions. That is the
real recovery story; treat everything above as unproven until drilled.

---

## Troubleshooting

### Search returns no results
```sql
SELECT count(*) FROM chunks WHERE organization_id = 'org-id';
SELECT count(*) FROM chunks WHERE embedding IS NULL;
SELECT count(*) FROM search_index_entries WHERE organization_id = 'org-id' AND is_searchable;
SELECT searchable_status, count(*) FROM chunks GROUP BY searchable_status;
```
`blocked` means governance classified the content as restricted: it is retained
redacted and owner-only, without embeddings, indexing, or enrichment. That is
intended, not a failure.

Also confirm the caller's JWT claims grant access. RLS plus application ACL
filtering will correctly return nothing for chunks the identity cannot see.

### Sessions stuck before `searchable`
1. Check worker logs and `sessions.last_error`.
2. Confirm the object exists at `raw_storage_key`.
3. Check `outbox_events` for a `failed` `session.process` event.
4. Check `chunk_processing_status` for a stuck `processing` row; leases are
   reclaimed after 20 seconds.

### High embedding cost
Confirm `EMBEDDING_MODEL`, batch sizes (100 for OpenAI, 32 otherwise), and that
no backfill is looping. `EMBEDDING_DIMENSIONS` must be 1536.

### PostgreSQL slow or bloated
```sql
SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables
WHERE n_dead_tup > 10000 ORDER BY n_dead_tup DESC;
```
