/**
 * PostgreSQL relational knowledge graph.
 *
 * Nodes and edges use organization-scoped composite keys. Traversal uses a
 * cycle-safe recursive CTE and never closes the shared PostgreSQL pool.
 */

import { randomUUID } from 'node:crypto';
import { type PoolClient } from 'pg';
import { query, withTransaction } from './database.js';
import { createChildLogger } from '../utils/logger.js';
import {
  type GraphNode,
  type GraphEdge,
  type GraphEdgeType,
  type GraphNodeType,
  type GraphExpansionRequest,
  type GraphExpansionResult,
} from '../models/index.js';

const logger = createChildLogger({ module: 'graph-repository' });

interface GraphNodeRow {
  [column: string]: unknown;
  node_id: string;
  node_type: GraphNodeType;
  name: string;
  properties: Record<string, unknown>;
  organization_id: string;
  created_at: Date | string;
  distance?: number | string;
  path_weight?: number | string;
}

const nodeTypes: readonly GraphNodeType[] = [
  'developer', 'team', 'repository', 'chunk', 'knowledge', 'technology',
  'file', 'concept', 'error', 'service',
];

const edgeTypes: readonly GraphEdgeType[] = [
  'authored', 'expert_in', 'member_of', 'works_on', 'related_to',
  'supersedes', 'depends_on', 'solves', 'references', 'uses',
  'integrates_with', 'alternative_to', 'belongs_to', 'fork_of',
  'causes', 'caused_by', 'enables', 'prevents',
];

function assertNodeType(value: string): asserts value is GraphNodeType {
  if (!nodeTypes.includes(value as GraphNodeType)) throw new Error(`Invalid graph node type: ${value}`);
}

function assertEdgeType(value: string): asserts value is GraphEdgeType {
  if (!edgeTypes.includes(value as GraphEdgeType)) throw new Error(`Invalid graph edge type: ${value}`);
}

async function upsertNodeWithClient(client: PoolClient, node: GraphNode): Promise<void> {
  assertNodeType(node.type);
  await client.query(
    `INSERT INTO graph_nodes
       (organization_id, node_type, node_id, name, properties, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
     ON CONFLICT (organization_id, node_type, node_id) DO UPDATE SET
       name = EXCLUDED.name,
       properties = EXCLUDED.properties,
       updated_at = NOW()`,
    [node.organizationId, node.type, node.id, node.name, JSON.stringify(node.properties), node.createdAt],
  );
}

async function upsertScopedEdge(
  client: PoolClient,
  organizationId: string,
  edge: Omit<GraphEdge, 'createdAt'> & { createdAt?: string },
  weightIncrement: number = 0,
): Promise<void> {
  assertNodeType(edge.sourceType);
  assertNodeType(edge.targetType);
  assertEdgeType(edge.type);
  await client.query(
    `INSERT INTO graph_edges
       (organization_id, edge_id, edge_type, source_node_type, source_node_id,
        target_node_type, target_node_id, properties, weight, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, COALESCE($10::timestamptz, NOW()), NOW())
     ON CONFLICT (organization_id, edge_type, source_node_type, source_node_id,
                  target_node_type, target_node_id) DO UPDATE SET
       edge_id = EXCLUDED.edge_id,
       properties = EXCLUDED.properties,
       weight = CASE WHEN $11::real > 0
         THEN LEAST(1.0, graph_edges.weight + $11::real)
         ELSE EXCLUDED.weight END,
       updated_at = NOW()`,
    [
      organizationId, edge.id, edge.type, edge.sourceType, edge.sourceId,
      edge.targetType, edge.targetId, JSON.stringify(edge.properties), edge.weight,
      edge.createdAt ?? null, weightIncrement,
    ],
  );
}

function graphNodeFromRow(row: GraphNodeRow): GraphNode {
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();
  return {
    id: row.node_id,
    type: row.node_type,
    name: row.name,
    properties: row.properties ?? {},
    organizationId: row.organization_id,
    createdAt,
  };
}

export class GraphRepository {
  async upsertNode(node: GraphNode): Promise<void> {
    await withTransaction(client => upsertNodeWithClient(client, node));
  }

