/*
 * Fact Repository
 *
 * PostgreSQL + pgvector persistence for atomic MemoryFacts.
 */

import { type PoolClient, type QueryResultRow } from 'pg';

import { type FactType, type MemoryFact, type TemporalQuery } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { query, withTransaction } from './database.js';

const logger = createChildLogger({ module: 'fact-repository' });

interface FactRow extends QueryResultRow {
  id: string;
  content: string;
  type: FactType;
  entities: string[];
  temporal_observed_at: Date | string;
  temporal_valid_from: Date | string | null;
  temporal_valid_until: Date | string | null;
  temporal_superseded_by: string | null;
  temporal_supersedes: string | null;
  temporal_source: MemoryFact['temporal']['temporalSource'];
  source_chunk_id: string | null;
  source_session_id: string | null;
  source_capture_id: string | null;
  source_capture_sequence: number | null;
  source_message_index: number | null;
  extracted_from: MemoryFact['extractedFrom'];
  author_id: string;
  organization_id: string;
  team_id: string | null;
  scope: MemoryFact['scope'];
  confidence: number;
  usage_count: number;
  upvotes: number;
  last_accessed_at: Date | string | null;
  /** Absent when a retrieval projection deliberately omits the vector. */
  embedding?: string | number[] | null;
  embedding_model: string | null;
  repository: string | null;
  language: string | null;
  frameworks: string[];
  created_at: Date | string;
  updated_at: Date | string;
}

const INSERT_SQL = `
  INSERT INTO memory_facts (
    id, content, type, entities, temporal_observed_at, temporal_valid_from,
    temporal_valid_until, temporal_superseded_by, temporal_supersedes,
    temporal_source, source_chunk_id, source_session_id, source_capture_id,
    source_capture_sequence, source_message_index, extracted_from, author_id,
    organization_id, team_id, scope, confidence, usage_count, upvotes,
    last_accessed_at, embedding, embedding_model, repository, language,
    frameworks, created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::vector, $26, $27,
    $28, $29, $30, $31
  )
  ON CONFLICT DO NOTHING
`;

/**
 * Retrieval projection that omits `embedding`. Fact vectors are only needed for
 * similarity search, which computes distance in SQL, so shipping and parsing
 * ~15KB per row into the API process is pure waste on the query path.
 */
