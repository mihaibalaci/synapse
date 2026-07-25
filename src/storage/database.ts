/**
 * Database Connection Manager
 *
 * Manages PostgreSQL connection pool with health checks,
 * graceful shutdown, and query instrumentation.
 * Uses pg library with pgvector extension support.
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger({ module: 'database' });

let pool: Pool | null = null;

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
export async function query<T = any>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now();
  const p = getPool();

  try {
    const result = await p.query<T>(text, params);
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
      confidence TEXT NOT NULL DEFAULT 'high',
      quality_score REAL NOT NULL DEFAULT 0.5,
      usage_count INTEGER NOT NULL DEFAULT 0,
      upvotes INTEGER NOT NULL DEFAULT 0,
      downvotes INTEGER NOT NULL DEFAULT 0,
      cluster_id UUID,
      is_canonical BOOLEAN NOT NULL DEFAULT false,
      embedding_model TEXT NOT NULL,
      embedding_version INTEGER NOT NULL DEFAULT 1,
      embedding vector(3072),
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
      canonical_chunk_id UUID NOT NULL REFERENCES chunks(id),
      member_chunk_ids UUID[] NOT NULL DEFAULT '{}',
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      member_count INTEGER NOT NULL DEFAULT 0,
      average_similarity REAL NOT NULL DEFAULT 0
    )
  `);

  // Feedback events table
  await query(`
    CREATE TABLE IF NOT EXISTS feedback_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      search_id UUID NOT NULL,
      result_id UUID NOT NULL,
      developer_id TEXT NOT NULL,
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
      embedding vector(3072),
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
      fact_ids UUID[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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
  await query(`CREATE INDEX IF NOT EXISTS idx_chunks_confidence ON chunks(confidence, quality_score)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_developer ON sessions(developer_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(organization_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_knowledge_org ON knowledge_records(organization_id)`);
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
