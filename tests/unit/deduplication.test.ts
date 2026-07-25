import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeduplicationEngine } from '../../src/ingestion/deduplication.js';

// Mock dependencies
vi.mock('../../src/utils/embedding.js', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Array(10).fill(0.5)),
  })),
}));

vi.mock('../../src/storage/chunk-repository.js', () => ({
  ChunkRepository: vi.fn().mockImplementation(() => ({
    searchByVector: vi.fn().mockResolvedValue([]),
    assignToCluster: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/storage/cluster-repository.js', () => ({
  ClusterRepository: vi.fn().mockImplementation(() => ({
    findByMemberChunkId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('DeduplicationEngine', () => {
  let engine: DeduplicationEngine;

  beforeEach(() => {
    engine = new DeduplicationEngine({
      embeddingSimilarityThreshold: 0.90,
      minhashThreshold: 0.70,
      titleSimilarityThreshold: 0.60,
      mergeThreshold: 0.85,
      minhashNumHashes: 64,
      shingleSize: 3,
      maxCandidates: 10,
    });
  });

  const makeChunk = (content: string, id: string = '1') => ({
    id,
    sessionId: 's1',
    title: 'Docker build optimization',
    summary: 'How to fix docker build',
    content,
    tokenCount: 50,
    type: 'debugging' as const,
    entities: [],
    codeReferences: [],
    language: 'typescript',
    languages: ['typescript'],
    frameworks: ['docker'],
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
    embedding: new Array(10).fill(0.5),
    createdAt: '2025-07-25T10:00:00Z',
    updatedAt: '2025-07-25T10:00:00Z',
  });

  it('should return isDuplicate=false when no candidates found', async () => {
    const chunk = makeChunk('A completely unique piece of content');
    const result = await engine.deduplicate(chunk);
    expect(result.isDuplicate).toBe(false);
  });

  it('should detect MinHash similarity correctly for similar content', () => {
    // Access private methods via prototype for unit testing
    const eng = engine as any;

    const shingles1 = eng.computeShingles('docker build fails with permission denied error');
    const shingles2 = eng.computeShingles('docker build fails with permission denied problem');
    const shingles3 = eng.computeShingles('kubernetes pod scheduling is complex');

    const hash1 = eng.computeMinHash(shingles1);
    const hash2 = eng.computeMinHash(shingles2);
    const hash3 = eng.computeMinHash(shingles3);

    const sim12 = eng.minhashJaccard(hash1, hash2);
    const sim13 = eng.minhashJaccard(hash1, hash3);

    // Similar content should have high MinHash similarity
    expect(sim12).toBeGreaterThan(0.5);
    // Unrelated content should have low similarity
    expect(sim13).toBeLessThan(sim12);
  });

  it('should compute Jaccard similarity between token sets', () => {
    const eng = engine as any;

    const set1 = eng.tokenize('docker build fails permission denied');
    const set2 = eng.tokenize('docker build fails access denied');
    const set3 = eng.tokenize('kubernetes pod scheduling network');

    const sim12 = eng.jaccardSimilarity(set1, set2);
    const sim13 = eng.jaccardSimilarity(set1, set3);

    expect(sim12).toBeGreaterThan(0.4); // Share most words
    expect(sim13).toBeLessThan(0.2); // Share almost none
  });

  it('should handle empty content gracefully', () => {
    const eng = engine as any;
    const shingles = eng.computeShingles('');
    expect(shingles.size).toBe(0);
  });
});
