/*
 * Capture Repository
 *
 * Persistence for ambient capture events (terminal, browser, meetings, etc.).
 */

import { type PoolClient, type QueryResultRow } from 'pg';

import { type CaptureEvent } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { query, withTransaction } from './database.js';
import { insertOutboxEvent } from './outbox-repository.js';

const logger = createChildLogger({ module: 'capture-repository' });

interface CaptureRow extends QueryResultRow {
  id: string;
  type: CaptureEvent['type'];
  source: string;
  content: string;
  metadata: CaptureEvent['metadata'];
  capture_mode: CaptureEvent['captureMode'];
  developer_id: string;
  organization_id: string;
  timestamp: Date | string;
  duration: number | null;
  processed: boolean;
  processing_status: CaptureEvent['processingStatus'];
  processing_attempts: number;
  last_error: string | null;
  processed_at: Date | string | null;
  fact_ids: string[];
}

const INSERT_SQL = `
  INSERT INTO capture_events (
    id, type, source, content, metadata, capture_mode, developer_id,
    organization_id, timestamp, duration, processed, processing_status,
    processing_attempts, last_error, processed_at, fact_ids
  ) VALUES (
    $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
  )
`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function insertParams(event: CaptureEvent): unknown[] {
  return [
    event.id, event.type, event.source, event.content, JSON.stringify(event.metadata),
    event.captureMode, event.developerId, event.organizationId, event.timestamp,
    event.duration ?? null, event.processed, event.processingStatus ?? 'pending',
    event.processingAttempts ?? 0, event.lastError ?? null, event.processedAt ?? null,
    event.factIds,
  ];
}

function mapCapture(row: CaptureRow): CaptureEvent {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    content: row.content,
    metadata: row.metadata ?? {},
    captureMode: row.capture_mode,
    developerId: row.developer_id,
    organizationId: row.organization_id,
    timestamp: iso(row.timestamp),
    ...(row.duration != null ? { duration: Number(row.duration) } : {}),
    processed: row.processed,
    processingStatus: row.processing_status,
    processingAttempts: row.processing_attempts,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.processed_at ? { processedAt: iso(row.processed_at) } : {}),
    factIds: row.fact_ids ?? [],
  };
}

async function insertCapture(client: PoolClient, event: CaptureEvent): Promise<void> {
  await client.query(INSERT_SQL, insertParams(event));
}

export class CaptureRepository {
  async create(event: CaptureEvent): Promise<void> {
    logger.debug({ eventId: event.id, type: event.type }, 'Storing capture event');
    await query(INSERT_SQL, insertParams(event));
  }

  async createWithOutbox(event: CaptureEvent): Promise<void> {
    await withTransaction(async client => {
      await insertCapture(client, event);
      await insertOutboxEvent(client, {
        aggregateType: 'capture',
        aggregateId: event.id,
        organizationId: event.organizationId,
        eventType: 'capture.process',
        payload: { captureId: event.id, organizationId: event.organizationId },
        deduplicationKey: `capture.process:${event.id}`,
      });
    });
  }

  async createBatchWithOutbox(events: CaptureEvent[]): Promise<void> {
    if (events.length === 0) return;
    await withTransaction(async client => {
      for (const event of events) {
        await insertCapture(client, event);
        await insertOutboxEvent(client, {
          aggregateType: 'capture',
          aggregateId: event.id,
          organizationId: event.organizationId,
          eventType: 'capture.process',
          payload: { captureId: event.id, organizationId: event.organizationId },
          deduplicationKey: `capture.process:${event.id}`,
        });
      }
    });
  }

  async createBatch(events: CaptureEvent[]): Promise<void> {
    if (events.length === 0) return;
    await withTransaction(async client => {
      for (const event of events) await insertCapture(client, event);
    });
  }

  async findById(id: string): Promise<CaptureEvent | null> {
    const result = await query<CaptureRow>('SELECT * FROM capture_events WHERE id = $1', [id]);
    return result.rows[0] ? mapCapture(result.rows[0]) : null;
  }

  async findUnprocessed(
    organizationId: string,
    options?: { type?: string; limit?: number },
  ): Promise<CaptureEvent[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 100, 1000));
    const result = await query<CaptureRow>(`
      SELECT * FROM capture_events
      WHERE processed = false
        AND organization_id = $1
        AND ($2::text IS NULL OR type = $2)
      ORDER BY timestamp ASC
      LIMIT $3
    `, [organizationId, options?.type ?? null, limit]);
    return result.rows.map(mapCapture);
  }

  async markProcessed(eventId: string, factIds: string[]): Promise<void> {
    await query(`
      UPDATE capture_events
      SET processed = true, processing_status = 'complete', fact_ids = $2,
          processed_at = NOW(), last_error = NULL
      WHERE id = $1
    `, [eventId, factIds]);
  }

  async claimProcessing(eventId: string): Promise<'claimed' | 'terminal' | 'busy'> {
    const claim = await query(`
      UPDATE capture_events
      SET processing_status = 'processing', processing_attempts = processing_attempts + 1,
          processing_started_at = NOW(), last_error = NULL
      WHERE id = $1 AND (
        processing_status IN ('pending', 'failed')
        OR (processing_status = 'processing' AND processed = false
          AND processing_started_at < NOW() - INTERVAL '20 seconds')
      )
      RETURNING id
    `, [eventId]);
    if ((claim.rowCount ?? 0) > 0) return 'claimed';
    const current = await query<{ processed: boolean; processing_status: string }>(`
      SELECT processed, processing_status FROM capture_events WHERE id = $1
    `, [eventId]);
    const row = current.rows[0];
    return row?.processed || row?.processing_status === 'complete' || row?.processing_status === 'blocked'
      ? 'terminal'
      : 'busy';
  }

  async markProcessing(eventId: string): Promise<void> {
    await query(`
      UPDATE capture_events SET processing_status = 'processing',
        processing_attempts = processing_attempts + 1, last_error = NULL
      WHERE id = $1
    `, [eventId]);
  }

  async markBlocked(eventId: string): Promise<void> {
    await query(`
      UPDATE capture_events SET processed = true, processing_status = 'blocked',
        processed_at = NOW(), fact_ids = '{}', last_error = NULL
      WHERE id = $1
    `, [eventId]);
  }

  async markFailed(eventId: string, error: string): Promise<void> {
    await query(`
      UPDATE capture_events SET processing_status = 'failed', last_error = $2
      WHERE id = $1
    `, [eventId, error.slice(0, 4000)]);
  }

  async findByDeveloper(
    developerId: string,
    options?: { from?: string; to?: string; type?: string; limit?: number },
  ): Promise<CaptureEvent[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 100, 1000));
    const result = await query<CaptureRow>(`
      SELECT * FROM capture_events
      WHERE developer_id = $1
        AND ($2::timestamptz IS NULL OR timestamp >= $2)
        AND ($3::timestamptz IS NULL OR timestamp <= $3)
        AND ($4::text IS NULL OR type = $4)
      ORDER BY timestamp DESC
      LIMIT $5
    `, [developerId, options?.from ?? null, options?.to ?? null, options?.type ?? null, limit]);
    return result.rows.map(mapCapture);
  }
}
