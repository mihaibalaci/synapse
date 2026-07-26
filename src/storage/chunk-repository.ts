/*
 * Chunk Repository
 *
 * PostgreSQL + pgvector persistence for processed chunks.
 * Handles both metadata storage and vector indexing.
 */

import { type PoolClient, type QueryResultRow } from 'pg';

import { type Chunk } from '../models/index.js';
import { type ChunkProcessingAction, type ChunkProcessingJob } from '../ingestion/queue.js';
import { createChildLogger } from '../utils/logger.js';
import { query, withTransaction } from './database.js';
import { insertOutboxEvent } from './outbox-repository.js';

const logger = createChildLogger({ module: 'chunk-repository' });

interface ChunkRow extends QueryResultRow {
  id: string;
  session_id: string;
  title: string;
  summary: string;
  content: string;
  token_count: number;
  type: Chunk['type'];
  entities: Chunk['entities'];
  code_references: Chunk['codeReferences'];
  repository: string | null;
  branch: string | null;
  commit_sha: string | null;
  language: string;
  languages: string[];
  frameworks: string[];
  author_id: string;
  organization_id: string;
  team_id: string | null;
  acl: Chunk['acl'];
  searchable_status: Chunk['searchableStatus'];
  enrichment_status: Chunk['enrichmentStatus'];
  confidence: Chunk['confidence'];
  quality_score: number;
  usage_count: number;
  upvotes: number;
  downvotes: number;
  cluster_id: string | null;
  is_canonical: boolean;
  embedding_model: string;
  embedding_version: number;
  embedding: string | number[] | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_accessed_at: Date | string | null;
  expires_at: Date | string | null;
  linked_version: string | null;
  last_validated_at: Date | string | null;
}

const INSERT_SQL = `
  INSERT INTO chunks (
    id, session_id, title, summary, content, token_count, type, entities,
    code_references, repository, branch, commit_sha, language, languages,
    frameworks, author_id, organization_id, team_id, acl, searchable_status,
    enrichment_status, confidence, quality_score, usage_count, upvotes,
    downvotes, cluster_id, is_canonical, embedding_model,
    embedding_version, embedding, created_at, updated_at, last_accessed_at,
    expires_at, linked_version, last_validated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12,
    $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21, $22, $23, $24,
    $25, $26, $27, $28, $29, $30, $31::vector, $32, $33, $34, $35, $36, $37
  )
  ON CONFLICT (id) DO NOTHING
`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeVector(vector?: number[]): string | null {
  if (!vector) return null;
  if (!vector.every(Number.isFinite)) throw new Error('Embedding contains a non-finite value');
  return `[${vector.join(',')}]`;
}

function parseVector(vector: string | number[] | null): number[] | undefined {
  if (vector == null) return undefined;
  if (Array.isArray(vector)) return vector.map(Number);
  const trimmed = vector.trim().replace(/^\[/, '').replace(/\]$/, '');
  return trimmed ? trimmed.split(',').map(Number) : [];
}

function insertParams(chunk: Chunk): unknown[] {
  const acl = chunk.acl ?? {
    ownerId: chunk.authorId,
    organizationId: chunk.organizationId,
    teamIds: chunk.teamId ? [chunk.teamId] : [],
    repositoryIds: chunk.repository ? [chunk.repository] : [],
    sharedWith: [],
    classification: chunk.teamId || chunk.repository ? 'internal' : 'public',
    discoverable: true,
    containsPII: false,
    containsSecrets: false,
    redacted: false,
  };
  return [
    chunk.id, chunk.sessionId, chunk.title, chunk.summary, chunk.content, chunk.tokenCount,
    chunk.type, JSON.stringify(chunk.entities), JSON.stringify(chunk.codeReferences),
    chunk.repository ?? null, chunk.branch ?? null, chunk.commitSha ?? null, chunk.language,
    chunk.languages, chunk.frameworks, chunk.authorId, chunk.organizationId, chunk.teamId ?? null,
    JSON.stringify(acl), chunk.searchableStatus ?? 'pending', chunk.enrichmentStatus ?? 'pending',
    chunk.confidence, chunk.qualityScore, chunk.usageCount, chunk.upvotes, chunk.downvotes,
    chunk.clusterId ?? null, chunk.isCanonical, chunk.embeddingModel, chunk.embeddingVersion,
    serializeVector(chunk.embedding), chunk.createdAt, chunk.updatedAt,
    chunk.lastAccessedAt ?? null, chunk.expiresAt ?? null, chunk.linkedVersion ?? null,
    chunk.lastValidatedAt ?? null,
  ];
}

function mapChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    tokenCount: row.token_count,
    type: row.type,
    entities: row.entities ?? [],
    codeReferences: row.code_references ?? [],
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
    language: row.language,
    languages: row.languages ?? [],
    frameworks: row.frameworks ?? [],
    authorId: row.author_id,
    organizationId: row.organization_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    ...(row.acl?.ownerId ? { acl: row.acl } : {}),
    searchableStatus: row.searchable_status,
    enrichmentStatus: row.enrichment_status,
    confidence: row.confidence,
    qualityScore: Number(row.quality_score),
    usageCount: row.usage_count,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    ...(row.cluster_id ? { clusterId: row.cluster_id } : {}),
    isCanonical: row.is_canonical,
    embeddingModel: row.embedding_model,
    embeddingVersion: row.embedding_version,
    ...(row.embedding != null ? { embedding: parseVector(row.embedding) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.last_accessed_at ? { lastAccessedAt: iso(row.last_accessed_at) } : {}),
    ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
    ...(row.linked_version ? { linkedVersion: row.linked_version } : {}),
    ...(row.last_validated_at ? { lastValidatedAt: iso(row.last_validated_at) } : {}),
  };
}

async function insertChunk(client: PoolClient, chunk: Chunk): Promise<boolean> {
  const result = await client.query(INSERT_SQL, insertParams(chunk));
  return (result.rowCount ?? 0) > 0;
}

export class ChunkRepository {
  async create(chunk: Chunk): Promise<void> {
    logger.debug({ chunkId: chunk.id, sessionId: chunk.sessionId }, 'Creating chunk');
    await query(INSERT_SQL, insertParams(chunk));
  }

  async createBatch(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    logger.info({ count: chunks.length }, 'Creating chunk batch');
    await withTransaction(async client => {
      for (const chunk of chunks) await insertChunk(client, chunk);
    });
  }

  async createBatchWithOutbox(
    chunks: Chunk[],
    options: { sessionId: string; searchableChunkIds: Set<string>; deep: boolean },
  ): Promise<boolean> {
    return withTransaction(async client => {
      let insertedAny = false;
      const enrichmentActions: ChunkProcessingAction[] = ['facts', 'knowledge', 'deduplicate', 'graph'];
      for (const chunk of chunks) {
        const searchable = options.searchableChunkIds.has(chunk.id);
        chunk.searchableStatus = searchable ? 'pending' : 'blocked';
        chunk.enrichmentStatus = searchable && options.deep ? 'pending' : 'not_required';
        insertedAny = await insertChunk(client, chunk) || insertedAny;
        if (!searchable) continue;

        const actions: ChunkProcessingAction[] = ['index', ...(options.deep ? enrichmentActions : [])];
        for (const action of actions) {
          const job: ChunkProcessingJob = { chunkId: chunk.id, sessionId: options.sessionId, action };
          await client.query(`
            INSERT INTO chunk_processing_status (chunk_id, action)
            VALUES ($1, $2) ON CONFLICT (chunk_id, action) DO NOTHING
          `, [chunk.id, action]);
          await insertOutboxEvent(client, {
            aggregateType: 'chunk',
            aggregateId: chunk.id,
            organizationId: chunk.organizationId,
            eventType: `chunk.${action}` as `chunk.${ChunkProcessingAction}`,
            payload: job as unknown as Record<string, unknown>,
            deduplicationKey: `chunk.${action}:${chunk.id}`,
          });
        }
      }

      if (insertedAny) {
        await client.query(`
          UPDATE sessions
          SET searchable_status = CASE
                WHEN $2::integer = 0 THEN 'blocked' ELSE 'pending' END,
              enrichment_status = CASE
                WHEN $3::boolean AND $2::integer > 0 THEN 'pending' ELSE 'not_required' END,
              updated_at = NOW()
          WHERE id = $1
        `, [options.sessionId, options.searchableChunkIds.size, options.deep]);
      }
      return insertedAny;
    });
  }

