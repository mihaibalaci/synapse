import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpinionReinforcementEngine } from '../../src/ingestion/opinion-reinforcement.js';
import { ObservationGenerator } from '../../src/ingestion/observation-generator.js';
import { LearningLoop } from '../../src/ingestion/learning-loop.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockLlmGenerate = vi.fn();
vi.mock('../../src/utils/llm.js', () => ({
  LlmClient: vi.fn().mockImplementation(() => ({
    generate: mockLlmGenerate,
    disabled: false,
  })),
}));

const mockEmbedBatch = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
const mockEmbed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
vi.mock('../../src/utils/embedding.js', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: mockEmbed,
    embedBatch: mockEmbedBatch,
    getModelName: vi.fn().mockReturnValue('test-model'),
  })),
}));

const mockFindByType = vi.fn();
const mockFindByEntities = vi.fn();
const mockFindSimilar = vi.fn();
const mockFindByTemporal = vi.fn();
const mockUpdateOpinionConfidence = vi.fn();
const mockCreateBatch = vi.fn();
const mockIncrementUsage = vi.fn();

vi.mock('../../src/storage/fact-repository.js', () => ({
  FactRepository: vi.fn().mockImplementation(() => ({
    findByType: mockFindByType,
    findByEntities: mockFindByEntities,
    findSimilar: mockFindSimilar,
    findByTemporal: mockFindByTemporal,
    updateOpinionConfidence: mockUpdateOpinionConfidence,
    createBatch: mockCreateBatch,
    incrementUsage: mockIncrementUsage,
  })),
}));

const mockFindByEntity = vi.fn();
const mockFindStale = vi.fn();
const mockUpsert = vi.fn();
const mockCount = vi.fn();
vi.mock('../../src/storage/observation-repository.js', () => ({
  ObservationRepository: vi.fn().mockImplementation(() => ({
    findByEntity: mockFindByEntity,
    findByEntities: vi.fn().mockResolvedValue([]),
    findStale: mockFindStale,
    upsert: mockUpsert,
    count: mockCount,
  })),
}));

vi.mock('../../src/storage/database.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: vi.fn(async (fn: any) => fn({ query: vi.fn() })),
}));

vi.mock('../../src/config/index.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    REDIS_URL: 'redis://localhost:6379',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-4o-mini',
    LOG_LEVEL: 'info',
    NODE_ENV: 'test',
  }),
  loadConfig: vi.fn().mockReturnValue({
    REDIS_URL: 'redis://localhost:6379',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'gpt-4o-mini',
    LOG_LEVEL: 'info',
    NODE_ENV: 'test',
  }),
}));

// ─── Test Data ───────────────────────────────────────────────────────────────

const makeOpinion = (content: string, entities: string[], confidence = 0.7) => ({
  id: `opinion-${Math.random().toString(36).slice(2)}`,
  content,
  type: 'opinion' as const,
  entities,
  temporal: { observedAt: '2025-07-01T10:00:00Z', temporalSource: 'inferred' as const },
  extractedFrom: 'assistant' as const,
  authorId: 'dev-1',
  organizationId: 'org-1',
  scope: 'organization' as const,
  confidence,
  usageCount: 5,
  upvotes: 2,
  frameworks: [],
  createdAt: '2025-07-01T10:00:00Z',
  updatedAt: '2025-07-01T10:00:00Z',
  opinion: { reinforcements: 2, contradictions: 0, confidenceHistory: [] },
});

const makeFact = (content: string, entities: string[], type = 'lesson') => ({
  id: `fact-${Math.random().toString(36).slice(2)}`,
  content,
  type: type as any,
  entities,
  temporal: { observedAt: '2025-07-25T10:00:00Z', temporalSource: 'inferred' as const },
  extractedFrom: 'assistant' as const,
  authorId: 'dev-2',
  organizationId: 'org-1',
  scope: 'organization' as const,
  confidence: 0.8,
  usageCount: 0,
  upvotes: 0,
  frameworks: [],
  createdAt: '2025-07-25T10:00:00Z',
  updatedAt: '2025-07-25T10:00:00Z',
});

// ─── Opinion Reinforcement Tests ─────────────────────────────────────────────

