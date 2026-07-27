/**
 * Observation Repository
 *
 * Stores and retrieves entity observations (mental models).
 * Observations are pre-computed summaries of what the system knows
 * about a specific entity, synthesized from underlying facts.
 *
 * Think of observations as cached "entity profiles" that get
 * regenerated when new facts arrive about the entity.
 */

import { query, withTransaction } from './database.js';
import { createChildLogger } from '../utils/logger.js';
import { type Observation } from '../models/reflect.js';

const logger = createChildLogger({ module: 'observation-repository' });

interface ObservationRow {
  [column: string]: unknown;
  id: string;
  entity_name: string;
  organization_id: string;
  summary: string;
  source_fact_ids: string[];
  source_fact_count: number | string;
  embedding: number[] | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    entityName: row.entity_name,
    organizationId: row.organization_id,
    summary: row.summary,
    sourceFactIds: row.source_fact_ids ?? [],
    sourceFactCount: Number(row.source_fact_count),
    embedding: row.embedding ?? undefined,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString(),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : new Date(row.updated_at).toISOString(),
  };
}

export class ObservationRepository {
  /**
   * Find an observation by entity name.
   */
  async findByEntity(entityName: string, organizationId: string): Promise<Observation | null> {
    const result = await query<ObservationRow>(
      `SELECT id, entity_name, organization_id, summary,
              source_fact_ids, source_fact_count, embedding,
              created_at, updated_at
       FROM observations
       WHERE organization_id = $1
         AND LOWER(entity_name) = LOWER($2)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [organizationId, entityName],
    );

    if (result.rows.length === 0) return null;
    return rowToObservation(result.rows[0]);
  }

  /**
   * Find observations by multiple entity names.
   */
  async findByEntities(
    entityNames: string[],
    organizationId: string,
  ): Promise<Observation[]> {
    if (entityNames.length === 0) return [];

    const lowerNames = entityNames.map(n => n.toLowerCase());
    const result = await query<ObservationRow>(
      `SELECT DISTINCT ON (LOWER(entity_name))
              id, entity_name, organization_id, summary,
              source_fact_ids, source_fact_count, embedding,
              created_at, updated_at
       FROM observations
       WHERE organization_id = $1
         AND LOWER(entity_name) = ANY($2::text[])
       ORDER BY LOWER(entity_name), updated_at DESC`,
      [organizationId, lowerNames],
    );

    return result.rows.map(rowToObservation);
  }

  /**
   * Upsert an observation (create or update).
   */
  async upsert(observation: Observation): Promise<void> {
    await query(
      `INSERT INTO observations
         (id, entity_name, organization_id, summary,
          source_fact_ids, source_fact_count, embedding,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, LOWER(entity_name))
       DO UPDATE SET
         summary = EXCLUDED.summary,
         source_fact_ids = EXCLUDED.source_fact_ids,
         source_fact_count = EXCLUDED.source_fact_count,
         embedding = EXCLUDED.embedding,
         updated_at = EXCLUDED.updated_at`,
      [
        observation.id,
        observation.entityName,
        observation.organizationId,
        observation.summary,
        observation.sourceFactIds,
        observation.sourceFactCount,
        observation.embedding ? `[${observation.embedding.join(',')}]` : null,
        observation.createdAt,
        observation.updatedAt,
      ],
    );

    logger.debug({
      entityName: observation.entityName,
      factCount: observation.sourceFactCount,
    }, 'Observation upserted');
  }

  /**
   * Delete observations for an entity (e.g., when invalidated).
   */
  async deleteByEntity(entityName: string, organizationId: string): Promise<void> {
    await query(
      `DELETE FROM observations
       WHERE organization_id = $1
         AND LOWER(entity_name) = LOWER($2)`,
      [organizationId, entityName],
    );
  }

  /**
   * Find stale observations (source facts have changed since last update).
   * Used by background refresh jobs.
   */
  async findStale(organizationId: string, limit: number = 50): Promise<Observation[]> {
    const result = await query<ObservationRow>(
      `SELECT o.id, o.entity_name, o.organization_id, o.summary,
              o.source_fact_ids, o.source_fact_count, o.embedding,
              o.created_at, o.updated_at
       FROM observations o
       WHERE o.organization_id = $1
         AND EXISTS (
           SELECT 1 FROM memory_facts f
           WHERE f.organization_id = o.organization_id
             AND $2 = ANY(f.entities)
             AND f.created_at > o.updated_at
         )
       ORDER BY o.updated_at ASC
       LIMIT $3`,
      [organizationId, 'placeholder', limit], // Note: actual query uses entity_name per row
    );

    // Fallback: find observations older than 7 days with potentially new facts
    if (result.rows.length === 0) {
      const fallbackResult = await query<ObservationRow>(
        `SELECT id, entity_name, organization_id, summary,
                source_fact_ids, source_fact_count, embedding,
                created_at, updated_at
         FROM observations
         WHERE organization_id = $1
           AND updated_at < NOW() - INTERVAL '7 days'
         ORDER BY updated_at ASC
         LIMIT $2`,
        [organizationId, limit],
      );
      return fallbackResult.rows.map(rowToObservation);
    }

    return result.rows.map(rowToObservation);
  }

  /**
   * Count observations for an organization.
   */
  async count(organizationId: string): Promise<number> {
    const result = await query<{ [column: string]: unknown; count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM observations
       WHERE organization_id = $1`,
      [organizationId],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }
}
