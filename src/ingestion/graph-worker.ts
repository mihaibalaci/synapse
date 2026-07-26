/** Worker that materializes chunk relationships in the PostgreSQL graph. */

import { Job, Worker } from 'bullmq';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { GraphRepository } from '../storage/graph-repository.js';
import { QUEUE_NAMES, type ChunkProcessingJob } from './queue.js';
import { runTrackedChunkJob } from './tracked-job.js';

const logger = createChildLogger({ module: 'graph-worker' });
let graphWorker: Worker<ChunkProcessingJob> | null = null;

export function startGraphWorker(): Worker<ChunkProcessingJob> {
  if (graphWorker) return graphWorker;

  const config = getConfig();
  const chunkRepository = new ChunkRepository();
  const graphRepository = new GraphRepository();

  graphWorker = new Worker<ChunkProcessingJob>(
    QUEUE_NAMES.GRAPH_PROCESSING,
    async (job: Job<ChunkProcessingJob>) => runTrackedChunkJob(job.data, async () => {
      const chunk = await chunkRepository.findById(job.data.chunkId);
      if (!chunk) throw new Error(`Chunk ${job.data.chunkId} not found for graph processing`);
      if (chunk.acl?.classification === 'restricted' || chunk.acl?.discoverable === false) {
        logger.warn({ chunkId: chunk.id }, 'Restricted chunk blocked from graph processing');
        return { chunkId: chunk.id, blocked: true };
      }

      await graphRepository.indexChunk({
        id: chunk.id,
        title: chunk.title,
        authorId: chunk.authorId,
        organizationId: chunk.organizationId,
        repository: chunk.repository,
        language: chunk.language,
        frameworks: chunk.frameworks,
        entities: chunk.entities,
      });
      return { chunkId: chunk.id };
    }),
    {
      connection: { url: config.REDIS_URL },
      concurrency: config.QUEUE_CONCURRENCY,
      limiter: { max: 100, duration: 60_000 },
    },
  );

  graphWorker.on('failed', (job, error) => {
    logger.error({ chunkId: job?.data.chunkId, err: error }, 'Graph processing job failed');
  });
  graphWorker.on('error', error => logger.error({ err: error }, 'Graph worker error'));
  logger.info({ concurrency: config.QUEUE_CONCURRENCY }, 'Graph worker started');
  return graphWorker;
}

export async function stopGraphWorker(): Promise<void> {
  if (!graphWorker) return;
  await graphWorker.close();
  graphWorker = null;
  logger.info('Graph worker stopped');
}