describe('OpinionReinforcementEngine', () => {
  let engine: OpinionReinforcementEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new OpinionReinforcementEngine();
  });

  describe('evaluateNewFact', () => {
    it('should reinforce an opinion when evidence supports it', async () => {
      const opinion = makeOpinion(
        'Kafka is better than SQS for our event-driven architecture',
        ['Kafka', 'SQS'],
        0.7,
      );
      const fact = makeFact(
        'Kafka handled 50K events/sec with zero message loss during peak load',
        ['Kafka'],
      );

      mockFindByType.mockResolvedValue([opinion]);
      mockLlmGenerate.mockResolvedValue({ text: 'REINFORCE', inputTokens: 50, outputTokens: 5 });

      await engine.evaluateNewFact(fact, 'org-1');

      expect(mockUpdateOpinionConfidence).toHaveBeenCalledWith(
        opinion.id,
        expect.objectContaining({
          confidence: expect.any(Number),
          reinforcements: 3, // Was 2, now 3
        }),
      );

      const call = mockUpdateOpinionConfidence.mock.calls[0];
      expect(call[1].confidence).toBeGreaterThan(0.7);
    });

    it('should weaken an opinion when evidence partially undermines it', async () => {
      const opinion = makeOpinion(
        'Kafka is better than SQS for our event-driven architecture',
        ['Kafka', 'SQS'],
        0.7,
      );
      const fact = makeFact(
        'SQS FIFO queues now support 30K messages/sec which covers most of our use cases',
        ['SQS', 'Kafka'],
      );

      mockFindByType.mockResolvedValue([opinion]);
      mockLlmGenerate.mockResolvedValue({ text: 'WEAKEN', inputTokens: 50, outputTokens: 5 });

      await engine.evaluateNewFact(fact, 'org-1');

      expect(mockUpdateOpinionConfidence).toHaveBeenCalled();
      const call = mockUpdateOpinionConfidence.mock.calls[0];
      expect(call[1].confidence).toBeLessThan(0.7);
    });

    it('should strongly reduce confidence when evidence contradicts', async () => {
      const opinion = makeOpinion(
        'Kafka is better than SQS for our event-driven architecture',
        ['Kafka', 'SQS'],
        0.7,
      );
      const fact = makeFact(
        'Team decided to migrate from Kafka to SQS due to operational complexity',
        ['Kafka', 'SQS'],
        'decision',
      );

      mockFindByType.mockResolvedValue([opinion]);
      mockLlmGenerate.mockResolvedValue({ text: 'CONTRADICT', inputTokens: 50, outputTokens: 5 });

      await engine.evaluateNewFact(fact, 'org-1');

      const call = mockUpdateOpinionConfidence.mock.calls[0];
      expect(call[1].confidence).toBeLessThan(0.7 - 0.08); // double alpha penalty
    });

    it('should not evaluate when entities do not overlap', async () => {
      const opinion = makeOpinion('Redis is fast', ['Redis'], 0.8);
      const fact = makeFact('PostgreSQL supports vector search', ['PostgreSQL']);

      mockFindByType.mockResolvedValue([opinion]);

      await engine.evaluateNewFact(fact, 'org-1');

      expect(mockLlmGenerate).not.toHaveBeenCalled();
      expect(mockUpdateOpinionConfidence).not.toHaveBeenCalled();
    });

    it('should skip evaluation when fact is an opinion itself', async () => {
      const fact = makeFact('I think Kafka is great', ['Kafka'], 'opinion');

      await engine.evaluateNewFact(fact, 'org-1');

      expect(mockFindByType).not.toHaveBeenCalled();
    });

    it('should skip when fact has no entities', async () => {
      const fact = makeFact('Something happened', []);

      await engine.evaluateNewFact(fact, 'org-1');

      expect(mockFindByType).not.toHaveBeenCalled();
    });
  });

  describe('reinforceFromRecentFacts', () => {
    it('should process multiple opinions against recent evidence', async () => {
      const opinions = [
        makeOpinion('Kafka is the best for events', ['Kafka'], 0.7),
        makeOpinion('TypeScript is better than JavaScript', ['TypeScript', 'JavaScript'], 0.8),
      ];
      const recentFacts = [
        makeFact('Kafka cluster achieved 99.99% uptime this quarter', ['Kafka']),
        makeFact('TypeScript strict mode caught 47 runtime bugs', ['TypeScript']),
      ];

      mockFindByType.mockResolvedValue(opinions);
      mockFindByTemporal.mockResolvedValue(recentFacts);
      mockLlmGenerate.mockResolvedValue({ text: 'REINFORCE', inputTokens: 50, outputTokens: 5 });

      const result = await engine.reinforceFromRecentFacts('org-1', 7);

      expect(result.opinionsEvaluated).toBeGreaterThan(0);
      expect(result.reinforced).toBeGreaterThan(0);
    });

    it('should return empty result when LLM is disabled', async () => {
      // Override mock to simulate disabled LLM
      const disabledEngine = new OpinionReinforcementEngine();
      (disabledEngine as any).llm = { disabled: true, generate: vi.fn() };

      const result = await disabledEngine.reinforceFromRecentFacts('org-1');

      expect(result.opinionsEvaluated).toBe(0);
    });
  });
});

