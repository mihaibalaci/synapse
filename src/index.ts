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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new requests
    await server.close();

    // Close queue connections
    await closeQueues();

    // Close DB connections (TODO)

    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Unhandled rejection handler
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
