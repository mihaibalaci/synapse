/**
 * Feedback API Routes
 *
 * Collects usage signals from IDE plugins to improve ranking.
 * Every retrieval result can receive feedback: clicked, copied, used, thumbs up/down.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { FeedbackEventSchema, type FeedbackEvent } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { FeedbackProcessor } from '../retrieval/feedback.js';
import { v4 as uuidv4 } from 'uuid';

const logger = createChildLogger({ module: 'feedback-api' });

// ─── Submit Feedback ─────────────────────────────────────────────────────────

interface FeedbackBody {
  Body: Omit<FeedbackEvent, 'id' | 'timestamp'>;
}

async function handleFeedback(
  request: FastifyRequest<FeedbackBody>,
  reply: FastifyReply,
): Promise<void> {
  const event: FeedbackEvent = {
    ...request.body,
    id: uuidv4(),
    timestamp: new Date().toISOString(),
  };

  const parseResult = FeedbackEventSchema.safeParse(event);
  if (!parseResult.success) {
    reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid feedback event',
      details: parseResult.error.issues,
    });
    return;
  }

  try {
    const processor = new FeedbackProcessor();
    await processor.recordFeedback(parseResult.data);

    logger.debug({
      action: event.action,
      resultId: event.resultId,
      developerId: event.developerId,
    }, 'Feedback recorded');

    reply.status(201).send({ id: event.id, recorded: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to record feedback');
    reply.status(500).send({ error: 'FEEDBACK_ERROR', message: 'Failed to record feedback' });
  }
}

// ─── Batch Feedback ──────────────────────────────────────────────────────────

interface BatchFeedbackBody {
  Body: { events: Array<Omit<FeedbackEvent, 'id' | 'timestamp'>> };
}

async function handleBatchFeedback(
  request: FastifyRequest<BatchFeedbackBody>,
  reply: FastifyReply,
): Promise<void> {
  const { events } = request.body;

  if (!Array.isArray(events) || events.length === 0) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'events array required' });
    return;
  }

  if (events.length > 100) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Max 100 events per batch' });
    return;
  }

  const processor = new FeedbackProcessor();
  let recorded = 0;

  for (const rawEvent of events) {
    const event: FeedbackEvent = {
      ...rawEvent,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };

    const parseResult = FeedbackEventSchema.safeParse(event);
    if (parseResult.success) {
      await processor.recordFeedback(parseResult.data);
      recorded++;
    }
  }

  reply.status(201).send({ recorded, total: events.length });
}

// ─── Route Registration ──────────────────────────────────────────────────────

export async function registerFeedbackRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/feedback', handleFeedback);
  app.post('/api/v1/feedback/batch', handleBatchFeedback);
  logger.info('Feedback API routes registered');
}
