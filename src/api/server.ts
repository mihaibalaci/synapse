/**
 * Fastify Server Setup
 *
 * Configures the HTTP server with:
 * - CORS for IDE plugin access
 * - Rate limiting
 * - Request logging
 * - Health checks
 * - Graceful shutdown
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { registerUploadRoutes } from './upload.js';
import { registerRetrievalRoutes } from './retrieval-routes.js';
import { registerFeedbackRoutes } from './feedback-routes.js';
import { registerCaptureRoutes } from './capture-routes.js';
import { registerAuthentication } from './auth.js';
import { registerFactRoutes } from './fact-routes.js';
import { checkDatabaseHealth } from '../storage/database.js';
import { checkCacheHealth } from '../storage/cache.js';
import { ObjectStorageClient } from '../storage/object-storage.js';
import { getQueueHealth } from '../ingestion/queue.js';

export async function createServer(): Promise<FastifyInstance> {
  const config = getConfig();
  const logger = getLogger();

  const app = Fastify({
    logger: false, // We use our own pino logger
    requestTimeout: 30000,
    bodyLimit: 10 * 1024 * 1024, // 10 MB
    genReqId: () => crypto.randomUUID(),
  });

  // ─── Plugins ─────────────────────────────────────────────────────────────

  await app.register(cors, {
    origin: true, // Allow all origins (IDE plugins)
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    credentials: true,
  });

  await registerAuthentication(app);

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: request => request.authContext?.userId ?? request.ip,
  });

  // ─── Request Hooks ───────────────────────────────────────────────────────

  app.addHook('onRequest', async (request) => {
    logger.debug({
      method: request.method,
      url: request.url,
      requestId: request.id,
    }, 'Incoming request');
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
      requestId: request.id,
    }, 'Request completed');
  });

  // ─── Health Checks ───────────────────────────────────────────────────────

  app.get('/health', async () => ({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  }));

  app.get('/health/ready', async (_request, reply) => {
    const [database, redis, objectStorage, queueResult] = await Promise.all([
      checkDatabaseHealth(),
      checkCacheHealth(),
      new ObjectStorageClient().checkBucket(config.S3_BUCKET),
      getQueueHealth().then(() => ({ healthy: true })).catch(() => ({ healthy: false })),
    ]);
    const ready = database.healthy && redis.healthy && objectStorage.healthy && queueResult.healthy;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: database.healthy ? 'ok' : 'unavailable',
        redis: redis.healthy ? 'ok' : 'unavailable',
        objectStorage: objectStorage.healthy ? 'ok' : 'unavailable',
        queue: queueResult.healthy ? 'ok' : 'unavailable',
      },
    });
  });

  // ─── API Routes ──────────────────────────────────────────────────────────

  await registerUploadRoutes(app);
  await registerCaptureRoutes(app);
  await registerRetrievalRoutes(app);
  await registerFactRoutes(app);
  await registerFeedbackRoutes(app);

  // ─── Error Handler ───────────────────────────────────────────────────────

  app.setErrorHandler(async (error, request, reply) => {
    logger.error({
      err: error,
      requestId: request.id,
      method: request.method,
      url: request.url,
    }, 'Unhandled error');

    const normalizedError = error as { statusCode?: number; message?: string };
    const statusCode = normalizedError.statusCode ?? 500;

    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message: statusCode >= 500
        ? 'An unexpected error occurred'
        : normalizedError.message ?? 'Request failed',
      requestId: request.id,
    });
  });

  return app;
}

// ─── Server Startup ──────────────────────────────────────────────────────────

export async function startServer(): Promise<FastifyInstance> {
  const config = getConfig();
  const logger = getLogger();
  const app = await createServer();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info({ port: config.PORT, host: config.HOST }, 'Server started');
    return app;
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}
