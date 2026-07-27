/** Dedicated process entrypoint for every asynchronous Recall worker. */

import { loadConfig } from './config/index.js';
import { getLogger } from './utils/logger.js';
import { startPipelineWorker, stopPipelineWorker } from './ingestion/pipeline.js';
import {
  startFactExtractionWorker,
  stopFactExtractionWorker,
} from './ingestion/fact-extractor.js';
import { startExtractionWorker, stopExtractionWorker } from './ingestion/knowledge-extractor.js';
import { startDeduplicationWorker, stopDeduplicationWorker } from './ingestion/deduplication.js';
import { startGraphWorker, stopGraphWorker } from './ingestion/graph-worker.js';
import { startSearchWorker, stopSearchWorker } from './ingestion/search-worker.js';
import { startCaptureWorker, stopCaptureWorker } from './ingestion/capture-worker.js';
import { startOutboxDispatcher, stopOutboxDispatcher } from './ingestion/outbox-dispatcher.js';
import { closeQueues } from './ingestion/queue.js';
import { closeDatabase, enterDatabaseContext } from './storage/database.js';
import {
  beginWorkerDrain,
  startWorkerHealthServer,
  stopWorkerHealthServer,
} from './worker-health.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger();

  enterDatabaseContext({
    userId: 'synapse-worker',
    organizationId: '',
    teamIds: [],
    roles: ['service'],
    repositoryAccess: [],
    isService: true,
  });

  startPipelineWorker();
  startFactExtractionWorker();
  startExtractionWorker();
  startDeduplicationWorker();
  startGraphWorker();
  startCaptureWorker();
  await startSearchWorker();
  startOutboxDispatcher();
  startWorkerHealthServer();

  logger.info({ concurrency: config.QUEUE_CONCURRENCY }, 'All Recall workers started');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutdown signal received');
    // Fail health checks first so no new traffic or scheduling decisions
    // assume this replica is available while in-flight jobs drain.
    beginWorkerDrain();

    await Promise.all([
      stopPipelineWorker(),
      stopFactExtractionWorker(),
      stopExtractionWorker(),
      stopDeduplicationWorker(),
      stopGraphWorker(),
      stopSearchWorker(),
      stopCaptureWorker(),
      stopOutboxDispatcher(),
    ]);
    await closeQueues();
    await closeDatabase();
    await stopWorkerHealthServer();
    logger.info('All Recall workers stopped');
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection means some code path lost track of its own errors,
  // so process state is unknown and the safe action is to drain and let the
  // orchestrator replace this replica. Recoverable dependency failures are
  // handled at their source and must never reach here.
  process.on('unhandledRejection', reason => {
    logger.fatal({ reason }, 'Unhandled worker rejection; draining for replacement');
    void shutdown('unhandledRejection').finally(() => { process.exit(1); });
  });
}

main().catch(error => {
  console.error('Fatal worker startup error:', error);
  process.exitCode = 1;
});
