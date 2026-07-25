/**
 * Graph Repository
 *
 * Neo4j-backed storage for the knowledge graph.
 * Stores relationships between developers, repositories, technologies,
 * chunks, and knowledge records. Graph traversal enables:
 *   - "What else does the author of this chunk know?"
 *   - "What other issues have occurred in this repository?"
 *   - "What technologies are related to this framework?"
 *
 * This dramatically improves retrieval by expanding context beyond
 * simple vector similarity.
 */

import neo4j, { Driver, Session as Neo4jSession, Result } from 'neo4j-driver';
import { getConfig } from '../config/index.js';
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

let driver: Driver | null = null;

// ─── Connection Management ───────────────────────────────────────────────────

function getDriver(): Driver {
  if (driver) return driver;

  const config = getConfig();
  driver = neo4j.driver(
    config.NEO4J_URI,
    neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD),
    {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 5000,
      maxTransactionRetryTime: 15000,
    },
  );

  logger.info({ uri: config.NEO4J_URI }, 'Neo4j driver created');
  return driver;
}

function getSession(): Neo4jSession {
  return getDriver().session({ database: 'neo4j' });
}

// ─── Graph Repository ────────────────────────────────────────────────────────

export class GraphRepository {
  /**
   * Create or update a node in the graph.
   */
  async upsertNode(node: GraphNode): Promise<void> {
    const session = getSession();
    try {
      await session.run(
        `
        MERGE (n:${node.type} {id: $id})
        SET n.name = $name,
            n.organizationId = $organizationId,
            n.properties = $properties,
            n.updatedAt = datetime()
        ON CREATE SET n.createdAt = datetime()
        `,
        {
          id: node.id,
          name: node.name,
          organizationId: node.organizationId,
          properties: JSON.stringify(node.properties),
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Create or update an edge between two nodes.
   */
  async upsertEdge(edge: GraphEdge): Promise<void> {
    const session = getSession();
    try {
      await session.run(
        `
        MATCH (source {id: $sourceId})
        MATCH (target {id: $targetId})
        MERGE (source)-[r:${edge.type}]->(target)
        SET r.id = $edgeId,
            r.weight = $weight,
            r.properties = $properties,
            r.updatedAt = datetime()
        ON CREATE SET r.createdAt = datetime()
        `,
        {
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          edgeId: edge.id,
          weight: edge.weight,
          properties: JSON.stringify(edge.properties),
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Create graph nodes and edges from an ingested chunk.
   * Builds relationships: author→chunk, chunk→repository, chunk→technology, etc.
   */
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
    const session = getSession();
    const now = new Date().toISOString();

    try {
      // Create chunk node
      await session.run(
        `
        MERGE (c:chunk {id: $id})
        SET c.name = $title, c.organizationId = $orgId, c.updatedAt = datetime()
        ON CREATE SET c.createdAt = datetime()
        `,
        { id: chunk.id, title: chunk.title, orgId: chunk.organizationId },
      );

      // Link author → chunk
      await session.run(
        `
        MERGE (d:developer {id: $authorId})
        ON CREATE SET d.name = $authorId, d.organizationId = $orgId, d.createdAt = datetime()
        WITH d
        MATCH (c:chunk {id: $chunkId})
        MERGE (d)-[:authored]->(c)
        `,
        { authorId: chunk.authorId, orgId: chunk.organizationId, chunkId: chunk.id },
      );

      // Link chunk → repository
      if (chunk.repository) {
        await session.run(
          `
          MERGE (r:repository {id: $repoId})
          ON CREATE SET r.name = $repoId, r.organizationId = $orgId, r.createdAt = datetime()
          WITH r
          MATCH (c:chunk {id: $chunkId})
          MERGE (c)-[:references]->(r)
          `,
          { repoId: chunk.repository, orgId: chunk.organizationId, chunkId: chunk.id },
        );

        // Developer → works_on → repository
        await session.run(
          `
          MATCH (d:developer {id: $authorId})
          MATCH (r:repository {id: $repoId})
          MERGE (d)-[w:works_on]->(r)
          SET w.weight = coalesce(w.weight, 0) + 0.1
          `,
          { authorId: chunk.authorId, repoId: chunk.repository },
        );
      }

      // Link chunk → technology nodes (language + frameworks + entities)
      const technologies = [
        chunk.language,
        ...chunk.frameworks,
        ...chunk.entities
          .filter(e => e.type === 'library' || e.type === 'service')
          .map(e => e.name),
      ].filter(Boolean);

      for (const tech of technologies) {
        await session.run(
          `
          MERGE (t:technology {id: $techId})
          ON CREATE SET t.name = $techName, t.organizationId = $orgId, t.createdAt = datetime()
          WITH t
          MATCH (c:chunk {id: $chunkId})
          MERGE (c)-[:depends_on]->(t)
          `,
          {
            techId: tech.toLowerCase(),
            techName: tech,
            orgId: chunk.organizationId,
            chunkId: chunk.id,
          },
        );

        // Developer → expert_in → technology (accumulates weight)
        await session.run(
          `
          MATCH (d:developer {id: $authorId})
          MATCH (t:technology {id: $techId})
          MERGE (d)-[e:expert_in]->(t)
          SET e.weight = coalesce(e.weight, 0) + 0.05
          `,
          { authorId: chunk.authorId, techId: tech.toLowerCase() },
        );
      }

      logger.debug({
        chunkId: chunk.id,
        technologies: technologies.length,
      }, 'Chunk indexed in graph');
    } finally {
      await session.close();
    }
  }

  /**
   * Graph expansion: starting from seed nodes, traverse edges to find related content.
   * This is the core function called during retrieval to enrich search results.
   */
  async expand(request: GraphExpansionRequest): Promise<GraphExpansionResult> {
    const session = getSession();

    try {
      // Build edge type filter
      const edgeFilter = request.edgeTypes
        ? `:${request.edgeTypes.join('|:')}`
        : '';

      // Build target node type filter
      const nodeFilter = request.targetNodeTypes
        ? `WHERE ANY(label IN labels(related) WHERE label IN $targetTypes)`
        : '';

      const result = await session.run(
        `
        UNWIND $seedIds AS seedId
        MATCH (seed {id: seedId})
        MATCH path = (seed)-[${edgeFilter}*1..${request.maxDepth}]-(related)
        ${nodeFilter}
        WHERE related.id <> seedId
        WITH DISTINCT related,
             min(length(path)) AS distance,
             max(reduce(w = 1.0, r IN relationships(path) | w * coalesce(r.weight, 0.5))) AS pathWeight
        WHERE pathWeight >= $minWeight
        RETURN related.id AS id,
               labels(related)[0] AS type,
               related.name AS name,
               related.properties AS properties,
               related.organizationId AS organizationId,
               distance,
               pathWeight
        ORDER BY pathWeight DESC
        LIMIT $limit
        `,
        {
          seedIds: request.seedNodeIds,
          targetTypes: request.targetNodeTypes ?? [],
          minWeight: request.minWeight,
          limit: neo4j.int(request.limit),
        },
      );

      const nodes: GraphNode[] = result.records.map(record => ({
        id: record.get('id'),
        type: record.get('type') as GraphNodeType,
        name: record.get('name'),
        properties: JSON.parse(record.get('properties') ?? '{}'),
        organizationId: record.get('organizationId'),
        createdAt: new Date().toISOString(),
      }));

      // Extract chunk IDs from related nodes
      const relatedContentIds = nodes
        .filter(n => n.type === 'chunk' || n.type === 'knowledge')
        .map(n => n.id);

      return {
        nodes,
        edges: [], // Edges omitted for performance; available via separate query
        relatedContentIds,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Find experts for a given technology or topic.
   * Returns developers with highest edge weight to the technology node.
   */
  async findExperts(
    technology: string,
    organizationId: string,
    limit: number = 5,
  ): Promise<Array<{ developerId: string; weight: number }>> {
    const session = getSession();

    try {
      const result = await session.run(
        `
        MATCH (d:developer)-[e:expert_in]->(t:technology {id: $techId})
        WHERE d.organizationId = $orgId
        RETURN d.id AS developerId, e.weight AS weight
        ORDER BY e.weight DESC
        LIMIT $limit
        `,
        { techId: technology.toLowerCase(), orgId: organizationId, limit: neo4j.int(limit) },
      );

      return result.records.map(r => ({
        developerId: r.get('developerId'),
        weight: r.get('weight'),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Find related repositories for a given repository.
   * Two repos are related if the same developers work on both.
   */
  async findRelatedRepositories(
    repository: string,
    limit: number = 10,
  ): Promise<Array<{ repository: string; sharedDevelopers: number }>> {
    const session = getSession();

    try {
      const result = await session.run(
        `
        MATCH (r1:repository {id: $repoId})<-[:works_on]-(d:developer)-[:works_on]->(r2:repository)
        WHERE r2.id <> $repoId
        RETURN r2.id AS repository, count(d) AS sharedDevelopers
        ORDER BY sharedDevelopers DESC
        LIMIT $limit
        `,
        { repoId: repository, limit: neo4j.int(limit) },
      );

      return result.records.map(r => ({
        repository: r.get('repository'),
        sharedDevelopers: r.get('sharedDevelopers').toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get the technology stack for a repository.
   */
  async getRepositoryStack(repository: string): Promise<string[]> {
    const session = getSession();

    try {
      const result = await session.run(
        `
        MATCH (:chunk)-[:references]->(:repository {id: $repoId})
        MATCH (:chunk)-[:depends_on]->(t:technology)
        RETURN DISTINCT t.name AS tech
        `,
        { repoId: repository },
      );

      return result.records.map(r => r.get('tech'));
    } finally {
      await session.close();
    }
  }
}

// ─── Health Check ────────────────────────────────────────────────────────────

export async function checkGraphHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  const session = getSession();

  try {
    await session.run('RETURN 1');
    return { healthy: true, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  } finally {
    await session.close();
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

export async function closeGraph(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
    logger.info('Neo4j driver closed');
  }
}
