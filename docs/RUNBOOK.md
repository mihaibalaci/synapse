# Operational Runbook

## Service Overview

The Recall runs as two ECS Fargate services:
- **API** (internet-facing via ALB) — handles uploads, search, feedback
- **Workers** (internal) — processes ingestion pipeline jobs from Redis queue

Dependencies: Aurora PostgreSQL, Redis (ElastiCache), S3

---

## Common Operations

### Check System Health

```bash
# API health
curl https://api.context-store.internal.company.com/health/ready

# Queue depth (high = workers can't keep up)
redis-cli -u $REDIS_URL LLEN bull:session-processing:wait

# Database connections
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"

# Stuck sessions (processing for >30 min)
psql $DATABASE_URL -c "
  SELECT id, status, processing_attempts, updated_at
  FROM sessions
  WHERE status NOT IN ('indexed', 'failed')
    AND updated_at < NOW() - INTERVAL '30 minutes'
  ORDER BY updated_at;
"
```

### Scale Workers

If queue depth > 5,000 for sustained period:
```bash
aws ecs update-service \
  --cluster recall-prod \
  --service recall-workers-prod \
  --desired-count 15
```

Auto-scaling should handle this, but manual override for spikes.

### Reprocess Failed Sessions

```bash
# Find failed sessions
psql $DATABASE_URL -c "
  SELECT id, last_error, processing_attempts
  FROM sessions
  WHERE status = 'failed' AND processing_attempts < 5
  ORDER BY created_at DESC LIMIT 20;
"

# Re-enqueue (set status back to 'uploaded' and they'll be picked up)
psql $DATABASE_URL -c "
  UPDATE sessions
  SET status = 'uploaded', processing_attempts = processing_attempts
  WHERE status = 'failed'
    AND processing_attempts < 5
    AND last_error NOT LIKE '%validation%';
"
```

### Clear Cache (after major changes)

```bash
# Invalidate all search cache for an org
redis-cli -u $REDIS_URL KEYS "search:org-456:*" | xargs redis-cli -u $REDIS_URL DEL

# Flush all cache (nuclear option)
redis-cli -u $REDIS_URL FLUSHDB
```

---

## Monitoring & Alerts

### Key Metrics

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| API p99 latency | < 200ms | > 500ms | > 2s |
| Queue depth | < 1,000 | > 5,000 | > 20,000 |
| DB connections | < 80% pool | > 90% pool | Pool exhausted |
| Error rate (5xx) | < 0.1% | > 1% | > 5% |
| Disk (Postgres) | < 70% | > 85% | > 95% |

### Alert Response

**High queue depth:**
1. Check worker logs for errors
2. Check if embedding API is rate-limited (OpenAI 429s)
3. Scale workers if healthy but slow
4. If embedding API is down, pause queue (workers will retry on resume)

**High API latency:**
1. Check Postgres: `SELECT * FROM pg_stat_activity WHERE wait_event IS NOT NULL;`
2. Check for lock contention or long-running queries
3. Check vector index health: `SELECT * FROM pg_stat_user_indexes WHERE indexrelname LIKE '%hnsw%';`
4. Check Redis: `redis-cli -u $REDIS_URL INFO memory`

**Database storage growing fast:**
1. Check for un-archived chunks: `SELECT confidence, count(*) FROM chunks GROUP BY confidence;`
2. Run monthly pruning job manually
3. Check if dedup is working: clusters should be forming

---

## Maintenance Jobs

### Weekly: Knowledge Compaction

Synthesizes cluster canonical articles. Reduces token usage over time.
```bash
# Trigger manually (normally runs via cron)
curl -X POST http://localhost:3000/internal/jobs/compaction \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -d '{"organizationId": "org-456"}'
```

### Monthly: Pruning

Archives unused low-quality chunks.
```bash
curl -X POST http://localhost:3000/internal/jobs/pruning \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -d '{"organizationId": "org-456"}'
```

### On-demand: Re-embedding

When embedding model is upgraded, re-embed all chunks in background.
```bash
# Queue re-embedding for all active chunks (runs at low priority)
psql $DATABASE_URL -c "
  UPDATE chunks SET embedding_version = 0
  WHERE embedding_version < 2 AND confidence != 'archived';
"
# Worker picks up chunks with outdated embedding_version
```

---

## Disaster Recovery

### Aurora Failover (automatic)
- Multi-AZ enabled; failover takes <30 seconds
- Application reconnects automatically via Aurora endpoint

### Redis Failure
- BullMQ jobs survive Redis restart (persistence enabled)
- Search cache is ephemeral — no data loss, just cold start latency

### S3 Data Loss (extremely unlikely)
- Versioned bucket with Cross-Region Replication
- If needed: raw sessions can be reprocessed to rebuild all chunks/knowledge

### Full Region Failure
1. Promote Aurora read replica in us-west-2
2. Update DNS to point to DR ALB
3. Deploy workers to DR region
4. S3 CRR ensures raw data is available
5. Redis: restore from latest snapshot (jobs will re-enqueue)

---

## Troubleshooting

### "Search returns no results"
1. Confirm chunks exist: `SELECT count(*) FROM chunks WHERE organization_id = 'org-456';`
2. Confirm embeddings exist: `SELECT count(*) FROM chunks WHERE embedding IS NOT NULL;`
3. Check if search vector is populated: `SELECT id FROM chunks WHERE search_vector IS NULL LIMIT 5;`
4. Test vector search directly: run a raw pgvector query

### "Sessions stuck in 'parsing' status"
1. Check worker logs for errors
2. Check if S3 object exists at `raw_storage_key`
3. Check if session JSON is valid (malformed upload)
4. Manually retry: update status to 'uploaded'

### "High embedding costs"
1. Check `EMBEDDING_PROVIDER` — should be `text-embedding-3-small` for indexing
2. Check batch sizes (should be 100 per API call)
3. Check for re-embedding loops (embedding_version constantly resetting)

### "Postgres slow queries"
```sql
-- Find slow queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state != 'idle' AND now() - pg_stat_activity.query_start > interval '5 seconds';

-- Check index usage
SELECT indexrelname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC LIMIT 20;

-- Check table bloat
SELECT relname, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```
