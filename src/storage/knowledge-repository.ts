/*
 * Knowledge Repository
 *
 * PostgreSQL persistence for structured knowledge records.
 */

import { type QueryResultRow } from 'pg';

import { type KnowledgeRecord, type KnowledgeType } from '../models/index.js';
import { createChildLogger } from '../utils/logger.js';
import { query } from './database.js';

const logger = createChildLogger({ module: 'knowledge-repository' });

type StructuredContent = Pick<
  KnowledgeRecord,
  'problemSolution' | 'architectureDecision' | 'bestPractice' | 'howTo'
>;

interface KnowledgeRow extends QueryResultRow {
  id: string;
  chunk_id: string;
  session_id: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  structured_content: StructuredContent;
  content: string | null;
  entities: KnowledgeRecord['entities'];
  code_references: KnowledgeRecord['codeReferences'];
  citations: KnowledgeRecord['citations'];
  repository: string | null;
  language: string;
  frameworks: string[];
  tags: string[];
  author_id: string;
  organization_id: string;
  team_id: string | null;
  endorsed_by: string[];
  quality_score: number;
  is_validated: boolean;
  validated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_validated_at: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function structuredContent(record: KnowledgeRecord): StructuredContent {
  return {
    ...(record.problemSolution ? { problemSolution: record.problemSolution } : {}),
    ...(record.architectureDecision ? { architectureDecision: record.architectureDecision } : {}),
    ...(record.bestPractice ? { bestPractice: record.bestPractice } : {}),
    ...(record.howTo ? { howTo: record.howTo } : {}),
  };
}

function mapKnowledge(row: KnowledgeRow): KnowledgeRecord {
  const structured = row.structured_content ?? {};
  return {
    id: row.id,
    chunkId: row.chunk_id,
    sessionId: row.session_id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    ...structured,
    ...(row.content ? { content: row.content } : {}),
    entities: row.entities ?? [],
    codeReferences: row.code_references ?? [],
    citations: row.citations ?? [],
    ...(row.repository ? { repository: row.repository } : {}),
    language: row.language,
    frameworks: row.frameworks ?? [],
    tags: row.tags ?? [],
    authorId: row.author_id,
    organizationId: row.organization_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    endorsedBy: row.endorsed_by ?? [],
    qualityScore: Number(row.quality_score),
    isValidated: row.is_validated,
    ...(row.validated_by ? { validatedBy: row.validated_by } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.last_validated_at ? { lastValidatedAt: iso(row.last_validated_at) } : {}),
  };
}

export class KnowledgeRepository {
  async create(record: KnowledgeRecord): Promise<void> {
    logger.debug({ knowledgeId: record.id, type: record.type, chunkId: record.chunkId }, 'Creating knowledge record');
    await query(`
      INSERT INTO knowledge_records (
        id, chunk_id, session_id, type, title, summary, structured_content, content,
        entities, code_references, citations, repository, language, frameworks, tags,
        author_id, organization_id, team_id, endorsed_by, quality_score, is_validated,
        validated_by, created_at, updated_at, last_validated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb,
        $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
        $23, $24, $25
      )
      ON CONFLICT (chunk_id) DO NOTHING
    `, [
      record.id, record.chunkId, record.sessionId, record.type, record.title, record.summary,
      JSON.stringify(structuredContent(record)), record.content ?? null,
      JSON.stringify(record.entities), JSON.stringify(record.codeReferences),
      JSON.stringify(record.citations), record.repository ?? null, record.language,
      record.frameworks, record.tags, record.authorId, record.organizationId,
      record.teamId ?? null, record.endorsedBy, record.qualityScore, record.isValidated,
      record.validatedBy ?? null, record.createdAt, record.updatedAt,
      record.lastValidatedAt ?? null,
    ]);
  }

  async findById(id: string): Promise<KnowledgeRecord | null> {
    const result = await query<KnowledgeRow>('SELECT * FROM knowledge_records WHERE id = $1', [id]);
    return result.rows[0] ? mapKnowledge(result.rows[0]) : null;
  }

  async findByChunkId(chunkId: string): Promise<KnowledgeRecord[]> {
    const result = await query<KnowledgeRow>(`
      SELECT * FROM knowledge_records WHERE chunk_id = $1 ORDER BY created_at ASC
    `, [chunkId]);
    return result.rows.map(mapKnowledge);
  }