  async findById(chunkId: string): Promise<Chunk | null> {
    const result = await query<ChunkRow>('SELECT * FROM chunks WHERE id = $1', [chunkId]);
    return result.rows[0] ? mapChunk(result.rows[0]) : null;
  }

  async findBySessionId(sessionId: string): Promise<Chunk[]> {
    const result = await query<ChunkRow>(
      'SELECT * FROM chunks WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId],
    );
    return result.rows.map(mapChunk);
  }

  async searchByVector(
    embedding: number[],
    options: {
      limit?: number;
      organizationId: string;
      repositoryFilter?: string[];
      languageFilter?: string[];
      minQualityScore?: number;
    },
  ): Promise<Array<Chunk & { similarity: number }>> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    logger.debug({ limit, organizationId: options.organizationId }, 'Vector search');

    const result = await query<ChunkRow & { similarity: number }>(`
      SELECT chunks.*, 1 - (embedding <=> $1::vector) AS similarity
      FROM chunks
      WHERE organization_id = $2
        AND embedding IS NOT NULL
        AND ($3::text[] IS NULL OR repository = ANY($3))
        AND ($4::text[] IS NULL OR language = ANY($4))
        AND quality_score >= $5
      ORDER BY embedding <=> $1::vector
      LIMIT $6
    `, [
      serializeVector(embedding), options.organizationId,
      options.repositoryFilter?.length ? options.repositoryFilter : null,
      options.languageFilter?.length ? options.languageFilter : null,
      options.minQualityScore ?? 0, limit,
    ]);
    return result.rows.map(row => ({ ...mapChunk(row), similarity: Number(row.similarity) }));
  }

  async updateMetrics(
    chunkId: string,
    updates: Partial<Pick<Chunk, 'usageCount' | 'upvotes' | 'downvotes' | 'qualityScore'>>,
  ): Promise<void> {
    logger.debug({ chunkId, updates }, 'Updating chunk metrics');
    await query(`
      UPDATE chunks SET
        usage_count = GREATEST(usage_count + COALESCE($2, 0), 0),
        upvotes = GREATEST(upvotes + COALESCE($3, 0), 0),
        downvotes = GREATEST(downvotes + COALESCE($4, 0), 0),
        quality_score = LEAST(GREATEST(quality_score + COALESCE($5, 0), 0), 1),
        updated_at = NOW()
      WHERE id = $1
    `, [
      chunkId, updates.usageCount ?? null, updates.upvotes ?? null,
      updates.downvotes ?? null, updates.qualityScore ?? null,
    ]);
  }

  async assignToCluster(chunkId: string, clusterId: string, isCanonical: boolean): Promise<void> {
    await query(`
      UPDATE chunks SET cluster_id = $1, is_canonical = $2, updated_at = NOW() WHERE id = $3
    `, [clusterId, isCanonical, chunkId]);
  }

  async findDuplicateCandidates(
    embedding: number[],
    threshold: number = 0.95,
    organizationId: string,
  ): Promise<Array<{ id: string; similarity: number; title: string }>> {
    const result = await query<{ id: string; similarity: number; title: string }>(`
      SELECT id, title, 1 - (embedding <=> $1::vector) AS similarity
      FROM chunks
      WHERE organization_id = $2
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> $1::vector) > $3
      ORDER BY embedding <=> $1::vector
      LIMIT 20
    `, [serializeVector(embedding), organizationId, threshold]);
    return result.rows.map(row => ({ ...row, similarity: Number(row.similarity) }));
  }

  async findByRepository(
    repository: string,
    options?: { branch?: string; confidence?: string },
  ): Promise<Chunk[]> {
    const result = await query<ChunkRow>(`
      SELECT * FROM chunks
      WHERE repository = $1
        AND ($2::text IS NULL OR branch = $2)
        AND ($3::text IS NULL OR confidence = $3)
      ORDER BY created_at DESC
    `, [repository, options?.branch ?? null, options?.confidence ?? null]);
    return result.rows.map(mapChunk);
  }

  async bulkUpdateConfidence(
    updates: Array<{ id: string; confidence: 'high' | 'medium' | 'low' | 'archived' }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    logger.info({ count: updates.length }, 'Bulk updating confidence');
    await withTransaction(async client => {
      for (const update of updates) {
        await client.query(
          'UPDATE chunks SET confidence = $1, updated_at = NOW() WHERE id = $2',
          [update.confidence, update.id],
        );
      }
    });
  }
}
