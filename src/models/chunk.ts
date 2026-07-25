/**
 * Chunk Models
 *
 * A chunk is the atomic unit of knowledge in the system.
 * Sessions are split into chunks via semantic segmentation.
 * Each chunk represents a single coherent topic from a conversation.
 */

import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const ChunkType = z.enum([
  'discussion',       // General technical discussion
  'code_explanation', // Explanation of how code works
  'debugging',        // Diagnosing and fixing a bug
  'architecture',     // System design / architecture decisions
  'configuration',    // Config, provisioning, infrastructure
  'best_practice',    // Coding standards, patterns
  'troubleshooting',  // Operational issue resolution
  'tutorial',         // Step-by-step guide
  'decision',         // Technical decision with tradeoffs
  'review',           // Code review feedback
]);
export type ChunkType = z.infer<typeof ChunkType>;

export const ConfidenceLevel = z.enum([
  'high',       // Recently created, code unchanged, validated
  'medium',     // Aging or minor code changes
  'low',        // Stale, major refactors detected
  'archived',   // Superseded by newer knowledge
]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

// ─── Code Reference ──────────────────────────────────────────────────────────

export const CodeReferenceSchema = z.object({
  filePath: z.string(),
  language: z.string(),
  snippet: z.string(),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  repository: z.string().optional(),
  commitSha: z.string().optional(),
});
export type CodeReference = z.infer<typeof CodeReferenceSchema>;

// ─── Entity (extracted named entities) ───────────────────────────────────────

export const EntitySchema = z.object({
  name: z.string(),
  type: z.enum([
    'service',        // AWS service, internal service
    'library',        // npm package, framework
    'tool',           // CLI tool, IDE
    'concept',        // Design pattern, algorithm
    'file',           // Specific file path
    'api',            // API endpoint or method
    'error',          // Error type or message
    'config',         // Configuration key or setting
    'infrastructure', // Cloud resource, server
  ]),
  context: z.string().optional(),   // Brief context of how it's used
});
export type Entity = z.infer<typeof EntitySchema>;

// ─── Chunk Schema ────────────────────────────────────────────────────────────

export const ChunkSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),

  /** Content */
  title: z.string(),
  summary: z.string(),
  content: z.string(),               // Full text of this chunk
  tokenCount: z.number().int(),

  /** Classification */
  type: ChunkType,
  entities: z.array(EntitySchema).default([]),
  codeReferences: z.array(CodeReferenceSchema).default([]),

  /** Provenance */
  repository: z.string().optional(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  language: z.string(),
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),

  /** Ownership */
  authorId: z.string(),
  organizationId: z.string(),
  teamId: z.string().optional(),

  /** Quality & Lifecycle */
  confidence: ConfidenceLevel,
  qualityScore: z.number().min(0).max(1).default(0.5),
  usageCount: z.number().int().default(0),
  upvotes: z.number().int().default(0),
  downvotes: z.number().int().default(0),

  /** Deduplication */
  clusterId: z.string().uuid().optional(),  // If merged into a cluster
  isCanonical: z.boolean().default(false),  // Is this the canonical version?

  /** Embedding */
  embeddingModel: z.string(),               // e.g. "text-embedding-3-large"
  embeddingVersion: z.number().int(),       // For re-embedding tracking
  embedding: z.array(z.number()).optional(), // The actual vector (stored in vector DB)

  /** Timestamps */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),

  /** Version tracking for staleness detection */
  linkedVersion: z.string().optional(),     // Release version when created
  lastValidatedAt: z.string().datetime().optional(),
});
export type Chunk = z.infer<typeof ChunkSchema>;

// ─── Chunk Cluster (deduplicated group) ──────────────────────────────────────

export const ChunkClusterSchema = z.object({
  id: z.string().uuid(),
  canonicalChunkId: z.string().uuid(),      // The "best" representative
  memberChunkIds: z.array(z.string().uuid()),
  title: z.string(),
  summary: z.string(),                      // Merged/synthesized summary
  mergedAt: z.string().datetime(),
  memberCount: z.number().int(),
  averageSimilarity: z.number().min(0).max(1),
});
export type ChunkCluster = z.infer<typeof ChunkClusterSchema>;
