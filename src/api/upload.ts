/**
 * Session Upload API
 *
 * Handles incoming AI session uploads from IDE plugins.
 * - Validates payload against schema
 * - Persists raw session to object storage (S3)
 * - Writes metadata record to Postgres
 * - Enqueues session for async processing
 * - Returns 202 Accepted immediately
 *
 * Design: Non-blocking. Developer should never wait for parsing/embedding.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { SessionUploadSchema, type SessionUpload, type SessionRecord } from '../models/index.js';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { enqueueSession } from '../ingestion/queue.js';
import { ObjectStorageClient } from '../storage/object-storage.js';
import { SessionRepository } from '../storage/session-repository.js';

const logger = createChildLogger({ module: 'upload-api' });

// ─── Route Handler ───────────────────────────────────────────────────────────

interface UploadBody {
  Body: SessionUpload;
}

async function handleSessionUpload(
  request: FastifyRequest<UploadBody>,
  reply: FastifyReply,
): Promise<void> {
  const startTime = Date.now();

  // 1. Validate payload
  const parseResult = SessionUploadSchema.safeParse(request.body);
  if (!parseResult.success) {
    logger.warn({ errors: parseResult.error.issues }, 'Invalid session upload payload');
    reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid session upload payload',
      details: parseResult.error.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const payload = parseResult.data;
  const sessionId = uuidv4();
  const config = getConfig();

  logger.info({
    sessionId,
    developerId: payload.developerId,
    messageCount: payload.messages.length,
    totalTokens: payload.totalTokens,
    provider: payload.metadata.aiProvider,
  }, 'Processing session upload');

  try {
    // 2. Store raw payload in object storage (immutable)
    const rawStorageKey = `sessions/${payload.organizationId}/${payload.developerId}/${sessionId}.json`;

    const objectStorage = new ObjectStorageClient();
    await objectStorage.putObject(config.S3_BUCKET, rawStorageKey, JSON.stringify(payload), {
      contentType: 'application/json',
      metadata: {
        sessionId,
        developerId: payload.developerId,
        organizationId: payload.organizationId,
        provider: payload.metadata.aiProvider,
        uploadedAt: new Date().toISOString(),
      },
    });

    // 3. Create session record in database
    const now = new Date().toISOString();
    const sessionRecord: SessionRecord = {
      ...payload,
      id: sessionId,
      status: 'uploaded',
      rawStorageKey,
      createdAt: now,
      updatedAt: now,
      processingAttempts: 0,
    };

    const sessionRepo = new SessionRepository();
    await sessionRepo.create(sessionRecord);

    // 4. Enqueue for async processing
    await enqueueSession({
      sessionId,
      organizationId: payload.organizationId,
      developerId: payload.developerId,
      rawStorageKey,
      totalTokens: payload.totalTokens,
      messageCount: payload.messages.length,
      priority: calculatePriority(payload),
    });

    const latencyMs = Date.now() - startTime;
    logger.info({ sessionId, latencyMs }, 'Session upload accepted');

    // 5. Return 202 Accepted (processing happens async)
    reply.status(202).send({
      sessionId,
      status: 'uploaded',
      message: 'Session accepted for processing',
      estimatedProcessingTime: estimateProcessingTime(payload),
      trackingUrl: `/api/v1/sessions/${sessionId}/status`,
    });
  } catch (error) {
    logger.error({ err: error, sessionId }, 'Failed to process session upload');
    reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'Failed to process session upload. Please retry.',
      retryable: true,
    });
  }
}

// ─── Session Status Endpoint ─────────────────────────────────────────────────

interface StatusParams {
  Params: { sessionId: string };
}

async function handleSessionStatus(
  request: FastifyRequest<StatusParams>,
  reply: FastifyReply,
): Promise<void> {
  const { sessionId } = request.params;

  const sessionRepo = new SessionRepository();
  const session = await sessionRepo.findById(sessionId);

  if (!session) {
    reply.status(404).send({ error: 'NOT_FOUND', message: 'Session not found' });
    return;
  }

  reply.send({
    sessionId: session.id,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    processingAttempts: session.processingAttempts,
    lastError: session.lastError,
  });
}

// ─── Batch Upload ────────────────────────────────────────────────────────────

interface BatchUploadBody {
  Body: { sessions: SessionUpload[] };
}

async function handleBatchUpload(
  request: FastifyRequest<BatchUploadBody>,
  reply: FastifyReply,
): Promise<void> {
  const { sessions } = request.body;

  if (!Array.isArray(sessions) || sessions.length === 0) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'sessions array is required' });
    return;
  }

  if (sessions.length > 50) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Maximum 50 sessions per batch' });
    return;
  }

  const results: Array<{ clientId: string; sessionId?: string; error?: string }> = [];

  for (const session of sessions) {
    const parseResult = SessionUploadSchema.safeParse(session);
    if (!parseResult.success) {
      results.push({
        clientId: session.clientId ?? 'unknown',
        error: parseResult.error.issues[0]?.message ?? 'Validation failed',
      });
      continue;
    }

    // Process each valid session (simplified — in production, batch the S3/DB writes)
    const sessionId = uuidv4();
    results.push({ clientId: session.clientId, sessionId });
  }

  reply.status(202).send({
    accepted: results.filter(r => r.sessionId).length,
    rejected: results.filter(r => r.error).length,
    results,
  });
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function calculatePriority(payload: SessionUpload): number {
  // Higher priority for:
  // - Shorter sessions (quick answers, likely high-value single insights)
  // - Sessions with code diffs (likely debugging/fixes)
  // - Sessions from active repositories
  let priority = 5; // Default medium

  if (payload.messages.length <= 5) priority += 2;
  if (payload.git?.codeDiffs && payload.git.codeDiffs.length > 0) priority += 1;
  if (payload.totalTokens < 5000) priority += 1;

  return Math.min(priority, 10);
}

function estimateProcessingTime(payload: SessionUpload): string {
  const tokenCount = payload.totalTokens;
  if (tokenCount < 5000) return '~30 seconds';
  if (tokenCount < 20000) return '~1 minute';
  if (tokenCount < 50000) return '~3 minutes';
  return '~5 minutes';
}

// ─── Route Registration ──────────────────────────────────────────────────────

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  // Single session upload
  app.post('/api/v1/sessions', handleSessionUpload);

  // Batch upload
  app.post('/api/v1/sessions/batch', handleBatchUpload);

  // Session status
  app.get('/api/v1/sessions/:sessionId/status', handleSessionStatus);

  logger.info('Upload API routes registered');
}
