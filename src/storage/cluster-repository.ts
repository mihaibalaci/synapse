/* Persistence for organization-scoped deduplication clusters. */

import { type QueryResultRow } from 'pg';
import { type ChunkCluster } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { query } from './database.js';

const logger = createChildLogger({ module: 'cluster-repository' });

interface ClusterRow extends QueryResultRow {
  id: string;
  organization_id: string;
  canonical_chunk_id: string;
  member_chunk_ids: string[];
  title: string;
  summary: string;
  merged_at: Date | string;
  member_count: number;
  average_similarity: number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapCluster(row: ClusterRow): ChunkCluster {
  return {
    id: row.id,
    organizationId: row.organization_id,
    canonicalChunkId: row.canonical_chunk_id,
    memberChunkIds: row.member_chunk_ids ?? [],
    title: row.title,
    summary: row.summary,
    mergedAt: iso(row.merged_at),
    memberCount: row.member_count,
    averageSimilarity: Number(row.average_similarity),
  };
}

function requireMutation(rowCount: number | null, operation: string): void {
  if ((rowCount ?? 0) !== 1) {
    throw new Error(`Cluster ${operation} rejected: cluster or same-organization chunk not found`);
  }
}

export class ClusterRepository {
  async create(cluster: ChunkCluster): Promise<void> {
    logger.debug({
      clusterId: cluster.id,
      organizationId: cluster.organizationId,
      memberCount: cluster.memberCount,
      canonical: cluster.canonicalChunkId,
    }, 'Creating cluster');
    const result = await query(`
      INSERT INTO chunk_clusters (
        id, organization_id, canonical_chunk_id, member_chunk_ids, title, summary,
        merged_at, member_count, average_similarity
      )
      SELECT $1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9
      FROM chunks canonical
      WHERE canonical.id = $3
        AND canonical.organization_id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM unnest($4::uuid[]) member_id
          LEFT JOIN chunks member ON member.id = member_id
          WHERE member.id IS NULL OR member.organization_id <> $2
        )
    `, [
      cluster.id, cluster.organizationId, cluster.canonicalChunkId, cluster.memberChunkIds,
      cluster.title, cluster.summary, cluster.mergedAt, cluster.memberCount,
      cluster.averageSimilarity,
    ]);
    requireMutation(result.rowCount, 'create');
  }

  async findById(organizationId: string, clusterId: string): Promise<ChunkCluster | null> {
    const result = await query<ClusterRow>(
      'SELECT * FROM chunk_clusters WHERE organization_id = $1 AND id = $2',
      [organizationId, clusterId],
    );
    return result.rows[0] ? mapCluster(result.rows[0]) : null;
  }

  async findByMemberChunkId(organizationId: string, chunkId: string): Promise<ChunkCluster | null> {
    const result = await query<ClusterRow>(`
      SELECT * FROM chunk_clusters
      WHERE organization_id = $1 AND $2::uuid = ANY(member_chunk_ids)
      LIMIT 1
    `, [organizationId, chunkId]);
    return result.rows[0] ? mapCluster(result.rows[0]) : null;
  }

  async addMember(organizationId: string, clusterId: string, chunkId: string): Promise<void> {
    logger.debug({ organizationId, clusterId, chunkId }, 'Adding member to cluster');
    const result = await query(`
      UPDATE chunk_clusters clusters
      SET member_chunk_ids = CASE
            WHEN $3::uuid = ANY(member_chunk_ids) THEN member_chunk_ids
            ELSE array_append(member_chunk_ids, $3::uuid)
          END,
          member_count = CASE
            WHEN $3::uuid = ANY(member_chunk_ids) THEN member_count
            ELSE member_count + 1
          END
      WHERE clusters.organization_id = $1
        AND clusters.id = $2
        AND EXISTS (
          SELECT 1 FROM chunks member
          WHERE member.id = $3 AND member.organization_id = $1
        )
    `, [organizationId, clusterId, chunkId]);
    requireMutation(result.rowCount, 'member update');
  }

  async updateCanonical(
    organizationId: string,
    clusterId: string,
    newCanonicalId: string,
  ): Promise<void> {
    const result = await query(`
      UPDATE chunk_clusters clusters SET canonical_chunk_id = $3
      WHERE clusters.organization_id = $1 AND clusters.id = $2
        AND $3::uuid = ANY(clusters.member_chunk_ids)
        AND EXISTS (
          SELECT 1 FROM chunks canonical
          WHERE canonical.id = $3 AND canonical.organization_id = $1
        )
    `, [organizationId, clusterId, newCanonicalId]);
    requireMutation(result.rowCount, 'canonical update');
  }

