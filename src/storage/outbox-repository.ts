import { type PoolClient, type QueryResultRow } from 'pg';
import { query, withTransaction } from './database.js';

export type OutboxEventType =
  | 'session.process'
  | 'chunk.index'
  | 'chunk.facts'
  | 'chunk.knowledge'
  | 'chunk.deduplicate'
  | 'chunk.graph'
  | 'capture.process';

export interface OutboxEventInput {
  aggregateType: 'session' | 'chunk' | 'capture';
  aggregateId: string;
  organizationId: string;
  eventType: OutboxEventType;
  payload: Record<string, unknown>;
  deduplicationKey: string;
}

export interface OutboxEvent extends OutboxEventInput {
  id: string;
  status: 'pending' | 'publishing' | 'published' | 'failed';
  attempts: number;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  aggregate_type: OutboxEvent['aggregateType'];
  aggregate_id: string;
  organization_id: string;
  event_type: OutboxEventType;
  payload: Record<string, unknown>;
  deduplication_key: string;
  status: OutboxEvent['status'];
  attempts: number;
}

export async function insertOutboxEvent(
  client: PoolClient,
  event: OutboxEventInput,
): Promise<void> {
  await client.query(`
    INSERT INTO outbox_events (
      aggregate_type, aggregate_id, organization_id, event_type, payload,
      deduplication_key
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    ON CONFLICT (deduplication_key) DO NOTHING
  `, [
    event.aggregateType,
    event.aggregateId,
    event.organizationId,
    event.eventType,
    JSON.stringify(event.payload),
    event.deduplicationKey,
  ]);
}

function mapEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    organizationId: row.organization_id,
    eventType: row.event_type,
    payload: row.payload,
    deduplicationKey: row.deduplication_key,
    status: row.status,
    attempts: row.attempts,
  };
}

export class OutboxRepository {
  async claimBatch(limit = 50, staleAfterMinutes = 5): Promise<OutboxEvent[]> {
    return withTransaction(async client => {
      await client.query(`
        UPDATE outbox_events
        SET status = 'pending', available_at = NOW(), updated_at = NOW(),
            last_error = COALESCE(last_error, 'Recovered stale publication claim')
        WHERE status = 'publishing'
          AND updated_at < NOW() - ($1 * INTERVAL '1 minute')
      `, [staleAfterMinutes]);

      const result = await client.query<OutboxRow>(`
        WITH claimed AS (
          SELECT id
          FROM outbox_events
          WHERE status = 'pending' AND available_at <= NOW()
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE outbox_events event
        SET status = 'publishing', attempts = event.attempts + 1, updated_at = NOW()
        FROM claimed
        WHERE event.id = claimed.id
        RETURNING event.*
      `, [Math.max(1, Math.min(limit, 500))]);
      return result.rows.map(mapEvent);
    });
  }

  async markPublished(id: string, claimAttempt: number): Promise<void> {
    await query(`
      UPDATE outbox_events
      SET status = 'published', published_at = NOW(), last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'publishing' AND attempts = $2
    `, [id, claimAttempt]);
  }

  async markFailed(id: string, claimAttempt: number, error: string): Promise<void> {
    const terminal = claimAttempt >= 10;
    const delaySeconds = Math.min(300, 2 ** Math.min(claimAttempt, 8));
    await query(`
      UPDATE outbox_events
      SET status = $3,
          available_at = CASE WHEN $3 = 'pending'
            THEN NOW() + ($4 * INTERVAL '1 second') ELSE available_at END,
          last_error = $5,
          updated_at = NOW()
      WHERE id = $1 AND status = 'publishing' AND attempts = $2
    `, [id, claimAttempt, terminal ? 'failed' : 'pending', delaySeconds, error.slice(0, 4000)]);
  }
}