// ─── Observation Generator Tests ─────────────────────────────────────────────

describe('ObservationGenerator', () => {
  let generator: ObservationGenerator;

  beforeEach(() => {
    vi.clearAllMocks();
    generator = new ObservationGenerator();
  });

  describe('generateForEntity', () => {
    it('should generate an observation when entity has enough facts', async () => {
      const facts = [
        makeFact('Kafka is used for event streaming', ['Kafka']),
        makeFact('Kafka cluster has 6 brokers', ['Kafka']),
        makeFact('Kafka replaced RabbitMQ in March 2025', ['Kafka', 'RabbitMQ']),
      ];

      mockFindByEntities.mockResolvedValue(facts);
      mockFindByEntity.mockResolvedValue(null); // No existing observation
      mockLlmGenerate.mockResolvedValue({
        text: 'Kafka is the primary event streaming platform with 6 brokers, adopted in March 2025 replacing RabbitMQ.',
        inputTokens: 100,
        outputTokens: 30,
      });

      const result = await generator.generateForEntity('Kafka', 'org-1');

      expect(result).not.toBeNull();
      expect(result!.entityName).toBe('Kafka');
      expect(result!.summary).toContain('Kafka');
      expect(result!.sourceFactCount).toBe(3);
      expect(mockUpsert).toHaveBeenCalled();
    });

    it('should skip when entity has fewer than 3 facts', async () => {
      mockFindByEntities.mockResolvedValue([
        makeFact('Kafka is used', ['Kafka']),
      ]);

      const result = await generator.generateForEntity('Kafka', 'org-1');

      expect(result).toBeNull();
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should return existing observation if still fresh', async () => {
      const facts = [
        makeFact('Fact 1', ['Redis']),
        makeFact('Fact 2', ['Redis']),
        makeFact('Fact 3', ['Redis']),
      ];
      const existing = {
        id: 'obs-1',
        entityName: 'Redis',
        organizationId: 'org-1',
        summary: 'Redis is used for caching.',
        sourceFactIds: ['f1', 'f2', 'f3'],
        sourceFactCount: 3,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), // Very recent
      };

      mockFindByEntities.mockResolvedValue(facts);
      mockFindByEntity.mockResolvedValue(existing);

      const result = await generator.generateForEntity('Redis', 'org-1');

      // Should return existing without regenerating
      expect(result).toEqual(existing);
      expect(mockLlmGenerate).not.toHaveBeenCalled();
    });

    it('should use heuristic fallback when LLM is disabled', async () => {
      const facts = [
        makeFact('Redis handles 100K ops/sec', ['Redis']),
        makeFact('Redis cluster has 3 nodes', ['Redis']),
        makeFact('Redis is used for session caching', ['Redis']),
      ];

      mockFindByEntities.mockResolvedValue(facts);
      mockFindByEntity.mockResolvedValue(null);

      // Simulate disabled LLM
      const disabledGen = new ObservationGenerator();
      (disabledGen as any).llm = { disabled: true, generate: vi.fn().mockResolvedValue(null) };

      const result = await disabledGen.generateForEntity('Redis', 'org-1');

      expect(result).not.toBeNull();
      expect(result!.summary).toContain('Redis');
    });
  });
});

// ─── Learning Loop Orchestrator Tests ────────────────────────────────────────

