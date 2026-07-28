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
console.log(`Retrieval Engine: ${passed} passed, ${failed} failed`);
// Don't exit here — dedup tests follow


// ─── DEDUP + EMBEDDING PIPELINE TESTS ────────────────────────────────────────

import {
  computeMinhash,
  batchComputeMinhash,
  minhashJaccard,
  batchMinhashJaccard,
  scoreDedupCandidates,
  titleJaccardSimilarity,
  batchTitleSimilarity,
  validateEmbedding,
  batchValidateEmbeddings,
  generateLocalEmbeddings,
  fnv1AFingerprint,
  batchFnv1AFingerprint,
} from './index.js';

console.log('\n═══════════════════════════════════════════════════');
console.log('Dedup + Embedding Pipeline — Rust Native Tests');
console.log('═══════════════════════════════════════════════════\n');

let dedupPassed = 0;
let dedupFailed = 0;

function assert2(condition, msg) {
  if (condition) { dedupPassed++; console.log(`  ✓ ${msg}`); }
  else { dedupFailed++; console.error(`  ✗ ${msg}`); }
}

// ─── MinHash ─────────────────────────────────────────────────────────────────
console.log('MinHash:');
{
  const sig = computeMinhash('Lambda timeout in VPC due to DNS resolution delay', 128, 3);
  assert2(sig.length === 128, 'Produces 128-element signature');
  assert2(sig.every(v => v >= 0), 'All values are non-negative u32');

  // Same text should produce same signature
  const sig2 = computeMinhash('Lambda timeout in VPC due to DNS resolution delay', 128, 3);
  assert2(JSON.stringify(sig) === JSON.stringify(sig2), 'Deterministic: same text = same signature');

  // Different text should produce different signature
  const sigDiff = computeMinhash('React hooks and state management with Redux', 128, 3);
  const jaccard = minhashJaccard(sig, sigDiff);
  assert2(jaccard < 0.3, `Different topics have low Jaccard (${jaccard.toFixed(3)})`);

  // Similar text should have higher Jaccard
  const sigSimilar = computeMinhash('Lambda timeout in VPC caused by DNS lookup failure', 128, 3);
  const jaccardSimilar = minhashJaccard(sig, sigSimilar);
  assert2(jaccardSimilar > 0.3, `Similar texts have higher Jaccard (${jaccardSimilar.toFixed(3)})`);
}

// ─── Batch MinHash ───────────────────────────────────────────────────────────
console.log('\nBatch MinHash:');
{
  const texts = [
    'Deploy using Terraform with S3 backend',
    'Deploy using Terraform with DynamoDB lock',
    'React component lifecycle and hooks',
  ];
  const sigs = batchComputeMinhash(texts, 128, 3);
  assert2(sigs.length === 3, 'Returns 3 signatures');
  assert2(sigs[0].length === 128, 'Each signature has 128 elements');

  const similarities = batchMinhashJaccard(sigs[0], [sigs[1], sigs[2]]);
  assert2(similarities[0] > similarities[1], 'Terraform texts more similar to each other than to React');
}

// ─── Dedup Scoring ───────────────────────────────────────────────────────────
console.log('\nDedup Scoring:');
{
  const candidates = [
    { id: 'c1', embeddingSimilarity: 0.95, minhashSimilarity: 0.85, titleSimilarity: 0.90, repositoryOverlap: true },
    { id: 'c2', embeddingSimilarity: 0.80, minhashSimilarity: 0.40, titleSimilarity: 0.30, repositoryOverlap: false },
    { id: 'c3', embeddingSimilarity: 0.92, minhashSimilarity: 0.75, titleSimilarity: 0.80, repositoryOverlap: true },
  ];
  const weights = { embedding: 0.40, minhash: 0.30, title: 0.20, repository: 0.10 };

  const results = scoreDedupCandidates(candidates, weights, 0.85);
  assert2(results.length === 2, 'Filters to candidates above 0.85 threshold');
  assert2(results[0].id === 'c1', 'Highest combined score first');
  assert2(results[0].combinedScore > 0.85, `Score above threshold: ${results[0].combinedScore.toFixed(3)}`);
}

