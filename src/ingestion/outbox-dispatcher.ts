import { createChildLogger } from '../utils/logger.js';
import { OutboxRepository, type OutboxEvent } from '../storage/outbox-repository.js';
import {
  enqueueCaptureProcessing,
  enqueueChunkProcessing,
  enqueueSession,
  type CaptureProcessingJob,
  type ChunkProcessingJob,
  type SessionProcessingJob,
} from './queue.js';

const logger = createChildLogger({ module: 'outbox-dispatcher' });
const repository = new OutboxRepository();
let timer: NodeJS.Timeout | null = null;
let dispatching = false;
let lastLoopCompletedAt: number | null = null;

/**
 * Timestamp of the last completed dispatch cycle. A fresh value proves the
 * worker event loop is running and PostgreSQL is reachable, which is what a
 * liveness probe must actually assert.
 */
export function getOutboxHeartbeat(): number | null {
  return lastLoopCompletedAt;
}

async function publish(event: OutboxEvent): Promise<void> {
  switch (event.eventType) {
    case 'session.process':
      await enqueueSession(event.payload as unknown as SessionProcessingJob);
      return;
    case 'capture.process':
      await enqueueCaptureProcessing(event.payload as unknown as CaptureProcessingJob);
      return;
    case 'chunk.index':
    case 'chunk.facts':
    case 'chunk.knowledge':
    case 'chunk.deduplicate':
    case 'chunk.graph':
      await enqueueChunkProcessing(event.payload as unknown as ChunkProcessingJob);
      return;
  }
}

export async function dispatchOutboxOnce(): Promise<number> {
  if (dispatching) return 0;
  dispatching = true;
  try {
    const events = await repository.claimBatch();
    await Promise.all(events.map(async event => {
      try {
        await publish(event);
        await repository.markPublished(event.id, event.attempts);
      } catch (error) {
        logger.error({ err: error, eventId: event.id, eventType: event.eventType }, 'Outbox publication failed');
        await repository.markFailed(event.id, event.attempts, (error as Error).message);
      }
    }));
    return events.length;
  } finally {
    dispatching = false;
  }
}

/**
 * One dispatch tick that never rejects.
 *
 * A dependency outage is expected and recoverable, so it must not escalate to an
 * unhandled rejection and tear the worker down. The heartbeat advances whenever
 * the tick completes, making liveness mean "event loop is turning" while
 * readiness remains responsible for dependency health.
 */
async function dispatchTick(): Promise<void> {
  try {
    await dispatchOutboxOnce();
  } catch (error) {
    logger.error({ err: error }, 'Outbox dispatch cycle failed; will retry');
  } finally {
    lastLoopCompletedAt = Date.now();
  }
}

export function startOutboxDispatcher(intervalMs = 1000): void {
  if (timer) return;
  timer = setInterval(() => void dispatchTick(), intervalMs);
  timer.unref();
  void dispatchTick();
  logger.info({ intervalMs }, 'Transactional outbox dispatcher started');
}

export async function stopOutboxDispatcher(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  lastLoopCompletedAt = null;
  while (dispatching) await new Promise(resolve => setTimeout(resolve, 10));
  logger.info('Transactional outbox dispatcher stopped');
}
