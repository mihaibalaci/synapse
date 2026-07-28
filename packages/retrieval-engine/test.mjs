import {
  rrfFuse,
  rankCandidates,
  packByTokenBudget,
  computeTemporalScores,
  batchCosineSimilarity,
  batchEntityOverlap,
} from './index.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('Synapse Retrieval Engine — Rust Native Module Tests');
console.log('═══════════════════════════════════════════════════\n');

// ─── RRF Fusion ──────────────────────────────────────────────────────────────
console.log('RRF Fusion:');
{
  const result = rrfFuse([
    ['a', 'b', 'c', 'd'],
    ['b', 'a', 'd', 'c'],
    ['a', 'c', 'b', 'd'],
  ], 60);
  assert(result[0] === 'a', 'Top result is "a" (appears in top 2 of all lists)');
  assert(result[1] === 'b', 'Second result is "b"');
  assert(result.length === 4, 'All 4 unique items returned');
}

// ─── Composite Ranking ───────────────────────────────────────────────────────
console.log('\nComposite Ranking:');
{
  const now = Date.now();
  const candidates = [
    {
      id: 'chunk-1', sessionId: 'session-1', contentLength: 500, tokenCount: 125,
      qualityScore: 0.9, usageCount: 50, upvotes: 10, createdAtMs: now - 86400000, // 1 day ago
      lastAccessedAtMs: now - 3600000, confidence: 'high', repository: 'org/service',
      scores: { semantic: 0.95, keyword: 0.8, entityMatch: 0.5, temporal: 0.9, graphRelevance: 0.3 },
      source: 'vector',
    },
    {
      id: 'chunk-2', sessionId: 'session-2', contentLength: 300, tokenCount: 75,
      qualityScore: 0.5, usageCount: 2, upvotes: 0, createdAtMs: now - 86400000 * 90, // 90 days ago
      confidence: 'low', repository: 'org/other',
      scores: { semantic: 0.7, keyword: 0.3, entityMatch: 0.1, temporal: 0.2, graphRelevance: 0.0 },
      source: 'keyword',
    },
  ];
  const weights = {
    semantic: 0.30, keyword: 0.10, freshness: 0.12, repoMatch: 0.15,
    authorReputation: 0.05, usage: 0.10, upvotes: 0.05, quality: 0.08, graph: 0.05,
  };
  const context = { queryRepository: 'org/service', nowMs: now };

  const result = rankCandidates(candidates, weights, context);
  assert(result.length === 2, 'Returns 2 scored candidates');
  assert(result[0].id === 'chunk-1', 'High-quality recent chunk ranks first');
  assert(result[0].finalScore > result[1].finalScore, 'Score ordering correct');
  assert(result[0].repoMatchContribution > 0, 'Repository match contributes to score');
  assert(result[0].semanticContribution > 0.2, 'Semantic is the largest contributor');
}

// ─── Token Budget Packing ────────────────────────────────────────────────────
console.log('\nToken Budget Packing:');
{
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const tokens = [100, 200, 150, 300, 50];

  const result = packByTokenBudget(ids, tokens, 400);
  // 100 <= 400 → include (remaining=300). 200 <= 300 → include (remaining=100). 150 > 100 → stop.
  assert(result.length === 2, 'Packs 2 items within 400 token budget (100+200=300, next 150 exceeds remaining 100)');
  assert(result[0] === 'a', 'First item included');
  assert(result[1] === 'b', 'Second item included');

  // Edge case: budget smaller than first item
  const result2 = packByTokenBudget(['x'], [500], 100);
  assert(result2.length === 1, 'Always returns at least 1 result even if over budget');
}

