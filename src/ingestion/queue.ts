/**
 * Ingestion Queue
 *
 * Uses BullMQ (backed by Redis) to manage async processing of uploaded sessions.
 * Provides at-least-once delivery, retries with exponential backoff,
 * and priority-based scheduling.
 */

import { Queue, Worker, Job } from 'bullmq';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'ingestion-queue' });

// ─── Job Types ───────────────────────────────────────────────────────────────

export interface SessionProcessingJob {
  sessionId: string;
  organizationId: string;
  developerId: string;
  rawStorageKey: string;
  totalTokens: number;
  messageCount: number;
  priority: number;
}

export interface ChunkProcessingJob {
  chunkId: string;
  sessionId: string;
  action: 'embed' | 'extract' | 'deduplicate' | 'index';
}

// ─── Queue Names ─────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  SESSION_PROCESSING: 'session-processing',
  CHUNK_PROCESSING: 'chunk-processing',
  EMBEDDING: 'embedding',
  KNOWLEDGE_EXTRACTION: 'knowledge-extraction',
  DEDUPLICATION: 'deduplication',
  REINDEXING: 'reindexing',
} as const;

// ─── Queue Factory ───────────────────────────────────────────────────────────

const queues = new Map<string, Queue>();

function getQueue(name: string): Queue {
  if (queues.has(name)) return queues.get(name)!;

  const config = getConfig();
  const queue = new Queue(name, {
    connection: { url: config.REDIS_URL },
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000, // 5s, 25s, 125s
      },
    },
  });

  queues.set(name, queue);
  return queue;
}

// ─── Enqueue Functions ───────────────────────────────────────────────────────

export async function enqueueSession(job: SessionProcessingJob): Promise<string> {
  const queue = getQueue(QUEUE_NAMES.SESSION_PROCESSING);
  const result = await queue.add('process-session', job, {
    priority: 10 - job.priority, // BullMQ: lower number = higher priority
    jobId: `session-${job.sessionId}`, // Idempotent — same session won't be queued twice
  });

  logger.debug({ sessionId: job.sessionId, jobId: result.id }, 'Session enqueued');
  return result.id!;
}

export async function enqueueChunkProcessing(job: ChunkProcessingJob): Promise<string> {
  const queueName = job.action === 'embed'
    ? QUEUE_NAMES.EMBEDDING
    : job.action === 'extract'
      ? QUEUE_NAMES.KNOWLEDGE_EXTRACTION
      : job.action === 'deduplicate'
        ? QUEUE_NAMES.DEDUPLICATION
        : QUEUE_NAMES.CHUNK_PROCESSING;

  const queue = getQueue(queueName);
  const result = await queue.add(job.action, job, {
    jobId: `${job.action}-${job.chunkId}`,
  });

  return result.id!;
}

export async function enqueueReindexing(chunkIds: string[]): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.REINDEXING);
  const jobs = chunkIds.map(id => ({
    name: 'reindex',
    data: { chunkId: id },
    opts: { jobId: `reindex-${id}` },
  }));
  await queue.addBulk(jobs);
  logger.info({ count: chunkIds.length }, 'Reindexing jobs enqueued');
}

// ─── Queue Health ────────────────────────────────────────────────────────────

export async function getQueueHealth(): Promise<Record<string, { waiting: number; active: number; failed: number }>> {
  const health: Record<string, { waiting: number; active: number; failed: number }> = {};

  for (const [name] of Object.entries(QUEUE_NAMES)) {
    const queue = getQueue(name);
    const [waiting, active, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getFailedCount(),
    ]);
    health[name] = { waiting, active, failed };
  }

  return health;
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

export async function closeQueues(): Promise<void> {
  for (const [name, queue] of queues.entries()) {
    await queue.close();
    logger.debug({ queue: name }, 'Queue closed');
  }
  queues.clear();
}
