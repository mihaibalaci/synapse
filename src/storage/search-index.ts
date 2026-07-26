/**
 * PostgreSQL full-text search adapter.
 *
 * Chunk text remains authoritative in the chunks table. search_index_entries
 * tracks whether a persisted chunk is currently exposed to retrieval so index
 * deletion never deletes source content.
 */

import { query, withTransaction } from './database.js';
import { createChildLogger } from '../utils/logger.js';
import { type Chunk } from '../models/index.js';

const logger = createChildLogger({ module: 'search-index' });

interface SearchRow {
  [column: string]: unknown;
  id: string;
  score: number | string;
  title_highlight: string | null;
  summary_highlight: string | null;
  content_highlight: string | null;
}

interface SuggestionRow {
  [column: string]: unknown;
  title: string;
}

export class SearchIndex {
  /** Ensure PostgreSQL search membership and supporting indexes exist. */
  async initialize(): Promise<void> {
    await query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
    await query(`
      CREATE TABLE IF NOT EXISTS search_index_entries (
        chunk_id UUID PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL,
        is_searchable BOOLEAN NOT NULL DEFAULT true,
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_search_entries_org
      ON search_index_entries(organization_id, is_searchable)
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_chunks_title_trgm ON chunks USING gin(title gin_trgm_ops)`);
    logger.info('PostgreSQL full-text search initialized');
  }

  /** Expose an already-persisted chunk through the PostgreSQL search index. */
  async indexChunk(chunk: Chunk): Promise<void> {
    const result = await query(
      `INSERT INTO search_index_entries (chunk_id, organization_id, is_searchable, indexed_at)
       SELECT id, organization_id, true, NOW()
       FROM chunks
       WHERE id = $1 AND organization_id = $2
       ON CONFLICT (chunk_id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         is_searchable = true,
         indexed_at = NOW()`,
      [chunk.id, chunk.organizationId],
    );

    if (result.rowCount !== 1) {
      throw new Error(`Cannot index missing chunk ${chunk.id}`);
    }
  }

