/**
 * Recall — Entry Point
 *
 * Bootstraps configuration, starts the HTTP server,
 * and sets up graceful shutdown handlers.
 */

import { loadConfig } from './config/index.js';
import { getLogger } from './utils/logger.js';
import { startServer } from './api/server.js';
import { closeQueues } from './ingestion/queue.js';
import { closeCache } from './storage/cache.js';
import { closeDatabase } from './storage/database.js';

async function main(): Promise<void> {
  // Load and validate config first
  const config = loadConfig();
  const logger = getLogger();

  logger.info({
    env: config.NODE_ENV,
    port: config.PORT,
  }, 'Starting Recall');

  // Start HTTP server
  const server = await startServer();

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await server.close();
      await Promise.all([closeQueues(), closeCache(), closeDatabase()]);
      logger.info('Graceful shutdown complete');
    } catch (error) {
      logger.error({ err: error }, 'Graceful shutdown failed');
      exitCode = 1;
    }
    process.exitCode = exitCode;
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', reason => {
    logger.fatal({ reason }, 'Unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