// ─── Temporal Scores ─────────────────────────────────────────────────────────
console.log('\nTemporal Scores:');
{
  const now = Date.now();
  const scores = computeTemporalScores(
    [now - 86400000, now - 86400000 * 30, now - 86400000 * 180], // 1d, 30d, 180d ago
    [now - 3600000, null, null], // first was accessed 1h ago
    ['high', 'high', 'archived'],
    now,
    130.0,
  );
  assert(scores.length === 3, 'Returns 3 scores');
  assert(scores[0] > scores[1], 'Recent item scores higher than 30-day old');
  assert(scores[1] > scores[2], '30-day item scores higher than 180-day archived');
  assert(scores[0] > 0.9, 'Very recent + recently accessed gets high score');
  assert(scores[2] < 0.2, 'Old archived item gets very low score');
}

// ─── Batch Cosine Similarity ─────────────────────────────────────────────────
console.log('\nCosine Similarity:');
{
  const query = [1.0, 0.0, 0.0];
  const candidates = [
    [1.0, 0.0, 0.0],  // identical
    [0.0, 1.0, 0.0],  // orthogonal
    [0.7, 0.7, 0.0],  // ~45 degrees
  ];
  const sims = batchCosineSimilarity(query, candidates);
  assert(Math.abs(sims[0] - 1.0) < 0.001, 'Identical vectors = 1.0');
  assert(Math.abs(sims[1]) < 0.001, 'Orthogonal vectors = 0.0');
  assert(sims[2] > 0.6 && sims[2] < 0.8, '45-degree vectors ~0.707');
}

// ─── Batch Entity Overlap ────────────────────────────────────────────────────
console.log('\nEntity Overlap:');
{
  const query = ['Kafka', 'Redis'];
  const candidates = [
    ['kafka', 'redis', 'postgres'], // full overlap (case insensitive)
    ['Lambda', 'S3'],               // no overlap
    ['Kafka'],                      // partial overlap
  ];
  const overlaps = batchEntityOverlap(query, candidates);
  assert(overlaps[0] > 0.5, 'Full overlap > 0.5 (Jaccard 2/3)');
  assert(overlaps[1] === 0.0, 'No overlap = 0.0');
  assert(overlaps[2] > 0.3, 'Partial overlap (1 shared out of 2 unique) = 1/2 Jaccard');
}

// ─── Performance Test ────────────────────────────────────────────────────────
console.log('\nPerformance:');
{
  const now = Date.now();
  const N = 1000;
  const candidates = Array.from({ length: N }, (_, i) => ({
    id: `chunk-${i}`, sessionId: `session-${i % 50}`, contentLength: 500, tokenCount: 125,
    qualityScore: Math.random(), usageCount: Math.floor(Math.random() * 100),
    upvotes: Math.floor(Math.random() * 20), createdAtMs: now - Math.random() * 86400000 * 180,
    lastAccessedAtMs: Math.random() > 0.5 ? now - Math.random() * 86400000 * 7 : undefined,
    confidence: ['high', 'medium', 'low'][Math.floor(Math.random() * 3)],
    repository: Math.random() > 0.5 ? 'org/service' : 'org/other',
    scores: { semantic: Math.random(), keyword: Math.random() * 0.5, entityMatch: Math.random() * 0.3, temporal: Math.random(), graphRelevance: Math.random() * 0.2 },
    source: 'vector',
  }));
  const weights = { semantic: 0.30, keyword: 0.10, freshness: 0.12, repoMatch: 0.15, authorReputation: 0.05, usage: 0.10, upvotes: 0.05, quality: 0.08, graph: 0.05 };

  const start = performance.now();
  const iterations = 100;
  for (let i = 0; i < iterations; i++) {
    rankCandidates(candidates, weights, { queryRepository: 'org/service', nowMs: now });
  }
  const elapsed = performance.now() - start;
  const perCall = elapsed / iterations;

  console.log(`  ${N} candidates × ${iterations} iterations = ${elapsed.toFixed(1)}ms total`);
  console.log(`  Per call: ${perCall.toFixed(2)}ms`);
  assert(perCall < 5.0, `Ranking 1000 candidates takes < 5ms (got ${perCall.toFixed(2)}ms)`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
