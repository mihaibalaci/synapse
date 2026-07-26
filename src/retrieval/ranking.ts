/**
 * Ranking Engine
 *
 * This is where quality comes from. After candidate retrieval,
 * the ranking engine applies a composite scoring function that
 * combines multiple signals to produce the final ordering.
 *
 * Scoring formula:
 *   FinalScore = w1*SemanticSimilarity + w2*Freshness + w3*RepoMatch
 *              + w4*AuthorReputation + w5*UsageCount + w6*Upvotes
 *              + w7*AcceptedSolution + w8*ClickThrough + w9*QualityScore
 *
 * Weights are tunable via A/B testing and can be learned from
 * click-through data over time.
 *
 * Also includes cross-encoder reranking for the top-N candidates
 * (more expensive but much more accurate than bi-encoder similarity).
 */

import { createChildLogger } from '../utils/logger.js';
import {
  type RankingWeights,
  type SearchRequest,
  type Chunk,
  type MemoryFact,
} from '../models/index.js';

const logger = createChildLogger({ module: 'ranking' });

// ─── Internal Types ──────────────────────────────────────────────────────────

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

const DEFAULT_WEIGHTS: RankingWeights = {
  semanticSimilarity: 0.30,
  freshness: 0.12,
  repositoryMatch: 0.15,
  authorReputation: 0.05,
  usageCount: 0.10,
  upvotes: 0.05,
  acceptedSolution: 0.05,
  clickThrough: 0.08,
  llmQualityScore: 0.10,
};

// ─── Ranking Engine ──────────────────────────────────────────────────────────

export class RankingEngine {
  private weights: RankingWeights;

