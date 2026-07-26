/** Worker that exposes persisted chunks through PostgreSQL full-text search. */

import { Job, Worker } from 'bullmq';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { SearchIndex } from '../storage/search-index.js';
import { QUEUE_NAMES, type ChunkProcessingJob } from './queue.js';
import { runTrackedChunkJob } from './tracked-job.js';

const logger = createChildLogger({ module: 'search-worker' });
let searchWorker: Worker<ChunkProcessingJob> | null = null;

export async function startSearchWorker(): Promise<Worker<ChunkProcessingJob>> {
  if (searchWorker) return searchWorker;

  const config = getConfig();
  const chunkRepository = new ChunkRepository();
  const searchIndex = new SearchIndex();
  await searchIndex.initialize();

  searchWorker = new Worker<ChunkProcessingJob>(
    QUEUE_NAMES.SEARCH_INDEXING,
    async (job: Job<ChunkProcessingJob>) => runTrackedChunkJob(job.data, async () => {
      const chunk = await chunkRepository.findById(job.data.chunkId);
      if (!chunk) throw new Error(`Chunk ${job.data.chunkId} not found for search indexing`);
      if (chunk.acl?.classification === 'restricted' || chunk.acl?.discoverable === false) {
        await searchIndex.deleteChunk(chunk.id);
        logger.warn({ chunkId: chunk.id }, 'Restricted chunk blocked from search indexing');
        return { chunkId: chunk.id, blocked: true };
      }
      await searchIndex.indexChunk(chunk);
      return { chunkId: chunk.id };
    }),
    {
      connection: { url: config.REDIS_URL },
      concurrency: config.QUEUE_CONCURRENCY,
      limiter: { max: 200, duration: 60_000 },
    },
  );

  searchWorker.on('failed', (job, error) => {
    logger.error({ chunkId: job?.data.chunkId, err: error }, 'Search indexing job failed');
  });
  searchWorker.on('error', error => logger.error({ err: error }, 'Search worker error'));
  logger.info({ concurrency: config.QUEUE_CONCURRENCY }, 'Search worker started');
  return searchWorker;
}

export async function stopSearchWorker(): Promise<void> {
  if (!searchWorker) return;
  await searchWorker.close();
  searchWorker = null;
  logger.info('Search worker stopped');
}