  /** Ranked PostgreSQL FTS with trigram fallback and parameterized filters. */
  async search(params: {
    query: string;
    organizationId: string;
    filters?: {
      repositories?: string[];
      languages?: string[];
      types?: string[];
      minQualityScore?: number;
    };
    limit?: number;
    offset?: number;
  }): Promise<Array<{ id: string; score: number; highlights: Record<string, string[]> }>> {
    const {
      query: searchText,
      organizationId,
      filters,
      limit = 50,
      offset = 0,
    } = params;

    if (!searchText.trim()) return [];

    const values: unknown[] = [searchText, organizationId];
    const predicates = [
      's.organization_id = $2',
      's.is_searchable = true',
      `(c.search_vector @@ q.value
        OR c.title % $1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(c.entities) AS entity
          WHERE entity->>'name' ILIKE '%' || $1 || '%'
        ))`,
    ];

    const addArrayFilter = (sql: string, value?: string[]): void => {
      if (!value?.length) return;
      values.push(value);
      const parameter = `$${values.length}`;
      predicates.push(sql.split('?').join(parameter));
    };

    addArrayFilter('c.repository = ANY(?::text[])', filters?.repositories);
    addArrayFilter('(c.language = ANY(?::text[]) OR c.languages && ?::text[])', filters?.languages);
    addArrayFilter('c.type = ANY(?::text[])', filters?.types);

    if (filters?.minQualityScore !== undefined) {
      values.push(filters.minQualityScore);
      predicates.push(`c.quality_score >= $${values.length}`);
    }

    values.push(Math.max(1, Math.min(limit, 100)));
    const limitParameter = `$${values.length}`;
    values.push(Math.max(0, offset));
    const offsetParameter = `$${values.length}`;

    try {
      const result = await query<SearchRow>(
        `WITH q AS (
           SELECT websearch_to_tsquery('english', $1) AS value
         )
         SELECT
           c.id::text,
           (ts_rank_cd(c.search_vector, q.value, 32)
             + similarity(c.title, $1) * 0.15
             + CASE WHEN EXISTS (
                 SELECT 1 FROM jsonb_array_elements(c.entities) AS entity
                 WHERE entity->>'name' ILIKE '%' || $1 || '%'
               ) THEN 0.2 ELSE 0 END) AS score,
           CASE WHEN to_tsvector('english', c.title) @@ q.value
             THEN ts_headline('english', c.title, q.value,
               'StartSel=<mark>, StopSel=</mark>, MaxFragments=1') END AS title_highlight,
           CASE WHEN to_tsvector('english', c.summary) @@ q.value
             THEN ts_headline('english', c.summary, q.value,
               'StartSel=<mark>, StopSel=</mark>, MaxFragments=2') END AS summary_highlight,
           CASE WHEN to_tsvector('english', c.content) @@ q.value
             THEN ts_headline('english', c.content, q.value,
               'StartSel=<mark>, StopSel=</mark>, MaxFragments=3, MaxWords=35, MinWords=10') END AS content_highlight
         FROM chunks c
         JOIN search_index_entries s ON s.chunk_id = c.id
         CROSS JOIN q
         WHERE ${predicates.join('\n           AND ')}
         ORDER BY score DESC, c.updated_at DESC
         LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
        values,
      );

      return result.rows.map(row => {
        const highlights: Record<string, string[]> = {};
        if (row.title_highlight) highlights.title = [row.title_highlight];
        if (row.summary_highlight) highlights.summary = [row.summary_highlight];
        if (row.content_highlight) highlights.content = [row.content_highlight];
        return { id: row.id, score: Number(row.score), highlights };
      });
    } catch (error) {
      logger.error({ err: error, query: searchText }, 'PostgreSQL full-text query failed');
      return [];
    }
  }

  /** Add multiple persisted chunks to the index in one transaction. */
  async bulkIndex(chunks: Chunk[]): Promise<{ indexed: number; errors: number }> {
    if (chunks.length === 0) return { indexed: 0, errors: 0 };

    const uniqueChunks = [...new Map(chunks.map(chunk => [chunk.id, chunk])).values()];
    try {
      const indexed = await withTransaction(async client => {
        let count = 0;
        for (const chunk of uniqueChunks) {
          const result = await client.query(
            `INSERT INTO search_index_entries (chunk_id, organization_id, is_searchable, indexed_at)
             SELECT id, organization_id, true, NOW()
             FROM chunks
             WHERE id = $1 AND organization_id = $2
             ON CONFLICT (chunk_id) DO UPDATE SET
               organization_id = EXCLUDED.organization_id,
               is_searchable = true,
               indexed_at = NOW()`,
            [chunk.id, chunk.organizationId],
          );
          count += result.rowCount ?? 0;
        }
        return count;
      });
      return { indexed, errors: chunks.length - indexed };
    } catch (error) {
      logger.error({ err: error, count: chunks.length }, 'Bulk PostgreSQL indexing failed');
      return { indexed: 0, errors: chunks.length };
    }
  }

  /** Hide a chunk from search without deleting the persisted chunk. */
  async deleteChunk(chunkId: string): Promise<void> {
    await query(
      `UPDATE search_index_entries
       SET is_searchable = false, indexed_at = NOW()
       WHERE chunk_id = $1`,
      [chunkId],
    );
  }

  /** Prefix/trigram title suggestions scoped to one organization. */
  async suggest(prefix: string, organizationId: string, limit: number = 5): Promise<string[]> {
    if (!prefix.trim()) return [];

    try {
      const result = await query<SuggestionRow>(
        `SELECT DISTINCT c.title
         FROM chunks c
         JOIN search_index_entries s ON s.chunk_id = c.id
         WHERE s.organization_id = $2
           AND s.is_searchable = true
           AND (c.title ILIKE $1 || '%' OR c.title % $1)
         ORDER BY c.title
         LIMIT $3`,
        [prefix, organizationId, Math.max(1, Math.min(limit, 20))],
      );
      return result.rows.map(row => row.title);
    } catch (error) {
      logger.warn({ err: error, prefix }, 'PostgreSQL suggestion query failed');
      return [];
    }
  }
}

export async function checkSearchHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const result = await query<{ [column: string]: unknown; ready: boolean }>(
      `SELECT to_regclass('public.search_index_entries') IS NOT NULL AS ready`,
    );
    return { healthy: result.rows[0]?.ready === true, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  }
}
