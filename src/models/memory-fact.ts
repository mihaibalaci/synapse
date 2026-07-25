/**
 * Memory Fact Model (v3)
 *
 * Atomic facts extracted from conversations. These are the building blocks
 * of the memory layer — small, precise, independently retrievable units.
 *
 * Unlike chunks (which are 800-1200 tokens of conversation context),
 * facts are typically 10-50 tokens of distilled knowledge:
 *   "Team uses Kafka for event streaming between services"
 *   "Lambda timeout in VPC caused by DNS resolution delay"
 *   "Always use multipart upload for S3 files >100MB"
 *
 * Facts follow an ADD-only principle: when information changes,
 * we add a new fact and mark the old one as superseded. We never overwrite.
 * This preserves history and enables temporal reasoning:
 *   "When did we switch from RabbitMQ to Kafka?"
 *   "What was our auth strategy before the rewrite?"
 */

import { z } from 'zod';

// ─── Fact Types ──────────────────────────────────────────────────────────────

export const FactType = z.enum([
  'decision',      // "Team decided to use Kafka" — architectural/tech choices
  'preference',    // "Developer prefers async/await over .then()" — individual/team norms
  'pattern',       // "Use retry with exponential backoff for DynamoDB writes" — reusable patterns
  'lesson',        // "Lambda cold starts double when using VPC" — learned insights
  'constraint',    // "Max payload size for API Gateway is 10MB" — hard limits
  'procedure',     // "Deploy by merging to main; pipeline handles the rest" — how-tos
  'definition',    // "The auth service is the source of truth for user tokens" — what things are
  'relationship',  // "Service A depends on Service B for user data" — connections
]);
export type FactType = z.infer<typeof FactType>;

// ─── Temporal Context ────────────────────────────────────────────────────────

export const TemporalContextSchema = z.object({
  /** When this fact was observed/stated */
  observedAt: z.string().datetime(),

  /** When this fact became true (may differ from observedAt) */
  validFrom: z.string().datetime().optional(),

  /** When this fact was superseded (null = still valid) */
  validUntil: z.string().datetime().optional(),

  /** ID of the fact that supersedes this one */
  supersededBy: z.string().uuid().optional(),

  /** ID of the fact this one supersedes */
  supersedes: z.string().uuid().optional(),

  /** How was this temporal relationship determined */
  temporalSource: z.enum(['explicit', 'inferred', 'manual']).default('inferred'),
});
export type TemporalContext = z.infer<typeof TemporalContextSchema>;

// ─── Memory Fact Schema ──────────────────────────────────────────────────────

export const MemoryFactSchema = z.object({
  id: z.string().uuid(),

  /** The atomic fact content (10-50 tokens typically) */
  content: z.string().min(5).max(500),

  /** Classification */
  type: FactType,

  /** Entities mentioned in this fact (for entity-boosted retrieval) */
  entities: z.array(z.string()),

  /** Temporal context — when this was true, what supersedes it */
  temporal: TemporalContextSchema,

  /** Source tracing — always link back to full context */
  sourceChunkId: z.string().uuid(),
  sourceSessionId: z.string().uuid(),
  sourceMessageIndex: z.number().int().optional(),

  /** Who generated this fact */
  extractedFrom: z.enum(['user', 'assistant', 'both']),

  /** Ownership */
  authorId: z.string(),
  organizationId: z.string(),
  teamId: z.string().optional(),

  /** Scope: is this personal knowledge or team knowledge? */
  scope: z.enum([
    'personal',     // Only relevant to the author
    'team',         // Relevant to the author's team
    'organization', // Relevant to the whole org
  ]).default('organization'),

  /** Quality and usage */
  confidence: z.number().min(0).max(1).default(0.7),
  usageCount: z.number().int().default(0),
  upvotes: z.number().int().default(0),
  lastAccessedAt: z.string().datetime().optional(),

  /** Embedding for semantic retrieval */
  embedding: z.array(z.number()).optional(),
  embeddingModel: z.string().optional(),

  /** Repository/code context (if applicable) */
  repository: z.string().optional(),
  language: z.string().optional(),
  frameworks: z.array(z.string()).default([]),

  /** Timestamps */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

// ─── Capture Event (Pieces-inspired passive capture) ─────────────────────────

export const CaptureEventSchema = z.object({
  id: z.string().uuid(),

  /** What type of event was captured */
  type: z.enum([
    'ai_session',     // Complete AI conversation (primary)
    'ai_turn',        // Single turn in an ongoing conversation (streaming)
    'clipboard',      // Code/text copied to clipboard
    'terminal',       // Terminal command + output
    'browser',        // URL visited, content read
    'meeting',        // Meeting transcript segment
    'commit',         // Git commit with message
    'pr_review',      // Pull request review comment
    'slack_thread',   // Slack discussion thread
  ]),

  /** Source application */
  source: z.string(),  // "cursor", "kiro", "iterm2", "chrome", "slack", "zoom"

  /** Raw content */
  content: z.string(),

  /** Structured metadata (varies by type) */
  metadata: z.record(z.unknown()).default({}),

  /** Was this an automatic capture or manual save? */
  captureMode: z.enum(['passive', 'active']).default('passive'),

  /** Developer identity */
  developerId: z.string(),
  organizationId: z.string(),

  /** Temporal */
  timestamp: z.string().datetime(),
  duration: z.number().optional(), // Duration in seconds (for sessions/meetings)

  /** Processing status */
  processed: z.boolean().default(false),
  factIds: z.array(z.string().uuid()).default([]), // Facts extracted from this event
});
export type CaptureEvent = z.infer<typeof CaptureEventSchema>;

// ─── Temporal Query (for time-based retrieval) ───────────────────────────────

export const TemporalQuerySchema = z.object({
  /** Natural language time reference */
  timeReference: z.string().optional(), // "last week", "yesterday", "before the rewrite"

  /** Explicit time range */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),

  /** Filter by temporal validity */
  onlyCurrentlyValid: z.boolean().default(false), // true = exclude superseded facts
  includeSuperseded: z.boolean().default(true),   // false = only show latest version
});
export type TemporalQuery = z.infer<typeof TemporalQuerySchema>;
