/**
 * Feedback Processor
 *
 * Records and processes feedback events from retrieval.
 * Every search result interaction is tracked:
 *   - shown, clicked, copied, used, thumbs_up, thumbs_down
 *
 * This data feeds back into the ranking engine to continuously
 * improve result quality (online learning / PageRank-style).
 */

import { createChildLogger } from '../utils/logger.js';
import { type FeedbackEvent } from '../models/index.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { query } from '../storage/database.js';

const logger = createChildLogger({ module: 'feedback' });

export class FeedbackProcessor {
  private chunkRepo: ChunkRepository;

  constructor() {
    this.chunkRepo = new ChunkRepository();
  }

  /**
   * Record a single feedback event and update chunk metrics.
   */
  async recordFeedback(event: FeedbackEvent): Promise<void> {
    if (!event.organizationId) {
      throw new Error('Feedback organization identity is required');
    }
    // 1. Persist the feedback event
    await this.persistEvent(event);

    // 2. Update chunk metrics based on action
    await this.updateChunkMetrics(event);

    logger.debug({
      action: event.action,
      resultId: event.resultId,
      developerId: event.developerId,
    }, 'Feedback recorded');
  }

  /**
   * Persist feedback event to database.
   */
  private async persistEvent(event: FeedbackEvent): Promise<void> {
    await query(
      `INSERT INTO feedback_events
         (id, search_id, result_id, developer_id, organization_id, action,
          comment, conversation_successful, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.id,
        event.searchId,
        event.resultId,
        event.developerId,
        event.organizationId,
        event.action,
        event.comment ?? null,
        event.conversationSuccessful ?? null,
        event.timestamp,
      ],
    );
  }

  /**
   * Update chunk metrics based on feedback action.
   * Different actions have different weights.
   */
  private async updateChunkMetrics(event: FeedbackEvent): Promise<void> {
    const updates: Partial<{ usageCount: number; upvotes: number; downvotes: number; qualityScore: number }> = {};

    switch (event.action) {
      case 'clicked':
        updates.usageCount = 1; // Increment
        break;

      case 'copied':
        updates.usageCount = 2; // Copying is stronger signal
        break;

      case 'used':
        updates.usageCount = 3; // Actually used in AI context = strong signal
        break;

      case 'thumbs_up':
        updates.upvotes = 1;
        break;

      case 'thumbs_down':
        updates.downvotes = 1;
        break;

      case 'reported':
        // Reported content gets quality penalty
        updates.qualityScore = -0.1;
        break;

      default:
        // 'shown' and 'dismissed' — no metric update
        return;
    }

    if (Object.keys(updates).length > 0) {
      await this.chunkRepo.updateMetrics(event.resultId, updates);
    }

    // If conversation was successful, boost the chunk
    if (event.conversationSuccessful === true) {
      await this.chunkRepo.updateMetrics(event.resultId, { qualityScore: 0.05 });
    } else if (event.conversationSuccessful === false) {
      await this.chunkRepo.updateMetrics(event.resultId, { qualityScore: -0.02 });
    }
  }

  /**
   * Compute click-through rate for a chunk (used by ranking engine).
   */
  async getClickThroughRate(chunkId: string): Promise<number> {
    // TODO: SELECT
    //   COUNT(*) FILTER (WHERE action = 'clicked') AS clicks,
    //   COUNT(*) FILTER (WHERE action = 'shown') AS impressions
    // FROM feedback_events WHERE result_id = $1
    return 0.5; // Default CTR
  }

  /**
   * Get aggregate feedback stats for ranking weight optimization.
   */
  async getAggregateStats(organizationId: string, days: number = 30): Promise<{
    totalSearches: number;
    totalClicks: number;
    totalThumbsUp: number;
    totalThumbsDown: number;
    avgCTR: number;
    topPerformingChunks: string[];
  }> {
    // TODO: Aggregate queries over feedback_events
    return {
      totalSearches: 0,
      totalClicks: 0,
      totalThumbsUp: 0,
      totalThumbsDown: 0,
      avgCTR: 0,
      topPerformingChunks: [],
    };
  }
}
