CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY,
    client_id text NOT NULL,
    developer_id text NOT NULL,
    organization_id text NOT NULL,
    team_id text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'processing',
    searchable_status text NOT NULL DEFAULT 'pending',
    enrichment_status text NOT NULL DEFAULT 'pending',
    raw_storage_key text NOT NULL,
    total_tokens integer NOT NULL DEFAULT 0,
    message_count integer NOT NULL DEFAULT 0,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, developer_id, client_id)
);
CREATE INDEX IF NOT EXISTS sessions_org_updated_idx ON sessions (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_recovery_idx ON sessions (updated_at)
    WHERE searchable_status <> 'searchable' AND status <> 'failed';

CREATE TABLE IF NOT EXISTS chunks (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    content text NOT NULL,
    token_count integer NOT NULL DEFAULT 0,
    type text NOT NULL DEFAULT 'discussion',
    repository text NOT NULL DEFAULT '',
    language text NOT NULL DEFAULT '',
    frameworks text[] NOT NULL DEFAULT '{}',
    author_id text NOT NULL,
    organization_id text NOT NULL,
    embedding vector(768),
    embedding_model text NOT NULL DEFAULT '',
    embedding_version integer NOT NULL DEFAULT 1,
    searchable_status text NOT NULL DEFAULT 'pending',
    confidence text NOT NULL DEFAULT 'high',
    quality_score double precision NOT NULL DEFAULT 0.5,
    usage_count integer NOT NULL DEFAULT 0,
    last_accessed_at timestamptz,
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
    ) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_org_status_idx ON chunks (organization_id, searchable_status);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks (session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_search ON chunks USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON chunks
    USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_facts (
    id uuid PRIMARY KEY,
    content text NOT NULL,
    type text NOT NULL,
    entities text[] NOT NULL DEFAULT '{}',
    temporal_observed_at timestamptz NOT NULL DEFAULT now(),
    temporal_valid_from timestamptz,
    temporal_valid_until timestamptz,
    temporal_superseded_by uuid REFERENCES memory_facts(id),
    source_chunk_id uuid REFERENCES chunks(id) ON DELETE CASCADE,
    source_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
    extracted_from text NOT NULL DEFAULT 'heuristic',
    author_id text NOT NULL,
    organization_id text NOT NULL,
    scope text NOT NULL DEFAULT 'organization',
    confidence double precision NOT NULL DEFAULT 0.7,
    usage_count integer NOT NULL DEFAULT 0,
    last_accessed_at timestamptz,
    embedding vector(768),
    embedding_model text NOT NULL DEFAULT '',
    repository text NOT NULL DEFAULT '',
    language text NOT NULL DEFAULT '',
    frameworks text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_facts_created ON memory_facts (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_entities ON memory_facts USING gin (entities);
CREATE INDEX IF NOT EXISTS memory_facts_source_session_idx ON memory_facts (source_session_id);
CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw ON memory_facts
    USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS search_index_entries (
    chunk_id uuid PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    organization_id text NOT NULL,
    is_searchable boolean NOT NULL DEFAULT false,
    indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_entries_org
    ON search_index_entries (organization_id, is_searchable);
