/**
 * Database Connection Manager
 *
 * Manages PostgreSQL connection pool with health checks,
 * graceful shutdown, and query instrumentation.
 * Uses pg library with pgvector extension support.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, PoolClient, QueryResult, type QueryResultRow } from 'pg';

import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'database' });

let pool: Pool | null = null;

export interface DatabaseSecurityContext {
  userId: string;
  organizationId: string;
  teamIds: string[];
  roles: string[];
  repositoryAccess: string[];
  isService?: boolean;
}

const securityContext = new AsyncLocalStorage<DatabaseSecurityContext>();

export function enterDatabaseContext(context: DatabaseSecurityContext): void {
  securityContext.enterWith(context);
}

export function runWithDatabaseContext<T>(
  context: DatabaseSecurityContext,
  fn: () => T,
): T {
  return securityContext.run(context, fn);
}

async function applySecurityContext(client: PoolClient): Promise<void> {
  const context = securityContext.getStore();
  if (!context) return;
  await client.query(
    `SELECT
       set_config('app.user_id', $1, true),
       set_config('app.organization_id', $2, true),
       set_config('app.team_ids', $3, true),
       set_config('app.roles', $4, true),
       set_config('app.repository_access', $5, true),
       set_config('app.is_service', $6, true)`,
    [
      context.userId,
      context.organizationId,
      JSON.stringify(context.teamIds),
      JSON.stringify(context.roles),
      JSON.stringify(context.repositoryAccess),
      context.isService ? 'true' : 'false',
    ],
  );
}

// ─── Connection Pool ─────────────────────────────────────────────────────────

export function getPool(): Pool {
  if (pool) return pool;

  const config = getConfig();

  pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 20,                    // Max connections in pool
    idleTimeoutMillis: 30000,   // Close idle connections after 30s
    connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s
    statement_timeout: 30000,    // Kill queries running longer than 30s
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database pool error');
  });

  pool.on('connect', (client) => {
    // Enable pgvector extension on each new connection
    client.query('SET search_path TO public').catch(() => {});
  });

  logger.info('Database pool created');
  return pool;
}

// ─── Query Helpers ───────────────────────────────────────────────────────────

/**
 * Execute a query with automatic instrumentation.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now();
  const p = getPool();
  const context = securityContext.getStore();

  try {
    let result: QueryResult<T>;
    if (!context) {
      result = await p.query<T>(text, params);
    } else {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await applySecurityContext(client);
        result = await client.query<T>(text, params);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    const duration = Date.now() - start;

    if (duration > 1000) {
      logger.warn({ duration, query: text.substring(0, 100) }, 'Slow query detected');
    }

    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error({ err: error, duration, query: text.substring(0, 100) }, 'Query failed');
    throw error;
  }
}

/**
 * Execute multiple queries in a transaction.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const client = await p.connect();

  try {
    await client.query('BEGIN');
    await applySecurityContext(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ─── Health Check ────────────────────────────────────────────────────────────

export async function checkDatabaseHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
  poolSize: number;
  idleCount: number;
  waitingCount: number;
}> {
  const start = Date.now();
  const p = getPool();

  try {
    await p.query('SELECT 1');
    return {
      healthy: true,
      latencyMs: Date.now() - start,
      poolSize: p.totalCount,
      idleCount: p.idleCount,
      waitingCount: p.waitingCount,
    };
  } catch {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      poolSize: p.totalCount,
      idleCount: p.idleCount,
      waitingCount: p.waitingCount,
    };
  }
}

// ─── Schema Initialization ───────────────────────────────────────────────────

/**
 * Initialize database schema (for development/testing).
 * In production, use proper migrations (node-pg-migrate).
 */
