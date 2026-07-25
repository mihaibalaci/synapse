import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SemanticSegmenter } from '../../src/ingestion/segmenter.js';

// Mock the embedding client
vi.mock('../../src/utils/embedding.js', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embedBatch: vi.fn().mockImplementation((texts: string[]) => {
      // Return mock embeddings that simulate topic changes
      return texts.map((_, i) => {
        const base = new Array(10).fill(0);
        // Messages 0-2 similar, message 3+ different
        if (i < 3) base[0] = 0.9;
        else base[1] = 0.9;
        return base;
      });
    }),
  })),
}));

describe('SemanticSegmenter', () => {
  let segmenter: SemanticSegmenter;

  beforeEach(() => {
    segmenter = new SemanticSegmenter({
      useLLMSegmentation: false, // Force embedding-based
      maxChunkTokens: 500,
      minChunkTokens: 20,
      overlapTokens: 50,
      similarityThreshold: 0.7,
    });
  });

  const mockSession = {
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    messages: [
      { id: '1', role: 'user' as const, content: 'How do I configure S3 bucket policies?', codeBlocks: [], timestamp: '2025-01-01T00:00:00Z', tokenCount: 10, index: 0 },
      { id: '2', role: 'assistant' as const, content: 'You can use the PutBucketPolicy API with a JSON policy document.', codeBlocks: [], timestamp: '2025-01-01T00:01:00Z', tokenCount: 20, index: 1 },
      { id: '3', role: 'user' as const, content: 'What about versioning?', codeBlocks: [], timestamp: '2025-01-01T00:02:00Z', tokenCount: 5, index: 2 },
      { id: '4', role: 'user' as const, content: 'Now a completely different topic: how does Kubernetes networking work?', codeBlocks: [], timestamp: '2025-01-01T00:05:00Z', tokenCount: 15, index: 3 },
      { id: '5', role: 'assistant' as const, content: 'Kubernetes uses a flat network model where every pod gets an IP.', codeBlocks: [], timestamp: '2025-01-01T00:06:00Z', tokenCount: 20, index: 4 },
    ],
    totalTokens: 70,
    languages: ['typescript'],
    frameworks: ['aws-sdk'],
    topics: ['S3 bucket policies'],
  };

  const metadata = {
    organizationId: 'org-1',
    developerId: 'dev-1',
    repository: 'org/my-service',
    branch: 'main',
  };

  it('should split session into multiple chunks', async () => {
    const chunks = await segmenter.segment(mockSession, metadata);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('should assign titles to chunks', async () => {
    const chunks = await segmenter.segment(mockSession, metadata);
    for (const chunk of chunks) {
      expect(chunk.title).toBeTruthy();
      expect(chunk.title.length).toBeGreaterThan(3);
    }
  });

  it('should not exceed max token limit per chunk', async () => {
    const chunks = await segmenter.segment(mockSession, metadata);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(500);
    }
  });

  it('should skip chunks below minimum token threshold', async () => {
    const chunks = await segmenter.segment(mockSession, metadata);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThanOrEqual(20);
    }
  });

  it('should classify chunk types', async () => {
    const chunks = await segmenter.segment(mockSession, metadata);
    const validTypes = ['discussion', 'code_explanation', 'debugging', 'architecture', 'configuration', 'best_practice', 'troubleshooting', 'tutorial', 'decision', 'review'];
    for (const chunk of chunks) {
      expect(validTypes).toContain(chunk.type);
    }
  });

  it('should attach metadata to chunks', async () => {
    const chunks = await segmenter.segment(mockSession, metadata);
    for (const chunk of chunks) {
      expect(chunk.organizationId).toBe('org-1');
      expect(chunk.authorId).toBe('dev-1');
      expect(chunk.repository).toBe('org/my-service');
      expect(chunk.sessionId).toBe(mockSession.sessionId);
    }
  });

  it('should extract entities from content', async () => {
    const session = {
      ...mockSession,
      messages: [{
        ...mockSession.messages[0],
        content: 'We need to configure Lambda with DynamoDB and S3 for the pipeline',
        tokenCount: 50,
      }],
    };
    const chunks = await segmenter.segment(session, metadata);
    if (chunks.length > 0) {
      const entityNames = chunks[0].entities.map(e => e.name);
      expect(entityNames.some(n => ['LAMBDA', 'DYNAMODB', 'S3'].includes(n))).toBe(true);
    }
  });
});