  /**
   * Upsert an edge only when its typed endpoints resolve to exactly one common
   * organization. This fails closed because GraphEdge itself has no tenant ID.
   */
  async upsertEdge(edge: GraphEdge): Promise<void> {
    assertNodeType(edge.sourceType);
    assertNodeType(edge.targetType);
    assertEdgeType(edge.type);

    await withTransaction(async client => {
      const organizations = await client.query<{ organization_id: string }>(
        `SELECT source.organization_id
         FROM graph_nodes source
         JOIN graph_nodes target ON target.organization_id = source.organization_id
         WHERE source.node_type = $1 AND source.node_id = $2
           AND target.node_type = $3 AND target.node_id = $4`,
        [edge.sourceType, edge.sourceId, edge.targetType, edge.targetId],
      );
      if (organizations.rowCount !== 1) {
        throw new Error(
          `Graph edge endpoints must resolve to exactly one organization; found ${organizations.rowCount ?? 0}`,
        );
      }
      await upsertScopedEdge(client, organizations.rows[0].organization_id, edge);
    });
  }

  async indexChunk(chunk: {
    id: string;
    title: string;
    authorId: string;
    organizationId: string;
    repository?: string;
    language: string;
    frameworks: string[];
    entities: Array<{ name: string; type: string }>;
  }): Promise<void> {
    const createdAt = new Date().toISOString();
    const organizationId = chunk.organizationId;

    await withTransaction(async client => {
      const addNode = (id: string, type: GraphNodeType, name: string): Promise<void> =>
        upsertNodeWithClient(client, {
          id, type, name, organizationId, properties: {}, createdAt,
        });
      const addEdge = (
        type: GraphEdgeType,
        sourceId: string,
        sourceType: GraphNodeType,
        targetId: string,
        targetType: GraphNodeType,
        weight: number,
        increment: number = 0,
      ): Promise<void> => upsertScopedEdge(client, organizationId, {
        id: `${type}:${sourceType}:${sourceId}:${targetType}:${targetId}`,
        type, sourceId, sourceType, targetId, targetType,
        properties: {}, weight, createdAt,
      }, increment);

      await addNode(chunk.id, 'chunk', chunk.title);
      await addNode(chunk.authorId, 'developer', chunk.authorId);
      await addEdge('authored', chunk.authorId, 'developer', chunk.id, 'chunk', 0.5);

      if (chunk.repository) {
        await addNode(chunk.repository, 'repository', chunk.repository);
        await addEdge('references', chunk.id, 'chunk', chunk.repository, 'repository', 0.5);
        await addEdge('works_on', chunk.authorId, 'developer', chunk.repository, 'repository', 0.1, 0.1);
      }

      const technologies = [...new Map([
        chunk.language,
        ...chunk.frameworks,
        ...chunk.entities
          .filter(entity => entity.type === 'library' || entity.type === 'service')
          .map(entity => entity.name),
      ].filter(Boolean).map(name => [name.toLowerCase(), name])).entries()];

      for (const [technologyId, technologyName] of technologies) {
        await addNode(technologyId, 'technology', technologyName);
        await addEdge('depends_on', chunk.id, 'chunk', technologyId, 'technology', 0.5);
        await addEdge('expert_in', chunk.authorId, 'developer', technologyId, 'technology', 0.05, 0.05);
      }

      await client.query(`DELETE FROM chunk_entities WHERE chunk_id = $1`, [chunk.id]);
      for (const entity of chunk.entities) {
        await client.query(
          `INSERT INTO chunk_entities (chunk_id, organization_id, entity_name, entity_type)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chunk_id, entity_name, entity_type) DO NOTHING`,
          [chunk.id, organizationId, entity.name, entity.type],
        );
      }

      logger.debug({ chunkId: chunk.id, technologies: technologies.length }, 'Chunk indexed in relational graph');
    });
  }

