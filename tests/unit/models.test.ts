import { describe, it, expect } from 'vitest';
import {
  SessionUploadSchema,
  MemoryFactSchema,
  CaptureEventSchema,
  SearchRequestSchema,
  FeedbackEventSchema,
} from '../../src/models/index.js';

describe('Model Validation (Zod Schemas)', () => {
  describe('SessionUploadSchema', () => {
    const validSession = {
      clientId: '00000000-0000-0000-0000-000000000001',
      developerId: 'dev-1',
      organizationId: 'org-1',
      messages: [{
        id: '00000000-0000-0000-0000-000000000010',
        role: 'user',
        content: 'Hello',
        codeBlocks: [],
        timestamp: '2025-07-25T10:00:00Z',
        tokenCount: 5,
        toolCalls: [],
      }],
      metadata: {
        project: 'test',
        language: 'typescript',
        aiProvider: 'claude',
        aiModel: 'sonnet',
      },
      startedAt: '2025-07-25T10:00:00Z',
      endedAt: '2025-07-25T10:01:00Z',
      totalTokens: 5,
    };

    it('should accept valid session upload', () => {
      const result = SessionUploadSchema.safeParse(validSession);
      expect(result.success).toBe(true);
    });

    it('should reject session without messages', () => {
      const invalid = { ...validSession, messages: [] };
      const result = SessionUploadSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject invalid AI provider', () => {
      const invalid = { ...validSession, metadata: { ...validSession.metadata, aiProvider: 'invalid' } };
      const result = SessionUploadSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('MemoryFactSchema', () => {
    const validFact = {
      id: '00000000-0000-0000-0000-000000000001',
      content: 'Team uses Kafka for event streaming',
      type: 'decision',
      entities: ['Kafka'],
      temporal: {
        observedAt: '2025-07-25T10:00:00Z',
        temporalSource: 'inferred',
      },
      sourceChunkId: '00000000-0000-0000-0000-000000000002',
      sourceSessionId: '00000000-0000-0000-0000-000000000003',
      extractedFrom: 'assistant',
      authorId: 'dev-1',
      organizationId: 'org-1',
      scope: 'organization',
      confidence: 0.85,
      usageCount: 0,
      upvotes: 0,
      createdAt: '2025-07-25T10:00:00Z',
      updatedAt: '2025-07-25T10:00:00Z',
    };

    it('should accept valid memory fact', () => {
      const result = MemoryFactSchema.safeParse(validFact);
      expect(result.success).toBe(true);
    });

    it('should reject fact with empty content', () => {
      const invalid = { ...validFact, content: '' };
      const result = MemoryFactSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject invalid fact type', () => {
      const invalid = { ...validFact, type: 'invalid_type' };
      const result = MemoryFactSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject confidence > 1', () => {
      const invalid = { ...validFact, confidence: 1.5 };
      const result = MemoryFactSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should accept all valid fact types', () => {
      const types = ['decision', 'preference', 'pattern', 'lesson', 'constraint', 'procedure', 'definition', 'relationship'];
      for (const type of types) {
        const result = MemoryFactSchema.safeParse({ ...validFact, type });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('CaptureEventSchema', () => {
    it('should accept valid capture event', () => {
      const event = {
        id: '00000000-0000-0000-0000-000000000001',
        type: 'terminal',
        source: 'iterm2',
        content: '$ kubectl get pods\nRunning...',
        metadata: {},
        captureMode: 'passive',
        developerId: 'dev-1',
        organizationId: 'org-1',
        timestamp: '2025-07-25T10:00:00Z',
        processed: false,
        factIds: [],
      };
      const result = CaptureEventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('should accept all valid event types', () => {
      const types = ['ai_session', 'ai_turn', 'clipboard', 'terminal', 'browser', 'meeting', 'commit', 'pr_review', 'slack_thread'];
      for (const type of types) {
        const result = CaptureEventSchema.safeParse({
          id: '00000000-0000-0000-0000-000000000001',
          type,
          source: 'test',
          content: 'test',
          developerId: 'dev-1',
          organizationId: 'org-1',
          timestamp: '2025-07-25T10:00:00Z',
          processed: false,
          factIds: [],
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('SearchRequestSchema', () => {
    it('should accept valid search request', () => {
      const result = SearchRequestSchema.safeParse({
        query: 'how do we deploy?',
        topK: 5,
        strategy: 'hybrid',
        includeContent: true,
        developerId: 'dev-1',
        organizationId: 'org-1',
      });
      expect(result.success).toBe(true);
    });

    it('should reject query shorter than 3 chars', () => {
      const result = SearchRequestSchema.safeParse({
        query: 'ab',
        developerId: 'dev-1',
        organizationId: 'org-1',
      });
      expect(result.success).toBe(false);
    });

    it('should default strategy to hybrid', () => {
      const result = SearchRequestSchema.safeParse({
        query: 'test query',
        developerId: 'dev-1',
        organizationId: 'org-1',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.strategy).toBe('hybrid');
      }
    });
  });

  describe('FeedbackEventSchema', () => {
    it('should accept valid feedback event', () => {
      const result = FeedbackEventSchema.safeParse({
        id: '00000000-0000-0000-0000-000000000001',
        searchId: '00000000-0000-0000-0000-000000000002',
        resultId: '00000000-0000-0000-0000-000000000003',
        developerId: 'dev-1',
        action: 'thumbs_up',
        timestamp: '2025-07-25T10:00:00Z',
      });
      expect(result.success).toBe(true);
    });

    it('should accept all valid feedback actions', () => {
      const actions = ['shown', 'clicked', 'copied', 'used', 'thumbs_up', 'thumbs_down', 'reported', 'dismissed'];
      for (const action of actions) {
        const result = FeedbackEventSchema.safeParse({
          id: '00000000-0000-0000-0000-000000000001',
          searchId: '00000000-0000-0000-0000-000000000002',
          resultId: '00000000-0000-0000-0000-000000000003',
          developerId: 'dev-1',
          action,
          timestamp: '2025-07-25T10:00:00Z',
        });
        expect(result.success).toBe(true);
      }
    });
  });
});
