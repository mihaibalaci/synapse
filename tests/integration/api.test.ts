import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';

vi.mock('../../src/ingestion/queue.js', () => ({
  enqueueSession: vi.fn().mockResolvedValue('job-1'),
  getQueueHealth: vi.fn().mockResolvedValue({}),
  closeQueues: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/storage/object-storage.js', () => ({
  ObjectStorageClient: class {
    putObject = vi.fn().mockResolvedValue({ key: 'test-key' });
    getObject = vi.fn().mockResolvedValue({ body: '{}', metadata: {} });
    checkBucket = vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 });
  },
}));

vi.mock('../../src/storage/database.js', () => ({
  checkDatabaseHealth: vi.fn().mockResolvedValue({
    healthy: true, latencyMs: 1, poolSize: 1, idleCount: 1, waitingCount: 0,
  }),
  enterDatabaseContext: vi.fn(),
  closeDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/storage/cache.js', () => ({
  checkCacheHealth: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
  closeCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/storage/session-repository.js', () => ({
  SessionRepository: class {
    create = vi.fn().mockResolvedValue(undefined);
    createWithOutbox = vi.fn().mockResolvedValue(undefined);
    createBatchWithOutbox = vi.fn().mockResolvedValue(undefined);
    findById = vi.fn().mockResolvedValue(null);
    findByClientId = vi.fn().mockResolvedValue(null);
  },
}));

vi.mock('../../src/storage/capture-repository.js', () => ({
  CaptureRepository: class {
    create = vi.fn().mockResolvedValue(undefined);
    createWithOutbox = vi.fn().mockResolvedValue(undefined);
    createBatchWithOutbox = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../src/retrieval/feedback.js', () => ({
  FeedbackProcessor: class {
    recordFeedback = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../src/retrieval/engine.js', () => ({
  RetrievalEngine: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue({
      results: [],
      totalCount: 0,
      query: 'test',
      strategy: 'hybrid',
      latencyMs: 1,
      cached: false,
      estimatedTokens: 0,
      relatedQueries: [],
    }),
    findSimilar: vi.fn().mockResolvedValue([]),
  })),
}));

import { createServer } from '../../src/api/server.js';

/**
 * Integration tests for the Recall API.
 * These test the HTTP endpoints without external dependencies
 * (DB calls are stubbed via the repository pattern).
 */

