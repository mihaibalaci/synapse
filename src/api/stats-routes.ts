/**
 * Real-time stats endpoint for the dashboard.
 *
 * Returns live counts from PostgreSQL and Redis so the dashboard can show
 * actual system state rather than hardcoded placeholders.
 */

import { type FastifyInstance } from 'fastify';
import { query } from '../storage/database.js';
import { getRedis } from '../storage/cache.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'stats-api' });

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/stats', async (request) => {
    const orgId = request.authContext?.organizationId;
    if (!orgId) return { error: 'missing organization context' };

    const [counts, processing, queueDepth, recentActivity] = await Promise.all([
      getCounts(orgId),
      getProcessingState(orgId),
      getQueueDepths(),
      getRecentActivity(orgId),
    ]);

    return {
      organization: orgId,
      timestamp: new Date().toISOString(),
      counts,
      processing,
      queues: queueDepth,
      recentActivity,
    };
  });

  // Learning loop metrics and health
  app.get('/api/v1/stats/learning', async (request) => {
    const orgId = request.authContext?.organizationId;
    if (!orgId) return { error: 'missing organization context' };

    const { LearningLoop } = await import('../ingestion/learning-loop.js');
    const loop = new LearningLoop();

    const [metrics, health] = await Promise.all([
      loop.getMetrics(orgId, 7),
      loop.isHealthy(orgId),
    ]);

    return { metrics, health, config: loop.getConfig() };
  });

  // Manual trigger for learning cycle (admin/debug)
  app.post('/api/v1/stats/learning/trigger', async (request) => {
    const orgId = request.authContext?.organizationId;
    if (!orgId) return { error: 'missing organization context' };

    const { LearningLoop } = await import('../ingestion/learning-loop.js');
    const loop = new LearningLoop();
    const result = await loop.triggerFullCycle(orgId);

    return { triggered: true, result };
  });

  logger.info('Stats API routes registered');
}

async function getCounts(orgId: string) {
  const result = await query<{
    sessions: string;
    chunks: string;
    searchable_chunks: string;
    facts: string;
    clusters: string;
    knowledge_records: string;
    graph_nodes: string;
  }>(`
    SELECT
      (SELECT count(*)::text FROM sessions WHERE organization_id = $1) AS sessions,
      (SELECT count(*)::text FROM chunks WHERE organization_id = $1) AS chunks,
      (SELECT count(*)::text FROM search_index_entries WHERE organization_id = $1 AND is_searchable) AS searchable_chunks,
      (SELECT count(*)::text FROM memory_facts WHERE organization_id = $1) AS facts,
      (SELECT count(*)::text FROM chunk_clusters WHERE organization_id = $1) AS clusters,
      (SELECT count(*)::text FROM knowledge_records WHERE organization_id = $1) AS knowledge_records,
      (SELECT count(*)::text FROM graph_nodes WHERE organization_id = $1) AS graph_nodes
  `, [orgId]);

  const row = result.rows[0];
  return {
    sessions: Number(row?.sessions ?? 0),
    chunks: Number(row?.chunks ?? 0),
    searchableChunks: Number(row?.searchable_chunks ?? 0),
    facts: Number(row?.facts ?? 0),
    clusters: Number(row?.clusters ?? 0),
    knowledgeRecords: Number(row?.knowledge_records ?? 0),
    graphNodes: Number(row?.graph_nodes ?? 0),
  };
}

async function getProcessingState(orgId: string) {
  const result = await query<{
    status: string;
    count: string;
  }>(`
    SELECT searchable_status AS status, count(*)::text AS count
    FROM sessions WHERE organization_id = $1
    GROUP BY searchable_status
  `, [orgId]);

  const byStatus: Record<string, number> = {};
  for (const row of result.rows) byStatus[row.status] = Number(row.count);

  // Active sessions = those currently being processed
  const active = (byStatus['pending'] ?? 0) + (byStatus['processing'] ?? 0);

  return {
    activeSessions: active,
    searchable: byStatus['searchable'] ?? 0,
    blocked: byStatus['blocked'] ?? 0,
    failed: byStatus['failed'] ?? 0,
    byStatus,
  };
}

async function getQueueDepths() {
  try {
    const redis = getRedis();
    const [sessions, facts, knowledge, dedup, graph, search, capture] = await Promise.all([
      redis.llen('bull:session-processing:wait'),
      redis.llen('bull:chunk-facts:wait'),
      redis.llen('bull:chunk-knowledge:wait'),
      redis.llen('bull:chunk-deduplicate:wait'),
      redis.llen('bull:chunk-graph:wait'),
      redis.llen('bull:search-indexing:wait'),
      redis.llen('bull:capture-processing:wait'),
    ]);
    return {
      sessionProcessing: sessions,
      factExtraction: facts,
      knowledgeExtraction: knowledge,
      deduplication: dedup,
      graphIndexing: graph,
      searchIndexing: search,
      captureProcessing: capture,
      total: sessions + facts + knowledge + dedup + graph + search + capture,
    };
  } catch {
    return { total: -1 };
  }
}

async function getRecentActivity(orgId: string) {
  const result = await query<{
    id: string;
    developer_id: string;
    searchable_status: string;
    enrichment_status: string;
    total_tokens: number;
    created_at: string;
    updated_at: string;
  }>(`
    SELECT id, developer_id, searchable_status, enrichment_status,
           total_tokens, created_at, updated_at
    FROM sessions
    WHERE organization_id = $1
    ORDER BY updated_at DESC
    LIMIT 20
  `, [orgId]);

  return result.rows.map(row => ({
    id: row.id,
    developerId: row.developer_id,
    searchableStatus: row.searchable_status,
    enrichmentStatus: row.enrichment_status,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
