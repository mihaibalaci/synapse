/** BullMQ queue contracts and producers for ingestion and enrichment. */

import { Queue } from 'bullmq';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'ingestion-queue' });

export interface SessionProcessingJob {
  sessionId: string;
  organizationId: string;
  developerId: string;
  rawStorageKey: string;
  totalTokens: number;
  messageCount: number;
  priority: number;
}

export type ChunkProcessingAction =
  | 'facts'
  | 'knowledge'
  | 'deduplicate'
  | 'graph'
  | 'index';

export interface ChunkProcessingJob {
  chunkId: string;
  sessionId: string;
  action: ChunkProcessingAction;
}

export interface CaptureProcessingJob {
  captureId: string;
  organizationId: string;
}

export const QUEUE_NAMES = {
  SESSION_PROCESSING: 'session-processing',
  FACT_EXTRACTION: 'fact-extraction',
  KNOWLEDGE_EXTRACTION: 'knowledge-extraction',
  DEDUPLICATION: 'deduplication',
  GRAPH_PROCESSING: 'graph-processing',
  SEARCH_INDEXING: 'search-indexing',
  CAPTURE_PROCESSING: 'capture-processing',
} as const;

const queues = new Map<string, Queue>();

function getQueue(name: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const config = getConfig();
  const queue = new Queue(name, {
    connection: { url: config.REDIS_URL },
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  });
  queues.set(name, queue);
  return queue;
}

export async function enqueueSession(job: SessionProcessingJob): Promise<string> {
  const result = await getQueue(QUEUE_NAMES.SESSION_PROCESSING).add('process-session', job, {
    priority: Math.max(1, 10 - job.priority),
    jobId: `session-${job.sessionId}`,
  });
  logger.debug({ sessionId: job.sessionId, jobId: result.id }, 'Session enqueued');
  return result.id!;
}

function queueForAction(action: ChunkProcessingAction): string {
  switch (action) {
    case 'facts': return QUEUE_NAMES.FACT_EXTRACTION;
    case 'knowledge': return QUEUE_NAMES.KNOWLEDGE_EXTRACTION;
    case 'deduplicate': return QUEUE_NAMES.DEDUPLICATION;
    case 'graph': return QUEUE_NAMES.GRAPH_PROCESSING;
    case 'index': return QUEUE_NAMES.SEARCH_INDEXING;
  }
}

export async function enqueueChunkProcessing(job: ChunkProcessingJob): Promise<string> {
  const result = await getQueue(queueForAction(job.action)).add(job.action, job, {
    jobId: `${job.action}-${job.chunkId}`,
  });
  return result.id!;
}

/** Queue every independent deep-enrichment concern for one persisted chunk. */
export async function enqueueChunkEnrichment(
  chunkId: string,
  sessionId: string,
): Promise<void> {
  const actions: ChunkProcessingAction[] = ['facts', 'knowledge', 'deduplicate', 'graph'];
  await Promise.all(actions.map(action => enqueueChunkProcessing({ chunkId, sessionId, action })));
}

export async function enqueueCaptureProcessing(job: CaptureProcessingJob): Promise<string> {
  const result = await getQueue(QUEUE_NAMES.CAPTURE_PROCESSING).add('process-capture', job, {
    jobId: `capture-${job.captureId}`,
  });
  return result.id!;
}

export async function enqueueReindexing(chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  const queue = getQueue(QUEUE_NAMES.SEARCH_INDEXING);
  await queue.addBulk(chunkIds.map(chunkId => ({
    name: 'index',
    data: { chunkId, sessionId: '', action: 'index' as const },
    opts: { jobId: `index-${chunkId}` },
  })));
  logger.info({ count: chunkIds.length }, 'Search reindexing jobs enqueued');
}

export async function getQueueHealth(): Promise<Record<string, {
  waiting: number;
  active: number;
  failed: number;
}>> {
  const health: Record<string, { waiting: number; active: number; failed: number }> = {};
  for (const name of Object.values(QUEUE_NAMES)) {
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

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.entries()].map(async ([name, queue]) => {
    await queue.close();
    logger.debug({ queue: name }, 'Queue closed');
  }));
  queues.clear();
}
