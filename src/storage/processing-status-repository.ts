import { type PoolClient } from 'pg';
import { withTransaction } from './database.js';

export type ChunkAction = 'index' | 'facts' | 'knowledge' | 'deduplicate' | 'graph';
export type ActionStatus = 'pending' | 'processing' | 'completed' | 'blocked' | 'failed';
export type ActionClaim = 'claimed' | 'terminal' | 'busy';

/**
 * Serialize all status transitions for one chunk.
 *
 * Reconciliation derives the chunk and session projection from every sibling
 * action row. Without this lock, concurrent completions each run in their own
 * READ COMMITTED transaction and cannot see the others' uncommitted rows, so
 * every one of them can conclude that work is still in flight and write
 * 'processing'. Nothing reconciles afterwards, leaving a chunk whose actions all
 * completed permanently stuck. Taking the chunk row lock first makes the last
 * committer observe all of its siblings.
 *
 * Every caller locks the chunk before touching chunk_processing_status, so the
 * lock order is consistent and cannot deadlock against a sibling action.
 */
async function lockChunk(client: PoolClient, chunkId: string): Promise<boolean> {
  const result = await client.query('SELECT id FROM chunks WHERE id = $1 FOR UPDATE', [chunkId]);
  return (result.rowCount ?? 0) > 0;
}

async function reconcile(client: PoolClient, chunkId: string): Promise<void> {
  const chunkResult = await client.query<{ session_id: string }>(`
    UPDATE chunks chunk
    SET searchable_status = CASE
          WHEN index_state.status = 'completed' THEN 'searchable'
          WHEN index_state.status = 'blocked' THEN 'blocked'
          WHEN index_state.status = 'failed' THEN 'failed'
          WHEN index_state.status = 'processing' THEN 'processing'
          ELSE 'pending'
        END,
        enrichment_status = CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM chunk_processing_status s
            WHERE s.chunk_id = chunk.id AND s.action <> 'index'
          ) THEN 'not_required'
          WHEN EXISTS (
            SELECT 1 FROM chunk_processing_status s
            WHERE s.chunk_id = chunk.id AND s.action <> 'index'
              AND s.status IN ('pending', 'processing')
          ) THEN CASE WHEN EXISTS (
            SELECT 1 FROM chunk_processing_status s
            WHERE s.chunk_id = chunk.id AND s.action <> 'index' AND s.status = 'processing'
          ) THEN 'processing' ELSE 'pending' END
          WHEN EXISTS (
            SELECT 1 FROM chunk_processing_status s
            WHERE s.chunk_id = chunk.id AND s.action <> 'index' AND s.status = 'failed'
          ) AND EXISTS (
            SELECT 1 FROM chunk_processing_status s
            WHERE s.chunk_id = chunk.id AND s.action <> 'index' AND s.status IN ('completed', 'blocked')
          ) THEN 'partial'
          WHEN EXISTS (
            SELECT 1 FROM chunk_processing_status s
            WHERE s.chunk_id = chunk.id AND s.action <> 'index' AND s.status = 'failed'
          ) THEN 'failed'
          ELSE 'complete'
        END,
        updated_at = NOW()
    FROM chunk_processing_status index_state
    WHERE chunk.id = $1
      AND index_state.chunk_id = chunk.id
      AND index_state.action = 'index'
    RETURNING chunk.session_id
  `, [chunkId]);

  const sessionId = chunkResult.rows[0]?.session_id;
  if (!sessionId) return;

  await client.query(`
    UPDATE sessions session
    SET searchable_status = aggregate.searchable_status,
        enrichment_status = aggregate.enrichment_status,
        status = CASE
          WHEN aggregate.searchable_status = 'failed' THEN 'failed'
          WHEN aggregate.searchable_status IN ('searchable', 'blocked') THEN 'indexed'
          ELSE session.status
        END,
        last_error = CASE WHEN aggregate.searchable_status = 'failed'
          THEN COALESCE(session.last_error, 'One or more chunks failed search indexing')
          WHEN aggregate.searchable_status IN ('searchable', 'blocked') THEN NULL
          ELSE session.last_error END,
        updated_at = NOW()
    FROM (
      SELECT session_id,
        CASE
          WHEN bool_or(searchable_status = 'failed') THEN 'failed'
          WHEN bool_and(searchable_status = 'blocked') THEN 'blocked'
          WHEN bool_and(searchable_status IN ('searchable', 'blocked')) THEN 'searchable'
          WHEN bool_or(searchable_status = 'processing') THEN 'processing'
          ELSE 'pending'
        END AS searchable_status,
        CASE
          WHEN bool_or(enrichment_status IN ('pending', 'processing'))
            THEN CASE WHEN bool_or(enrichment_status = 'processing') THEN 'processing' ELSE 'pending' END
          WHEN bool_or(enrichment_status = 'failed')
            AND bool_or(enrichment_status IN ('complete', 'partial')) THEN 'partial'
          WHEN bool_or(enrichment_status = 'failed') THEN 'failed'
          WHEN bool_or(enrichment_status = 'partial') THEN 'partial'
          WHEN bool_and(enrichment_status = 'not_required') THEN 'not_required'
          ELSE 'complete'
        END AS enrichment_status
      FROM chunks
      WHERE session_id = $1
      GROUP BY session_id
    ) aggregate
    WHERE session.id = aggregate.session_id
  `, [sessionId]);
}

