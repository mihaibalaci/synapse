import { type ChunkProcessingJob } from './queue.js';
import { ProcessingStatusRepository } from '../storage/processing-status-repository.js';

export async function runTrackedChunkJob<T>(
  job: ChunkProcessingJob,
  processor: () => Promise<T>,
): Promise<T> {
  const statuses = new ProcessingStatusRepository();
  const claim = await statuses.markProcessing(job.chunkId, job.action);
  if (claim === 'terminal') return undefined as T;
  if (claim === 'busy') throw new Error(`Chunk action ${job.action}:${job.chunkId} is already processing`);
  try {
    const result = await processor();
    const blocked = typeof result === 'object' && result !== null
      && 'blocked' in result && result.blocked === true;
    await statuses.markCompleted(job.chunkId, job.action, blocked);
    return result;
  } catch (error) {
    await statuses.markFailed(job.chunkId, job.action, (error as Error).message);
    throw error;
  }
}
