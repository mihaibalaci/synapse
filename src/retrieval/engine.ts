/**
 * Retrieval Engine (v3 — 5-Signal Fusion)
 *
 * Implements hybrid retrieval with 5 parallel signals:
 *   1. Semantic vector search (pgvector ANN)
 *   2. Keyword BM25 search (Postgres tsvector)
 *   3. Entity matching (boost results sharing entities with query)
 *   4. Temporal scoring (time-aware relevance, valid/superseded)
 *   5. Graph expansion (AGE relationship traversal, conditional)
 *
 * Also searches the Fact layer (atomic facts) for quick answers.
 * Returns a mix of facts (instant answers) and chunks (full context).
 *
 * Target: <180ms p99 (warm), <5ms (cached)
 */

import { v4 as uuidv4 } from 'uuid';
import { createChildLogger } from '../utils/logger.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { FactRepository } from '../storage/fact-repository.js';
import { GraphRepository } from '../storage/graph-repository.js';
import { SearchIndex } from '../storage/search-index.js';
import { SearchCache } from '../storage/cache.js';
import { RankingEngine } from './ranking.js';
import { PermissionFilter } from './permission-filter.js';
import {
  type SearchRequest,
  type SearchResponse,
  type SearchResultItem,
  type Chunk,
  type MemoryFact,
} from '../models/index.js';

const logger = createChildLogger({ module: 'retrieval-engine' });

// ─── Internal Candidate Type (v3: supports both facts and chunks) ────────────

interface RetrievalCandidate {
  chunk: Chunk;
  facts?: MemoryFact[];
  scores: {
    semantic: number;
    keyword: number;
    entityMatch: number;
    temporal: number;
    graphRelevance: number;
  };
  source: 'vector' | 'keyword' | 'entity' | 'temporal' | 'graph';
}

// ─── Query Entity Extraction ─────────────────────────────────────────────────

function extractQueryEntities(query: string): string[] {
  const entities: string[] = [];
  const seen = new Set<string>();
  const techMatches = query.match(
    /\b(AWS|S3|EC2|Lambda|DynamoDB|Kafka|Redis|Postgres(?:QL)?|MongoDB|Docker|Kubernetes|K8s|React|Node\.?js?|TypeScript|Python|Go|Rust|GraphQL|REST|gRPC|Terraform|CDK|IAM|VPC|ECS|EKS|RDS|SQS|SNS|CloudFront|CloudWatch|Next\.?js|Express|Fastify)\b/gi
  );
  if (techMatches) {
    for (const t of techMatches) {
      if (!seen.has(t.toLowerCase())) { entities.push(t); seen.add(t.toLowerCase()); }
    }
  }
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) {
    for (const q of quoted) {
      const term = q.replace(/"/g, '');
      if (!seen.has(term.toLowerCase())) { entities.push(term); seen.add(term.toLowerCase()); }
    }
  }
  return entities;
}

// ─── Retrieval Engine ────────────────────────────────────────────────────────

export class RetrievalEngine {
  private embeddingClient: EmbeddingClient;
  private chunkRepo: ChunkRepository;
  private factRepo: FactRepository;
  private graphRepo: GraphRepository;
  private searchIndex: SearchIndex;
  private searchCache: SearchCache;
  private rankingEngine: RankingEngine;
  private permissionFilter: PermissionFilter;

  constructor() {
    this.embeddingClient = new EmbeddingClient();
    this.chunkRepo = new ChunkRepository();
    this.factRepo = new FactRepository();
    this.graphRepo = new GraphRepository();
    this.searchIndex = new SearchIndex();
    this.searchCache = new SearchCache();
    this.rankingEngine = new RankingEngine();
    this.permissionFilter = new PermissionFilter();
  }

