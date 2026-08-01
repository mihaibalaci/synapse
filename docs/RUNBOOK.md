# Operational Runbook

## Health and state

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/health/ready
systemctl status synapse-api synapse-worker
journalctl -u synapse-api -u synapse-worker --since '30 minutes ago'
redis-cli -u "$REDIS_URL" LLEN synapse:session
redis-cli -u "$REDIS_URL" LLEN synapse:dead
```

`/health` is process liveness. `/health/ready` checks PostgreSQL, Redis, and object storage. The worker has no HTTP probe; inspect its process/logs and queue progress.

## Sessions not becoming searchable

```sql
SELECT id, status, searchable_status, enrichment_status, raw_storage_key, updated_at
FROM sessions
WHERE searchable_status <> 'searchable'
ORDER BY updated_at
LIMIT 100;
```

1. Confirm `synapse-worker` is active.
2. Check `LLEN synapse:session` and whether depth decreases.
3. Inspect `synapse:dead`; entries include job, error, attempts, and parked time.
4. Confirm the raw object exists with `synapse verify-storage`.
5. Check embedding provider logs. Embedding failure alone should not block keyword indexing.

The reaper only runs recovery when the session queue is empty. During a backlog, an old pending session can be waiting rather than stranded.

## Dead-letter replay

There is no automated dead-letter replay command. Inspect and fix the cause first. For a failed session with a valid raw object, reset status and enqueue a JSON job:

```sql
UPDATE sessions SET status='processing', searchable_status='pending', updated_at=NOW()
WHERE id='<session-uuid>';
```

```bash
redis-cli -u "$REDIS_URL" LPUSH synapse:session \
  '{"type":"session","sessionId":"<session-uuid>","organizationId":"<org>","attempt":0}'
```

Do not replay malformed or unauthorized payloads blindly.

## Cache

Search cache keys are `search:*`, expire after five minutes, and do not refresh on read. Expiration never deletes durable sessions/chunks/raw objects.

```bash
redis-cli -u "$REDIS_URL" --scan --pattern 'search:*' | \
  xargs -r -n 500 redis-cli -u "$REDIS_URL" UNLINK
```

Never use `FLUSHDB`: it also deletes work and dead-letter queues. There is no write invalidation or prewarmer.

## Storage consistency

```bash
set -a; source /etc/synapse/synapse.env; set +a
/usr/local/bin/synapse verify-storage
```

A nonzero exit means a session points to a missing raw object. Restore from object-store backup; derived chunks cannot recreate the exact conversation.

## Migrations and embedding backfill

```bash
set -a; source /etc/synapse/synapse.env; set +a
/usr/local/bin/synapse migrate
/usr/local/bin/synapse embed-backfill
```

Back up first. The 768-dimension migration clears incompatible vectors. Backfill currently processes chunks only; fact vectors may remain null and require reprocessing or a future fact backfill.

## Metrics interpretation

`GET /api/v1/stats/metrics` requires JWT auth. Redis cache entries/expiry/evictions and object-store counters reflect shared systems. Retrieval latency/errors and several ingestion counters are process-local and reset or are reseeded on restart. Do not sum replicas without an external metrics system.

Watch:

- Redis memory, `synapse:session`, and `synapse:dead` growth.
- PostgreSQL pool saturation and slow queries.
- S3 PUT/GET errors and `verify-storage` drift.
- Worker throughput versus capture rate.
- Embedding provider latency/timeouts.

## Logs

All Go logs are structured JSON. Useful fields include `sessionId`, `chunkId`, `type`, `attempt`, `durationMs`, and `error`. Preserve request IDs from the API proxy. Secrets must never be added to log fields.

## Backup and recovery

- PostgreSQL: provider snapshots or tested pgBackRest/PITR.
- S3/MinIO: versioning plus replicated/independent backup.
- Redis: persistence/snapshot if queue RPO matters.
- `/etc/synapse`: encrypted configuration backup.

A Redis loss can be recovered gradually from unfinished PostgreSQL sessions and raw objects; a raw-object loss cannot. Recovery objectives are undefined until restore drills are run.

## Known operational gaps

No queue admission control, automatic dead-letter replay, Prometheus/OpenTelemetry export, alerting, fact-embedding backfill, real compaction, or automatic admin JWT rotation exists. Treat these as backlog, not hidden automation.
