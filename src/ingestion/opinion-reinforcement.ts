/**
 * Opinion Reinforcement Engine
 *
 * Implements confidence evolution for opinion-type facts. When new evidence
 * arrives (new facts extracted), opinions with overlapping entities are
 * evaluated for reinforcement or contradiction.
 *
 * Inspired by Hindsight's CARA opinion reinforcement mechanism, adapted
 * for team-scale organizational memory:
 *
 *   - Hindsight: per-agent opinions shaped by behavioral profiles
 *   - Recall: organizational opinions that represent team consensus
 *
 * Confidence evolution rules:
 *   - Supporting evidence: confidence += alpha (min 0.05, max cap at 0.95)
 *   - Weakening evidence: confidence -= alpha
 *   - Contradicting evidence: confidence -= 2*alpha, may trigger text revision
 *   - No relevant evidence: no change
 *
 * This runs:
 *   1. During compaction (batch: evaluate all recent facts against opinions)
 *   2. Inline during fact extraction (lightweight: only check same-entity opinions)
 */

import { createChildLogger } from '../utils/logger.js';
import { LlmClient } from '../utils/llm.js';
import { FactRepository } from '../storage/fact-repository.js';
import { type MemoryFact } from '../models/index.js';

const logger = createChildLogger({ module: 'opinion-reinforcement' });

// ─── Configuration ───────────────────────────────────────────────────────────

export interface OpinionReinforcementConfig {
  /** Step size for confidence updates */
  alpha: number;
  /** Minimum confidence before an opinion is considered "abandoned" */
  minConfidence: number;
  /** Maximum confidence (prevents over-certainty) */
  maxConfidence: number;
  /** Embedding similarity threshold for finding related opinions */
  similarityThreshold: number;
  /** Maximum opinions to process per run */
  maxPerRun: number;
}

const DEFAULT_CONFIG: OpinionReinforcementConfig = {
  alpha: 0.08,
  minConfidence: 0.1,
  maxConfidence: 0.95,
  similarityThreshold: 0.80,
  maxPerRun: 100,
};

// ─── Evidence Assessment ─────────────────────────────────────────────────────

export type EvidenceRelation = 'reinforce' | 'weaken' | 'contradict' | 'neutral';

const ASSESSMENT_PROMPT = `You are evaluating whether a new piece of evidence supports, weakens, contradicts, or is neutral to an existing opinion.

An opinion is a subjective organizational judgment or belief.
Evidence is a new fact that has been observed.

Rules:
- "reinforce": the evidence directly supports or confirms the opinion
- "weaken": the evidence somewhat undermines the opinion but doesn't directly contradict it
- "contradict": the evidence is incompatible with the opinion (both cannot be true)
- "neutral": the evidence is unrelated to the opinion's claim

Respond with EXACTLY one word: REINFORCE, WEAKEN, CONTRADICT, or NEUTRAL`;

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface ReinforcementResult {
  opinionsEvaluated: number;
  reinforced: number;
  weakened: number;
  contradicted: number;
  neutral: number;
  llmCalls: number;
  errors: number;
}

export class OpinionReinforcementEngine {
  private config: OpinionReinforcementConfig;
  private llm: LlmClient;
  private factRepo: FactRepository;

  constructor(config: Partial<OpinionReinforcementConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llm = new LlmClient();
    this.factRepo = new FactRepository();
  }

  /**
   * Evaluate recent facts against existing opinions and update confidence.
   * Intended to run during compaction or as a scheduled job.
   */
  async reinforceFromRecentFacts(
    organizationId: string,
    sinceDays: number = 7,
  ): Promise<ReinforcementResult> {
    const result: ReinforcementResult = {
      opinionsEvaluated: 0,
      reinforced: 0,
      weakened: 0,
      contradicted: 0,
      neutral: 0,
      llmCalls: 0,
      errors: 0,
    };

    if (this.llm.disabled) {
      logger.info('LLM disabled, skipping opinion reinforcement');
      return result;
    }

    // 1. Load all current opinions
    const opinions = await this.factRepo.findByType(
      organizationId,
      'opinion',
      { limit: this.config.maxPerRun, onlyValid: true },
    );

    if (opinions.length === 0) {
      logger.debug({ organizationId }, 'No opinions to reinforce');
      return result;
    }

    // 2. Load recent non-opinion facts (potential evidence)
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const recentFacts = await this.factRepo.findByTemporal(
      organizationId,
      { from: since, onlyCurrentlyValid: true, includeSuperseded: false },
      { limit: 200 },
    );

    // Filter out opinions from evidence pool
    const evidence = recentFacts.filter(f => f.type !== 'opinion');
    if (evidence.length === 0) {
      logger.debug({ organizationId }, 'No recent evidence for opinion reinforcement');
      return result;
    }

    // 3. For each opinion, find relevant evidence and assess
    for (const opinion of opinions) {
      try {
        const relevant = this.findRelevantEvidence(opinion, evidence);
        if (relevant.length === 0) continue;

        result.opinionsEvaluated++;

        for (const fact of relevant) {
          const relation = await this.assessEvidence(opinion, fact);
          result.llmCalls++;

          await this.applyReinforcement(opinion, fact, relation);

          switch (relation) {
            case 'reinforce': result.reinforced++; break;
            case 'weaken': result.weakened++; break;
            case 'contradict': result.contradicted++; break;
            case 'neutral': result.neutral++; break;
          }
        }
      } catch (error) {
        result.errors++;
        logger.warn({ err: error, opinionId: opinion.id }, 'Opinion reinforcement failed');
      }
    }

    logger.info({
      organizationId,
      ...result,
    }, 'Opinion reinforcement complete');

    return result;
  }

