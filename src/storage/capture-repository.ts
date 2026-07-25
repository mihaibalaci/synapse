/**
 * Capture Repository
 *
 * Persistence for ambient capture events (terminal, browser, meetings, etc.).
 * These are lightweight events that may later be processed into facts.
 */

import { type CaptureEvent } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'capture-repository' });

export class CaptureRepository {
  async create(event: CaptureEvent): Promise<void> {
    logger.debug({ eventId: event.id, type: event.type }, 'Storing capture event');
    // TODO: INSERT INTO capture_events (...)
  }

  async createBatch(events: CaptureEvent[]): Promise<void> {
    for (const event of events) { await this.create(event); }
  }

  async findById(id: string): Promise<CaptureEvent | null> {
    return null;
  }

  async findUnprocessed(
    organizationId: string,
    options?: { type?: string; limit?: number },
  ): Promise<CaptureEvent[]> {
    // SELECT * FROM capture_events WHERE processed = false AND organization_id = $1 LIMIT $2
    return [];
  }

  async markProcessed(eventId: string, factIds: string[]): Promise<void> {
    // UPDATE capture_events SET processed = true, fact_ids = $2 WHERE id = $1
  }

  async findByDeveloper(
    developerId: string,
    options?: { from?: string; to?: string; type?: string; limit?: number },
  ): Promise<CaptureEvent[]> {
    return [];
  }
}