  /**
   * Main search entry point. Orchestrates the full hybrid retrieval pipeline.
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const searchId = uuidv4();
    const startTime = Date.now();

    logger.info({
      searchId,
      query: request.query.substring(0, 100),
      strategy: request.strategy,
      topK: request.topK,
    }, 'Search started');

    // 1. Check cache first
    const cached = await this.searchCache.get(request);
    if (cached) {
      return { ...cached, cached: true, latencyMs: Date.now() - startTime };
    }

    // 2. Pre-process: entities for signal 3, and the query vector.
    // Embedding runs before the database scope opens: it may call a remote
    // provider, and holding a pooled connection across that wait would starve
    // the pool under load.
    const queryEntities = extractQueryEntities(request.query);
    const needsVector = request.strategy !== 'keyword';
    const queryEmbedding = needsVector
      ? await this.embeddingClient.embed(request.query)
      : null;

    // 3. Execute the strategy. Signals run concurrently on separate pooled
    // connections: measured on a low-latency link, overlapping the queries beats
    // sharing one connection to save the per-statement RLS setup round trips.
    let candidates: RetrievalCandidate[];
    switch (request.strategy) {
      case 'semantic':
        candidates = await this.semanticSearch(request, queryEmbedding!);
        break;
      case 'keyword':
        candidates = await this.keywordSearch(request);
        break;
      case 'graph':
        candidates = await this.graphSearch(request, queryEmbedding!);
        break;
      case 'hybrid':
      default:
        candidates = await this.hybridSearch(request, queryEntities, queryEmbedding!);
        break;
    }

    // 4. Permission filtering
    candidates = await this.permissionFilter.filter(candidates, {
      userId: request.developerId,
      organizationId: request.organizationId,
      teamIds: request.teamIds,
      roles: request.roles,
      repositoryAccess: request.repositoryAccess,
    });

    // 4. Rank and score
    const ranked = await this.rankingEngine.rank(candidates, request);

    // 5. Take top-K results
    const topResults = ranked.slice(request.offset, request.offset + request.topK);

    // 6. Format response
    const results: SearchResultItem[] = topResults.map(candidate => this.formatResult(candidate));

    // 7. Estimate token usage
    const estimatedTokens = results.reduce((sum, r) => {
      return sum + Math.ceil((r.content?.length ?? r.summary.length) / 4);
    }, 0);

    const response: SearchResponse = {
      results,
      totalCount: ranked.length,
      query: request.query,
      strategy: request.strategy,
      latencyMs: Date.now() - startTime,
      cached: false,
      estimatedTokens,
      relatedQueries: [], // TODO: generate related queries
    };

    // 8. Cache the response
    await this.searchCache.set(request, response);
    await this.searchCache.trackQuery(request.query, request.organizationId);

    logger.info({
      searchId,
      resultCount: results.length,
      latencyMs: response.latencyMs,
      estimatedTokens,
    }, 'Search completed');

    return response;
  }

  /**
   * Find chunks similar to a given chunk (for "related knowledge" features).
   */
  async findSimilar(chunkId: string, limit: number = 5): Promise<SearchResultItem[]> {
    const chunk = await this.chunkRepo.findById(chunkId);
    if (!chunk || !chunk.embedding) return [];

    const similar = await this.chunkRepo.searchByVector(chunk.embedding, {
      limit: limit + 1, // +1 because we'll exclude self
      organizationId: chunk.organizationId,
    });

    return similar
      .filter(s => s.id !== chunkId)
      .slice(0, limit)
      .map(s => this.formatResult({
        chunk: s,
        scores: { semantic: s.similarity, keyword: 0, entityMatch: 0, temporal: 0, graphRelevance: 0 },
        source: 'vector',
      }));
  }

  // ─── Search Strategies ─────────────────────────────────────────────────────

  /**
   * Pure semantic vector search.
   * Fast, good for conceptual similarity, may miss exact terms.
   */
  private async semanticSearch(
    request: SearchRequest,
    queryEmbedding: number[],
  ): Promise<RetrievalCandidate[]> {
    // Vector ANN search
    const results = await this.chunkRepo.searchByVector(queryEmbedding, {
      limit: 50,
      organizationId: request.organizationId,
      repositoryFilter: request.filters?.repositories,
      languageFilter: request.filters?.languages,
      minQualityScore: request.filters?.minQualityScore,
    });

    return results.map(r => ({
      chunk: r,
      scores: { semantic: r.similarity, keyword: 0, entityMatch: 0, temporal: 0, graphRelevance: 0 },
      source: 'vector' as const,
    }));
  }

