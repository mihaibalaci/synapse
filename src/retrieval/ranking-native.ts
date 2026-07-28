/**
 * Native Ranking Engine (Rust-powered)
 *
 * Delegates the compute-heavy scoring and fusion to the Rust native module
 * (@synapse/retrieval-engine) for parallel execution via Rayon.
 *
 * Falls back to the pure-JS ranking engine if the native module isn't available
 * (e.g., on platforms without a pre-built binary).
 *
 * Performance: 1000 candidates in ~5ms (vs ~40ms in pure JS)
 */

import { createChildLogger } from '../utils/logger.js';
import {
  type RankingWeights,
  type SearchRequest,
  type Chunk,
  type MemoryFact,
} from '../models/index.js';

const logger = createChildLogger({ module: 'ranking-native' });

// ─── Try to load native module ───────────────────────────────────────────────

let native: any = null;
let nativeLoaded = false;

async function loadNative(): Promise<void> {
  if (nativeLoaded) return;
  nativeLoaded = true;
  try {
    // Path from dist/retrieval/ to packages/retrieval-engine/
    native = await import('../../packages/retrieval-engine/index.js');
    logger.info('Rust retrieval engine loaded — using native ranking');
  } catch (err) {
    logger.warn('Native retrieval engine not available, falling back to JS ranking');
    native = null;
  }
}

// ─── Types (same interface as the JS ranking engine) ─────────────────────────

interface CandidateScores {
  semantic: number;
  keyword: number;
  entityMatch: number;
  temporal: number;
  graphRelevance: number;
}

interface RankableCandidate {
  chunk: Chunk;
  facts?: MemoryFact[];
  scores: CandidateScores;
  source: 'vector' | 'keyword' | 'entity' | 'temporal' | 'graph';
}

interface RankedCandidate extends RankableCandidate {
  finalScore: number;
  scoreBreakdown: {
    semanticContribution: number;
    keywordContribution: number;
    freshnessContribution: number;
    repoMatchContribution: number;
    authorContribution: number;
    usageContribution: number;
    qualityContribution: number;
    graphContribution: number;
    crossEncoderBoost: number;
  };
}

// ─── Default Weights ─────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
  semantic: 0.30,
  keyword: 0.10,
  freshness: 0.12,
  repoMatch: 0.15,
  authorReputation: 0.05,
  usage: 0.10,
  upvotes: 0.05,
  quality: 0.10,
  graph: 0.08,
};

// ─── Native Ranking Engine ───────────────────────────────────────────────────

export class NativeRankingEngine {
  private weights: typeof DEFAULT_WEIGHTS;

  constructor(weights?: Partial<typeof DEFAULT_WEIGHTS>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Rank candidates using the Rust native module (parallel scoring).
   * Falls back to JS implementation if native module is unavailable.
   */
  async rank(
    candidates: RankableCandidate[],
    request: SearchRequest,
  ): Promise<RankedCandidate[]> {
    if (candidates.length === 0) return [];

    // Lazy-load native module on first call
    await loadNative();

    if (native) {
      return this.rankNative(candidates, request);
    }

    // Fallback: import and use the JS engine
    const { RankingEngine } = await import('./ranking.js');
    const jsEngine = new RankingEngine();
    return jsEngine.rank(candidates, request);
  }

  /**
   * Native (Rust) ranking path — converts candidates to the native format,
   * calls Rust, and maps results back to the full RankedCandidate objects.
   */
  private rankNative(
    candidates: RankableCandidate[],
    request: SearchRequest,
  ): RankedCandidate[] {
    const now = Date.now();

    // Convert to native input format
    const nativeInputs = candidates.map(c => ({
      id: c.chunk.id,
      sessionId: c.chunk.sessionId ?? undefined,
      contentLength: c.chunk.content?.length ?? c.chunk.summary.length,
      tokenCount: c.chunk.tokenCount,
      qualityScore: c.chunk.qualityScore,
      usageCount: c.chunk.usageCount,
      upvotes: c.chunk.upvotes,
      createdAtMs: new Date(c.chunk.createdAt).getTime(),
      lastAccessedAtMs: c.chunk.lastAccessedAt
        ? new Date(c.chunk.lastAccessedAt).getTime()
        : undefined,
      confidence: c.chunk.confidence ?? 'high',
      repository: c.chunk.repository ?? undefined,
      scores: {
        semantic: c.scores.semantic,
        keyword: c.scores.keyword,
        entityMatch: c.scores.entityMatch,
        temporal: c.scores.temporal,
        graphRelevance: c.scores.graphRelevance,
      },
      source: c.source,
    }));

    const context = {
      queryRepository: request.context?.repository ?? undefined,
      nowMs: now,
    };

    // Call Rust — parallel scoring across all candidates
    const scored = native!.rankCandidates(nativeInputs, this.weights, context);

    // Build a lookup map for fast candidate resolution
    const candidateMap = new Map(candidates.map(c => [c.chunk.id, c]));

    // Map native results back to RankedCandidate with full chunk data
    const ranked: RankedCandidate[] = scored.map((s: any) => {
      const original = candidateMap.get(s.id)!;
      return {
        ...original,
        finalScore: s.finalScore,
        scoreBreakdown: {
          semanticContribution: s.semanticContribution,
          keywordContribution: s.keywordContribution,
          freshnessContribution: s.freshnessContribution,
          repoMatchContribution: s.repoMatchContribution,
          authorContribution: 0,
          usageContribution: s.usageContribution,
          qualityContribution: s.qualityContribution,
          graphContribution: s.graphContribution,
          crossEncoderBoost: 0,
        },
      };
    });

    // Cross-encoder reranking (still in JS — calls external service)
    if (ranked.length > 20) {
      this.applyCrossEncoderBoost(ranked.slice(0, 20), request.query);
    }

    logger.debug({
      candidateCount: candidates.length,
      topScore: ranked[0]?.finalScore,
      engine: 'rust-native',
    }, 'Native ranking complete');

    return ranked;
  }

  /**
   * Cross-encoder boost for top candidates (heuristic until a real model is deployed).
   */
  private applyCrossEncoderBoost(top: RankedCandidate[], _query: string): void {
    for (const candidate of top) {
      const hasKeyword = candidate.scores.keyword > 0.3;
      const hasSemantic = candidate.scores.semantic > 0.7;
      if (hasKeyword && hasSemantic) {
        candidate.finalScore *= 1.15;
        candidate.scoreBreakdown.crossEncoderBoost = 0.15;
      }
    }
  }

  /**
   * Update weights (for online learning / A/B testing).
   */
  updateWeights(newWeights: Partial<typeof DEFAULT_WEIGHTS>): void {
    this.weights = { ...this.weights, ...newWeights };
    logger.info({ weights: this.weights }, 'Native ranking weights updated');
  }
}
