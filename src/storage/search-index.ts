/**
 * Search Index (OpenSearch)
 *
 * BM25 full-text search for keyword-based retrieval.
 * Complements vector search — together they form hybrid retrieval.
 *
 * OpenSearch handles:
 *   - Keyword matching (exact terms, phrases)
 *   - Fuzzy search (typo tolerance)
 *   - Faceted filtering (by repo, language, type)
 *   - Highlighting (show which parts matched)
 *   - Aggregations (for analytics)
 */

import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { type Chunk } from '../models/index.js';

const logger = createChildLogger({ module: 'search-index' });

// ─── Index Configuration ─────────────────────────────────────────────────────

const CHUNK_INDEX = 'chunks';
const KNOWLEDGE_INDEX = 'knowledge';

const CHUNK_MAPPING = {
  properties: {
    id: { type: 'keyword' },
    sessionId: { type: 'keyword' },
    title: { type: 'text', analyzer: 'english', boost: 3 },
    summary: { type: 'text', analyzer: 'english', boost: 2 },
    content: { type: 'text', analyzer: 'english' },
    type: { type: 'keyword' },
    repository: { type: 'keyword' },
    branch: { type: 'keyword' },
    language: { type: 'keyword' },
    languages: { type: 'keyword' },
    frameworks: { type: 'keyword' },
    authorId: { type: 'keyword' },
    organizationId: { type: 'keyword' },
    teamId: { type: 'keyword' },
    confidence: { type: 'keyword' },
    qualityScore: { type: 'float' },
    usageCount: { type: 'integer' },
    upvotes: { type: 'integer' },
    entities: {
      type: 'nested',
      properties: {
        name: { type: 'keyword' },
        type: { type: 'keyword' },
      },
    },
    createdAt: { type: 'date' },
    updatedAt: { type: 'date' },
  },
};

// ─── Search Index Client ─────────────────────────────────────────────────────

export class SearchIndex {
  private baseUrl: string;

  constructor() {
    const config = getConfig();
    this.baseUrl = config.OPENSEARCH_URL;
  }

  /**
   * Initialize indexes with mappings.
   */
  async initialize(): Promise<void> {
    await this.createIndexIfNotExists(CHUNK_INDEX, CHUNK_MAPPING);
    await this.createIndexIfNotExists(KNOWLEDGE_INDEX, CHUNK_MAPPING);
    logger.info('Search indexes initialized');
  }

  /**
   * Index a chunk for full-text search.
   */
  async indexChunk(chunk: Chunk): Promise<void> {
    await this.indexDocument(CHUNK_INDEX, chunk.id, {
      id: chunk.id,
      sessionId: chunk.sessionId,
      title: chunk.title,
      summary: chunk.summary,
      content: chunk.content,
      type: chunk.type,
      repository: chunk.repository,
      branch: chunk.branch,
      language: chunk.language,
      languages: chunk.languages,
      frameworks: chunk.frameworks,
      authorId: chunk.authorId,
      organizationId: chunk.organizationId,
      teamId: chunk.teamId,
      confidence: chunk.confidence,
      qualityScore: chunk.qualityScore,
      usageCount: chunk.usageCount,
      upvotes: chunk.upvotes,
      entities: chunk.entities,
      createdAt: chunk.createdAt,
      updatedAt: chunk.updatedAt,
    });
  }

