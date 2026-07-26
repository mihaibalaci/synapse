/** Authenticated retrieval endpoints consumed by IDE integrations. */

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { SearchRequestSchema } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { RetrievalEngine } from '../retrieval/engine.js';

const logger = createChildLogger({ module: 'retrieval-api' });

type SearchBody = { Body: Record<string, unknown> };

async function handleSearch(
  request: FastifyRequest<SearchBody>,
  reply: FastifyReply,
): Promise<void> {
  const startTime = Date.now();
  const identity = request.authContext;
  const parseResult = SearchRequestSchema.safeParse({
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
      message: 'Invalid search request',
      details: parseResult.error.issues,
    });
    return;
  }

  const searchRequest = parseResult.data;
  logger.info({
    query: searchRequest.query.substring(0, 100),
    strategy: searchRequest.strategy,
    developerId: identity.userId,
    topK: searchRequest.topK,
  }, 'Search request received');

  try {
    const response = await new RetrievalEngine().search(searchRequest);
    const latencyMs = Date.now() - startTime;
    logger.info({ resultCount: response.results.length, latencyMs, cached: response.cached }, 'Search completed');
    reply.send({ ...response, latencyMs });
  } catch (error) {
    logger.error({ err: error }, 'Search failed');
    reply.status(500).send({ error: 'SEARCH_ERROR', message: 'Search request failed. Please retry.' });
  }
}

interface SimilarParams {
  Params: { chunkId: string };
  Querystring: { limit?: number };
}

async function handleSimilar(
  request: FastifyRequest<SimilarParams>,
  reply: FastifyReply,
): Promise<void> {
  const { chunkId } = request.params;
  const limit = request.query.limit ?? 5;
  try {
    const results = await new RetrievalEngine().findSimilar(chunkId, limit);
    reply.send({ results });
  } catch (error) {
    logger.error({ err: error, chunkId }, 'Similar search failed');
    reply.status(500).send({ error: 'SEARCH_ERROR', message: 'Failed to find similar chunks' });
  }
}

interface ContextBody {
  Body: {
    query: string;
    repository?: string;
    filePath?: string;
    language?: string;
    maxTokens?: number;
    developerId?: string;
    organizationId?: string;
  };
}

async function handleGetContext(
  request: FastifyRequest<ContextBody>,
  reply: FastifyReply,
): Promise<void> {
  const { query, repository, filePath, language, maxTokens = 4000 } = request.body;
  const identity = request.authContext;
  const startTime = Date.now();

  const parsed = SearchRequestSchema.safeParse({
    query,
    context: { repository, filePath, language },
    filters: { repositories: repository ? [repository] : undefined },
    topK: 10,
    offset: 0,
    strategy: 'hybrid',
    includeContent: true,
    developerId: identity.userId,
    organizationId: identity.organizationId,
    teamIds: identity.teamIds,
    roles: identity.roles,
    repositoryAccess: identity.repositoryAccess,
  });
  if (!parsed.success) {
    reply.status(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    return;
  }

  try {
    const response = await new RetrievalEngine().search(parsed.data);
    let tokenBudget = Math.max(1, Math.min(maxTokens, 50_000));
    const contextChunks: Array<{ title: string; content: string; score: number }> = [];
    for (const result of response.results) {
      const content = result.content ?? result.summary;
      const estimatedTokens = Math.ceil(content.length / 4);
      if (tokenBudget - estimatedTokens < 0) break;
      tokenBudget -= estimatedTokens;
      contextChunks.push({ title: result.title, content, score: result.finalScore });
    }

    reply.send({
      context: contextChunks,
      totalResults: response.totalCount,
      returnedResults: contextChunks.length,
      estimatedTokens: Math.max(1, Math.min(maxTokens, 50_000)) - tokenBudget,
      latencyMs: Date.now() - startTime,
      cached: response.cached,
    });
  } catch (error) {
    logger.error({ err: error }, 'Context retrieval failed');
    reply.status(500).send({ error: 'CONTEXT_ERROR', message: 'Failed to retrieve context' });
  }
}

export async function registerRetrievalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/search', handleSearch);
  app.get('/api/v1/chunks/:chunkId/similar', handleSimilar);
  app.post('/api/v1/context', handleGetContext);
  logger.info('Retrieval API routes registered');
}