  /**
   * Lightweight inline check: when a new fact is extracted, check if it
   * reinforces/contradicts any opinion sharing the same entities.
   * Called from the fact extractor for immediate feedback.
   */
  async evaluateNewFact(
    newFact: MemoryFact,
    organizationId: string,
  ): Promise<void> {
    if (this.llm.disabled || newFact.type === 'opinion') return;
    if (newFact.entities.length === 0) return;

    // Find opinions with overlapping entities
    const opinions = await this.factRepo.findByType(
      organizationId,
      'opinion',
      { limit: 20, onlyValid: true },
    );

    const relevant = opinions.filter(op =>
      this.entityOverlap(op.entities, newFact.entities) > 0.3,
    );

    if (relevant.length === 0) return;

    // Assess only the top 3 most relevant opinions (cost control)
    for (const opinion of relevant.slice(0, 3)) {
      try {
        const relation = await this.assessEvidence(opinion, newFact);
        if (relation !== 'neutral') {
          await this.applyReinforcement(opinion, newFact, relation);
          logger.debug({
            opinionId: opinion.id,
            factId: newFact.id,
            relation,
          }, 'Inline opinion reinforcement applied');
        }
      } catch {
        // Inline reinforcement failures are not critical
      }
    }
  }

  // ─── Internal Methods ────────────────────────────────────────────────────

  /**
   * Find evidence facts that are potentially relevant to an opinion.
   * Uses entity overlap as a fast filter.
   */
  private findRelevantEvidence(opinion: MemoryFact, evidence: MemoryFact[]): MemoryFact[] {
    return evidence.filter(fact => {
      // Must share at least one entity
      const overlap = this.entityOverlap(opinion.entities, fact.entities);
      return overlap > 0.2;
    }).slice(0, 5); // Cap to control LLM costs
  }

  /**
   * Ask the LLM to assess the relationship between an opinion and new evidence.
   */
  private async assessEvidence(
    opinion: MemoryFact,
    evidence: MemoryFact,
  ): Promise<EvidenceRelation> {
    const userPrompt = `OPINION: "${opinion.content}"\nEVIDENCE (new fact): "${evidence.content}"`;
    const response = await this.llm.generate(ASSESSMENT_PROMPT, userPrompt);

    if (!response) return 'neutral';

    const text = response.text.trim().toUpperCase();
    if (text.startsWith('REINFORCE')) return 'reinforce';
    if (text.startsWith('WEAKEN')) return 'weaken';
    if (text.startsWith('CONTRADICT')) return 'contradict';
    return 'neutral';
  }

  /**
   * Apply a confidence update to an opinion based on the assessed relation.
   */
  private async applyReinforcement(
    opinion: MemoryFact,
    evidence: MemoryFact,
    relation: EvidenceRelation,
  ): Promise<void> {
    if (relation === 'neutral') return;

    let newConfidence = opinion.confidence;
    let reason: 'reinforced' | 'weakened' | 'contradicted';

    switch (relation) {
      case 'reinforce':
        newConfidence = Math.min(
          opinion.confidence + this.config.alpha,
          this.config.maxConfidence,
        );
        reason = 'reinforced';
        break;
      case 'weaken':
        newConfidence = Math.max(
          opinion.confidence - this.config.alpha,
          this.config.minConfidence,
        );
        reason = 'weakened';
        break;
      case 'contradict':
        newConfidence = Math.max(
          opinion.confidence - 2 * this.config.alpha,
          this.config.minConfidence,
        );
        reason = 'contradicted';
        break;
    }

    // Build the history entry
    const historyEntry = {
      confidence: newConfidence,
      reason,
      evidenceFactId: evidence.id,
      timestamp: new Date().toISOString(),
    };

    // Update in database
    await this.factRepo.updateOpinionConfidence(opinion.id, {
      confidence: newConfidence,
      reinforcements: (opinion.opinion?.reinforcements ?? 0) + (relation === 'reinforce' ? 1 : 0),
      contradictions: (opinion.opinion?.contradictions ?? 0) + (relation === 'contradict' ? 1 : 0),
      historyEntry,
    });

    logger.info({
      opinionId: opinion.id,
      oldConfidence: opinion.confidence,
      newConfidence,
      relation,
      evidenceContent: evidence.content.substring(0, 60),
    }, 'Opinion confidence updated');
  }

  /**
   * Jaccard overlap between entity arrays.
   */
  private entityOverlap(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a.map(e => e.toLowerCase()));
    const setB = new Set(b.map(e => e.toLowerCase()));
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
  }
}
