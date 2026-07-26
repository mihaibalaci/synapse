import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock all external dependencies before importing CompactionEngine.
vi.mock('../../src/utils/llm.js', () => ({
  LlmClient: vi.fn().mockImplementation(() => ({
    disabled: false,
    generate: vi.fn(),
    getModel: vi.fn().mockReturnValue('test-model'),
    getProvider: vi.fn().mockReturnValue('openai'),
  })),
}));

vi.mock('../../src/utils/embedding.js', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.01)),
    embedBatch: vi.fn().mockResolvedValue([new Array(1536).fill(0.01)]),
    getModelName: vi.fn().mockReturnValue('test-embed'),
    getDimensions: vi.fn().mockReturnValue(1536),
  })),
}));

vi.mock('../../src/storage/chunk-repository.js', () => ({
  ChunkRepository: vi.fn().mockImplementation(() => ({
    findById: vi.fn(),
    assignToCluster: vi.fn().mockResolvedValue(undefined),
    bulkUpdateConfidence: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/storage/cluster-repository.js', () => ({
  ClusterRepository: vi.fn().mockImplementation(() => ({
    findTopClusters: vi.fn().mockResolvedValue([]),
    updateCanonical: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/storage/fact-repository.js', () => ({
  FactRepository: vi.fn().mockImplementation(() => ({
    findByTemporal: vi.fn().mockResolvedValue([]),
    findSimilar: vi.fn().mockResolvedValue([]),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/storage/database.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: vi.fn(async (fn: any) => fn({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  })),
  enterDatabaseContext: vi.fn(),
}));

import { CompactionEngine } from '../../src/ingestion/compaction.js';
import { LlmClient } from '../../src/utils/llm.js';
import { ClusterRepository } from '../../src/storage/cluster-repository.js';
import { ChunkRepository } from '../../src/storage/chunk-repository.js';
import { FactRepository } from '../../src/storage/fact-repository.js';
import { query } from '../../src/storage/database.js';

function makeChunk(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: 'session-1',
    title: `Chunk ${id}`,
    summary: `Summary of chunk ${id}`,
    content: `Content of chunk ${id} about Terraform deployment configuration`,
    tokenCount: 100,
    type: 'configuration' as const,
    entities: [{ name: 'Terraform', type: 'tool' as const }],
    codeReferences: [],
    language: 'hcl',
    languages: ['hcl'],
    frameworks: ['terraform'],
    authorId: 'dev-1',
    organizationId: 'org-1',
    confidence: 'high' as const,
    qualityScore: 0.7,
    usageCount: 2,
    upvotes: 0,
    downvotes: 0,
    isCanonical: false,
    embeddingModel: 'test-embed',
    embeddingVersion: 1,
    embedding: new Array(1536).fill(0.01),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('CompactionEngine', () => {
  let engine: CompactionEngine;
  let llmMock: ReturnType<typeof vi.fn>;
  let clusterRepoMock: any;
  let chunkRepoMock: any;
  let factRepoMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new CompactionEngine({ minClusterSize: 3 });

    // Get access to the mocked instances
    llmMock = (LlmClient as any).mock.results[0].value.generate;
    clusterRepoMock = (ClusterRepository as any).mock.results[0].value;
    chunkRepoMock = (ChunkRepository as any).mock.results[0].value;
    factRepoMock = (FactRepository as any).mock.results[0].value;
  });

  describe('cluster synthesis', () => {
    it('synthesizes a canonical from cluster members using LLM', async () => {
      const cluster = {
        id: 'cluster-1',
        organizationId: 'org-1',
        canonicalChunkId: 'chunk-1',
        memberChunkIds: ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4'],
        title: 'Terraform S3 backend',
        summary: 'How to configure S3 backend',
        mergedAt: '2026-01-01T00:00:00Z',
        memberCount: 4,
        averageSimilarity: 0.92,
      };

      clusterRepoMock.findTopClusters.mockResolvedValue([cluster]);
      chunkRepoMock.findById.mockImplementation((id: string) =>
        Promise.resolve(makeChunk(id, { isCanonical: id === 'chunk-1' })),
      );

      // Simulate LLM synthesis response
      llmMock.mockResolvedValue({
        text: 'TITLE: Terraform S3 Backend Configuration\nSUMMARY: How to configure a remote S3 backend with DynamoDB locking.\nCONTENT:\n## Terraform S3 Backend\n\nConfigure your backend block with encryption and locking [Source 1].',
        inputTokens: 500,
        outputTokens: 100,
        model: 'test-model',
      });

      const result = await engine.run('org-1');

      expect(result.clustersSynthesized).toBe(1);
      expect(result.tokensSaved).toBeGreaterThan(0);
      expect(result.llmCalls).toBe(1);
      expect(llmMock).toHaveBeenCalledOnce();
      expect(llmMock.mock.calls[0][1]).toContain('Terraform S3 backend');
    });

    it('skips synthesis when canonical was already synthesized with same sources', async () => {
      const cluster = {
        id: 'cluster-1',
        organizationId: 'org-1',
        canonicalChunkId: 'chunk-1',
        memberChunkIds: ['chunk-1', 'chunk-2', 'chunk-3'],
        title: 'Already synthesized',
        summary: 'test',
        mergedAt: '2026-01-01T00:00:00Z',
        memberCount: 3,
        averageSimilarity: 0.9,
      };

      clusterRepoMock.findTopClusters.mockResolvedValue([cluster]);

      // chunk-1 already has a synth: linkedVersion matching the source hash
      const ids = ['chunk-1', 'chunk-2', 'chunk-3'].sort().join(':');
      const { createHash } = await import('node:crypto');
      const expectedHash = createHash('sha256').update(ids).digest('hex').slice(0, 16);

      chunkRepoMock.findById.mockImplementation((id: string) =>
        Promise.resolve(makeChunk(id, {
          isCanonical: id === 'chunk-1',
          linkedVersion: id === 'chunk-1' ? `synth:${expectedHash}` : undefined,
        })),
      );

      const result = await engine.run('org-1');

      expect(result.clustersSkipped).toBe(1);
      expect(result.clustersSynthesized).toBe(0);
      expect(llmMock).not.toHaveBeenCalled();
    });

    it('falls back to quality-based re-canonicalization when LLM is disabled', async () => {
      // Replace the engine instance with one that has LLM disabled
      const disabledLlm = (LlmClient as any).mock.results[0].value;
      Object.defineProperty(disabledLlm, 'disabled', { get: () => true });

      const cluster = {
        id: 'cluster-1',
        organizationId: 'org-1',
        canonicalChunkId: 'chunk-1',
        memberChunkIds: ['chunk-1', 'chunk-2', 'chunk-3'],
        title: 'Fallback',
        summary: 'test',
        mergedAt: '2026-01-01T00:00:00Z',
        memberCount: 3,
        averageSimilarity: 0.9,
      };

      clusterRepoMock.findTopClusters.mockResolvedValue([cluster]);
      chunkRepoMock.findById.mockImplementation((id: string) =>
        Promise.resolve(makeChunk(id, {
          isCanonical: id === 'chunk-1',
          qualityScore: id === 'chunk-3' ? 0.95 : 0.5,
          usageCount: id === 'chunk-3' ? 10 : 0,
        })),
      );

      const result = await engine.run('org-1');

      // chunk-3 has the best score, so it should become canonical
      expect(result.clustersSynthesized).toBe(1);
      expect(clusterRepoMock.updateCanonical).toHaveBeenCalledWith('org-1', 'cluster-1', 'chunk-3');
      expect(llmMock).not.toHaveBeenCalled();
    });
  });

  describe('fact supersession', () => {
    it('marks an older fact as superseded when LLM detects contradiction', async () => {
      const newFact = {
        id: 'fact-new',
        content: 'Team migrated from Kafka to SQS for event streaming',
        entities: ['Kafka', 'SQS'],
        embedding: new Array(1536).fill(0.02),
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        organizationId: 'org-1',
        authorId: 'dev-1',
        type: 'decision',
        scope: 'organization',
        confidence: 0.8,
        usageCount: 0,
        upvotes: 0,
        temporal: { observedAt: '2026-07-20T00:00:00Z', temporalSource: 'inferred' },
        extractedFrom: 'assistant',
        frameworks: [],
      };

      const oldFact = {
        id: 'fact-old',
        content: 'Team uses Kafka for event streaming',
        entities: ['Kafka'],
        embedding: new Array(1536).fill(0.02),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        organizationId: 'org-1',
        authorId: 'dev-2',
        type: 'decision',
        scope: 'organization',
        confidence: 0.8,
        usageCount: 5,
        upvotes: 1,
        temporal: { observedAt: '2026-01-01T00:00:00Z', temporalSource: 'inferred' },
        extractedFrom: 'assistant',
        frameworks: [],
      };

      factRepoMock.findByTemporal.mockResolvedValue([newFact]);
      factRepoMock.findSimilar.mockResolvedValue([oldFact]);

      // LLM says they contradict
      llmMock.mockResolvedValue({
        text: 'CONTRADICTS',
        inputTokens: 50,
        outputTokens: 1,
        model: 'test-model',
      });

      const result = await engine.run('org-1');

      expect(result.factsSuperseded).toBe(1);
      expect(result.llmCalls).toBe(1);
      expect(factRepoMock.markSuperseded).toHaveBeenCalledWith('fact-old', 'fact-new');
    });

    it('does not supersede when LLM says facts are compatible', async () => {
      const newFact = {
        id: 'fact-new',
        content: 'Terraform state stored in S3',
        entities: ['Terraform', 'S3'],
        embedding: new Array(1536).fill(0.02),
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
        organizationId: 'org-1',
        authorId: 'dev-1',
        type: 'decision',
        scope: 'organization',
        confidence: 0.8,
        usageCount: 0,
        upvotes: 0,
        temporal: { observedAt: '2026-07-20T00:00:00Z', temporalSource: 'inferred' },
        extractedFrom: 'assistant',
        frameworks: [],
      };

      const oldFact = {
        id: 'fact-old',
        content: 'Deploy uses Terraform',
        entities: ['Terraform'],
        embedding: new Array(1536).fill(0.02),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        organizationId: 'org-1',
        authorId: 'dev-2',
        type: 'decision',
        scope: 'organization',
        confidence: 0.8,
        usageCount: 3,
        upvotes: 0,
        temporal: { observedAt: '2026-01-01T00:00:00Z', temporalSource: 'inferred' },
        extractedFrom: 'assistant',
        frameworks: [],
      };

      factRepoMock.findByTemporal.mockResolvedValue([newFact]);
      factRepoMock.findSimilar.mockResolvedValue([oldFact]);

      // LLM says compatible
      llmMock.mockResolvedValue({
        text: 'COMPATIBLE',
        inputTokens: 50,
        outputTokens: 1,
        model: 'test-model',
      });

      const result = await engine.run('org-1');

      expect(result.factsSuperseded).toBe(0);
      expect(factRepoMock.markSuperseded).not.toHaveBeenCalled();
    });
  });

  describe('stale pruning', () => {
    it('archives old unused low-quality non-canonical chunks', async () => {
      // When LLM is enabled, synthesis runs first (no clusters → no work), then
      // supersession (no facts → no work), then pruning issues its own query.
      // The mock must return stale rows for the pruning SELECT.
      const queryMock = query as unknown as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({ rows: [{ id: 'stale-1' }, { id: 'stale-2' }], rowCount: 2 });

      const result = await engine.run('org-1');

      expect(result.chunksArchived).toBe(2);
      expect(chunkRepoMock.bulkUpdateConfidence).toHaveBeenCalledWith([
        { id: 'stale-1', confidence: 'archived' },
        { id: 'stale-2', confidence: 'archived' },
      ]);
    });
  });
});