  /**
   * Pure keyword BM25 search.
   * Good for exact terms, error messages, function names.
   */
  private async keywordSearch(request: SearchRequest): Promise<RetrievalCandidate[]> {
    const results = await this.searchIndex.search({
      query: request.query,
      organizationId: request.organizationId,
      filters: {
        repositories: request.filters?.repositories,
        languages: request.filters?.languages,
        types: request.filters?.types,
        minQualityScore: request.filters?.minQualityScore,
      },
      limit: 50,
    });

    // Load matched chunks in one round trip, preserving relevance order.
    const chunks = await this.chunkRepo.findByIds(
      results.map(hit => hit.id),
      request.organizationId,
    );

    const topScore = results[0]?.score ?? 1;
    const candidates: RetrievalCandidate[] = [];
    for (const hit of results) {
      const chunk = chunks.get(hit.id);
      if (!chunk) continue;
      candidates.push({
        chunk,
        scores: {
          semantic: 0,
          keyword: hit.score / topScore,
          entityMatch: 0,
          temporal: 0,
          graphRelevance: 0,
        },
        source: 'keyword',
      });
    }

    return candidates;
  }

  /**
   * Graph-based search.
   * Starts from query entities and traverses relationships.
   */
  private async graphSearch(
    request: SearchRequest,
    queryEmbedding: number[],
  ): Promise<RetrievalCandidate[]> {
    // Extract entities from query for graph seed nodes
    const seedNodeIds: string[] = [];

    // Use repository as seed if provided
    if (request.context?.repository) {
      seedNodeIds.push(request.context.repository);
    }

    // Use language/framework as seed
    if (request.context?.language) {
      seedNodeIds.push(request.context.language.toLowerCase());
    }
    if (request.context?.frameworks) {
      for (const fw of request.context.frameworks) {
        seedNodeIds.push(fw.toLowerCase());
      }
    }

    if (seedNodeIds.length === 0) {
      // Fall back to semantic search if no graph seeds
      return this.semanticSearch(request, queryEmbedding);
    }

    const expansion = await this.graphRepo.expand({
      seedNodeIds,
      organizationId: request.organizationId,
      maxDepth: 2,
      targetNodeTypes: ['chunk', 'knowledge'],
      limit: 30,
      minWeight: 0.3,
    });

    // Load graph-discovered chunks in one round trip, preserving expansion order.
    const chunks = await this.chunkRepo.findByIds(
      expansion.relatedContentIds,
      request.organizationId,
    );

    const candidates: RetrievalCandidate[] = [];
    for (const contentId of expansion.relatedContentIds) {
      const chunk = chunks.get(contentId);
      if (!chunk) continue;
      candidates.push({
        chunk,
        scores: { semantic: 0, keyword: 0, entityMatch: 0, temporal: 0, graphRelevance: 0.7 },
        source: 'graph',
      });
    }

    return candidates;
  }

  /**
   * Hybrid search — 5-signal fusion (v3).
   * Runs Semantic + Keyword + Entity in parallel, applies Temporal to all,
   * conditionally expands Graph when semantic confidence is low.
   */
  private async hybridSearch(
    request: SearchRequest,
    queryEntities: string[],
    queryEmbedding: number[],
  ): Promise<RetrievalCandidate[]> {
    // Three signals in parallel, each on its own pooled connection.
    const [semanticResults, keywordResults, entityResults] = await Promise.all([
      this.semanticSearch(request, queryEmbedding),
      this.keywordSearch(request),
      this.entitySearch(queryEntities, request.organizationId),
    ]);

    // Reciprocal Rank Fusion (RRF) to combine results
    const fusedMap = new Map<string, RetrievalCandidate>();

    for (const candidate of semanticResults) {
      fusedMap.set(candidate.chunk.id, candidate);
    }

    for (const candidate of keywordResults) {
      const existing = fusedMap.get(candidate.chunk.id);
      if (existing) {
        existing.scores.keyword = candidate.scores.keyword;
      } else {
        fusedMap.set(candidate.chunk.id, candidate);
      }
    }

    for (const candidate of entityResults) {
      const existing = fusedMap.get(candidate.chunk.id);
      if (existing) {
        existing.scores.entityMatch = candidate.scores.entityMatch;
        if (candidate.facts) existing.facts = candidate.facts;
      } else {
        fusedMap.set(candidate.chunk.id, candidate);
      }
    }

    // Signal 4: Temporal — apply to ALL candidates (free, metadata-based)
    for (const candidate of fusedMap.values()) {
      candidate.scores.temporal = this.computeTemporalScore(candidate.chunk);
    }

    // Signal 5: Graph — ADAPTIVE, only when semantic confidence is low
    const topSemanticScore = semanticResults[0]?.scores.semantic ?? 0;
    const shouldExpandGraph = topSemanticScore < 0.85 && request.context?.repository;

    if (shouldExpandGraph) {
      const graphResults = await this.graphSearch(request, queryEmbedding);
      for (const candidate of graphResults) {
        const existing = fusedMap.get(candidate.chunk.id);
        if (existing) {
          existing.scores.graphRelevance = candidate.scores.graphRelevance;
        } else {
          candidate.scores.temporal = this.computeTemporalScore(candidate.chunk);
          fusedMap.set(candidate.chunk.id, candidate);
        }
      }
      logger.debug({ topSemanticScore, graphResultCount: graphResults.length }, 'Graph expansion triggered');
    }

    return [...fusedMap.values()];
  }

