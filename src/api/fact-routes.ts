import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { FactType } from '../models/index.js';
import { FactRepository } from '../storage/fact-repository.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'facts-api' });

interface ListFactsRequest {
  Querystring: {
    entity?: string;
    type?: string;
    limit?: number;
    includeSuperseded?: boolean;
  };
}

async function listFacts(
  request: FastifyRequest<ListFactsRequest>,
  reply: FastifyReply,
): Promise<void> {
  const parsedType = request.query.type ? FactType.safeParse(request.query.type) : null;
  if (parsedType && !parsedType.success) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid fact type' });
    return;
  }

  const facts = await new FactRepository().findByTemporal(
    request.authContext.organizationId,
    {
      onlyCurrentlyValid: false,
      includeSuperseded: request.query.includeSuperseded ?? false,
    },
    {
      entities: request.query.entity ? [request.query.entity] : undefined,
      types: parsedType?.success ? [parsedType.data] : undefined,
      limit: request.query.limit ?? 50,
    },
  );
  reply.send({ facts, count: facts.length });
}

interface FactHistoryRequest {
  Params: { entity: string };
  Querystring: { limit?: number };
}

async function factHistory(
  request: FastifyRequest<FactHistoryRequest>,
  reply: FastifyReply,
): Promise<void> {
  const facts = await new FactRepository().getEntityHistory(
    request.params.entity,
    request.authContext.organizationId,
    request.query.limit ?? 50,
  );
  reply.send({ entity: request.params.entity, facts, count: facts.length });
}

export async function registerFactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/facts', listFacts);
  app.get('/api/v1/facts/:entity/history', factHistory);
  logger.info('Facts API routes registered');
}