  constructor(weights?: Partial<RankingWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Rank candidates using composite scoring.
   * Returns candidates sorted by finalScore descending.
   */
  async rank(
    candidates: RankableCandidate[],
    request: SearchRequest,
  ): Promise<RankedCandidate[]> {
    if (candidates.length === 0) return [];

    logger.debug({ candidateCount: candidates.length }, 'Ranking candidates');

    // Phase 1: Compute composite scores
    const scored = candidates.map(candidate =>
      this.computeCompositeScore(candidate, request),
    );

    // Phase 2: Cross-encoder reranking on top-N (if enough candidates)
    const topN = 20;
    if (scored.length > topN) {
      // Sort by initial score, then rerank top-N
      scored.sort((a, b) => b.finalScore - a.finalScore);
      const topCandidates = scored.slice(0, topN);
      const reranked = await this.crossEncoderRerank(topCandidates, request.query);

      // Replace top-N with reranked results
      return [...reranked, ...scored.slice(topN)];
    }

    // Sort by final score
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // Phase 3: Diversity boosting (avoid returning 5 results from same session)
    return this.applyDiversity(scored);
  }

  /**
   * Compute the composite score for a single candidate.
   */
  private computeCompositeScore(
    candidate: RankableCandidate,
    request: SearchRequest,
  ): RankedCandidate {
    const { chunk, scores } = candidate;
    const w = this.weights;

    // Semantic signal (combine vector + keyword with RRF-style fusion)
    const semanticSignal = Math.max(scores.semantic, scores.keyword * 0.9);
    const semanticContribution = w.semanticSimilarity * semanticSignal;

    // Keyword bonus (exact match is valuable)
    const keywordContribution = (w.clickThrough * 0.5) * scores.keyword;

    // Freshness (exponential decay)
    const freshnessScore = this.computeFreshness(chunk.createdAt);
    const freshnessContribution = w.freshness * freshnessScore;

    // Repository match (same repo as query context = highly relevant)
    const repoMatch = this.computeRepoMatch(chunk, request);
    const repoMatchContribution = w.repositoryMatch * repoMatch;

    // Author reputation (based on historical quality of their contributions)
    const authorScore = this.computeAuthorReputation(chunk);
    const authorContribution = w.authorReputation * authorScore;

    // Usage signal (how many times this was retrieved and used)
    const usageScore = Math.min(chunk.usageCount / 50, 1); // Saturates at 50 uses
    const usageContribution = w.usageCount * usageScore;

    // Quality score (from extraction + validation)
    const qualityContribution = w.llmQualityScore * chunk.qualityScore;

    // Graph relevance boost
    const graphContribution = 0.08 * scores.graphRelevance;

    // Upvote/acceptance bonus
    const upvoteBonus = w.upvotes * Math.min(chunk.upvotes / 10, 1);
    const acceptedBonus = w.acceptedSolution * (chunk.isCanonical ? 1 : 0);

    // Confidence penalty (stale content ranked lower)
    const confidencePenalty = chunk.confidence === 'low' ? 0.7
      : chunk.confidence === 'archived' ? 0.3
      : 1.0;

    // Final score
    const rawScore = (
      semanticContribution +
      keywordContribution +
      freshnessContribution +
      repoMatchContribution +
      authorContribution +
      usageContribution +
      qualityContribution +
      graphContribution +
      upvoteBonus +
      acceptedBonus
    ) * confidencePenalty;

    // Clamp to [0, 1]
    const finalScore = Math.max(0, Math.min(1, rawScore));

    return {
      ...candidate,
      finalScore,
      scoreBreakdown: {
        semanticContribution,
        keywordContribution,
        freshnessContribution,
        repoMatchContribution,
        authorContribution,
        usageContribution,
        qualityContribution,
        graphContribution,
        crossEncoderBoost: 0,
      },
    };
  }

  /**
   * Cross-encoder reranking for top candidates.
   * More expensive but dramatically more accurate than bi-encoder.
   * Typically adds 20-50ms latency.
   */
  private async crossEncoderRerank(
    candidates: RankedCandidate[],
    query: string,
  ): Promise<RankedCandidate[]> {
    // TODO: Call cross-encoder model (e.g., ms-marco-MiniLM-L-12-v2)
    // For each candidate, compute cross_encoder_score(query, candidate.content)
    // This is a placeholder — in production, call a dedicated reranker service.

    // For now, apply a simple heuristic boost:
    // Candidates with both keyword AND semantic matches get boosted
    for (const candidate of candidates) {
      const hasKeywordMatch = candidate.scores.keyword > 0.3;
      const hasSemanticMatch = candidate.scores.semantic > 0.7;

      if (hasKeywordMatch && hasSemanticMatch) {
        candidate.finalScore *= 1.15; // 15% boost for double-match
        candidate.scoreBreakdown.crossEncoderBoost = 0.15;
      }
    }

    // Re-sort after boosting
    candidates.sort((a, b) => b.finalScore - a.finalScore);
    return candidates;
  }

  /**
   * Apply diversity constraint: avoid too many results from same session or same cluster.
   */
  private applyDiversity(candidates: RankedCandidate[]): RankedCandidate[] {
    const sessionCounts = new Map<string, number>();
    const clusterCounts = new Map<string, number>();
    const diverseResults: RankedCandidate[] = [];

    for (const candidate of candidates) {
      const sessionId = candidate.chunk.sessionId;
      const clusterId = candidate.chunk.clusterId;

      // Max 2 results from same session
      const sessionCount = sessionCounts.get(sessionId) ?? 0;
      if (sessionCount >= 2) {
        // Demote rather than remove (move to end)
        candidate.finalScore *= 0.5;
      }
      sessionCounts.set(sessionId, sessionCount + 1);

      // Max 1 result from same cluster (they're duplicates)
      if (clusterId) {
        const clusterCount = clusterCounts.get(clusterId) ?? 0;
        if (clusterCount >= 1) {
          candidate.finalScore *= 0.3;
        }
        clusterCounts.set(clusterId, clusterCount + 1);
      }

      diverseResults.push(candidate);
    }

    // Re-sort after diversity adjustments
    diverseResults.sort((a, b) => b.finalScore - a.finalScore);
    return diverseResults;
  }

  // ─── Signal Computation ────────────────────────────────────────────────────

  private computeFreshness(createdAt: string): number {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // Half-life of 90 days
    return Math.exp(-ageDays / 130);
  }

  private computeRepoMatch(chunk: Chunk, request: SearchRequest): number {
    if (!request.context?.repository || !chunk.repository) return 0;
    if (chunk.repository === request.context.repository) return 1.0;
    // Partial match (same org prefix)
    const queryOrg = request.context.repository.split('/')[0];
    const chunkOrg = chunk.repository.split('/')[0];
    if (queryOrg === chunkOrg) return 0.3;
    return 0;
  }

  private computeAuthorReputation(chunk: Chunk): number {
    // Proxy: authors with many upvoted chunks have higher reputation
    // In production, this would query a developer reputation service
    const upvoteRatio = chunk.upvotes / Math.max(chunk.upvotes + chunk.downvotes, 1);
    return upvoteRatio;
  }

  /**
   * Update weights based on feedback data (online learning).
   * Called periodically by the feedback loop.
   */
  updateWeights(newWeights: Partial<RankingWeights>): void {
    this.weights = { ...this.weights, ...newWeights };
    logger.info({ weights: this.weights }, 'Ranking weights updated');
  }
}