  async expand(request: GraphExpansionRequest): Promise<GraphExpansionResult> {
    if (request.seedNodeIds.length === 0) return { nodes: [], edges: [], relatedContentIds: [] };

    let organizationId = request.organizationId;
    if (!organizationId) {
      const organizations = await query<{ [column: string]: unknown; organization_id: string }>(
        `SELECT DISTINCT organization_id
         FROM graph_nodes
         WHERE node_id = ANY($1::text[])`,
        [request.seedNodeIds],
      );
      if (organizations.rowCount === 0) return { nodes: [], edges: [], relatedContentIds: [] };
      if (organizations.rowCount !== 1) {
        throw new Error('Graph expansion seed IDs are ambiguous across organizations');
      }
      organizationId = organizations.rows[0].organization_id;
    }

    const result = await query<GraphNodeRow>(
      `WITH RECURSIVE paths AS (
         SELECT n.organization_id, n.node_type, n.node_id, n.name, n.properties,
                n.created_at, 0 AS distance, 1.0::double precision AS path_weight,
                ARRAY[n.node_type || ':' || n.node_id]::text[] AS visited
         FROM graph_nodes n
         WHERE n.organization_id = $1 AND n.node_id = ANY($2::text[])

         UNION ALL

         SELECT next.organization_id, next.node_type, next.node_id, next.name,
                next.properties, next.created_at, paths.distance + 1,
                paths.path_weight * edge.weight,
                paths.visited || (next.node_type || ':' || next.node_id)
         FROM paths
         JOIN graph_edges edge ON edge.organization_id = paths.organization_id
           AND ((edge.source_node_type = paths.node_type AND edge.source_node_id = paths.node_id)
             OR (edge.target_node_type = paths.node_type AND edge.target_node_id = paths.node_id))
         JOIN graph_nodes next ON next.organization_id = edge.organization_id
           AND next.node_type = CASE WHEN edge.source_node_type = paths.node_type
                                  AND edge.source_node_id = paths.node_id
             THEN edge.target_node_type ELSE edge.source_node_type END
           AND next.node_id = CASE WHEN edge.source_node_type = paths.node_type
                                  AND edge.source_node_id = paths.node_id
             THEN edge.target_node_id ELSE edge.source_node_id END
         WHERE paths.distance < $3
           AND ($4::text[] IS NULL OR edge.edge_type = ANY($4::text[]))
           AND NOT ((next.node_type || ':' || next.node_id) = ANY(paths.visited))
       ), ranked AS (
         SELECT organization_id, node_type, node_id, name, properties, created_at,
                MIN(distance) AS distance, MAX(path_weight) AS path_weight
         FROM paths
         WHERE distance > 0
           AND ($5::text[] IS NULL OR node_type = ANY($5::text[]))
         GROUP BY organization_id, node_type, node_id, name, properties, created_at
       )
       SELECT * FROM ranked
       WHERE path_weight >= $6
       ORDER BY path_weight DESC, distance ASC
       LIMIT $7`,
      [
        organizationId,
        request.seedNodeIds,
        request.maxDepth,
        request.edgeTypes?.length ? request.edgeTypes : null,
        request.targetNodeTypes?.length ? request.targetNodeTypes : null,
        request.minWeight,
        request.limit,
      ],
    );

    const nodes = result.rows.map(graphNodeFromRow);
    return {
      nodes,
      edges: [],
      relatedContentIds: nodes
        .filter(node => node.type === 'chunk' || node.type === 'knowledge')
        .map(node => node.id),
    };
  }

  /**
   * Index causal relationships extracted from facts.
   * Creates edges between concept/technology/chunk nodes when a causal
   * relationship is detected (e.g., "VPC caused Lambda cold starts").
   */
  async indexCausalLinks(links: Array<{
    organizationId: string;
    sourceEntityName: string;
    targetEntityName: string;
    causalType: 'causes' | 'caused_by' | 'enables' | 'prevents';
    sourceChunkId?: string;
    weight?: number;
  }>): Promise<void> {
    if (links.length === 0) return;

    await withTransaction(async client => {
      for (const link of links) {
        const sourceId = link.sourceEntityName.toLowerCase();
        const targetId = link.targetEntityName.toLowerCase();
        const createdAt = new Date().toISOString();

        // Ensure both nodes exist (as technology/concept)
        await upsertNodeWithClient(client, {
          id: sourceId,
          type: 'technology',
          name: link.sourceEntityName,
          organizationId: link.organizationId,
          properties: {},
          createdAt,
        });
        await upsertNodeWithClient(client, {
          id: targetId,
          type: 'technology',
          name: link.targetEntityName,
          organizationId: link.organizationId,
          properties: {},
          createdAt,
        });

        // Create causal edge with weight increment (strengthens with repeated observation)
        await upsertScopedEdge(client, link.organizationId, {
          id: `${link.causalType}:technology:${sourceId}:technology:${targetId}`,
          type: link.causalType,
          sourceId,
          sourceType: 'technology',
          targetId,
          targetType: 'technology',
          properties: {
            ...(link.sourceChunkId ? { sourceChunkId: link.sourceChunkId } : {}),
          },
          weight: link.weight ?? 0.6,
          createdAt,
        }, 0.1); // Increment weight on repeated observations
      }
    });

    logger.debug({ count: links.length }, 'Causal links indexed');
  }

