-- Recall — Database Initialization
-- This script runs once when the PostgreSQL container is first created.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Sessions table
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
);

-- Chunks table with pgvector embedding
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
);

-- Knowledge records table
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
);

-- Chunk clusters (deduplication)
CREATE TABLE IF NOT EXISTS chunk_clusters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  canonical_chunk_id UUID NOT NULL REFERENCES chunks(id),
  member_chunk_ids UUID[] NOT NULL DEFAULT '{}',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  member_count INTEGER NOT NULL DEFAULT 0,
  average_similarity REAL NOT NULL DEFAULT 0
);

-- Feedback events
CREATE TABLE IF NOT EXISTS feedback_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  search_id UUID NOT NULL,
  result_id UUID NOT NULL,
  developer_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  conversation_successful BOOLEAN,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log
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
);

-- ═══════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════

-- Vector similarity index (HNSW for fast ANN search)
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Full-text search indexes
CREATE INDEX IF NOT EXISTS idx_chunks_search ON chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_knowledge_search ON knowledge_records USING gin(search_vector);

-- Filtering indexes
CREATE INDEX IF NOT EXISTS idx_chunks_org ON chunks(organization_id);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks(repository);
CREATE INDEX IF NOT EXISTS idx_chunks_cluster ON chunks(cluster_id);
CREATE INDEX IF NOT EXISTS idx_chunks_confidence ON chunks(confidence, quality_score);
CREATE INDEX IF NOT EXISTS idx_chunks_author ON chunks(author_id);
CREATE INDEX IF NOT EXISTS idx_sessions_developer ON sessions(developer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_org ON knowledge_records(organization_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_records(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_repo ON knowledge_records(repository);
CREATE INDEX IF NOT EXISTS idx_feedback_result ON feedback_events(result_id);
CREATE INDEX IF NOT EXISTS idx_feedback_search ON feedback_events(search_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(organization_id, timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED DATA (for local development)
-- ═══════════════════════════════════════════════════════════════════════════

-- No seed data — the system populates via session uploads.
-- Use `npm run seed` for development test data.
