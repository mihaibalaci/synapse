/**
 * Session Repository
 *
 * PostgreSQL-backed persistence for session metadata.
 * Raw session content lives in S3; this stores the record
 * with status, ownership, and processing state.
 */

import { type SessionRecord, type SessionStatus } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'session-repository' });

export class SessionRepository {
  /**
   * Create a new session record.
   * Called immediately on upload before async processing begins.
   */
  async create(session: SessionRecord): Promise<void> {
    logger.debug({ sessionId: session.id, status: session.status }, 'Creating session record');

    // TODO: Actual Postgres INSERT
    // await db.query(`
    //   INSERT INTO sessions (id, client_id, developer_id, organization_id, team_id,
    //     status, raw_storage_key, total_tokens, message_count, metadata,
    //     started_at, ended_at, created_at, updated_at, processing_attempts)
    //   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    // `, [...]);
  }

  /**
   * Find session by ID.
   */
  async findById(sessionId: string): Promise<SessionRecord | null> {
    logger.debug({ sessionId }, 'Finding session by ID');

    // TODO: Actual Postgres SELECT
    // const result = await db.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return null;
  }

  /**
   * Update session processing status.
   * Called by pipeline workers as they progress through stages.
   */
  async updateStatus(
    sessionId: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    logger.debug({ sessionId, status, error }, 'Updating session status');

    // TODO: Actual Postgres UPDATE
    // await db.query(`
    //   UPDATE sessions
    //   SET status = $1, updated_at = NOW(), last_error = $2,
    //       processing_attempts = processing_attempts + 1
    //   WHERE id = $3
    // `, [status, error ?? null, sessionId]);
  }

  /**
   * Find sessions that are stuck in processing (for retry/dead-letter).
   */
  async findStuckSessions(
    olderThanMinutes: number = 30,
    maxAttempts: number = 3,
  ): Promise<SessionRecord[]> {
    // TODO: Find sessions where status is not 'indexed' or 'failed'
    // and updated_at < NOW() - interval
    // and processing_attempts < maxAttempts
    return [];
  }

  /**
   * Get session counts by status for monitoring.
   */
  async getStatusCounts(organizationId: string): Promise<Record<string, number>> {
    // TODO: SELECT status, COUNT(*) FROM sessions WHERE org_id = $1 GROUP BY status
    return {};
  }

  /**
   * List sessions for a developer (for UI/audit).
   */
  async listByDeveloper(
    developerId: string,
    options: { limit?: number; offset?: number; status?: SessionStatus } = {},
  ): Promise<{ sessions: SessionRecord[]; total: number }> {
    const { limit = 20, offset = 0 } = options;
    logger.debug({ developerId, limit, offset }, 'Listing sessions for developer');

    // TODO: Paginated SELECT
    return { sessions: [], total: 0 };
  }
}