describe('API Integration Tests', () => {
  let app: FastifyInstance;
  let authorization: string;

  const inject = (options: InjectOptions) => app.inject({
    ...options,
    headers: { ...options.headers, authorization },
  });

  beforeAll(async () => {
    app = await createServer();
    authorization = `Bearer ${app.jwt.sign({
      sub: 'dev-test',
      organization_id: 'org-test',
      team_ids: ['team-test'],
      roles: ['developer'],
      repository_access: ['org/service', 'org/lambda-service'],
      iss: 'https://auth.company.com',
      aud: 'synapse',
    })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Health ──────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const res = await inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
      expect(body.version).toBeDefined();
    });
  });

  describe('GET /health/ready', () => {
    it('should return readiness checks', async () => {
      const res = await inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe('ready');
      expect(body.checks).toBeDefined();
    });
  });

  // ─── Capture: Passive ────────────────────────────────────────────────────

  describe('POST /api/v1/capture/passive', () => {
    it('should accept a passive capture with minimal payload', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/capture/passive',
        payload: {
          messages: [
            { role: 'user', content: 'How do I fix this timeout?' },
            { role: 'assistant', content: 'Check your VPC DNS settings.' },
          ],
          source: 'kiro',
          repository: 'org/service',
          language: 'typescript',
          developerId: 'dev-test',
          organizationId: 'org-test',
        },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBeDefined();
      expect(body.mode).toBe('passive');
    });

    it('should reject capture with fewer than 2 messages', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/capture/passive',
        payload: {
          messages: [{ role: 'user', content: 'Hi' }],
          source: 'test',
          developerId: 'dev-test',
          organizationId: 'org-test',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Capture: Active ─────────────────────────────────────────────────────

  describe('POST /api/v1/capture/active', () => {
    it('should accept an active capture with full payload', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/capture/active',
        payload: {
          clientId: '00000000-0000-0000-0000-000000000001',
          developerId: 'dev-test',
          organizationId: 'org-test',
          messages: [{
            id: '00000000-0000-0000-0000-000000000010',
            role: 'user',
            content: 'How do we deploy to prod?',
            codeBlocks: [],
            timestamp: '2025-07-25T10:00:00Z',
            tokenCount: 8,
            toolCalls: [],
          }, {
            id: '00000000-0000-0000-0000-000000000011',
            role: 'assistant',
            content: 'Merge to main and the pipeline handles it.',
            codeBlocks: [],
            timestamp: '2025-07-25T10:00:05Z',
            tokenCount: 12,
            toolCalls: [],
          }],
          metadata: {
            project: 'test',
            language: 'typescript',
            languages: ['typescript'],
            frameworks: [],
            aiProvider: 'claude',
            aiModel: 'sonnet',
            tags: ['deployment'],
          },
          startedAt: '2025-07-25T10:00:00Z',
          endedAt: '2025-07-25T10:01:00Z',
          totalTokens: 20,
          tags: ['deployment', 'ci-cd'],
          annotation: 'Important deployment procedure',
          promoteTier2: true,
        },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBeDefined();
      expect(body.mode).toBe('active');
      expect(body.tier).toBe('deep');
    });
  });

  // ─── Capture: Ambient ────────────────────────────────────────────────────

  describe('POST /api/v1/capture/event', () => {
    it('should accept a terminal capture event', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/capture/event',
        payload: {
          type: 'terminal',
          source: 'iterm2',
          content: '$ npm run build\n> synapse@0.1.0 build\n> tsc\nDone.',
          metadata: { cwd: '/opt/synapse' },
          captureMode: 'passive',
          developerId: 'dev-test',
          organizationId: 'org-test',
          timestamp: '2025-07-25T10:30:00Z',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.captured).toBe(true);
    });
  });

  // ─── Search ──────────────────────────────────────────────────────────────

  describe('POST /api/v1/search', () => {
    it('should accept a valid search request', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/search',
        payload: {
          query: 'how do we handle authentication?',
          topK: 5,
          strategy: 'hybrid',
          includeContent: true,
          developerId: 'dev-test',
          organizationId: 'org-test',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.latencyMs).toBeDefined();
    });

    it('should reject search with too-short query', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/search',
        payload: {
          query: 'ab',
          developerId: 'dev-test',
          organizationId: 'org-test',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Context ─────────────────────────────────────────────────────────────

  describe('POST /api/v1/context', () => {
    it('should return context for a valid request', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/context',
        payload: {
          query: 'Lambda timeout in VPC',
          repository: 'org/lambda-service',
          language: 'python',
          maxTokens: 3000,
          developerId: 'dev-test',
          organizationId: 'org-test',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.context).toBeDefined();
      expect(body.estimatedTokens).toBeDefined();
    });
  });

  // ─── Feedback ────────────────────────────────────────────────────────────

  describe('POST /api/v1/feedback', () => {
    it('should accept valid feedback', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/feedback',
        payload: {
          searchId: '00000000-0000-0000-0000-000000000001',
          resultId: '00000000-0000-0000-0000-000000000002',
          developerId: 'dev-test',
          action: 'thumbs_up',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.recorded).toBe(true);
    });

    it('should reject invalid feedback action', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/v1/feedback',
        payload: {
          searchId: '00000000-0000-0000-0000-000000000001',
          resultId: '00000000-0000-0000-0000-000000000002',
          developerId: 'dev-test',
          action: 'invalid_action',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Session Status ──────────────────────────────────────────────────────

  describe('GET /api/v1/sessions/:id/status', () => {
    it('should return 404 for non-existent session', async () => {
      const res = await inject({
        method: 'GET',
        url: '/api/v1/sessions/00000000-0000-0000-0000-000000000099/status',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