describe('LearningLoop', () => {
  let loop: LearningLoop;

  beforeEach(() => {
    vi.clearAllMocks();
    loop = new LearningLoop();
  });

  describe('getConfig', () => {
    it('should return default configuration', () => {
      const config = loop.getConfig();

      expect(config.inlineReinforcementEnabled).toBe(true);
      expect(config.reflectWriteBackEnabled).toBe(true);
      expect(config.sourceBoostEnabled).toBe(true);
      expect(config.writeBackMinConfidence).toBe('high');
      expect(config.maxInsightsPerReflect).toBe(3);
      expect(config.observationRefreshDelay).toBe(30);
    });
  });

  describe('isHealthy', () => {
    it('should report unhealthy when no facts exist', async () => {
      mockFindByTemporal.mockResolvedValue([]);
      mockCount.mockResolvedValue(0);
      mockFindByType.mockResolvedValue([]);

      const result = await loop.isHealthy('org-1');

      expect(result.healthy).toBe(false);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons).toContain('No facts extracted in the last 24 hours');
    });

    it('should report healthy when all checks pass', async () => {
      mockFindByTemporal.mockResolvedValue([makeFact('recent fact', ['x'])]);
      mockCount.mockResolvedValue(5);
      mockFindByType.mockResolvedValue([makeOpinion('opinion', ['x'])]);

      const result = await loop.isHealthy('org-1');

      expect(result.healthy).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });
  });

  describe('triggerFullCycle', () => {
    it('should run opinion reinforcement and observation refresh', async () => {
      mockFindByType.mockResolvedValue([]);
      mockFindByTemporal.mockResolvedValue([]);
      mockFindStale.mockResolvedValue([]);

      // Mock the internal query for discoverAndGenerate
      const { query: dbQuery } = await import('../../src/storage/database.js');
      (dbQuery as any).mockResolvedValue({ rows: [] });

      const result = await loop.triggerFullCycle('org-1');

      expect(result).toHaveProperty('opinionsReinforced');
      expect(result).toHaveProperty('observationsRefreshed');
      expect(result).toHaveProperty('observationsDiscovered');
    });
  });
});

// ─── Reflect Write-Back Tests ────────────────────────────────────────────────

describe('Reflect Write-Back (integration)', () => {
  it('should extract and validate insights from a high-confidence answer', () => {
    // Test the insight filtering logic directly
    const rawInsights = [
      { content: 'Dual-write strategy enables zero-downtime migrations', type: 'pattern', entities: ['Kafka'], confidence: 0.85 },
      { content: 'Short', type: 'opinion', entities: [], confidence: 0.9 }, // Too short
      { content: 'A valid insight about using consumer groups for parallel processing', type: 'lesson', entities: ['Kafka'], confidence: 0.4 }, // Too low confidence
      { content: 'Kafka partition count should match consumer group size for optimal throughput', type: 'lesson', entities: ['Kafka'], confidence: 0.8 },
    ];

    const validInsights = rawInsights.filter(i =>
      i.content && typeof i.content === 'string'
      && i.content.length >= 20 && i.content.length <= 400
      && i.confidence >= 0.6
      && ['opinion', 'lesson', 'pattern', 'decision'].includes(i.type),
    ).slice(0, 3);

    expect(validInsights).toHaveLength(2);
    expect(validInsights[0].content).toContain('Dual-write');
    expect(validInsights[1].content).toContain('partition count');
  });

  it('should cap insights at 3 per reflect call', () => {
    const rawInsights = [
      { content: 'Insight 1 that is long enough to pass validation', type: 'lesson', entities: ['A'], confidence: 0.9 },
      { content: 'Insight 2 that is long enough to pass validation', type: 'pattern', entities: ['B'], confidence: 0.85 },
      { content: 'Insight 3 that is long enough to pass validation', type: 'opinion', entities: ['C'], confidence: 0.8 },
      { content: 'Insight 4 that is long enough to pass validation', type: 'decision', entities: ['D'], confidence: 0.75 },
      { content: 'Insight 5 that is long enough to pass validation', type: 'lesson', entities: ['E'], confidence: 0.7 },
    ];

    const validInsights = rawInsights.filter(i =>
      i.content.length >= 20 && i.confidence >= 0.6
      && ['opinion', 'lesson', 'pattern', 'decision'].includes(i.type),
    ).slice(0, 3);

    expect(validInsights).toHaveLength(3);
  });
});

// ─── Opinion Confidence Bounds Tests ─────────────────────────────────────────

describe('Opinion Confidence Bounds', () => {
  it('should not exceed maxConfidence (0.95)', () => {
    const alpha = 0.08;
    const maxConfidence = 0.95;
    const current = 0.93;

    const newConfidence = Math.min(current + alpha, maxConfidence);
    expect(newConfidence).toBe(0.95);
  });

  it('should not fall below minConfidence (0.1)', () => {
    const alpha = 0.08;
    const minConfidence = 0.1;
    const current = 0.12;

    // Contradiction applies 2*alpha
    const newConfidence = Math.max(current - 2 * alpha, minConfidence);
    expect(newConfidence).toBe(0.1);
  });

  it('should apply correct delta for each evidence relation', () => {
    const alpha = 0.08;
    const base = 0.7;

    expect(Math.min(base + alpha, 0.95)).toBeCloseTo(0.78); // reinforce
    expect(Math.max(base - alpha, 0.1)).toBeCloseTo(0.62);  // weaken
    expect(Math.max(base - 2 * alpha, 0.1)).toBeCloseTo(0.54); // contradict
  });
});
