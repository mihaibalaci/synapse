import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FactExtractor } from '../../src/ingestion/fact-extractor.js';

// Mock dependencies
vi.mock('../../src/utils/embedding.js', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    getModelName: vi.fn().mockReturnValue('test-model'),
  })),
}));

vi.mock('../../src/storage/chunk-repository.js', () => ({
  ChunkRepository: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/storage/fact-repository.js', () => ({
  FactRepository: vi.fn().mockImplementation(() => ({
    createBatch: vi.fn().mockResolvedValue(undefined),
    findSimilar: vi.fn().mockResolvedValue([]),
  })),
}));

describe('FactExtractor', () => {
  let extractor: FactExtractor;

  beforeEach(() => {
    extractor = new FactExtractor();
  });

  const makeChunk = (content: string, overrides?: any) => ({
    id: '00000000-0000-0000-0000-000000000001',
    sessionId: '00000000-0000-0000-0000-000000000002',
    title: 'Test chunk',
    summary: 'Test summary',
    content,
    tokenCount: Math.ceil(content.length / 4),
    type: 'discussion' as const,
    entities: [],
    codeReferences: [],
    repository: 'org/service',
    branch: 'main',
    language: 'typescript',
    languages: ['typescript'],
    frameworks: [],
    authorId: 'dev-1',
    organizationId: 'org-1',
    confidence: 'high' as const,
    qualityScore: 0.7,
    usageCount: 0,
    upvotes: 0,
    downvotes: 0,
    isCanonical: false,
    embeddingModel: 'test',
    embeddingVersion: 1,
    createdAt: '2025-07-25T10:00:00Z',
    updatedAt: '2025-07-25T10:00:00Z',
    ...overrides,
  });

  it('should extract decision facts', async () => {
    const chunk = makeChunk(
      'USER: What should we use for messaging?\n\n' +
      'ASSISTANT: We decided to use Kafka for event streaming between services because it handles high throughput better than RabbitMQ.'
    );

    const facts = await extractor.extract(chunk);
    expect(facts.length).toBeGreaterThanOrEqual(1);

    const decision = facts.find(f => f.type === 'decision');
    expect(decision).toBeDefined();
    expect(decision!.content).toContain('Kafka');
  });

  it('should extract lesson facts', async () => {
    const chunk = makeChunk(
      'USER: Why was Lambda timing out?\n\n' +
      'ASSISTANT: The root cause was VPC DNS resolution. It turned out that the Lambda function needed a VPC endpoint for S3.'
    );

    const facts = await extractor.extract(chunk);
    const lesson = facts.find(f => f.type === 'lesson');
    expect(lesson).toBeDefined();
    expect(lesson!.content).toContain('root cause');
  });

  it('should extract pattern facts', async () => {
    const chunk = makeChunk(
      'ASSISTANT: You should always use exponential backoff when retrying DynamoDB writes. Never use a fixed delay.'
    );

    const facts = await extractor.extract(chunk);
    const pattern = facts.find(f => f.type === 'pattern');
    expect(pattern).toBeDefined();
  });

  it('should extract constraint facts with numbers', async () => {
    const chunk = makeChunk(
      'ASSISTANT: The maximum payload size for API Gateway is 10MB. You cannot exceed this limit without using a streaming endpoint.'
    );

    const facts = await extractor.extract(chunk);
    const constraint = facts.find(f => f.type === 'constraint');
    expect(constraint).toBeDefined();
    expect(constraint!.content).toContain('10MB');
  });

  it('should extract entities from facts', async () => {
    const chunk = makeChunk(
      'ASSISTANT: We decided to use PostgreSQL with pgvector for the embedding store instead of Pinecone.'
    );

    const facts = await extractor.extract(chunk);
    if (facts.length > 0) {
      const allEntities = facts.flatMap(f => f.entities);
      expect(allEntities.some(e => /postgres/i.test(e))).toBe(true);
    }
  });

  it('should return empty array for trivial content', async () => {
    const chunk = makeChunk('USER: Hello\n\nASSISTANT: Hi there!');
    const facts = await extractor.extract(chunk);
    expect(facts).toHaveLength(0);
  });

  it('should assign confidence scores between 0 and 1', async () => {
    const chunk = makeChunk(
      'ASSISTANT: The fix is to add a VPC endpoint. This resolved the timeout issue completely.'
    );

    const facts = await extractor.extract(chunk);
    for (const fact of facts) {
      expect(fact.confidence).toBeGreaterThanOrEqual(0);
      expect(fact.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('should link facts back to source chunk and session', async () => {
    const chunk = makeChunk(
      'ASSISTANT: We decided to migrate from REST to gRPC for internal service communication.'
    );

    const facts = await extractor.extract(chunk);
    for (const fact of facts) {
      expect(fact.sourceChunkId).toBe(chunk.id);
      expect(fact.sourceSessionId).toBe(chunk.sessionId);
      expect(fact.organizationId).toBe(chunk.organizationId);
    }
  });

  it('should limit facts to at most 8 per chunk', async () => {
    const chunk = makeChunk(
      Array(20).fill(
        'ASSISTANT: We decided to use something new. The root cause was found. Always use best practices. The maximum limit is 100.'
      ).join('\n')
    );

    const facts = await extractor.extract(chunk);
    expect(facts.length).toBeLessThanOrEqual(8);
  });
});
