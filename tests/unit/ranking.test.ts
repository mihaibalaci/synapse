import { describe, it, expect } from 'vitest';
import { RankingEngine } from '../../src/retrieval/ranking.js';

describe('RankingEngine', () => {
  const engine = new RankingEngine();

  const makeCandidate = (overrides: any = {}) => ({
    chunk: {
      id: '1',
      sessionId: 's1',
      title: 'Test',
      summary: 'Test summary',
      content: 'Test content',
      tokenCount: 100,
      type: 'discussion',
      entities: [],
      codeReferences: [],
      language: 'typescript',
      languages: ['typescript'],
      frameworks: [],
      authorId: 'dev-1',
      organizationId: 'org-1',
      confidence: 'high',
      qualityScore: 0.7,
      usageCount: 10,
      upvotes: 5,
      downvotes: 0,
      isCanonical: false,
      embeddingModel: 'test',
      embeddingVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides.chunk,
    },
    scores: {
      semantic: 0.8,
      keyword: 0.5,
      entityMatch: 0,
      temporal: 0.9,
      graphRelevance: 0,
      ...overrides.scores,
    },
    source: overrides.source ?? 'vector',
  });

  const mockRequest: any = {
    query: 'test query',
    context: { repository: 'org/service' },
    developerId: 'dev-1',
    organizationId: 'org-1',
    topK: 5,
    offset: 0,
    strategy: 'hybrid',
    includeContent: true,
  };

  it('should rank candidates by final score (descending)', async () => {
    const candidates = [
      makeCandidate({ scores: { semantic: 0.5, keyword: 0.3, entityMatch: 0, temporal: 0.5, graphRelevance: 0 } }),
      makeCandidate({ scores: { semantic: 0.95, keyword: 0.8, entityMatch: 0.5, temporal: 0.9, graphRelevance: 0 }, chunk: { id: '2' } }),
      makeCandidate({ scores: { semantic: 0.7, keyword: 0.6, entityMatch: 0, temporal: 0.7, graphRelevance: 0 }, chunk: { id: '3' } }),
    ];

    const ranked = await engine.rank(candidates, mockRequest);

    expect(ranked[0].chunk.id).toBe('2'); // Highest scores
    expect(ranked[0].finalScore).toBeGreaterThan(ranked[1].finalScore);
    expect(ranked[1].finalScore).toBeGreaterThan(ranked[2].finalScore);
  });

  it('should penalize stale confidence', async () => {
    const fresh = makeCandidate({ chunk: { id: 'fresh', confidence: 'high' } });
    const stale = makeCandidate({ chunk: { id: 'stale', confidence: 'low' }, scores: { semantic: 0.8, keyword: 0.5, entityMatch: 0, temporal: 0.9, graphRelevance: 0 } });

    const ranked = await engine.rank([stale, fresh], mockRequest);

    const freshResult = ranked.find(r => r.chunk.id === 'fresh')!;
    const staleResult = ranked.find(r => r.chunk.id === 'stale')!;
    expect(freshResult.finalScore).toBeGreaterThan(staleResult.finalScore);
  });

  it('should boost canonical chunks', async () => {
    const canonical = makeCandidate({ chunk: { id: 'can', isCanonical: true } });
    const regular = makeCandidate({ chunk: { id: 'reg', isCanonical: false } });

    const ranked = await engine.rank([regular, canonical], mockRequest);

    const canonicalResult = ranked.find(r => r.chunk.id === 'can')!;
    const regularResult = ranked.find(r => r.chunk.id === 'reg')!;
    expect(canonicalResult.finalScore).toBeGreaterThanOrEqual(regularResult.finalScore);
  });

  it('should apply diversity constraint (max 2 from same session)', async () => {
    const candidates = [
      makeCandidate({ chunk: { id: '1', sessionId: 'same' }, scores: { semantic: 0.95, keyword: 0.9, entityMatch: 0, temporal: 0.9, graphRelevance: 0 } }),
      makeCandidate({ chunk: { id: '2', sessionId: 'same' }, scores: { semantic: 0.93, keyword: 0.85, entityMatch: 0, temporal: 0.9, graphRelevance: 0 } }),
      makeCandidate({ chunk: { id: '3', sessionId: 'same' }, scores: { semantic: 0.91, keyword: 0.8, entityMatch: 0, temporal: 0.9, graphRelevance: 0 } }),
      makeCandidate({ chunk: { id: '4', sessionId: 'different' }, scores: { semantic: 0.6, keyword: 0.4, entityMatch: 0, temporal: 0.5, graphRelevance: 0 } }),
    ];

    const ranked = await engine.rank(candidates, mockRequest);

    // 3rd result from 'same' session should be penalized, 'different' may rank above it
    const thirdSame = ranked.find(r => r.chunk.id === '3')!;
    expect(thirdSame.finalScore).toBeLessThan(ranked[0].finalScore * 0.6);
  });

  it('should produce scores between 0 and 1', async () => {
    const candidates = [makeCandidate()];
    const ranked = await engine.rank(candidates, mockRequest);

    for (const r of ranked) {
      expect(r.finalScore).toBeGreaterThanOrEqual(0);
      expect(r.finalScore).toBeLessThanOrEqual(1);
    }
  });
});