export class ProcessingStatusRepository {
  async markProcessing(chunkId: string, action: ChunkAction): Promise<ActionClaim> {
    return withTransaction(async client => {
      await lockChunk(client, chunkId);
      const result = await client.query(`
        UPDATE chunk_processing_status
        SET status = 'processing', attempts = attempts + 1, last_error = NULL,
            started_at = NOW(), updated_at = NOW()
        WHERE chunk_id = $1 AND action = $2
          AND (status IN ('pending', 'failed')
            OR (status = 'processing' AND updated_at < NOW() - INTERVAL '20 seconds'))
        RETURNING chunk_id
      `, [chunkId, action]);
      if ((result.rowCount ?? 0) > 0) {
        await reconcile(client, chunkId);
        return 'claimed';
      }

      const current = await client.query<{ status: ActionStatus }>(`
        SELECT status FROM chunk_processing_status
        WHERE chunk_id = $1 AND action = $2
        FOR UPDATE
      `, [chunkId, action]);
      const status = current.rows[0]?.status;
      if (status === 'completed' || status === 'blocked') {
        await reconcile(client, chunkId);
        return 'terminal';
      }
      return 'busy';
    });
  }

  async markCompleted(chunkId: string, action: ChunkAction, blocked = false): Promise<void> {
    await withTransaction(async client => {
      await lockChunk(client, chunkId);
      await client.query(`
        UPDATE chunk_processing_status
        SET status = $3, last_error = NULL, completed_at = NOW(), updated_at = NOW()
        WHERE chunk_id = $1 AND action = $2 AND status = 'processing'
      `, [chunkId, action, blocked ? 'blocked' : 'completed']);
      await reconcile(client, chunkId);
    });
  }

  async markFailed(chunkId: string, action: ChunkAction, error: string): Promise<void> {
    await withTransaction(async client => {
      await lockChunk(client, chunkId);
      await client.query(`
        UPDATE chunk_processing_status
        SET status = 'failed', last_error = $3, updated_at = NOW()
        WHERE chunk_id = $1 AND action = $2 AND status = 'processing'
      `, [chunkId, action, error.slice(0, 4000)]);
      await reconcile(client, chunkId);
    });
  }

  async reconcileChunkAndSession(chunkId: string): Promise<void> {
    await withTransaction(async client => {
      await lockChunk(client, chunkId);
      await reconcile(client, chunkId);
    });
  }

  /**
   * Repair projections that disagree with their action ledger.
   *
   * Defence in depth for the stuck-projection class of bug: any chunk whose
   * actions are all terminal but whose projection still claims work is in
   * flight is reconciled again. Returns the number of chunks repaired so a
   * non-zero result is visible rather than silent.
   */
  async sweepStuckProjections(limit = 200): Promise<number> {
    const candidates = await withTransaction(async client => {
      const result = await client.query<{ id: string }>(`
        SELECT chunk.id
        FROM chunks chunk
        WHERE (chunk.searchable_status IN ('pending', 'processing')
            OR chunk.enrichment_status IN ('pending', 'processing'))
          AND EXISTS (SELECT 1 FROM chunk_processing_status s WHERE s.chunk_id = chunk.id)
          AND NOT EXISTS (
            SELECT 1 FROM chunk_processing_status s
            WHERE s.chunk_id = chunk.id AND s.status IN ('pending', 'processing')
          )
        ORDER BY chunk.updated_at ASC
        LIMIT $1
      `, [Math.max(1, Math.min(limit, 1000))]);
      return result.rows.map(row => row.id);
    });

    for (const chunkId of candidates) {
      await this.reconcileChunkAndSession(chunkId);
    }
    return candidates.length;
  }
}