  /**
   * Signal 3: Entity matching.
   * Searches the fact layer for entities, then loads parent chunks.
   */
  private async entitySearch(queryEntities: string[], organizationId: string): Promise<RetrievalCandidate[]> {
    if (queryEntities.length === 0) return [];

    const matchingFacts = await this.factRepo.findByEntities(queryEntities, organizationId, {
      limit: 20,
      onlyValid: true,
    });

    // Resolve every source chunk in one round trip before scoring.
    const sourceChunkIds = matchingFacts
      .map(fact => fact.sourceChunkId)
      .filter((id): id is string => typeof id === 'string');
    const chunks = await this.chunkRepo.findByIds(sourceChunkIds, organizationId);

    const candidates: RetrievalCandidate[] = [];
    const seenChunks = new Set<string>();
    const queryLower = queryEntities.map(entity => entity.toLowerCase());

    for (const fact of matchingFacts) {
      if (!fact.sourceChunkId || seenChunks.has(fact.sourceChunkId)) continue;
      const chunk = chunks.get(fact.sourceChunkId);
      if (!chunk) continue;
      seenChunks.add(fact.sourceChunkId);

      const chunkEntityNames = chunk.entities.map(e => e.name.toLowerCase());
      const overlap = queryLower.filter(entity => chunkEntityNames.includes(entity)).length;
      const unionSize = new Set([...queryLower, ...chunkEntityNames]).size;
      const entityScore = unionSize > 0 ? Math.min((overlap / unionSize) * 1.5, 1.0) : 0;

      candidates.push({
        chunk,
        facts: [fact],
        scores: { semantic: 0, keyword: 0, entityMatch: entityScore, temporal: 0, graphRelevance: 0 },
        source: 'entity',
      });
    }

    return candidates;
  }

  /**
   * Signal 4: Temporal scoring (Pieces-inspired).
   * Recent + recently-accessed = higher. Stale/archived = lower.
   */
  private computeTemporalScore(chunk: Chunk): number {
    const ageMs = Date.now() - new Date(chunk.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    let score = Math.exp(-ageDays / 130); // 90-day half-life

    if (chunk.lastAccessedAt) {
      const lastAccessDays = (Date.now() - new Date(chunk.lastAccessedAt).getTime()) / 86400000;
      if (lastAccessDays < 7) score = Math.min(score + 0.2, 1.0);
    }

    if (chunk.confidence === 'low') score *= 0.6;
    if (chunk.confidence === 'archived') score *= 0.3;
    return score;
  }

  // ─── Result Formatting ─────────────────────────────────────────────────────

  private formatResult(candidate: RetrievalCandidate & { finalScore?: number }): SearchResultItem {
    const chunk = candidate.chunk;

    return {
      id: chunk.id,
      type: 'chunk',
      title: chunk.title,
      summary: chunk.summary,
      content: chunk.content,
      finalScore: candidate.finalScore ?? Math.max(
        candidate.scores.semantic,
        candidate.scores.keyword,
        candidate.scores.graphRelevance,
      ),
      scores: {
        semantic: candidate.scores.semantic,
        keyword: candidate.scores.keyword,
        freshness: candidate.scores.temporal,
        repositoryMatch: 0,
        authorReputation: 0,
        usageCount: Math.min(chunk.usageCount / 100, 1),
        qualityScore: chunk.qualityScore,
      },
      repository: chunk.repository,
      language: chunk.language,
      frameworks: chunk.frameworks,
      author: { id: chunk.authorId },
      citations: [{
        type: 'conversation',
        reference: `Session ${chunk.sessionId}`,
      }],
      codeSnippets: chunk.codeReferences.slice(0, 3).map(ref => ({
        language: ref.language,
        code: ref.snippet,
        filePath: ref.filePath,
      })),
      createdAt: chunk.createdAt,
      lastUsedAt: chunk.lastAccessedAt,
    };
  }
}
