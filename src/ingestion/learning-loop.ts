/**
 * Learning Loop Orchestrator
 *
 * Coordinates the full automatic learning cycle in the Synapse system.
 * This module represents the closed-loop intelligence that makes the system
 * get smarter over time — the key architectural concept inspired by Hindsight.
 *
 * The Learning Loop:
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                                                                     │
 * │   ┌──────────┐     ┌───────────┐     ┌──────────┐                 │
 * │   │  RETAIN  │────▶│  EXTRACT  │────▶│  REINFORCE│                │
 * │   │  (capture)│     │  (facts)  │     │ (opinions)│                │
 * │   └──────────┘     └───────────┘     └─────┬─────┘                │
 * │        ▲                                     │                      │
 * │        │                                     ▼                      │
 * │   ┌────┴─────┐     ┌───────────┐     ┌──────────┐                 │
 * │   │WRITE-BACK│◀────│  REFLECT  │◀────│  RECALL  │                 │
 * │   │ (insights)│     │ (reason)  │     │(retrieve)│                 │
 * │   └──────────┘     └───────────┘     └──────────┘                 │
 * │        │                                     ▲                      │
 * │        │           ┌───────────┐             │                      │
 * │        └──────────▶│  OBSERVE  │─────────────┘                     │
 * │                    │(summaries)│                                    │
 * │                    └───────────┘                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Each node feeds into the next. The system learns in three ways:
 *
 *   1. INLINE (on every ingestion):
 *      New facts → reinforce/weaken existing opinions → refresh observations
 *
 *   2. ON REFLECT (on every reflect call):
 *      Retrieve → reason → extract insights → write back as new facts
 *      + Boost contributing sources (usage signal)
 *
 *   3. BATCH (during compaction, weekly):
 *      Synthesize clusters → detect contradictions → refresh all observations
 *      → full opinion reinforcement sweep
 *
 * This module provides:
 *   - Metrics tracking for learning activity
 *   - Health assessment (is the system actually learning?)
 *   - Configuration for loop intensity (how aggressively to learn)
 *   - Manual triggers for testing/debugging
 */

import { createChildLogger } from '../utils/logger.js';
import { FactRepository } from '../storage/fact-repository.js';
import { ObservationRepository } from '../storage/observation-repository.js';
import { OpinionReinforcementEngine } from './opinion-reinforcement.js';
import { ObservationGenerator } from './observation-generator.js';
import { query } from '../storage/database.js';

const logger = createChildLogger({ module: 'learning-loop' });

// ─── Configuration ───────────────────────────────────────────────────────────

export interface LearningLoopConfig {
  /** Enable/disable inline reinforcement (on every fact extraction) */
  inlineReinforcementEnabled: boolean;
  /** Enable/disable reflect write-back (on every reflect call) */
  reflectWriteBackEnabled: boolean;
  /** Enable/disable source boosting (on successful reflect) */
  sourceBoostEnabled: boolean;
  /** Minimum confidence for reflect write-back */
  writeBackMinConfidence: 'high' | 'medium' | 'low';
  /** Maximum insights written back per reflect call */
  maxInsightsPerReflect: number;
  /** How often to refresh observations after fact changes (seconds) */
  observationRefreshDelay: number;
}

const DEFAULT_CONFIG: LearningLoopConfig = {
  inlineReinforcementEnabled: true,
  reflectWriteBackEnabled: true,
  sourceBoostEnabled: true,
  writeBackMinConfidence: 'high',
  maxInsightsPerReflect: 3,
  observationRefreshDelay: 30,
};

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface LearningMetrics {
  /** Time period these metrics cover */
  period: { from: string; to: string };

  /** Inline learning (at ingestion time) */
  inline: {
    factsExtracted: number;
    opinionsReinforced: number;
    opinionsWeakened: number;
    opinionsContradicted: number;
    observationsTriggered: number;
  };

  /** Reflect learning (at query time) */
  reflect: {
    reflectCalls: number;
    highConfidenceAnswers: number;
    insightsWrittenBack: number;
    sourcesBosted: number;
  };

  /** Batch learning (during compaction) */
  batch: {
    clustersSynthesized: number;
    factsSuperseded: number;
    observationsRefreshed: number;
    opinionsProcessed: number;
  };

  /** Overall health indicators */
  health: {
    /** Is the system actively learning? (>0 insights written in last 7 days) */
    isLearning: boolean;
    /** Average opinion confidence trend (positive = strengthening beliefs) */
    confidenceTrend: number;
    /** Knowledge compression ratio (facts/observations → tokens saved) */
    compressionRatio: number;
    /** Observation coverage (% of frequent entities with observations) */
    observationCoverage: number;
  };
}

// ─── Learning Loop Orchestrator ──────────────────────────────────────────────

export class LearningLoop {
  private config: LearningLoopConfig;
  private factRepo: FactRepository;
  private observationRepo: ObservationRepository;
  private opinionEngine: OpinionReinforcementEngine;
  private observationGenerator: ObservationGenerator;

  constructor(config: Partial<LearningLoopConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.factRepo = new FactRepository();
    this.observationRepo = new ObservationRepository();
    this.opinionEngine = new OpinionReinforcementEngine();
    this.observationGenerator = new ObservationGenerator();
  }

  /** Get current configuration */
  getConfig(): LearningLoopConfig {
    return { ...this.config };
  }