  async findExperts(
    technology: string,
    organizationId: string,
    limit: number = 5,
  ): Promise<Array<{ developerId: string; weight: number }>> {
    const result = await query<{ [column: string]: unknown; developer_id: string; weight: number | string }>(
      `SELECT edge.source_node_id AS developer_id, edge.weight
       FROM graph_edges edge
       WHERE edge.organization_id = $1
         AND edge.edge_type = 'expert_in'
         AND edge.source_node_type = 'developer'
         AND edge.target_node_type = 'technology'
         AND edge.target_node_id = $2
       ORDER BY edge.weight DESC
       LIMIT $3`,
      [organizationId, technology.toLowerCase(), Math.max(1, limit)],
    );
    return result.rows.map(row => ({ developerId: row.developer_id, weight: Number(row.weight) }));
  }

  async findRelatedRepositories(
    repository: string,
    limit: number = 10,
    organizationId?: string,
  ): Promise<Array<{ repository: string; sharedDevelopers: number }>> {
    const result = await query<{
      [column: string]: unknown;
      repository: string;
      shared_developers: number | string;
    }>(
      `WITH resolved_org AS (
         SELECT CASE WHEN $3::text IS NOT NULL THEN $3::text
           WHEN COUNT(DISTINCT organization_id) = 1 THEN MIN(organization_id)
           ELSE NULL END AS organization_id
         FROM graph_nodes
         WHERE node_type = 'repository' AND node_id = $1
       )
       SELECT second.target_node_id AS repository,
              COUNT(DISTINCT first.source_node_id)::int AS shared_developers
       FROM resolved_org org
       JOIN graph_edges first ON first.organization_id = org.organization_id
         AND first.edge_type = 'works_on' AND first.target_node_id = $1
       JOIN graph_edges second ON second.organization_id = first.organization_id
         AND second.edge_type = 'works_on'
         AND second.source_node_type = 'developer'
         AND second.source_node_id = first.source_node_id
         AND second.target_node_type = 'repository'
         AND second.target_node_id <> $1
       GROUP BY second.target_node_id
       ORDER BY shared_developers DESC
       LIMIT $2`,
      [repository, Math.max(1, limit), organizationId ?? null],
    );
    return result.rows.map(row => ({
      repository: row.repository,
      sharedDevelopers: Number(row.shared_developers),
    }));
  }

  async getRepositoryStack(repository: string, organizationId?: string): Promise<string[]> {
    const result = await query<{ [column: string]: unknown; technology: string }>(
      `WITH resolved_org AS (
         SELECT CASE WHEN $2::text IS NOT NULL THEN $2::text
           WHEN COUNT(DISTINCT organization_id) = 1 THEN MIN(organization_id)
           ELSE NULL END AS organization_id
         FROM graph_nodes
         WHERE node_type = 'repository' AND node_id = $1
       ), repository_chunks AS (
         SELECT ref.source_node_id AS chunk_id, ref.organization_id
         FROM resolved_org org
         JOIN graph_edges ref ON ref.organization_id = org.organization_id
           AND ref.edge_type = 'references'
           AND ref.source_node_type = 'chunk'
           AND ref.target_node_type = 'repository'
           AND ref.target_node_id = $1
       )
       SELECT DISTINCT technology.name AS technology
       FROM repository_chunks chunks
       JOIN graph_edges dependency ON dependency.organization_id = chunks.organization_id
         AND dependency.edge_type = 'depends_on'
         AND dependency.source_node_type = 'chunk'
         AND dependency.source_node_id = chunks.chunk_id
       JOIN graph_nodes technology ON technology.organization_id = dependency.organization_id
         AND technology.node_type = dependency.target_node_type
         AND technology.node_id = dependency.target_node_id
       ORDER BY technology.name`,
      [repository, organizationId ?? null],
    );
    return result.rows.map(row => row.technology);
  }
}

export async function checkGraphHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const result = await query<{ [column: string]: unknown; ready: boolean }>(
      `SELECT to_regclass('public.graph_nodes') IS NOT NULL
          AND to_regclass('public.graph_edges') IS NOT NULL AS ready`,
    );
    return { healthy: result.rows[0]?.ready === true, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  }
}

/** PostgreSQL lifecycle is owned by closeDatabase(). */
export async function closeGraph(): Promise<void> {
  logger.debug({ marker: randomUUID() }, 'Relational graph uses shared PostgreSQL pool');
}