  async findByType(
    organizationId: string,
    type: KnowledgeType,
    options?: { limit?: number; offset?: number; minQuality?: number },
  ): Promise<KnowledgeRecord[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 500));
    const offset = Math.max(0, options?.offset ?? 0);
    const result = await query<KnowledgeRow>(`
      SELECT * FROM knowledge_records
      WHERE organization_id = $1 AND type = $2 AND quality_score >= $3
      ORDER BY quality_score DESC, created_at DESC
      LIMIT $4 OFFSET $5
    `, [organizationId, type, options?.minQuality ?? 0.3, limit, offset]);
    return result.rows.map(mapKnowledge);
  }

  async searchByText(
    searchText: string,
    organizationId: string,
    options?: { types?: KnowledgeType[]; limit?: number },
  ): Promise<KnowledgeRecord[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 500));
    const result = await query<KnowledgeRow & { rank: number }>(`
      SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
      FROM knowledge_records
      WHERE organization_id = $2
        AND search_vector @@ plainto_tsquery('english', $1)
        AND ($3::text[] IS NULL OR type = ANY($3))
      ORDER BY rank DESC, quality_score DESC
      LIMIT $4
    `, [searchText, organizationId, options?.types?.length ? options.types : null, limit]);
    return result.rows.map(mapKnowledge);
  }

  async findByRepository(repository: string, organizationId: string): Promise<KnowledgeRecord[]> {
    const result = await query<KnowledgeRow>(`
      SELECT * FROM knowledge_records
      WHERE repository = $1 AND organization_id = $2
      ORDER BY quality_score DESC, created_at DESC
    `, [repository, organizationId]);
    return result.rows.map(mapKnowledge);
  }

  async updateQualityScore(id: string, qualityScore: number): Promise<void> {
    await query(`
      UPDATE knowledge_records SET quality_score = $1, updated_at = NOW() WHERE id = $2
    `, [qualityScore, id]);
  }

  async validate(id: string, validatedBy: string): Promise<void> {
    await query(`
      UPDATE knowledge_records
      SET is_validated = true, validated_by = $1, last_validated_at = NOW(), updated_at = NOW()
      WHERE id = $2
    `, [validatedBy, id]);
  }

  async addEndorsement(id: string, endorserId: string): Promise<void> {
    await query(`
      UPDATE knowledge_records
      SET endorsed_by = CASE
            WHEN $1 = ANY(endorsed_by) THEN endorsed_by
            ELSE array_append(endorsed_by, $1)
          END,
          updated_at = NOW()
      WHERE id = $2
    `, [endorserId, id]);
  }

  async findUnvalidatedOlderThan(days: number, organizationId: string): Promise<KnowledgeRecord[]> {
    const result = await query<KnowledgeRow>(`
      SELECT * FROM knowledge_records
      WHERE organization_id = $1
        AND is_validated = false
        AND created_at < NOW() - ($2 * INTERVAL '1 day')
      ORDER BY quality_score DESC
    `, [organizationId, days]);
    return result.rows.map(mapKnowledge);
  }

  async getStats(organizationId: string): Promise<{
    total: number;
    byType: Record<string, number>;
    validated: number;
    avgQuality: number;
  }> {
    const result = await query<{
      total: string;
      by_type: Record<string, number>;
      validated: string;
      avg_quality: string | null;
    }>(`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE is_validated)::text AS validated,
        AVG(quality_score)::text AS avg_quality,
        COALESCE((
          SELECT jsonb_object_agg(type, type_count)
          FROM (
            SELECT type, COUNT(*)::int AS type_count
            FROM knowledge_records
            WHERE organization_id = $1
            GROUP BY type
          ) counts
        ), '{}'::jsonb) AS by_type
      FROM knowledge_records
      WHERE organization_id = $1
    `, [organizationId]);
    const row = result.rows[0];
    return {
      total: Number(row?.total ?? 0),
      byType: row?.by_type ?? {},
      validated: Number(row?.validated ?? 0),
      avgQuality: Number(row?.avg_quality ?? 0),
    };
  }
}
