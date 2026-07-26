/**
 * Capture API Routes (v3 — Pieces-inspired)
 *
 * Supports two capture modes:
 *   - Passive: IDE plugins auto-upload completed sessions silently
 *   - Active: Developer explicitly saves with metadata/tags
 *
 * Also handles ambient capture events (terminal, browser, meetings)
 * and provides a streaming endpoint for real-time turn-by-turn ingestion.
 *
 * The key insight from Pieces: requiring manual "Save" kills adoption.
 * Passive capture should be the default; active is for high-value enrichment.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { CaptureEventSchema, SessionUploadSchema, type CaptureEvent, type SessionUpload } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { ObjectStorageClient } from '../storage/object-storage.js';
import { SessionRepository } from '../storage/session-repository.js';
import { CaptureRepository } from '../storage/capture-repository.js';

const logger = createChildLogger({ module: 'capture-api' });

// ─── Passive Capture: Auto-upload AI session ─────────────────────────────────

interface PassiveCaptureBody {
  Body: {
    /** Minimal session data — no extra effort from developer */
    messages: Array<{
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      timestamp?: string;
    }>;
    /** Auto-detected context */
    source: string;           // "cursor", "kiro", "copilot", "windsurf", "claude"
    repository?: string;      // Detected from git
    branch?: string;
    language?: string;        // Detected from active file
    filePath?: string;        // Active file when session ended
    /** Legacy identity fields are ignored; verified JWT claims are authoritative. */
    developerId?: string;
    organizationId?: string;
  };
}

async function handlePassiveCapture(
  request: FastifyRequest<PassiveCaptureBody>,
  reply: FastifyReply,
): Promise<void> {
  const { messages, source, repository, branch, language, filePath } = request.body;
  const { userId: developerId, organizationId, teamIds } = request.authContext;

  if (!messages || messages.length < 2) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'At least 2 messages required' });
    return;
  }

  const sessionId = uuidv4();
  const now = new Date().toISOString();

  // Estimate token count (rough: 4 chars ≈ 1 token)
  const totalTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

  // Build a lightweight session record
  const session: SessionUpload = {
    clientId: sessionId,
    developerId,
    organizationId,
    teamId: teamIds[0],
    messages: messages.map((m, i) => ({
      id: uuidv4(),
      role: m.role,
      content: m.content,
      codeBlocks: [],
      timestamp: m.timestamp ?? now,
      tokenCount: Math.ceil(m.content.length / 4),
      toolCalls: [],
    })),
    metadata: {
      project: repository?.split('/').pop() ?? 'unknown',
      language: language ?? 'unknown',
      languages: language ? [language] : [],
      frameworks: [],
      aiProvider: source as any ?? 'custom',
      aiModel: 'unknown',
      idePlugin: `${source}-passive`,
      tags: ['auto-captured'],
    },
    git: repository ? { repository, branch: branch ?? 'main', filesTouched: filePath ? [filePath] : [], codeDiffs: [] } : undefined,
    startedAt: messages[0].timestamp ?? now,
    endedAt: messages[messages.length - 1].timestamp ?? now,
    totalTokens,
  };

  try {
    // Store raw + enqueue (same as explicit upload, but flagged as passive)
    const config = getConfig();
    const rawKey = `sessions/${organizationId}/${developerId}/${sessionId}.json`;
    const objectStorage = new ObjectStorageClient();
    await objectStorage.putObject(config.S3_BUCKET, rawKey, JSON.stringify(session), {
      contentType: 'application/json',
      metadata: { captureMode: 'passive', source },
    });

    const sessionRepo = new SessionRepository();
    await sessionRepo.createWithOutbox({
      ...session,
      id: sessionId,
      status: 'uploaded',
      searchableStatus: 'pending',
      enrichmentStatus: 'pending',
      rawStorageKey: rawKey,
      createdAt: now,
      updatedAt: now,
      processingAttempts: 0,
    }, {
      sessionId,
      organizationId,
      developerId,
      rawStorageKey: rawKey,
      totalTokens,
      messageCount: messages.length,
      priority: 5,
    });

    logger.info({
      sessionId,
      source,
      messageCount: messages.length,
      tokens: totalTokens,
      mode: 'passive',
    }, 'Passive capture accepted');

    reply.status(202).send({
      sessionId,
      status: 'captured',
      mode: 'passive',
      message: 'Session captured automatically',
    });
  } catch (error) {
    logger.error({ err: error }, 'Passive capture failed');
    reply.status(500).send({ error: 'CAPTURE_ERROR', message: 'Failed to capture session' });
  }
}

// ─── Active Capture: Developer explicitly saves with enrichment ───────────────

interface ActiveCaptureBody {
  Body: SessionUpload & {
    /** Active-only fields: developer chose to save this */
    tags?: string[];
    annotation?: string;      // Developer's note about why this was useful
    linkedTicket?: string;    // Jira/Linear ticket ID
    promoteTier2?: boolean;   // Force deep processing
  };
}

