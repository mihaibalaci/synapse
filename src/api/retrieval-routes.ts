/**
 * Retrieval API Routes
 *
 * Exposes the search/retrieval endpoints consumed by IDE plugins.
 * Delegates to the retrieval engine for hybrid search + ranking.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SearchRequestSchema, type SearchRequest } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { RetrievalEngine } from '../retrieval/engine.js';

const logger = createChildLogger({ module: 'retrieval-api' });

// ─── Search Endpoint ─────────────────────────────────────────────────────────

interface SearchBody {
  Body: SearchRequest;
}

async function handleSearch(
  request: FastifyRequest<SearchBody>,
  reply: FastifyReply,
): Promise<void> {
  const startTime = Date.now();

  // Validate
  const parseResult = SearchRequestSchema.safeParse(request.body);
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
    developerId: searchRequest.developerId,
    topK: searchRequest.topK,
  }, 'Search request received');

  try {
    const engine = new RetrievalEngine();
    const response = await engine.search(searchRequest);

    const latencyMs = Date.now() - startTime;
    logger.info({
      resultCount: response.results.length,
      latencyMs,
      cached: response.cached,
    }, 'Search completed');

    reply.send({ ...response, latencyMs });
  } catch (error) {
    logger.error({ err: error }, 'Search failed');
    reply.status(500).send({
      error: 'SEARCH_ERROR',
      message: 'Search request failed. Please retry.',
    });
  }
}

// ─── Similar Chunks Endpoint ─────────────────────────────────────────────────

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
    const engine = new RetrievalEngine();
    const results = await engine.findSimilar(chunkId, limit);
    reply.send({ results });
  } catch (error) {
    logger.error({ err: error, chunkId }, 'Similar search failed');
    reply.status(500).send({ error: 'SEARCH_ERROR', message: 'Failed to find similar chunks' });
  }
}

// ─── Context for AI Endpoint ─────────────────────────────────────────────────
// This is the primary endpoint IDE plugins call to get context for an AI prompt.

interface ContextBody {
  Body: {
    query: string;
    repository?: string;
    filePath?: string;
    language?: string;
    maxTokens?: number;
    developerId: string;
    organizationId: string;
  };
}

async function handleGetContext(
  request: FastifyRequest<ContextBody>,
  reply: FastifyReply,
): Promise<void> {
  const { query, repository, filePath, language, maxTokens = 4000, developerId, organizationId } = request.body;
  const startTime = Date.now();

  try {
    const engine = new RetrievalEngine();
    const response = await engine.search({
      query,
      context: { repository, filePath, language },
      filters: { repositories: repository ? [repository] : undefined },
      topK: 10,
      offset: 0,
      strategy: 'hybrid',
      includeContent: true,
      developerId,
      organizationId,
    });

    // Trim results to fit within token budget
    let tokenBudget = maxTokens;
    const contextChunks: Array<{ title: string; content: string; score: number }> = [];

    for (const result of response.results) {
      const estimatedTokens = Math.ceil((result.content?.length ?? 0) / 4);
      if (tokenBudget - estimatedTokens < 0) break;
      tokenBudget -= estimatedTokens;
      contextChunks.push({
        title: result.title,
        content: result.content ?? result.summary,
        score: result.finalScore,
      });
    }

    const latencyMs = Date.now() - startTime;

    reply.send({
      context: contextChunks,
      totalResults: response.totalCount,
      returnedResults: contextChunks.length,
      estimatedTokens: maxTokens - tokenBudget,
      latencyMs,
      cached: response.cached,
    });
  } catch (error) {
    logger.error({ err: error }, 'Context retrieval failed');
    reply.status(500).send({ error: 'CONTEXT_ERROR', message: 'Failed to retrieve context' });
  }
}

// ─── Route Registration ──────────────────────────────────────────────────────

export async function registerRetrievalRoutes(app: FastifyInstance): Promise<void> {
  // Full search with all options
  app.post('/api/v1/search', handleSearch);

  // Find similar to a specific chunk
  app.get('/api/v1/chunks/:chunkId/similar', handleSimilar);

  // Optimized context retrieval for AI prompts (primary plugin endpoint)
  app.post('/api/v1/context', handleGetContext);

  logger.info('Retrieval API routes registered');
}
