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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Organization-ID'],
    credentials: true,
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => {
      // Rate limit per developer (from auth token)
      return request.headers['x-developer-id'] as string ?? request.ip;
    },
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

  app.get('/health/ready', async () => {
    // TODO: Check DB, Redis, S3 connectivity
    return {
      status: 'ready',
      checks: {
        database: 'ok',
        redis: 'ok',
        objectStorage: 'ok',
        queue: 'ok',
      },
    };
  });

  // ─── API Routes ──────────────────────────────────────────────────────────

  await registerUploadRoutes(app);
  await registerCaptureRoutes(app);
  await registerRetrievalRoutes(app);
  await registerFeedbackRoutes(app);

  // ─── Error Handler ───────────────────────────────────────────────────────

  app.setErrorHandler(async (error, request, reply) => {
    logger.error({
      err: error,
      requestId: request.id,
      method: request.method,
      url: request.url,
    }, 'Unhandled error');

    const statusCode = error.statusCode ?? 500;

    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message: statusCode >= 500
        ? 'An unexpected error occurred'
        : error.message,
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
