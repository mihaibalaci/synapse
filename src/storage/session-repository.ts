/* PostgreSQL-backed persistence for session metadata and processing state. */

import { type PoolClient, type QueryResultRow } from 'pg';
import {
  type EnrichmentStatus,
  type SearchableStatus,
  type SessionRecord,
  type SessionStatus,
} from '../models/index.js';
import { type SessionProcessingJob } from '../ingestion/queue.js';
import { createChildLogger } from '../utils/logger.js';
import { query, withTransaction } from './database.js';
import { insertOutboxEvent } from './outbox-repository.js';

const logger = createChildLogger({ module: 'session-repository' });

interface SessionRow extends QueryResultRow {
  id: string;
  client_id: string;
  developer_id: string;
  organization_id: string;
  team_id: string | null;
  status: SessionStatus;
  searchable_status: SearchableStatus;
  enrichment_status: EnrichmentStatus;
  raw_storage_key: string;
  total_tokens: number;
  metadata: SessionRecord['metadata'];
  git_context: SessionRecord['git'] | null;
  started_at: Date | string;
  ended_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  processing_attempts: number;
  last_error: string | null;
}

const INSERT_SQL = `
  INSERT INTO sessions (
    id, client_id, developer_id, organization_id, team_id, status,
    searchable_status, enrichment_status, raw_storage_key, total_tokens,
    message_count, metadata, git_context, started_at, ended_at, created_at,
    updated_at, processing_attempts, last_error
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
    $14, $15, $16, $17, $18, $19
  )
`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function insertParams(session: SessionRecord): unknown[] {
  return [
    session.id, session.clientId, session.developerId, session.organizationId,
    session.teamId ?? null, session.status, session.searchableStatus ?? 'pending',
    session.enrichmentStatus ?? 'pending', session.rawStorageKey, session.totalTokens,
    session.messages.length, JSON.stringify(session.metadata),
    session.git ? JSON.stringify(session.git) : null, session.startedAt, session.endedAt,
    session.createdAt, session.updatedAt, session.processingAttempts, session.lastError ?? null,
  ];
}

async function insertSession(client: PoolClient, session: SessionRecord): Promise<void> {
  await client.query(INSERT_SQL, insertParams(session));
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    developerId: row.developer_id,
    organizationId: row.organization_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    messages: [],
    ...(row.git_context ? { git: row.git_context } : {}),
    metadata: row.metadata,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    totalTokens: row.total_tokens,
    status: row.status,
    searchableStatus: row.searchable_status,
    enrichmentStatus: row.enrichment_status,
    rawStorageKey: row.raw_storage_key,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    processingAttempts: row.processing_attempts,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function sessionOutboxEvent(session: SessionRecord, job: SessionProcessingJob) {
  return {
    aggregateType: 'session' as const,
    aggregateId: session.id,
    organizationId: session.organizationId,
    eventType: 'session.process' as const,
    payload: job as unknown as Record<string, unknown>,
    deduplicationKey: `session.process:${session.id}`,
  };
}

export class SessionRepository {
  async create(session: SessionRecord): Promise<void> {
    logger.debug({ sessionId: session.id, status: session.status }, 'Creating session record');
    await query(INSERT_SQL, insertParams(session));
  }

  async createWithOutbox(session: SessionRecord, job: SessionProcessingJob): Promise<void> {
    await withTransaction(async client => {
      await insertSession(client, session);
      await insertOutboxEvent(client, sessionOutboxEvent(session, job));
    });
  }

  async createBatchWithOutbox(
    items: Array<{ session: SessionRecord; job: SessionProcessingJob }>,
  ): Promise<void> {
    if (items.length === 0) return;
    await withTransaction(async client => {
      for (const item of items) {
        await insertSession(client, item.session);
        await insertOutboxEvent(client, sessionOutboxEvent(item.session, item.job));
      }
    });
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const result = await query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async findByClientId(
    clientId: string,
    developerId: string,
    organizationId: string,
  ): Promise<SessionRecord | null> {
    const result = await query<SessionRow>(`
      SELECT * FROM sessions
      WHERE client_id = $1 AND developer_id = $2 AND organization_id = $3
      LIMIT 1
    `, [clientId, developerId, organizationId]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async updateStatus(sessionId: string, status: SessionStatus, error?: string): Promise<void> {
    await query(`
      UPDATE sessions
      SET status = $1, updated_at = NOW(), last_error = $2,
          processing_attempts = processing_attempts + 1
      WHERE id = $3
    `, [status, error ?? null, sessionId]);
  }

  async updateProcessingStatuses(
    sessionId: string,
    searchableStatus: SearchableStatus,
    enrichmentStatus: EnrichmentStatus,
  ): Promise<void> {
    await query(`
      UPDATE sessions SET searchable_status = $2, enrichment_status = $3, updated_at = NOW()
      WHERE id = $1
    `, [sessionId, searchableStatus, enrichmentStatus]);
  }

  async findStuckSessions(olderThanMinutes = 30, maxAttempts = 3): Promise<SessionRecord[]> {
    const result = await query<SessionRow>(`
      SELECT * FROM sessions
      WHERE status NOT IN ('indexed', 'failed')
        AND updated_at < NOW() - ($1 * INTERVAL '1 minute')
        AND processing_attempts < $2
      ORDER BY updated_at ASC
    `, [olderThanMinutes, maxAttempts]);
    return result.rows.map(mapSession);
  }

  async getStatusCounts(organizationId: string): Promise<Record<string, number>> {
    const result = await query<{ status: string; count: string }>(`
      SELECT status, COUNT(*)::text AS count FROM sessions
      WHERE organization_id = $1 GROUP BY status
    `, [organizationId]);
    return Object.fromEntries(result.rows.map(row => [row.status, Number(row.count)]));
  }

  async listByDeveloper(
    developerId: string,
    options: { limit?: number; offset?: number; status?: SessionStatus } = {},
  ): Promise<{ sessions: SessionRecord[]; total: number }> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const params = [developerId, options.status ?? null];
    const [sessionsResult, countResult] = await Promise.all([
      query<SessionRow>(`
        SELECT * FROM sessions WHERE developer_id = $1
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4
      `, [...params, limit, offset]),
      query<{ total: string }>(`
        SELECT COUNT(*)::text AS total FROM sessions WHERE developer_id = $1
          AND ($2::text IS NULL OR status = $2)
      `, params),
    ]);
    return {
      sessions: sessionsResult.rows.map(mapSession),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }
}