export async function initializeSchema(): Promise<void> {
  logger.info('Initializing database schema');

  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
  await query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

  // Sessions table
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      client_id UUID NOT NULL,
      developer_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      team_id TEXT,
      status TEXT NOT NULL DEFAULT 'uploaded',
      searchable_status TEXT NOT NULL DEFAULT 'pending' CHECK (searchable_status IN (
        'pending', 'processing', 'searchable', 'blocked', 'failed'
      )),
      enrichment_status TEXT NOT NULL DEFAULT 'pending' CHECK (enrichment_status IN (
        'pending', 'not_required', 'processing', 'complete', 'partial', 'failed'
      )),
      raw_storage_key TEXT NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}',
      git_context JSONB,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processing_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `);

  // Chunks table with pgvector
  await query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      session_id UUID NOT NULL REFERENCES sessions(id),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      type TEXT NOT NULL,
      entities JSONB NOT NULL DEFAULT '[]',
      code_references JSONB NOT NULL DEFAULT '[]',
      repository TEXT,
      branch TEXT,
      commit_sha TEXT,
      language TEXT NOT NULL DEFAULT 'unknown',
      languages TEXT[] NOT NULL DEFAULT '{}',
      frameworks TEXT[] NOT NULL DEFAULT '{}',
      author_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      team_id TEXT,
      acl JSONB NOT NULL DEFAULT '{}',
      searchable_status TEXT NOT NULL DEFAULT 'pending' CHECK (searchable_status IN (
        'pending', 'processing', 'searchable', 'blocked', 'failed'
      )),
      enrichment_status TEXT NOT NULL DEFAULT 'pending' CHECK (enrichment_status IN (
        'pending', 'not_required', 'processing', 'complete', 'partial', 'failed'
      )),
      confidence TEXT NOT NULL DEFAULT 'high',
      quality_score REAL NOT NULL DEFAULT 0.5,
      usage_count INTEGER NOT NULL DEFAULT 0,
      upvotes INTEGER NOT NULL DEFAULT 0,
      downvotes INTEGER NOT NULL DEFAULT 0,
      cluster_id UUID,
      is_canonical BOOLEAN NOT NULL DEFAULT false,
      embedding_model TEXT NOT NULL,
      embedding_version INTEGER NOT NULL DEFAULT 1,
      embedding vector(1536),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_accessed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      linked_version TEXT,
      last_validated_at TIMESTAMPTZ,
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
      ) STORED
    )
  `);

  // Knowledge records table
  await query(`
    CREATE TABLE IF NOT EXISTS knowledge_records (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      chunk_id UUID NOT NULL REFERENCES chunks(id),
      session_id UUID NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      structured_content JSONB NOT NULL DEFAULT '{}',
      content TEXT,
      entities JSONB NOT NULL DEFAULT '[]',
      code_references JSONB NOT NULL DEFAULT '[]',
      citations JSONB NOT NULL DEFAULT '[]',
      repository TEXT,
      language TEXT NOT NULL DEFAULT 'unknown',
      frameworks TEXT[] NOT NULL DEFAULT '{}',
      tags TEXT[] NOT NULL DEFAULT '{}',
      author_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      team_id TEXT,
      endorsed_by TEXT[] NOT NULL DEFAULT '{}',
      quality_score REAL NOT NULL DEFAULT 0.5,
      is_validated BOOLEAN NOT NULL DEFAULT false,
      validated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_validated_at TIMESTAMPTZ,
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B')
      ) STORED
    )
  `);

  // Chunk clusters table
  await query(`
    CREATE TABLE IF NOT EXISTS chunk_clusters (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      organization_id TEXT NOT NULL,
      canonical_chunk_id UUID NOT NULL REFERENCES chunks(id),
      member_chunk_ids UUID[] NOT NULL DEFAULT '{}',
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      member_count INTEGER NOT NULL DEFAULT 0,
      average_similarity REAL NOT NULL DEFAULT 0
    )
  `);
  await query(`ALTER TABLE chunk_clusters ADD COLUMN IF NOT EXISTS organization_id TEXT`);
  await query(`
    UPDATE chunk_clusters clusters
    SET organization_id = canonical.organization_id
    FROM chunks canonical
    WHERE canonical.id = clusters.canonical_chunk_id
      AND clusters.organization_id IS NULL
  `);
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM chunk_clusters clusters
        WHERE clusters.organization_id IS NULL
          OR clusters.canonical_chunk_id <> ALL(clusters.member_chunk_ids)
          OR EXISTS (
            SELECT 1 FROM unnest(clusters.member_chunk_ids) member_id
            LEFT JOIN chunks member ON member.id = member_id
            WHERE member.id IS NULL
              OR member.organization_id <> clusters.organization_id
          )
      ) THEN
        RAISE EXCEPTION 'chunk_clusters contains missing or cross-organization members';
      END IF;
    END $$
  `);
  await query(`ALTER TABLE chunk_clusters ALTER COLUMN organization_id SET NOT NULL`);
  await query(`
    CREATE OR REPLACE FUNCTION enforce_chunk_cluster_tenant()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.canonical_chunk_id <> ALL(NEW.member_chunk_ids)
        OR NOT EXISTS (
          SELECT 1 FROM chunks
          WHERE id = NEW.canonical_chunk_id AND organization_id = NEW.organization_id
        )
        OR EXISTS (
          SELECT 1 FROM unnest(NEW.member_chunk_ids) member_id
          LEFT JOIN chunks member ON member.id = member_id
          WHERE member.id IS NULL OR member.organization_id <> NEW.organization_id
        ) THEN
        RAISE EXCEPTION 'cluster chunks must belong to organization %', NEW.organization_id;
      END IF;
      NEW.member_count := cardinality(NEW.member_chunk_ids);
      RETURN NEW;
    END $$
  `);
  await query(`DROP TRIGGER IF EXISTS trg_chunk_clusters_tenant ON chunk_clusters`);
  await query(`
    CREATE TRIGGER trg_chunk_clusters_tenant
    BEFORE INSERT OR UPDATE ON chunk_clusters
    FOR EACH ROW EXECUTE FUNCTION enforce_chunk_cluster_tenant()
  `);

  // Feedback events table
  await query(`
    CREATE TABLE IF NOT EXISTS feedback_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      search_id UUID NOT NULL,
      result_id UUID NOT NULL,
      developer_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      action TEXT NOT NULL,
      comment TEXT,
      conversation_successful BOOLEAN,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Audit log
  await query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      metadata JSONB,
      ip_address TEXT,
      user_agent TEXT
    )
  `);

  // Memory facts table (v3 — atomic facts)
  await query(`
    CREATE TABLE IF NOT EXISTS memory_facts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      entities TEXT[] NOT NULL DEFAULT '{}',
      temporal_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      temporal_valid_from TIMESTAMPTZ,
      temporal_valid_until TIMESTAMPTZ,
      temporal_superseded_by UUID,
      temporal_supersedes UUID,
      temporal_source TEXT NOT NULL DEFAULT 'inferred',
      source_chunk_id UUID REFERENCES chunks(id),
      source_session_id UUID REFERENCES sessions(id),
      source_capture_id UUID,
      source_capture_sequence INTEGER,
      source_message_index INTEGER,
      extracted_from TEXT NOT NULL DEFAULT 'both',
      author_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      team_id TEXT,
      scope TEXT NOT NULL DEFAULT 'organization',
      confidence REAL NOT NULL DEFAULT 0.7,
      usage_count INTEGER NOT NULL DEFAULT 0,
      upvotes INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TIMESTAMPTZ,
      embedding vector(1536),
      embedding_model TEXT,
      repository TEXT,
      language TEXT,
      frameworks TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Capture events table (v3 — Pieces-inspired ambient capture)
  await query(`
    CREATE TABLE IF NOT EXISTS capture_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      capture_mode TEXT NOT NULL DEFAULT 'passive',
      developer_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration INTEGER,
      processed BOOLEAN NOT NULL DEFAULT false,
      processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN (
        'pending', 'processing', 'complete', 'blocked', 'failed'
      )),
      processing_attempts INTEGER NOT NULL DEFAULT 0,
      processing_started_at TIMESTAMPTZ,
      last_error TEXT,
      processed_at TIMESTAMPTZ,
      fact_ids UUID[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'memory_facts_source_capture_fk'
      ) THEN
        ALTER TABLE memory_facts
          ADD CONSTRAINT memory_facts_source_capture_fk
          FOREIGN KEY (source_capture_id) REFERENCES capture_events(id);
      END IF;
    END $$
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      aggregate_type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      organization_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      deduplication_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'publishing', 'published', 'failed'
      )),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS chunk_processing_status (
      chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('index', 'facts', 'knowledge', 'deduplicate', 'graph')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'processing', 'completed', 'blocked', 'failed'
      )),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chunk_id, action)
    )
  `);

  // Search membership is separate from chunk persistence so removing a search
  // document does not destroy source content.
  await query(`
    CREATE TABLE IF NOT EXISTS search_index_entries (
      chunk_id UUID PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      is_searchable BOOLEAN NOT NULL DEFAULT true,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Organization-scoped relational graph. Text IDs support repositories,
  // technologies, developers, and UUID-backed content nodes uniformly.
  await query(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      organization_id TEXT NOT NULL,
      node_type TEXT NOT NULL CHECK (node_type IN (
        'developer', 'team', 'repository', 'chunk', 'knowledge', 'technology',
        'file', 'concept', 'error', 'service'
      )),
      node_id TEXT NOT NULL,
      name TEXT NOT NULL,
      properties JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, node_type, node_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS graph_edges (
      organization_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      edge_type TEXT NOT NULL CHECK (edge_type IN (
        'authored', 'expert_in', 'member_of', 'works_on', 'related_to',
        'supersedes', 'depends_on', 'solves', 'references', 'uses',
        'integrates_with', 'alternative_to', 'belongs_to', 'fork_of',
        'causes', 'caused_by', 'enables', 'prevents'
      )),
      source_node_type TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_type TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      properties JSONB NOT NULL DEFAULT '{}',
      weight REAL NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, edge_id),
      UNIQUE (organization_id, edge_type, source_node_type, source_node_id,
              target_node_type, target_node_id),
      FOREIGN KEY (organization_id, source_node_type, source_node_id)
        REFERENCES graph_nodes(organization_id, node_type, node_id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, target_node_type, target_node_id)
        REFERENCES graph_nodes(organization_id, node_type, node_id) ON DELETE CASCADE
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS chunk_entities (
      chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chunk_id, entity_name, entity_type)
    )
  `);

  // Observations table (v3 — entity summaries / mental models)
  await query(`
    CREATE TABLE IF NOT EXISTS observations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      entity_name TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_fact_ids UUID[] NOT NULL DEFAULT '{}',
      source_fact_count INTEGER NOT NULL DEFAULT 0,
      embedding vector(1536),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, LOWER(entity_name))
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_observations_org_entity
      ON observations(organization_id, (LOWER(entity_name)))
  `);

  // Add security columns for databases initialized by an older release.
  await query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS acl JSONB NOT NULL DEFAULT '{}'`);
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS searchable_status TEXT NOT NULL DEFAULT 'pending'`);
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'pending'`);
  await query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS searchable_status TEXT NOT NULL DEFAULT 'pending'`);
  await query(`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'pending'`);
  await query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS source_capture_id UUID`);
  await query(`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS source_capture_sequence INTEGER`);
  await query(`ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'pending'`);
  await query(`ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ`);
  await query(`ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await query(`ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ`);
  await query(`ALTER TABLE feedback_events ADD COLUMN IF NOT EXISTS organization_id TEXT`);

  // Row-level security reads transaction-local settings populated by the API
  // authentication hook. Service workers must opt in with app.is_service=true.
  const tenantOnly = `
    current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), '')
  `;
  const userId = `NULLIF(current_setting('app.user_id', true), '')`;
  const roles = `COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb`;
  const teams = `COALESCE(NULLIF(current_setting('app.team_ids', true), ''), '[]')::jsonb`;
  const repositories = `COALESCE(NULLIF(current_setting('app.repository_access', true), ''), '[]')::jsonb`;

  const policies: Array<{ table: string; using: string; check: string }> = [
    {
      table: 'sessions',
      using: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND (developer_id = ${userId} OR ${roles} ? 'admin'
          OR (${roles} ? 'team_lead' AND team_id IS NOT NULL AND ${teams} ? team_id))
      )`,
      check: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND developer_id = ${userId}
      )`,
    },
    {
      table: 'chunks',
      using: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND (
          author_id = ${userId}
          OR ${roles} ? 'admin'
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(acl->'sharedWith', '[]'::jsonb)) grant_row
            WHERE grant_row->>'userId' = ${userId}
          )
          OR (
            COALESCE(acl->>'classification', 'public') IN ('public', 'internal')
            AND (team_id IS NULL OR ${teams} ? team_id)
            AND (repository IS NULL OR jsonb_array_length(${repositories}) = 0 OR ${repositories} ? repository)
          )
          OR (
            COALESCE(acl->>'classification', 'public') = 'confidential'
            AND ${roles} ? 'team_lead' AND team_id IS NOT NULL AND ${teams} ? team_id
          )
        )
      )`,
      check: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND author_id = ${userId}
      )`,
    },
    {
      table: 'knowledge_records',
      using: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND (author_id = ${userId} OR ${roles} ? 'admin'
          OR ((team_id IS NULL OR ${teams} ? team_id)
            AND (repository IS NULL OR jsonb_array_length(${repositories}) = 0 OR ${repositories} ? repository)))
      )`,
      check: tenantOnly,
    },
    {
      table: 'memory_facts',
      using: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND (author_id = ${userId} OR ${roles} ? 'admin' OR scope = 'organization'
          OR (scope = 'team' AND team_id IS NOT NULL AND ${teams} ? team_id))
      )`,
      check: tenantOnly,
    },
    {
      table: 'capture_events',
      using: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND (developer_id = ${userId} OR ${roles} ? 'admin')
      )`,
      check: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND developer_id = ${userId}
      )`,
    },
    {
      table: 'feedback_events',
      using: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND (developer_id = ${userId} OR ${roles} ? 'admin')
      )`,
      check: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND developer_id = ${userId}
      )`,
    },
    ...['chunk_clusters', 'search_index_entries', 'graph_nodes', 'graph_edges', 'chunk_entities', 'outbox_events'].map(table => ({
      table,
      using: tenantOnly,
      check: tenantOnly,
    })),
    {
      table: 'chunk_processing_status',
      using: `current_setting('app.is_service', true) = 'true'`,
      check: `current_setting('app.is_service', true) = 'true'`,
    },
    {
      table: 'audit_log',
      using: `current_setting('app.is_service', true) = 'true' OR (
        organization_id = NULLIF(current_setting('app.organization_id', true), '')
        AND (user_id = ${userId} OR ${roles} ? 'admin')
      )`,
      check: tenantOnly,
    },
  ];

  for (const policy of policies) {
    await query(`ALTER TABLE ${policy.table} ENABLE ROW LEVEL SECURITY`);
    await query(`ALTER TABLE ${policy.table} FORCE ROW LEVEL SECURITY`);
    await query(`DROP POLICY IF EXISTS synapse_tenant_acl ON ${policy.table}`);
    await query(`CREATE POLICY synapse_tenant_acl ON ${policy.table}
      USING (${policy.using}) WITH CHECK (${policy.check})`);
  }

  // Existing 3072/768-dimensional vectors cannot share an ANN index with the
  // canonical 1536-dimensional space. Clear only derived embeddings so source
  // content can be re-embedded deterministically by the reindexing worker.
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'chunks'::regclass
          AND attname = 'embedding'
          AND format_type(atttypid, atttypmod) <> 'vector(1536)'
      ) THEN
        DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
        ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1536)
          USING NULL::vector(1536);
      END IF;

      IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'memory_facts'::regclass
          AND attname = 'embedding'
          AND format_type(atttypid, atttypmod) <> 'vector(1536)'
      ) THEN
        DROP INDEX IF EXISTS idx_facts_embedding_hnsw;
        ALTER TABLE memory_facts ALTER COLUMN embedding TYPE vector(1536)
          USING NULL::vector(1536);
      END IF;
    END $$
  `);

  // ─── Indexes ─────────────────────────────────────────────────────────────

  // Vector similarity index (HNSW for fast ANN search)
  await query(`
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200)
  `);

  // Full-text search indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_search ON chunks USING gin(search_vector)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_knowledge_search ON knowledge_records USING gin(search_vector)`);

  // Filtering indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_org ON chunks(organization_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks(repository)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_cluster ON chunks(cluster_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunk_clusters_org ON chunk_clusters(organization_id, member_count DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_confidence ON chunks(confidence, quality_score)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_title_trgm ON chunks USING gin(title gin_trgm_ops)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_search_entries_org ON search_index_entries(organization_id, is_searchable)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_lookup ON graph_nodes(organization_id, node_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_name_trgm ON graph_nodes USING gin(name gin_trgm_ops)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(organization_id, source_node_type, source_node_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(organization_id, target_node_type, target_node_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(organization_id, edge_type)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunk_entities_org_name ON chunk_entities(organization_id, lower(entity_name))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_developer ON sessions(developer_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(organization_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_client_idempotency
    ON sessions(organization_id, developer_id, client_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_processing_status ON sessions(searchable_status, enrichment_status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_processing_status ON chunks(session_id, searchable_status, enrichment_status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, available_at, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_chunk_processing_status ON chunk_processing_status(status, updated_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_knowledge_org ON knowledge_records(organization_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunk ON knowledge_records(chunk_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_records(type)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_knowledge_repo ON knowledge_records(repository)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_feedback_result ON feedback_events(result_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_feedback_search ON feedback_events(search_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, timestamp DESC)`);

  // v3: Memory facts indexes
  await query(`
    CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw
    ON memory_facts USING hnsw (embedding vector_cosine_ops)
    WITH (m = 32, ef_construction = 256)
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_facts_org ON memory_facts(organization_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_facts_entities ON memory_facts USING gin(entities)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_facts_type ON memory_facts(type)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_facts_temporal ON memory_facts(organization_id, temporal_valid_until) WHERE temporal_valid_until IS NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_facts_source_chunk ON memory_facts(source_chunk_id)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_source_capture_sequence
    ON memory_facts(source_capture_id, source_capture_sequence)
    WHERE source_capture_id IS NOT NULL`);
  await query(`CREATE INDEX IF NOT EXISTS idx_facts_created ON memory_facts(organization_id, created_at DESC)`);

  // v3: Capture events indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_capture_developer ON capture_events(developer_id, timestamp DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_capture_unprocessed ON capture_events(organization_id) WHERE processed = false`);
  await query(`CREATE INDEX IF NOT EXISTS idx_capture_type ON capture_events(type, timestamp DESC)`);

  logger.info('Database schema initialized');
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}