async function handleActiveCapture(
  request: FastifyRequest<ActiveCaptureBody>,
  reply: FastifyReply,
): Promise<void> {
  const { tags, annotation, linkedTicket, promoteTier2, ...sessionData } = request.body;
  const identity = request.authContext;

  const parseResult = SessionUploadSchema.safeParse({
    ...sessionData,
    developerId: identity.userId,
    organizationId: identity.organizationId,
    teamId: identity.teamIds[0],
  });
  if (!parseResult.success) {
    reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid session data',
      details: parseResult.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  const payload = parseResult.data;
  const existing = await new SessionRepository().findByClientId(
    payload.clientId,
    payload.developerId,
    payload.organizationId,
  );
  if (existing) {
    reply.status(202).send({
      sessionId: existing.id,
      status: existing.status,
      mode: 'active',
      tier: promoteTier2 ? 'deep' : 'auto',
      message: 'Session was already saved',
    });
    return;
  }
  const sessionId = uuidv5(
    `${payload.organizationId}:${payload.developerId}:${payload.clientId}`,
    'bf821a66-0d7d-4ff7-a5e2-d72131b94563',
  );
  const now = new Date().toISOString();

  // Enrich metadata with active-capture info
  if (tags) payload.metadata.tags = [...(payload.metadata.tags ?? []), ...tags, 'manually-saved'];
  if (annotation) (payload.metadata as any).annotation = annotation;
  if (linkedTicket) (payload.metadata as any).linkedTicket = linkedTicket;

  try {
    const config = getConfig();
    const rawKey = `sessions/${payload.organizationId}/${payload.developerId}/${sessionId}.json`;
    const objectStorage = new ObjectStorageClient();
    await objectStorage.putObject(config.S3_BUCKET, rawKey, JSON.stringify(payload), {
      contentType: 'application/json',
      metadata: { captureMode: 'active', annotation: annotation ?? '' },
    });

    const sessionRepo = new SessionRepository();
    await sessionRepo.createWithOutbox({
      ...payload,
      id: sessionId,
      status: 'uploaded',
      searchableStatus: 'pending',
      enrichmentStatus: 'pending',
      rawStorageKey: rawKey,
      createdAt: now,
      updatedAt: now,
      processingAttempts: 0,
    }, {
      sessionId,
      organizationId: payload.organizationId,
      developerId: payload.developerId,
      rawStorageKey: rawKey,
      totalTokens: payload.totalTokens,
      messageCount: payload.messages.length,
      priority: promoteTier2 ? 9 : 7,
    });

    logger.info({
      sessionId,
      mode: 'active',
      tags,
      promoteTier2,
      linkedTicket,
    }, 'Active capture accepted');

    reply.status(202).send({
      sessionId,
      status: 'captured',
      mode: 'active',
      tier: promoteTier2 ? 'deep' : 'auto',
      message: 'Session saved successfully',
    });
  } catch (error) {
    logger.error({ err: error }, 'Active capture failed');
    reply.status(500).send({ error: 'CAPTURE_ERROR', message: 'Failed to save session' });
  }
}

// ─── Ambient Capture: Terminal, browser, meetings ────────────────────────────

interface AmbientCaptureBody {
  Body: Omit<CaptureEvent, 'id' | 'processed' | 'factIds'>;
}

async function handleAmbientCapture(
  request: FastifyRequest<AmbientCaptureBody>,
  reply: FastifyReply,
): Promise<void> {
  const event: CaptureEvent = {
    ...request.body,
    developerId: request.authContext.userId,
    organizationId: request.authContext.organizationId,
    id: uuidv4(),
    processed: false,
    factIds: [],
  };

  const parseResult = CaptureEventSchema.safeParse(event);
  if (!parseResult.success) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', details: parseResult.error.issues });
    return;
  }

  try {
    const captureRepo = new CaptureRepository();
    await captureRepo.createWithOutbox(parseResult.data);

    logger.debug({
      type: event.type,
      source: event.source,
      developerId: event.developerId,
    }, 'Ambient event captured');

    reply.status(201).send({ id: event.id, captured: true });
  } catch (error) {
    logger.error({ err: error }, 'Ambient capture failed');
    reply.status(500).send({ error: 'CAPTURE_ERROR' });
  }
}

// ─── Batch Ambient Capture ───────────────────────────────────────────────────

interface BatchAmbientBody {
  Body: { events: Array<Omit<CaptureEvent, 'id' | 'processed' | 'factIds'>> };
}

async function handleBatchAmbientCapture(
  request: FastifyRequest<BatchAmbientBody>,
  reply: FastifyReply,
): Promise<void> {
  const { events } = request.body;
  if (!events || events.length === 0) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'events array required' });
    return;
  }
  if (events.length > 200) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Max 200 events per batch' });
    return;
  }

  const captureRepo = new CaptureRepository();
  const validEvents: CaptureEvent[] = [];

  for (const rawEvent of events) {
    const event: CaptureEvent = {
      ...rawEvent,
      developerId: request.authContext.userId,
      organizationId: request.authContext.organizationId,
      id: uuidv4(),
      processed: false,
      factIds: [],
    };
    const result = CaptureEventSchema.safeParse(event);
    if (result.success) validEvents.push(result.data);
  }

  await captureRepo.createBatchWithOutbox(validEvents);
  reply.status(201).send({ captured: validEvents.length, total: events.length });
}

// ─── Route Registration ──────────────────────────────────────────────────────

export async function registerCaptureRoutes(app: FastifyInstance): Promise<void> {
  // Passive: auto-upload (minimal payload, no user effort)
  app.post('/api/v1/capture/passive', handlePassiveCapture);

  // Active: explicit save (full payload, developer chose to save)
  app.post('/api/v1/capture/active', handleActiveCapture);

  // Ambient: terminal, browser, meeting events
  app.post('/api/v1/capture/event', handleAmbientCapture);
  app.post('/api/v1/capture/events', handleBatchAmbientCapture);

  // Legacy compatibility: existing /api/v1/sessions still works
  // (it maps to active capture internally)

  logger.info('Capture API routes registered');
}