  /**
   * BM25 keyword search with metadata filtering.
   */
  async search(params: {
    query: string;
    organizationId: string;
    filters?: {
      repositories?: string[];
      languages?: string[];
      types?: string[];
      minQualityScore?: number;
    };
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: string; score: number; highlights: Record<string, string[]> }>> {
    const { query, organizationId, filters, limit = 50, offset = 0 } = params;

    // Build OpenSearch query
    const must: unknown[] = [
      {
        multi_match: {
          query,
          fields: ['title^3', 'summary^2', 'content', 'entities.name^2'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      },
      { term: { organizationId } },
    ];

    // Apply filters
    const filterClauses: unknown[] = [];
    if (filters?.repositories?.length) {
      filterClauses.push({ terms: { repository: filters.repositories } });
    }
    if (filters?.languages?.length) {
      filterClauses.push({ terms: { language: filters.languages } });
    }
    if (filters?.types?.length) {
      filterClauses.push({ terms: { type: filters.types } });
    }
    if (filters?.minQualityScore) {
      filterClauses.push({ range: { qualityScore: { gte: filters.minQualityScore } } });
    }

    const body = {
      query: {
        bool: {
          must,
          filter: filterClauses,
        },
      },
      highlight: {
        fields: {
          title: {},
          summary: {},
          content: { fragment_size: 150, number_of_fragments: 3 },
        },
      },
      from: offset,
      size: limit,
    };

    try {
      const response = await this.request('POST', `/${CHUNK_INDEX}/_search`, body);
      const hits = response.hits?.hits ?? [];

      return hits.map((hit: any) => ({
        id: hit._id,
        score: hit._score,
        highlights: hit.highlight ?? {},
      }));
    } catch (error) {
      logger.error({ err: error, query }, 'OpenSearch query failed');
      return [];
    }
  }

  /**
   * Bulk index multiple chunks (for batch processing).
   */
  async bulkIndex(chunks: Chunk[]): Promise<{ indexed: number; errors: number }> {
    if (chunks.length === 0) return { indexed: 0, errors: 0 };

    const operations: string[] = [];
    for (const chunk of chunks) {
      operations.push(JSON.stringify({ index: { _index: CHUNK_INDEX, _id: chunk.id } }));
      operations.push(JSON.stringify({
        id: chunk.id,
        sessionId: chunk.sessionId,
        title: chunk.title,
        summary: chunk.summary,
        content: chunk.content,
        type: chunk.type,
        repository: chunk.repository,
        language: chunk.language,
        languages: chunk.languages,
        frameworks: chunk.frameworks,
        authorId: chunk.authorId,
        organizationId: chunk.organizationId,
        confidence: chunk.confidence,
        qualityScore: chunk.qualityScore,
        usageCount: chunk.usageCount,
        entities: chunk.entities,
        createdAt: chunk.createdAt,
      }));
    }

    const body = operations.join('\n') + '\n';

    try {
      const response = await this.request('POST', '/_bulk', body, 'application/x-ndjson');
      const errors = response.errors ? response.items.filter((i: any) => i.index?.error).length : 0;
      return { indexed: chunks.length - errors, errors };
    } catch (error) {
      logger.error({ err: error, count: chunks.length }, 'Bulk index failed');
      return { indexed: 0, errors: chunks.length };
    }
  }

  /**
   * Delete a chunk from the index.
   */
  async deleteChunk(chunkId: string): Promise<void> {
    await this.request('DELETE', `/${CHUNK_INDEX}/_doc/${chunkId}`);
  }

  /**
   * Get search suggestions (autocomplete).
   */
  async suggest(prefix: string, organizationId: string, limit: number = 5): Promise<string[]> {
    const body = {
      query: {
        bool: {
          must: [
            { match_phrase_prefix: { title: { query: prefix, max_expansions: 10 } } },
            { term: { organizationId } },
          ],
        },
      },
      _source: ['title'],
      size: limit,
    };

    try {
      const response = await this.request('POST', `/${CHUNK_INDEX}/_search`, body);
      return (response.hits?.hits ?? []).map((h: any) => h._source.title);
    } catch {
      return [];
    }
  }

  // ─── HTTP Helpers ──────────────────────────────────────────────────────────

  private async createIndexIfNotExists(index: string, mapping: unknown): Promise<void> {
    try {
      const exists = await this.request('HEAD', `/${index}`);
      if (exists) return;
    } catch {
      // Index doesn't exist, create it
    }

    try {
      await this.request('PUT', `/${index}`, {
        settings: {
          number_of_shards: 3,
          number_of_replicas: 1,
          analysis: {
            analyzer: {
              code_analyzer: {
                type: 'custom',
                tokenizer: 'standard',
                filter: ['lowercase', 'word_delimiter_graph'],
              },
            },
          },
        },
        mappings: mapping,
      });
      logger.info({ index }, 'Search index created');
    } catch (error) {
      logger.warn({ err: error, index }, 'Failed to create index (may already exist)');
    }
  }

  private async indexDocument(index: string, id: string, doc: unknown): Promise<void> {
    await this.request('PUT', `/${index}/_doc/${id}`, doc);
  }

  private async request(method: string, path: string, body?: unknown, contentType?: string): Promise<any> {
    const url = `${this.baseUrl}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': contentType ?? 'application/json',
      },
    };

    if (body && method !== 'HEAD' && method !== 'GET') {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (method === 'HEAD') return response.ok;
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`OpenSearch ${method} ${path} failed: ${response.status} ${text}`);
    }

    return response.json();
  }
}

// ─── Health Check ────────────────────────────────────────────────────────────

export async function checkSearchHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  const config = getConfig();

  try {
    const response = await fetch(`${config.OPENSEARCH_URL}/_cluster/health`);
    const data = await response.json() as any;
    return {
      healthy: data.status === 'green' || data.status === 'yellow',
      latencyMs: Date.now() - start,
    };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  }
}
