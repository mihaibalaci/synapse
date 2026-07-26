/**
 * Regression test: concurrent action completions on one chunk.
 *
 * The bug this guards against passed the entire mocked test suite and only
 * appeared under real concurrency against real transactions. Every chunk action
 * (index, facts, knowledge, deduplicate, graph) completes in its own
 * READ COMMITTED transaction and then recomputes the chunk and session
 * projection from all sibling action rows. When several completed at the same
 * instant, none of them could see the others' uncommitted rows, so each wrote
 * 'processing' and nothing reconciled afterwards. The result was a chunk whose
 * five actions were all 'completed' while its session claimed to still be
 * processing, permanently and silently.
 *
 * Mocks cannot express that: it requires PostgreSQL's real isolation behaviour.
 * The test therefore needs a live database and skips when one is not supplied:
 *
 *   docker compose -f infra/docker/docker-compose.yml up -d postgres
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/recall \
 *     npm run migrate
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/recall \
 *     npm test -- --run tests/integration/processing-status-concurrency.test.ts
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const ACTIONS = ['index', 'facts', 'knowledge', 'deduplicate', 'graph'] as const;
/** Repeated because a lost race is probabilistic, not deterministic. */
const ITERATIONS = 8;

describeWithDatabase('chunk projection under concurrent action completion', () => {
  let query: typeof import('../../src/storage/database.js')['query'];
  let closeDatabase: typeof import('../../src/storage/database.js')['closeDatabase'];
  let ProcessingStatusRepository:
    typeof import('../../src/storage/processing-status-repository.js')['ProcessingStatusRepository'];
  let repository: InstanceType<typeof ProcessingStatusRepository>;

  const organizationId = `concurrency-org-${randomUUID()}`;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { loadConfig } = await import('../../src/config/index.js');
    loadConfig({ ...process.env, DATABASE_URL: testDatabaseUrl }, true);

    const database = await import('../../src/storage/database.js');
    query = database.query;
    closeDatabase = database.closeDatabase;

    // Workers run with the service context, which is what the reconciliation
    // path uses in production.
    database.enterDatabaseContext({
      userId: 'concurrency-test',
      organizationId: '',
      teamIds: [],
      roles: ['service'],
      repositoryAccess: [],
      isService: true,
    });

    ({ ProcessingStatusRepository } = await import(
      '../../src/storage/processing-status-repository.js'
    ));
    repository = new ProcessingStatusRepository();
  });

  afterAll(async () => {
    if (!query) return;
    for (const sessionId of createdSessionIds) {
      await query('DELETE FROM chunk_processing_status WHERE chunk_id IN (SELECT id FROM chunks WHERE session_id = $1)', [sessionId]);
      await query('DELETE FROM chunks WHERE session_id = $1', [sessionId]);
      await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    }
    await closeDatabase();
  });

  async function seedChunk(): Promise<string> {
    const sessionId = randomUUID();
    const chunkId = randomUUID();
    createdSessionIds.push(sessionId);

    await query(`
      INSERT INTO sessions (
        id, client_id, developer_id, organization_id, status, searchable_status,
        enrichment_status, raw_storage_key, total_tokens, message_count,
        started_at, ended_at
      ) VALUES ($1, $2, 'concurrency-dev', $3, 'uploaded', 'pending', 'pending',
                'sessions/concurrency.json', 100, 2, NOW(), NOW())
    `, [sessionId, randomUUID(), organizationId]);

    await query(`
      INSERT INTO chunks (
        id, session_id, title, summary, content, token_count, type, author_id,
        organization_id, embedding_model, searchable_status, enrichment_status
      ) VALUES ($1, $2, 'concurrency', 'concurrency', 'concurrency', 10,
                'discussion', 'concurrency-dev', $3, 'test', 'pending', 'pending')
    `, [chunkId, sessionId, organizationId]);

    for (const action of ACTIONS) {
      await query(
        'INSERT INTO chunk_processing_status (chunk_id, action) VALUES ($1, $2)',
        [chunkId, action],
      );
    }
    return chunkId;
  }

  it('settles the chunk and session projection when all actions complete at once', async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const chunkId = await seedChunk();

      // Claim every action, then complete all five simultaneously. This is the
      // exact interleaving that used to leave the projection stuck.
      const claims = await Promise.all(
        ACTIONS.map(action => repository.markProcessing(chunkId, action)),
      );
      expect(claims.every(claim => claim === 'claimed')).toBe(true);

      await Promise.all(ACTIONS.map(action => repository.markCompleted(chunkId, action)));

      const actionRows = await query<{ status: string }>(
        'SELECT status FROM chunk_processing_status WHERE chunk_id = $1',
        [chunkId],
      );
      expect(actionRows.rows).toHaveLength(ACTIONS.length);
      expect(actionRows.rows.every(row => row.status === 'completed')).toBe(true);

      const chunkRow = await query<{ searchable_status: string; enrichment_status: string; session_id: string }>(
        'SELECT searchable_status, enrichment_status, session_id FROM chunks WHERE id = $1',
        [chunkId],
      );
      expect(chunkRow.rows[0]?.searchable_status).toBe('searchable');
      expect(chunkRow.rows[0]?.enrichment_status).toBe('complete');

      const sessionRow = await query<{ searchable_status: string; enrichment_status: string; status: string }>(
        'SELECT searchable_status, enrichment_status, status FROM sessions WHERE id = $1',
        [chunkRow.rows[0]!.session_id],
      );
      expect(sessionRow.rows[0]?.searchable_status).toBe('searchable');
      expect(sessionRow.rows[0]?.enrichment_status).toBe('complete');
      expect(sessionRow.rows[0]?.status).toBe('indexed');
    }
  }, 60_000);

  it('reports a failed enrichment action as partial without stalling searchability', async () => {
    const chunkId = await seedChunk();
    await Promise.all(ACTIONS.map(action => repository.markProcessing(chunkId, action)));

    await Promise.all([
      repository.markCompleted(chunkId, 'index'),
      repository.markCompleted(chunkId, 'facts'),
      repository.markCompleted(chunkId, 'knowledge'),
      repository.markCompleted(chunkId, 'deduplicate'),
      repository.markFailed(chunkId, 'graph', 'synthetic failure'),
    ]);

    const chunkRow = await query<{ searchable_status: string; enrichment_status: string }>(
      'SELECT searchable_status, enrichment_status FROM chunks WHERE id = $1',
      [chunkId],
    );
    expect(chunkRow.rows[0]?.searchable_status).toBe('searchable');
    expect(chunkRow.rows[0]?.enrichment_status).toBe('partial');
  }, 30_000);

  it('leaves nothing for the drift sweeper to repair', async () => {
    const repaired = await repository.sweepStuckProjections();
    expect(repaired).toBe(0);
  }, 30_000);
});