// ─── Title Similarity ────────────────────────────────────────────────────────
console.log('\nTitle Similarity:');
{
  const sim = titleJaccardSimilarity(
    'Fix Lambda timeout in VPC',
    'Lambda VPC timeout fix',
  );
  assert2(sim > 0.5, `Same words reordered: ${sim.toFixed(3)}`);

  const simDiff = titleJaccardSimilarity(
    'Fix Lambda timeout in VPC',
    'React hooks state management',
  );
  assert2(simDiff < 0.1, `Different topics: ${simDiff.toFixed(3)}`);

  const batch = batchTitleSimilarity('Kafka event streaming', [
    'Event streaming with Kafka',
    'React component testing',
    'Kafka producer configuration',
  ]);
  assert2(batch[0] > batch[1], 'Similar title ranks higher');
  assert2(batch[2] > batch[1], 'Kafka-related title ranks higher than React');
}

// ─── Vector Validation ───────────────────────────────────────────────────────
console.log('\nVector Validation:');
{
  const valid = validateEmbedding(Array(1536).fill(0.1), 1536);
  assert2(valid === true, 'Valid 1536-dim vector passes');

  const invalidDim = validateEmbedding(Array(768).fill(0.1), 1536);
  assert2(invalidDim === false, 'Wrong dimension fails');

  const invalidNaN = validateEmbedding([...Array(1535).fill(0.1), NaN], 1536);
  assert2(invalidNaN === false, 'NaN value fails');

  const invalidInf = validateEmbedding([...Array(1535).fill(0.1), Infinity], 1536);
  assert2(invalidInf === false, 'Infinity value fails');

  const invalids = batchValidateEmbeddings([
    Array(1536).fill(0.1),       // valid
    Array(768).fill(0.1),        // wrong dim
    [...Array(1535).fill(0.1), NaN], // NaN
    Array(1536).fill(0.2),       // valid
  ], 1536);
  assert2(invalids.length === 2, 'Batch finds 2 invalid embeddings');
  assert2(invalids.includes(1) && invalids.includes(2), 'Identifies correct indices');
}

// ─── Local Embeddings ────────────────────────────────────────────────────────
console.log('\nLocal Embeddings:');
{
  const embeddings = generateLocalEmbeddings(['Hello world', 'Test input'], 1536);
  assert2(embeddings.length === 2, 'Generates 2 embeddings');
  assert2(embeddings[0].length === 1536, 'Correct dimensions');

  // Check normalization (L2 norm should be ~1.0)
  const norm = Math.sqrt(embeddings[0].reduce((s, v) => s + v * v, 0));
  assert2(Math.abs(norm - 1.0) < 0.001, `Normalized to unit length (norm=${norm.toFixed(4)})`);

  // Different texts should produce different embeddings
  const sim = embeddings[0].reduce((s, v, i) => s + v * embeddings[1][i], 0);
  assert2(sim < 1.0, 'Different texts produce different embeddings');
}

// ─── Fingerprinting ──────────────────────────────────────────────────────────
console.log('\nFingerprinting:');
{
  const fp = fnv1AFingerprint('Lambda timeout VPC');
  assert2(fp > 0, `Produces non-zero fingerprint: ${fp}`);

  const fp2 = fnv1AFingerprint('Lambda timeout VPC');
  assert2(fp === fp2, 'Deterministic');

  const fpDiff = fnv1AFingerprint('React hooks');
  assert2(fp !== fpDiff, 'Different texts produce different fingerprints');

  const batch = batchFnv1AFingerprint(['text1', 'text2', 'text3']);
  assert2(batch.length === 3, 'Batch returns 3 fingerprints');
  assert2(new Set(batch).size === 3, 'All unique');
}

