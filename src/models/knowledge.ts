/**
 * Knowledge Models
 *
 * Structured knowledge extracted from chunks.
 * This is the highest-value representation — distilled facts,
 * decisions, patterns, and solutions extracted by LLM passes.
 */

import { z } from 'zod';
import { CodeReferenceSchema, EntitySchema } from './chunk.js';

// ─── Knowledge Types ─────────────────────────────────────────────────────────

export const KnowledgeType = z.enum([
  'problem_solution',   // Bug/issue + resolution
  'architecture_decision', // ADR-style design choice
  'best_practice',      // Recommended approach
  'anti_pattern',       // What NOT to do
  'how_to',            // Step-by-step procedure
  'concept',           // Explanation of a technical concept
  'configuration',     // How to configure something
  'performance',       // Performance insight or optimization
  'security',          // Security-related guidance
  'deployment',        // Deployment/operations knowledge
]);
export type KnowledgeType = z.infer<typeof KnowledgeType>;

// ─── Problem-Solution Record ─────────────────────────────────────────────────

export const ProblemSolutionSchema = z.object({
  problem: z.string(),
  symptoms: z.array(z.string()).default([]),
  rootCause: z.string().optional(),
  solution: z.string(),
  solutionSteps: z.array(z.string()).default([]),
  impact: z.string().optional(),
  workarounds: z.array(z.string()).default([]),
  relatedErrors: z.array(z.string()).default([]),
});
export type ProblemSolution = z.infer<typeof ProblemSolutionSchema>;

// ─── Architecture Decision Record ────────────────────────────────────────────

export const ArchitectureDecisionSchema = z.object({
  context: z.string(),           // What is the situation?
  decision: z.string(),          // What did we decide?
  rationale: z.string(),         // Why this choice?
  alternatives: z.array(z.object({
    option: z.string(),
    proscons: z.string(),
    rejected: z.boolean(),
  })).default([]),
  consequences: z.array(z.string()).default([]),
  status: z.enum(['proposed', 'accepted', 'deprecated', 'superseded']),
});
export type ArchitectureDecision = z.infer<typeof ArchitectureDecisionSchema>;

// ─── Best Practice Record ────────────────────────────────────────────────────

export const BestPracticeSchema = z.object({
  practice: z.string(),
  rationale: z.string(),
  examples: z.array(z.object({
    description: z.string(),
    code: z.string().optional(),
    language: z.string().optional(),
  })).default([]),
  exceptions: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
});
export type BestPractice = z.infer<typeof BestPracticeSchema>;

// ─── How-To Record ───────────────────────────────────────────────────────────

export const HowToSchema = z.object({
  goal: z.string(),
  prerequisites: z.array(z.string()).default([]),
  steps: z.array(z.object({
    order: z.number().int(),
    instruction: z.string(),
    code: z.string().optional(),
    notes: z.string().optional(),
  })),
  validation: z.string().optional(),  // How to verify it worked
  commonPitfalls: z.array(z.string()).default([]),
});
export type HowTo = z.infer<typeof HowToSchema>;

// ─── Full Knowledge Record ───────────────────────────────────────────────────

export const KnowledgeRecordSchema = z.object({
  id: z.string().uuid(),
  chunkId: z.string().uuid(),          // Source chunk
  sessionId: z.string().uuid(),        // Original session

  /** Classification */
  type: KnowledgeType,
  title: z.string(),
  summary: z.string(),

  /** Structured content (one of these will be populated based on type) */
  problemSolution: ProblemSolutionSchema.optional(),
  architectureDecision: ArchitectureDecisionSchema.optional(),
  bestPractice: BestPracticeSchema.optional(),
  howTo: HowToSchema.optional(),

  /** Free-form content for types without specific structure */
  content: z.string().optional(),

  /** References */
  entities: z.array(EntitySchema).default([]),
  codeReferences: z.array(CodeReferenceSchema).default([]),
  citations: z.array(z.object({
    type: z.enum(['conversation', 'commit', 'pull_request', 'wiki', 'doc', 'file']),
    url: z.string().optional(),
    reference: z.string(),
    title: z.string().optional(),
  })).default([]),

  /** Context */
  repository: z.string().optional(),
  language: z.string(),
  frameworks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),

  /** Ownership */
  authorId: z.string(),
  organizationId: z.string(),
  teamId: z.string().optional(),
  endorsedBy: z.array(z.string()).default([]),   // Manager/lead endorsements

  /** Quality */
  qualityScore: z.number().min(0).max(1),
  isValidated: z.boolean().default(false),
  validatedBy: z.string().optional(),

  /** Timestamps */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastValidatedAt: z.string().datetime().optional(),
});
export type KnowledgeRecord = z.infer<typeof KnowledgeRecordSchema>;