  /**
   * Get learning metrics for a time period.
   * Answers: "Is the system actually getting smarter?"
   */
  async getMetrics(
    organizationId: string,
    days: number = 7,
  ): Promise<LearningMetrics> {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();

    // Query inline metrics
    const inlineMetrics = await this.getInlineMetrics(organizationId, from);

    // Query reflect metrics
    const reflectMetrics = await this.getReflectMetrics(organizationId, from);

    // Query health indicators
    const health = await this.getHealthIndicators(organizationId, from);

    return {
      period: { from, to },
      inline: inlineMetrics,
      reflect: reflectMetrics,
      batch: {
        // These would come from compaction logs; approximate from fact stats
        clustersSynthesized: 0,
        factsSuperseded: 0,
        observationsRefreshed: 0,
        opinionsProcessed: 0,
      },
      health,
    };
  }

  /**
   * Health check: is the learning loop functioning?
   */
  async isHealthy(organizationId: string): Promise<{
    healthy: boolean;
    reasons: string[];
  }> {
    const reasons: string[] = [];

    // Check 1: Are facts being extracted? (last 24h)
    const recentFacts = await this.factRepo.findByTemporal(
      organizationId,
      { from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), onlyCurrentlyValid: false, includeSuperseded: true },
      { limit: 1 },
    );
    if (recentFacts.length === 0) {
      reasons.push('No facts extracted in the last 24 hours');
    }

    // Check 2: Are observations being generated?
    const obsCount = await this.observationRepo.count(organizationId);
    if (obsCount === 0) {
      reasons.push('No observations exist yet');
    }

    // Check 3: Do opinions exist? (system is forming beliefs)
    const opinions = await this.factRepo.findByType(organizationId, 'opinion', { limit: 1 });
    if (opinions.length === 0) {
      reasons.push('No opinions formed yet (system has not started forming beliefs)');
    }

    return {
      healthy: reasons.length === 0,
      reasons,
    };
  }

  /**
   * Manually trigger a full learning cycle for testing/debugging.
   * Runs: opinion reinforcement + observation refresh + discovery.
   */
  async triggerFullCycle(organizationId: string): Promise<{
    opinionsReinforced: number;
    observationsRefreshed: number;
    observationsDiscovered: number;
  }> {
    logger.info({ organizationId }, 'Manual learning cycle triggered');

    const reinforceResult = await this.opinionEngine.reinforceFromRecentFacts(
      organizationId, 7,
    );

    const refreshResult = await this.observationGenerator.refreshStale(organizationId);
    const discovered = await this.observationGenerator.discoverAndGenerate(organizationId);

    const result = {
      opinionsReinforced: reinforceResult.reinforced + reinforceResult.weakened + reinforceResult.contradicted,
      observationsRefreshed: refreshResult.refreshed,
      observationsDiscovered: discovered,
    };

    logger.info({ organizationId, ...result }, 'Manual learning cycle complete');
    return result;
  }

  // ─── Internal Metric Queries ─────────────────────────────────────────────

  private async getInlineMetrics(
    organizationId: string,
    since: string,
  ): Promise<LearningMetrics['inline']> {
    const factsResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_facts
       WHERE organization_id = $1 AND created_at >= $2`,
      [organizationId, since],
    );

    const opinionsResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_facts
       WHERE organization_id = $1 AND type = 'opinion' AND created_at >= $2`,
      [organizationId, since],
    );

    return {
      factsExtracted: parseInt(factsResult.rows[0]?.count ?? '0', 10),
      opinionsReinforced: 0, // Would need a reinforcement event log
      opinionsWeakened: 0,
      opinionsContradicted: 0,
      observationsTriggered: 0,
    };
  }

  private async getReflectMetrics(
    organizationId: string,
    since: string,
  ): Promise<LearningMetrics['reflect']> {
    // Insights written back are facts extracted_from='assistant' created recently
    const insightsResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_facts
       WHERE organization_id = $1
         AND extracted_from = 'assistant'
         AND source_chunk_id IS NULL
         AND created_at >= $2`,
      [organizationId, since],
    );

    return {
      reflectCalls: 0, // Would need a reflect event log
      highConfidenceAnswers: 0,
      insightsWrittenBack: parseInt(insightsResult.rows[0]?.count ?? '0', 10),
      sourcesBosted: 0,
    };
  }

  private async getHealthIndicators(
    organizationId: string,
    since: string,
  ): Promise<LearningMetrics['health']> {
    // Is learning? Check if any insights were written back
    const insightsResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_facts
       WHERE organization_id = $1
         AND extracted_from = 'assistant'
         AND source_chunk_id IS NULL
         AND created_at >= $2`,
      [organizationId, since],
    );
    const insightsCount = parseInt(insightsResult.rows[0]?.count ?? '0', 10);

    // Average opinion confidence
    const confidenceResult = await query<{ avg_conf: string | null }>(
      `SELECT AVG(confidence)::text AS avg_conf FROM memory_facts
       WHERE organization_id = $1 AND type = 'opinion'
         AND temporal_valid_until IS NULL`,
      [organizationId],
    );
    const avgConfidence = parseFloat(confidenceResult.rows[0]?.avg_conf ?? '0');

    // Observation coverage
    const entityCountResult = await query<{ entity_count: string }>(
      `SELECT COUNT(DISTINCT unnest)::text AS entity_count
       FROM memory_facts, unnest(entities)
       WHERE organization_id = $1
         AND temporal_valid_until IS NULL`,
      [organizationId],
    );
    const totalEntities = parseInt(entityCountResult.rows[0]?.entity_count ?? '0', 10);
    const obsCount = await this.observationRepo.count(organizationId);
    const coverage = totalEntities > 0 ? Math.min(obsCount / totalEntities, 1) : 0;

    return {
      isLearning: insightsCount > 0,
      confidenceTrend: avgConfidence,
      compressionRatio: 0, // Would need compaction stats
      observationCoverage: coverage,
    };
  }
}