// ─── Performance ─────────────────────────────────────────────────────────────
console.log('\nPerformance:');
{
  // MinHash: 1000 texts
  const texts = Array.from({ length: 1000 }, (_, i) =>
    `This is test document number ${i} about ${['Kafka', 'Lambda', 'Docker', 'Redis', 'PostgreSQL'][i % 5]} with some extra content to make it realistic`
  );

  const start = performance.now();
  const sigs = batchComputeMinhash(texts, 128, 3);
  const minhashTime = performance.now() - start;
  console.log(`  MinHash 1000 texts: ${minhashTime.toFixed(1)}ms`);
  assert2(minhashTime < 500, `MinHash 1000 texts < 500ms (got ${minhashTime.toFixed(1)}ms)`);

  // Batch Jaccard: compare 1 signature against 1000
  const start2 = performance.now();
  batchMinhashJaccard(sigs[0], sigs);
  const jaccardTime = performance.now() - start2;
  console.log(`  Jaccard 1 vs 1000: ${jaccardTime.toFixed(1)}ms`);
  assert2(jaccardTime < 5, `Jaccard 1 vs 1000 < 5ms (got ${jaccardTime.toFixed(1)}ms)`);

  // Local embeddings: 100 texts × 1536 dim
  const start3 = performance.now();
  generateLocalEmbeddings(texts.slice(0, 100), 1536);
  const embedTime = performance.now() - start3;
  console.log(`  Local embed 100 texts: ${embedTime.toFixed(1)}ms`);
  assert2(embedTime < 100, `Local embed 100 × 1536 < 100ms (got ${embedTime.toFixed(1)}ms)`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`Dedup Pipeline: ${dedupPassed} passed, ${dedupFailed} failed`);
// Don't exit — graph tests follow


// ─── GRAPH TRAVERSAL TESTS ───────────────────────────────────────────────────

import {
  spreadingActivation,
  computeGraphActivations,
  scoreByConnectivity,
} from './index.js';

console.log('\n═══════════════════════════════════════════════════');
console.log('Graph Traversal — Rust Native Tests');
console.log('═══════════════════════════════════════════════════\n');

let graphPassed = 0;
let graphFailed = 0;

function assert3(condition, msg) {
  if (condition) { graphPassed++; console.log(`  ✓ ${msg}`); }
  else { graphFailed++; console.error(`  ✗ ${msg}`); }
}

// ─── Spreading Activation ────────────────────────────────────────────────────
console.log('Spreading Activation:');
{
  const edges = [
    { sourceId: 'kafka', targetId: 'chunk-1', edgeType: 'depends_on', weight: 0.8 },
    { sourceId: 'kafka', targetId: 'chunk-2', edgeType: 'depends_on', weight: 0.6 },
    { sourceId: 'chunk-1', targetId: 'chunk-3', edgeType: 'related_to', weight: 0.5 },
    { sourceId: 'chunk-2', targetId: 'chunk-4', edgeType: 'causes', weight: 0.9 },
    { sourceId: 'chunk-3', targetId: 'chunk-5', edgeType: 'related_to', weight: 0.4 },
    { sourceId: 'redis', targetId: 'chunk-6', edgeType: 'depends_on', weight: 0.7 },
  ];

  const config = {
    decay: 0.7,
    maxDepth: 3,
    minActivation: 0.05,
    maxResults: 10,
    edgeMultipliers: { 'causes': 1.5, 'caused_by': 1.5, 'depends_on': 1.0, 'related_to': 0.8 },
  };

  const results = spreadingActivation(['kafka'], edges, config);
  assert3(results.length > 0, `Returns results (got ${results.length})`);
  assert3(results[0].activation > results[results.length - 1].activation, 'Sorted by activation descending');

  // Chunks directly connected to kafka should have highest activation
  const directChunks = results.filter(r => r.distance === 1);
  assert3(directChunks.length >= 2, `Direct neighbors found (${directChunks.length})`);
  assert3(directChunks[0].activation > 0.4, `Direct activation is high (${directChunks[0].activation.toFixed(3)})`);

  // chunk-6 (connected to redis, not kafka) should NOT appear
  const chunk6 = results.find(r => r.nodeId === 'chunk-6');
  assert3(!chunk6, 'Unconnected nodes not reached');

  // Causal edges should boost activation (chunk-4 via 'causes' edge)
  const chunk4 = results.find(r => r.nodeId === 'chunk-4');
  const chunk3 = results.find(r => r.nodeId === 'chunk-3');
  if (chunk4 && chunk3) {
    // chunk-4 goes through a causal edge (1.5x multiplier) vs chunk-3 through related_to (0.8x)
    assert3(chunk4.activation > chunk3.activation, `Causal edge boosts activation (${chunk4.activation.toFixed(3)} > ${chunk3.activation.toFixed(3)})`);
  }

  // Multi-seed test
  const multiResults = spreadingActivation(['kafka', 'redis'], edges, config);
  assert3(multiResults.length > results.length, `Multi-seed finds more nodes (${multiResults.length} > ${results.length})`);
}

// ─── Compute Graph Activations ───────────────────────────────────────────────
console.log('\nGraph Activations:');
{
  const activations = computeGraphActivations(
    [1.0, 0.8, 0.5],    // seed activations
    [1, 2, 1],           // distances
    [0.9, 0.7, 0.6],    // edge weights
    0.7,                  // decay
  );
  assert3(activations.length === 3, 'Returns 3 activations');
  assert3(activations[0] > activations[1], 'Closer + stronger = higher activation');
  assert3(activations[0] === 1.0 * 0.7 * 0.9, `Correct formula: ${activations[0]}`);
}

// ─── Score by Connectivity ───────────────────────────────────────────────────
console.log('\nConnectivity Scoring:');
{
  const edges = [
    { sourceId: 'kafka', targetId: 'chunk-1', edgeType: 'depends_on', weight: 0.8 },
    { sourceId: 'redis', targetId: 'chunk-1', edgeType: 'depends_on', weight: 0.6 },
    { sourceId: 'kafka', targetId: 'chunk-2', edgeType: 'depends_on', weight: 0.9 },
    { sourceId: 'postgres', targetId: 'chunk-3', edgeType: 'depends_on', weight: 0.7 },
  ];

  const scores = scoreByConnectivity(
    ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4'],
    edges,
    ['kafka', 'redis'],
  );
  assert3(scores.length === 4, 'Returns 4 scores');
  assert3(scores[0] > scores[2], 'chunk-1 (connected to 2 seeds) scores higher than chunk-3 (0 seeds)');
  assert3(scores[0] === 0.8 + 0.6, `chunk-1 score = kafka(0.8) + redis(0.6) = ${scores[0]}`);
  assert3(scores[1] === 0.9, `chunk-2 score = kafka(0.9) = ${scores[1]}`);
  assert3(scores[2] === 0.0, `chunk-3 not connected to seeds = ${scores[2]}`);
  assert3(scores[3] === 0.0, `chunk-4 not in graph = ${scores[3]}`);
}

// ─── Performance ─────────────────────────────────────────────────────────────
console.log('\nPerformance:');
{
  // Generate a large graph (1000 nodes, 5000 edges)
  const edges = [];
  for (let i = 0; i < 5000; i++) {
    edges.push({
      sourceId: `node-${i % 200}`,
      targetId: `node-${(i * 7 + 13) % 1000}`,
      edgeType: ['depends_on', 'related_to', 'causes', 'uses'][i % 4],
      weight: 0.3 + Math.random() * 0.7,
    });
  }

  const config = {
    decay: 0.6,
    maxDepth: 3,
    minActivation: 0.01,
    maxResults: 50,
    edgeMultipliers: { 'causes': 1.5, 'depends_on': 1.0, 'related_to': 0.8, 'uses': 0.9 },
  };

  const start = performance.now();
  const iterations = 100;
  for (let i = 0; i < iterations; i++) {
    spreadingActivation([`node-${i % 200}`], edges, config);
  }
  const elapsed = performance.now() - start;
  const perCall = elapsed / iterations;
  console.log(`  1000-node graph, 5000 edges × ${iterations} iterations: ${elapsed.toFixed(0)}ms`);
  console.log(`  Per call: ${perCall.toFixed(2)}ms`);
  assert3(perCall < 10, `Graph traversal < 10ms per call (got ${perCall.toFixed(2)}ms)`);
}

// ─── Final Summary ───────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════`);
console.log(`Graph Traversal: ${graphPassed} passed, ${graphFailed} failed`);
console.log(`\nGRAND TOTAL: ${passed + dedupPassed + graphPassed} passed, ${failed + dedupFailed + graphFailed} failed`);
process.exit((failed + dedupFailed + graphFailed) > 0 ? 1 : 0);
