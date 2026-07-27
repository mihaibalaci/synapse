/**
 * Retrieval Models
 *
 * Request/response schemas for the retrieval API,
 * ranking configuration, and search result types.
 */

import { z } from 'zod';

// ─── Search Request ──────────────────────────────────────────────────────────

export const SearchRequestSchema = z.object({
  /** Natural language query */
  query: z.string().min(3).max(2000),

  /** Context to improve relevance */
  context: z.object({
    repository: z.string().optional(),
    branch: z.string().optional(),
    filePath: z.string().optional(),
    language: z.string().optional(),
    frameworks: z.array(z.string()).optional(),
    currentCode: z.string().optional(),        // Code around cursor
  }).optional(),

  /** Filters */
  filters: z.object({
    repositories: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    types: z.array(z.string()).optional(),      // ChunkType or KnowledgeType
    authors: z.array(z.string()).optional(),
    teams: z.array(z.string()).optional(),
    dateRange: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }).optional(),
    minConfidence: z.enum(['high', 'medium', 'low']).optional(),
    minQualityScore: z.number().min(0).max(1).optional(),
  }).optional(),

  /** Pagination & limits */
  topK: z.number().int().min(1).max(50).default(5),
  offset: z.number().int().min(0).default(0),

  /** Token budget: if set, pack results greedily until budget is exhausted.
   *  Takes precedence over topK when both are specified. */
  maxTokens: z.number().int().min(100).max(50000).optional(),

  /** Search strategy */
  strategy: z.enum([
    'hybrid',         // BM25 + vector + graph (default)
    'semantic',       // Vector only
    'keyword',        // BM25 only
    'graph',          // Graph traversal
  ]).default('hybrid'),

  /** Whether to include full content or just summaries */
  includeContent: z.boolean().default(true),

  /** Identity and authorization context injected from verified JWT claims. */
  developerId: z.string(),
  organizationId: z.string(),
  teamIds: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  repositoryAccess: z.array(z.string()).default([]),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

// ─── Search Result ───────────────────────────────────────────────────────────

export const SearchResultItemSchema = z.object({
  /** Chunk or Knowledge record ID */
  id: z.string().uuid(),
  type: z.enum(['chunk', 'knowledge', 'cluster']),

  /** Content */
  title: z.string(),
  summary: z.string(),
  content: z.string().optional(),

  /** Scores */
  finalScore: z.number().min(0).max(1),
  scores: z.object({
    semantic: z.number().min(0).max(1),
    keyword: z.number().min(0).max(1).optional(),
    freshness: z.number().min(0).max(1),
    repositoryMatch: z.number().min(0).max(1),
    authorReputation: z.number().min(0).max(1),
    usageCount: z.number().min(0).max(1),
    qualityScore: z.number().min(0).max(1),
  }),

  /** Metadata */
  repository: z.string().optional(),
  language: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
  author: z.object({
    id: z.string(),
    name: z.string().optional(),
  }).optional(),

  /** Citations for auditability */
  citations: z.array(z.object({
    type: z.string(),
    reference: z.string(),
    url: z.string().optional(),
  })).default([]),

  /** Code snippets if relevant */
  codeSnippets: z.array(z.object({
    language: z.string(),
    code: z.string(),
    filePath: z.string().optional(),
  })).default([]),

  /** Timestamps */
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
});
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultItemSchema),
  totalCount: z.number().int(),
  query: z.string(),
  strategy: z.string(),
  latencyMs: z.number(),
  cached: z.boolean(),

  /** Token usage estimate for returned context */
  estimatedTokens: z.number().int(),

  /** Pre-computed entity summaries relevant to this query (mental models) */
  observations: z.array(z.object({
    entityName: z.string(),
    summary: z.string(),
  })).default([]),

  /** Suggested related queries */
  relatedQueries: z.array(z.string()).default([]),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ─── Ranking Configuration ───────────────────────────────────────────────────

export const RankingWeightsSchema = z.object({
  semanticSimilarity: z.number().default(0.35),
  freshness: z.number().default(0.15),
  repositoryMatch: z.number().default(0.15),
  authorReputation: z.number().default(0.05),
  usageCount: z.number().default(0.10),
  upvotes: z.number().default(0.05),
  acceptedSolution: z.number().default(0.05),
  clickThrough: z.number().default(0.05),
  llmQualityScore: z.number().default(0.05),
});
export type RankingWeights = z.infer<typeof RankingWeightsSchema>;

// ─── Feedback Event ──────────────────────────────────────────────────────────

export const FeedbackEventSchema = z.object({
  id: z.string().uuid(),
  searchId: z.string().uuid(),        // Which search produced this result
  resultId: z.string().uuid(),        // Which result is being rated
  organizationId: z.string().optional(),
  developerId: z.string(),
  action: z.enum([
    'shown',           // Result was displayed to user
    'clicked',         // User expanded/viewed the result
    'copied',          // User copied code or text
    'used',            // Result was sent to AI as context
    'thumbs_up',       // Explicit positive feedback
    'thumbs_down',     // Explicit negative feedback
    'reported',        // Flagged as incorrect/outdated
    'dismissed',       // User explicitly dismissed
  ]),

  /** Optional comment */
  comment: z.string().optional(),

  /** Was the downstream AI conversation successful? */
  conversationSuccessful: z.boolean().optional(),

  timestamp: z.string().datetime(),
});
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;