  async updateMetadata(
    organizationId: string,
    clusterId: string,
    updates: Partial<Pick<ChunkCluster, 'title' | 'summary' | 'averageSimilarity'>>,
  ): Promise<void> {
    const result = await query(`
      UPDATE chunk_clusters SET
        title = COALESCE($3, title),
        summary = COALESCE($4, summary),
        average_similarity = COALESCE($5, average_similarity)
      WHERE organization_id = $1 AND id = $2
    `, [
      organizationId, clusterId, updates.title ?? null, updates.summary ?? null,
      updates.averageSimilarity ?? null,
    ]);
    requireMutation(result.rowCount, 'metadata update');
  }

  async findTopClusters(
    organizationId: string,
    options?: { limit?: number; minMembers?: number },
  ): Promise<ChunkCluster[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 500));
    const result = await query<ClusterRow>(`
      SELECT * FROM chunk_clusters
      WHERE organization_id = $1 AND member_count >= $2
      ORDER BY member_count DESC, average_similarity DESC
      LIMIT $3
    `, [organizationId, options?.minMembers ?? 3, limit]);
    return result.rows.map(mapCluster);
  }

  async findSimilarClusters(
    organizationId: string,
    clusterId: string,
    threshold: number = 0.85,
  ): Promise<Array<{ id: string; similarity: number }>> {
    const result = await query<{ id: string; similarity: number }>(`
      SELECT candidate_cluster.id,
             1 - (candidate_chunk.embedding <=> source_chunk.embedding) AS similarity
      FROM chunk_clusters source_cluster
      JOIN chunks source_chunk ON source_chunk.id = source_cluster.canonical_chunk_id
      JOIN chunk_clusters candidate_cluster
        ON candidate_cluster.organization_id = source_cluster.organization_id
       AND candidate_cluster.id <> source_cluster.id
      JOIN chunks candidate_chunk ON candidate_chunk.id = candidate_cluster.canonical_chunk_id
      WHERE source_cluster.organization_id = $1
        AND source_cluster.id = $2
        AND source_chunk.embedding IS NOT NULL
        AND candidate_chunk.embedding IS NOT NULL
        AND 1 - (candidate_chunk.embedding <=> source_chunk.embedding) >= $3
      ORDER BY candidate_chunk.embedding <=> source_chunk.embedding
    `, [organizationId, clusterId, threshold]);
    return result.rows.map(row => ({ id: row.id, similarity: Number(row.similarity) }));
  }

  async getStats(organizationId: string): Promise<{
    totalClusters: number;
    avgMembers: number;
    largestCluster: number;
    totalDeduplicated: number;
  }> {
    const result = await query<{
      total_clusters: string;
      avg_members: string | null;
      largest_cluster: number | null;
      total_deduplicated: string | null;
    }>(`
      SELECT COUNT(*)::text AS total_clusters,
             AVG(member_count)::text AS avg_members,
             MAX(member_count) AS largest_cluster,
             SUM(GREATEST(member_count - 1, 0))::text AS total_deduplicated
      FROM chunk_clusters WHERE organization_id = $1
    `, [organizationId]);
    const row = result.rows[0];
    return {
      totalClusters: Number(row?.total_clusters ?? 0),
      avgMembers: Number(row?.avg_members ?? 0),
      largestCluster: Number(row?.largest_cluster ?? 0),
      totalDeduplicated: Number(row?.total_deduplicated ?? 0),
    };
  }

  async removeMember(organizationId: string, clusterId: string, chunkId: string): Promise<void> {
    const result = await query(`
      UPDATE chunk_clusters
      SET member_chunk_ids = array_remove(member_chunk_ids, $3::uuid),
          member_count = CASE
            WHEN $3::uuid = ANY(member_chunk_ids) THEN GREATEST(member_count - 1, 0)
            ELSE member_count
          END
      WHERE organization_id = $1 AND id = $2 AND canonical_chunk_id <> $3::uuid
    `, [organizationId, clusterId, chunkId]);
    requireMutation(result.rowCount, 'member removal');
  }

  async delete(organizationId: string, clusterId: string): Promise<void> {
    const result = await query(
      'DELETE FROM chunk_clusters WHERE organization_id = $1 AND id = $2',
      [organizationId, clusterId],
    );
    requireMutation(result.rowCount, 'delete');
  }
}
