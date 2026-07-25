/**
 * Fact Repository
 *
 * Persistence for atomic MemoryFacts.
 * Supports:
 *   - ADD-only writes (never update content, only metadata)
 *   - Vector similarity search (for dedup + retrieval)
 *   - Entity-boosted queries
 *   - Temporal filtering (valid facts, superseded facts, history)
 */

import { type MemoryFact, type FactType, type TemporalQuery } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'fact-repository' });

export class FactRepository {
  /**
   * Create a single fact (ADD-only).
   */
  async create(fact: MemoryFact): Promise<void> {
    logger.debug({ factId: fact.id, type: fact.type }, 'Creating fact');
    // TODO: INSERT INTO memory_facts (...)
  }

  /**
   * Batch create facts.
   */
  async createBatch(facts: MemoryFact[]): Promise<void> {
    if (facts.length === 0) return;
    logger.info({ count: facts.length }, 'Creating fact batch');
    for (const fact of facts) {
      await this.create(fact);
    }
  }

  /**
   * Find fact by ID.
   */
  async findById(id: string): Promise<MemoryFact | null> {
    return null;
  }

  /**
   * Find facts by source chunk.
   */
  async findByChunkId(chunkId: string): Promise<MemoryFact[]> {
    return [];
  }

  /**
   * Vector similarity search on facts.
   */
  async findSimilar(
    embedding: number[],
    organizationId: string,
    threshold: number = 0.85,
    limit: number = 10,
  ): Promise<Array<MemoryFact & { similarity: number }>> {
    // TODO:
    // SELECT *, 1 - (embedding <=> $1) AS similarity
    // FROM memory_facts
    // WHERE organization_id = $2
    //   AND 1 - (embedding <=> $1) > $3
    // ORDER BY similarity DESC
    // LIMIT $4
    return [];
  }

  /**
   * Search facts by entities (entity-boosted retrieval).
   * Returns facts that share entities with the query.
   */
  async findByEntities(
    entities: string[],
    organizationId: string,
    options?: { limit?: number; onlyValid?: boolean },
  ): Promise<MemoryFact[]> {
    const { limit = 20, onlyValid = true } = options ?? {};
    // TODO:
    // SELECT * FROM memory_facts
    // WHERE organization_id = $1
    //   AND entities && $2::text[]  -- array overlap
    //   AND ($3 = false OR temporal_valid_until IS NULL)
    // ORDER BY array_length(entities & $2::text[], 1) DESC, confidence DESC
    // LIMIT $4
    return [];
  }

  /**
   * Temporal query: find facts valid at a specific time or within a range.
   */
  async findByTemporal(
    organizationId: string,
    temporal: TemporalQuery,
    options?: { entities?: string[]; types?: FactType[]; limit?: number },
  ): Promise<MemoryFact[]> {
    const { limit = 20 } = options ?? {};
    // TODO:
    // SELECT * FROM memory_facts
    // WHERE organization_id = $1
    //   AND created_at BETWEEN $from AND $to
    //   AND ($onlyValid = false OR temporal_valid_until IS NULL)
    //   AND ($entities IS NULL OR entities && $entities)
    //   AND ($types IS NULL OR type = ANY($types))
    // ORDER BY created_at DESC
    // LIMIT $limit
    return [];
  }

  /**
   * Mark a fact as superseded by a newer fact.
   * ADD-only: we don't delete the old fact, just link them.
   */
  async markSuperseded(oldFactId: string, newFactId: string): Promise<void> {
    // UPDATE memory_facts
    // SET temporal_valid_until = NOW(),
    //     temporal_superseded_by = $newFactId,
    //     updated_at = NOW()
    // WHERE id = $oldFactId
  }

  /**
   * Get fact history for an entity (temporal chain).
   * Returns all facts mentioning an entity, ordered chronologically.
   */
  async getEntityHistory(
    entity: string,
    organizationId: string,
    limit: number = 50,
  ): Promise<MemoryFact[]> {
    // SELECT * FROM memory_facts
    // WHERE organization_id = $1
    //   AND $2 = ANY(entities)
    // ORDER BY temporal_valid_from ASC NULLS FIRST, created_at ASC
    // LIMIT $3
    return [];
  }

  /**
   * Update usage metrics (the only mutable fields on a fact).
   */
  async incrementUsage(factId: string): Promise<void> {
    // UPDATE memory_facts SET usage_count = usage_count + 1, last_accessed_at = NOW() WHERE id = $1
  }

  /**
   * Upvote a fact (developer found it useful).
   */
  async upvote(factId: string): Promise<void> {
    // UPDATE memory_facts SET upvotes = upvotes + 1 WHERE id = $1
  }

  /**
   * Get stats for monitoring.
   */
  async getStats(organizationId: string): Promise<{
    total: number;
    byType: Record<string, number>;
    validCount: number;
    supersededCount: number;
    avgConfidence: number;
  }> {
    return { total: 0, byType: {}, validCount: 0, supersededCount: 0, avgConfidence: 0 };
  }
}