const RETRIEVAL_COLUMNS = `
  id, content, type, entities, temporal_observed_at, temporal_valid_from,
  temporal_valid_until, temporal_superseded_by, temporal_supersedes,
  temporal_source, source_chunk_id, source_session_id, source_capture_id,
  source_capture_sequence, source_message_index, extracted_from, author_id,
  organization_id, team_id, scope, confidence, usage_count, upvotes,
  last_accessed_at, embedding_model, repository, language, frameworks,
  created_at, updated_at
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

function insertParams(fact: MemoryFact): unknown[] {
  return [
    fact.id, fact.content, fact.type, fact.entities, fact.temporal.observedAt,
    fact.temporal.validFrom ?? null, fact.temporal.validUntil ?? null,
    fact.temporal.supersededBy ?? null, fact.temporal.supersedes ?? null,
    fact.temporal.temporalSource, fact.sourceChunkId ?? null, fact.sourceSessionId ?? null,
    fact.sourceCaptureId ?? null, fact.sourceCaptureSequence ?? null,
    fact.sourceMessageIndex ?? null, fact.extractedFrom,
    fact.authorId, fact.organizationId, fact.teamId ?? null, fact.scope, fact.confidence,
    fact.usageCount, fact.upvotes, fact.lastAccessedAt ?? null,
    serializeVector(fact.embedding), fact.embeddingModel ?? null,
    fact.repository ?? null, fact.language ?? null, fact.frameworks,
    fact.createdAt, fact.updatedAt,
  ];
}

function mapFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    entities: row.entities ?? [],
    temporal: {
      observedAt: iso(row.temporal_observed_at),
      ...(row.temporal_valid_from ? { validFrom: iso(row.temporal_valid_from) } : {}),
      ...(row.temporal_valid_until ? { validUntil: iso(row.temporal_valid_until) } : {}),
      ...(row.temporal_superseded_by ? { supersededBy: row.temporal_superseded_by } : {}),
      ...(row.temporal_supersedes ? { supersedes: row.temporal_supersedes } : {}),
      temporalSource: row.temporal_source,
    },
    ...(row.source_chunk_id ? { sourceChunkId: row.source_chunk_id } : {}),
    ...(row.source_session_id ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.source_capture_id ? { sourceCaptureId: row.source_capture_id } : {}),
    ...(row.source_capture_sequence != null ? { sourceCaptureSequence: row.source_capture_sequence } : {}),
    ...(row.source_message_index != null ? { sourceMessageIndex: row.source_message_index } : {}),
    extractedFrom: row.extracted_from,
    authorId: row.author_id,
    organizationId: row.organization_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    scope: row.scope,
    confidence: Number(row.confidence),
    usageCount: row.usage_count,
    upvotes: row.upvotes,
    ...(row.last_accessed_at ? { lastAccessedAt: iso(row.last_accessed_at) } : {}),
    ...(row.embedding != null ? { embedding: parseVector(row.embedding) } : {}),
    ...(row.embedding_model ? { embeddingModel: row.embedding_model } : {}),
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.language ? { language: row.language } : {}),
    frameworks: row.frameworks ?? [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function insertFact(client: PoolClient, fact: MemoryFact): Promise<void> {
  await client.query(INSERT_SQL, insertParams(fact));
}

export class FactRepository {
  async create(fact: MemoryFact): Promise<void> {
    logger.debug({ factId: fact.id, type: fact.type }, 'Creating fact');
    await query(INSERT_SQL, insertParams(fact));
  }

  async createBatch(facts: MemoryFact[]): Promise<void> {
    if (facts.length === 0) return;
    logger.info({ count: facts.length }, 'Creating fact batch');
    await withTransaction(async client => {
      for (const fact of facts) await insertFact(client, fact);
    });
  }

  async createForCaptureAndMarkProcessed(captureId: string, facts: MemoryFact[]): Promise<void> {
    await withTransaction(async client => {
      for (const fact of facts) await insertFact(client, fact);
      await client.query(`
        UPDATE capture_events
        SET processed = true, processing_status = 'complete', fact_ids = $2,
            processed_at = NOW(), last_error = NULL
        WHERE id = $1
      `, [captureId, facts.map(fact => fact.id)]);
    });
  }

  async findById(id: string): Promise<MemoryFact | null> {
    const result = await query<FactRow>('SELECT * FROM memory_facts WHERE id = $1', [id]);
    return result.rows[0] ? mapFact(result.rows[0]) : null;
  }

  async findByChunkId(chunkId: string): Promise<MemoryFact[]> {
    const result = await query<FactRow>(`
      SELECT * FROM memory_facts WHERE source_chunk_id = $1 ORDER BY created_at ASC
    `, [chunkId]);
    return result.rows.map(mapFact);
  }

  async findSimilar(
    embedding: number[],
    organizationId: string,
    threshold: number = 0.85,
    limit: number = 10,
  ): Promise<Array<MemoryFact & { similarity: number }>> {
    const result = await query<FactRow & { similarity: number }>(`
      SELECT memory_facts.*, 1 - (embedding <=> $1::vector) AS similarity
      FROM memory_facts
      WHERE organization_id = $2
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> $1::vector) > $3
      ORDER BY embedding <=> $1::vector
      LIMIT $4
    `, [serializeVector(embedding), organizationId, threshold, Math.max(1, Math.min(limit, 500))]);
    return result.rows.map(row => ({ ...mapFact(row), similarity: Number(row.similarity) }));
  }

  async findByEntities(
    entities: string[],
    organizationId: string,
    options?: { limit?: number; onlyValid?: boolean },
  ): Promise<MemoryFact[]> {
    if (entities.length === 0) return [];
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 500));
    const onlyValid = options?.onlyValid ?? true;
    const result = await query<FactRow>(`
      SELECT ${RETRIEVAL_COLUMNS}
      FROM memory_facts
      WHERE organization_id = $1
        AND entities && $2::text[]
        AND ($3::boolean = false OR temporal_valid_until IS NULL)
      ORDER BY cardinality(ARRAY(SELECT unnest(entities) INTERSECT SELECT unnest($2::text[]))) DESC,
               confidence DESC,
               created_at DESC
      LIMIT $4
    `, [organizationId, entities, onlyValid, limit]);
    return result.rows.map(mapFact);
  }

  async findByTemporal(
    organizationId: string,
    temporal: TemporalQuery,
    options?: { entities?: string[]; types?: FactType[]; limit?: number },
  ): Promise<MemoryFact[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 500));
    const requireValid = temporal.onlyCurrentlyValid || temporal.includeSuperseded === false;
    const result = await query<FactRow>(`
      SELECT ${RETRIEVAL_COLUMNS}
      FROM memory_facts
      WHERE organization_id = $1
        AND ($2::timestamptz IS NULL OR created_at >= $2)
        AND ($3::timestamptz IS NULL OR created_at <= $3)
        AND ($4::boolean = false OR temporal_valid_until IS NULL)
        AND ($5::text[] IS NULL OR entities && $5)
        AND ($6::text[] IS NULL OR type = ANY($6))
      ORDER BY created_at DESC
      LIMIT $7
    `, [
      organizationId, temporal.from ?? null, temporal.to ?? null, requireValid,
      options?.entities?.length ? options.entities : null,
      options?.types?.length ? options.types : null, limit,
    ]);
    return result.rows.map(mapFact);
  }

  async markSuperseded(oldFactId: string, newFactId: string): Promise<void> {
    await withTransaction(async client => {
      await client.query(`
        UPDATE memory_facts
        SET temporal_valid_until = NOW(), temporal_superseded_by = $2, updated_at = NOW()
        WHERE id = $1
      `, [oldFactId, newFactId]);
      await client.query(`
        UPDATE memory_facts
        SET temporal_supersedes = $1, updated_at = NOW()
        WHERE id = $2
      `, [oldFactId, newFactId]);
    });
  }

  async getEntityHistory(
    entity: string,
    organizationId: string,
    limit: number = 50,
  ): Promise<MemoryFact[]> {
    const result = await query<FactRow>(`
      SELECT * FROM memory_facts
      WHERE organization_id = $1 AND $2 = ANY(entities)
      ORDER BY temporal_valid_from ASC NULLS FIRST, created_at ASC
      LIMIT $3
    `, [organizationId, entity, Math.max(1, Math.min(limit, 500))]);
    return result.rows.map(mapFact);
  }

  async incrementUsage(factId: string): Promise<void> {
    await query(`
      UPDATE memory_facts
      SET usage_count = usage_count + 1, last_accessed_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [factId]);
  }

  async upvote(factId: string): Promise<void> {
    await query('UPDATE memory_facts SET upvotes = upvotes + 1, updated_at = NOW() WHERE id = $1', [factId]);
  }

  async getStats(organizationId: string): Promise<{
    total: number;
    byType: Record<string, number>;
    validCount: number;
    supersededCount: number;
    avgConfidence: number;
  }> {
    const result = await query<{
      total: string;
      by_type: Record<string, number>;
      valid_count: string;
      superseded_count: string;
      avg_confidence: string | null;
    }>(`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE temporal_valid_until IS NULL)::text AS valid_count,
        COUNT(*) FILTER (WHERE temporal_valid_until IS NOT NULL)::text AS superseded_count,
        AVG(confidence)::text AS avg_confidence,
        COALESCE((
          SELECT jsonb_object_agg(type, type_count)
          FROM (
            SELECT type, COUNT(*)::int AS type_count
            FROM memory_facts
            WHERE organization_id = $1
            GROUP BY type
          ) counts
        ), '{}'::jsonb) AS by_type
      FROM memory_facts
      WHERE organization_id = $1
    `, [organizationId]);
    const row = result.rows[0];
    return {
      total: Number(row?.total ?? 0),
      byType: row?.by_type ?? {},
      validCount: Number(row?.valid_count ?? 0),
      supersededCount: Number(row?.superseded_count ?? 0),
      avgConfidence: Number(row?.avg_confidence ?? 0),
    };
  }
}
