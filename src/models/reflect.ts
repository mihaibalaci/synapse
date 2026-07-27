/**
 * Reflect Models
 *
 * Request/response schemas for the Reflect API — the operation that
 * reasons over retrieved memories to produce synthesized answers.
 *
 * Inspired by Hindsight's CARA (Coherent Adaptive Reasoning Agents),
 * adapted for team-scale organizational memory.
 */

import { z } from 'zod';

// ─── Observation (Entity Summary / Mental Model) ─────────────────────────────

export const ObservationSchema = z.object({
  id: z.string().uuid(),

  /** The entity this observation is about */
  entityName: z.string(),

  /** Organization scope */
  organizationId: z.string(),

  /** Concise factual summary of the entity */
  summary: z.string(),

  /** IDs of facts that contributed to this observation */
  sourceFactIds: z.array(z.string().uuid()),

  /** How many facts were used to generate this */
  sourceFactCount: z.number().int(),

  /** Embedding for semantic retrieval of observations */
  embedding: z.array(z.number()).optional(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// ─── Reflect Request ─────────────────────────────────────────────────────────

export const ReflectRequestSchema = z.object({
  /** The question or topic to reflect on */
  query: z.string().min(3).max(2000),

  /** Optional entity to focus the reflection on */
  entityFocus: z.string().optional(),

  /** Optional temporal context for time-bounded reflection */
  temporalContext: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }).optional(),

  /** Context to improve retrieval relevance */
  context: z.object({
    repository: z.string().optional(),
    branch: z.string().optional(),
    filePath: z.string().optional(),
    language: z.string().optional(),
    frameworks: z.array(z.string()).optional(),
  }).optional(),

  /** Filters for retrieval */
  filters: z.object({
    repositories: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    types: z.array(z.string()).optional(),
    teams: z.array(z.string()).optional(),
  }).optional(),

  /** Maximum token budget for context fed to the LLM */
  maxTokens: z.number().int().min(500).max(50000).default(6000),

  /** Maximum number of source items to retrieve */
  maxSources: z.number().int().min(1).max(30).default(10),

  /** Whether to generate/update an observation as a side-effect */
  generateObservation: z.boolean().default(true),

  /** Whether to write learned insights back into memory (learning loop).
   *  Only triggers on high-confidence answers. Default: true. */
  writeBack: z.boolean().default(true),

  /** Identity and authorization */
  developerId: z.string(),
  organizationId: z.string(),
  teamIds: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  repositoryAccess: z.array(z.string()).default([]),
});
export type ReflectRequest = z.infer<typeof ReflectRequestSchema>;

// ─── Reflect Source ──────────────────────────────────────────────────────────

export const ReflectSourceSchema = z.object({
  sourceIndex: z.number().int(),
  type: z.enum(['fact', 'chunk', 'observation']),
  id: z.string(),

  // Shared fields
  content: z.string().optional(),
  createdAt: z.string().datetime().optional(),

  // Fact-specific
  factType: z.string().optional(),
  confidence: z.number().optional(),
  entities: z.array(z.string()).optional(),

  // Chunk-specific
  title: z.string().optional(),
  score: z.number().optional(),
  repository: z.string().optional(),
});
export type ReflectSource = z.infer<typeof ReflectSourceSchema>;

// ─── Reflect Response ────────────────────────────────────────────────────────

export const ReflectResponseSchema = z.object({
  /** Unique identifier for this reflect operation */
  reflectId: z.string().uuid(),

  /** Original query */
  query: z.string(),

  /** Synthesized answer from LLM reasoning over memories */
  answer: z.string(),

  /** Confidence in the answer */
  confidence: z.enum(['high', 'medium', 'low']),

  /** Why this confidence level */
  reasoning: z.string(),

  /** Sources used to generate the answer */
  sources: z.array(ReflectSourceSchema),

  /** Observation generated or retrieved (if entity-focused) */
  observation: ObservationSchema.optional(),

  /** Insights that were learned and stored back into memory (learning loop) */
  learnedInsights: z.array(z.object({
    id: z.string().uuid(),
    content: z.string(),
    type: z.string(),
  })).optional(),

  /** Timing */
  retrievalLatencyMs: z.number(),
  totalLatencyMs: z.number(),

  /** LLM usage for cost tracking */
  llmTokensUsed: z.object({
    input: z.number().int(),
    output: z.number().int(),
    model: z.string(),
  }).optional(),
});
export type ReflectResponse = z.infer<typeof ReflectResponseSchema>;
