/**
 * Reflect API Routes
 *
 * The Reflect endpoint goes beyond retrieval: it retrieves memories,
 * reasons over them with an LLM, and returns a synthesized answer.
 *
 * POST /api/v1/reflect — Reflect on a query (retrieve + reason + answer)
 * GET  /api/v1/observations/:entity — Get pre-computed entity observation
 */

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { createChildLogger } from '../utils/logger.js';
import { ReflectEngine } from '../retrieval/reflect.js';
import { ObservationRepository } from '../storage/observation-repository.js';
import { ReflectRequestSchema } from '../models/reflect.js';

const logger = createChildLogger({ module: 'reflect-api' });

// ─── POST /api/v1/reflect ────────────────────────────────────────────────────

interface ReflectBody {
  Body: Record<string, unknown>;
}

async function handleReflect(
  request: FastifyRequest<ReflectBody>,
  reply: FastifyReply,
): Promise<void> {
  const startTime = Date.now();
  const identity = request.authContext;

  const parseResult = ReflectRequestSchema.safeParse({
    ...request.body,
    developerId: identity.userId,
    organizationId: identity.organizationId,
    teamIds: identity.teamIds,
    roles: identity.roles,
    repositoryAccess: identity.repositoryAccess,
  });

  if (!parseResult.success) {
    reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid reflect request',
      details: parseResult.error.issues,
    });
    return;
  }

  const reflectRequest = parseResult.data;
  logger.info({
    query: reflectRequest.query.substring(0, 100),
    entityFocus: reflectRequest.entityFocus,
    maxTokens: reflectRequest.maxTokens,
    developerId: identity.userId,
  }, 'Reflect request received');

  try {
    const engine = new ReflectEngine();
    const response = await engine.reflect(reflectRequest);

    logger.info({
      reflectId: response.reflectId,
      confidence: response.confidence,
      sourceCount: response.sources.length,
      totalLatencyMs: response.totalLatencyMs,
    }, 'Reflect completed');

    reply.send(response);
  } catch (error) {
    logger.error({ err: error }, 'Reflect failed');
    reply.status(500).send({
      error: 'REFLECT_ERROR',
      message: 'Failed to reflect on query. Please retry.',
    });
  }
}

// ─── GET /api/v1/observations/:entity ────────────────────────────────────────

interface ObservationParams {
  Params: { entity: string };
}

async function handleGetObservation(
  request: FastifyRequest<ObservationParams>,
  reply: FastifyReply,
): Promise<void> {
  const { entity } = request.params;
  const organizationId = request.authContext.organizationId;

  try {
    const repo = new ObservationRepository();
    const observation = await repo.findByEntity(entity, organizationId);

    if (!observation) {
      reply.status(404).send({
        error: 'NOT_FOUND',
        message: `No observation exists for entity "${entity}". Use the reflect endpoint to generate one.`,
      });
      return;
    }

    reply.send({ observation });
  } catch (error) {
    logger.error({ err: error, entity }, 'Failed to get observation');
    reply.status(500).send({ error: 'OBSERVATION_ERROR', message: 'Failed to retrieve observation' });
  }
}

// ─── GET /api/v1/observations ────────────────────────────────────────────────

interface ObservationsQuery {
  Querystring: {
    entities?: string;
    limit?: number;
  };
}

async function handleListObservations(
  request: FastifyRequest<ObservationsQuery>,
  reply: FastifyReply,
): Promise<void> {
  const organizationId = request.authContext.organizationId;
  const entities = request.query.entities?.split(',').map(e => e.trim()) ?? [];

  try {
    const repo = new ObservationRepository();

    if (entities.length > 0) {
      const observations = await repo.findByEntities(entities, organizationId);
      reply.send({ observations, count: observations.length });
    } else {
      const count = await repo.count(organizationId);
      reply.send({ count, message: 'Provide ?entities=Kafka,Lambda to retrieve specific observations.' });
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to list observations');
    reply.status(500).send({ error: 'OBSERVATION_ERROR', message: 'Failed to list observations' });
  }
}

// ─── Route Registration ──────────────────────────────────────────────────────

export async function registerReflectRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/reflect', handleReflect);
  app.get('/api/v1/observations/:entity', handleGetObservation);
  app.get('/api/v1/observations', handleListObservations);
  logger.info('Reflect API routes registered');
}
