/**
 * Graph Models
 *
 * Define the nodes and edges for the knowledge graph.
 * The graph captures relationships between developers, repositories,
 * technologies, chunks, and knowledge records.
 */

import { z } from 'zod';

// ─── Node Types ──────────────────────────────────────────────────────────────

export const GraphNodeType = z.enum([
  'developer',
  'team',
  'repository',
  'chunk',
  'knowledge',
  'technology',    // Language, framework, library, service
  'file',
  'concept',       // Design pattern, algorithm, architecture style
  'error',         // Specific error type
  'service',       // Internal or external service
]);
export type GraphNodeType = z.infer<typeof GraphNodeType>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  type: GraphNodeType,
  name: z.string(),
  properties: z.record(z.unknown()).default({}),
  organizationId: z.string(),
  createdAt: z.string().datetime(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ─── Edge Types ──────────────────────────────────────────────────────────────

export const GraphEdgeType = z.enum([
  // Developer relationships
  'authored',             // developer → chunk/knowledge
  'expert_in',           // developer → technology/concept
  'member_of',           // developer → team
  'works_on',            // developer → repository

  // Knowledge relationships
  'related_to',          // chunk ↔ chunk
  'supersedes',          // knowledge → knowledge (newer replaces older)
  'depends_on',          // chunk → technology/service
  'solves',              // knowledge → error
  'references',          // chunk → file/repository

  // Technology relationships
  'uses',                // repository/service → technology
  'integrates_with',     // service → service
  'alternative_to',      // technology ↔ technology

  // Repository relationships
  'belongs_to',          // file → repository
  'fork_of',             // repository → repository
]);
export type GraphEdgeType = z.infer<typeof GraphEdgeType>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  type: GraphEdgeType,
  sourceId: z.string(),
  sourceType: GraphNodeType,
  targetId: z.string(),
  targetType: GraphNodeType,
  properties: z.record(z.unknown()).default({}),
  weight: z.number().min(0).max(1).default(0.5),  // Relationship strength
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// ─── Graph Query ─────────────────────────────────────────────────────────────

export const GraphExpansionRequestSchema = z.object({
  /** Start from these node IDs */
  seedNodeIds: z.array(z.string()),

  /** How many hops to traverse */
  maxDepth: z.number().int().min(1).max(4).default(2),

  /** Filter edge types to follow */
  edgeTypes: z.array(GraphEdgeType).optional(),

  /** Filter target node types */
  targetNodeTypes: z.array(GraphNodeType).optional(),

  /** Maximum results */
  limit: z.number().int().min(1).max(100).default(20),

  /** Minimum edge weight */
  minWeight: z.number().min(0).max(1).default(0.3),
});
export type GraphExpansionRequest = z.infer<typeof GraphExpansionRequestSchema>;

export const GraphExpansionResultSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  /** IDs of related chunks/knowledge found via graph traversal */
  relatedContentIds: z.array(z.string()),
});
export type GraphExpansionResult = z.infer<typeof GraphExpansionResultSchema>;
