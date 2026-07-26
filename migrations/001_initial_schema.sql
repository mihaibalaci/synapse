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
  organization_id TEXT NOT NULL,
  canonical_chunk_id UUID NOT NULL REFERENCES chunks(id),
  member_chunk_ids UUID[] NOT NULL DEFAULT '{}',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  member_count INTEGER NOT NULL DEFAULT 0,
  average_similarity REAL NOT NULL DEFAULT 0
);

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
END $$;

CREATE TRIGGER trg_chunk_clusters_tenant
  BEFORE INSERT OR UPDATE ON chunk_clusters
  FOR EACH ROW EXECUTE FUNCTION enforce_chunk_cluster_tenant();

-- Feedback events
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

-- Atomic memory facts.
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
);

-- Ambient capture events.
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
);

ALTER TABLE memory_facts
  ADD CONSTRAINT memory_facts_source_capture_fk
  FOREIGN KEY (source_capture_id) REFERENCES capture_events(id);

-- Transactional outbox: database state and queue intent commit together.
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
);

-- Durable expected/completed state for every asynchronous chunk action.
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
);

-- Search membership is separate from chunk persistence.
CREATE TABLE IF NOT EXISTS search_index_entries (
  chunk_id UUID PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  is_searchable BOOLEAN NOT NULL DEFAULT true,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organization-scoped relational knowledge graph.
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
);

CREATE TABLE IF NOT EXISTS graph_edges (
  organization_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  edge_type TEXT NOT NULL CHECK (edge_type IN (
    'authored', 'expert_in', 'member_of', 'works_on', 'related_to',
    'supersedes', 'depends_on', 'solves', 'references', 'uses',
    'integrates_with', 'alternative_to', 'belongs_to', 'fork_of'
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
);

CREATE TABLE IF NOT EXISTS chunk_entities (
  chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chunk_id, entity_name, entity_type)
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
CREATE INDEX IF NOT EXISTS idx_chunk_clusters_org
  ON chunk_clusters(organization_id, member_count DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_confidence ON chunks(confidence, quality_score);
CREATE INDEX IF NOT EXISTS idx_chunks_author ON chunks(author_id);
CREATE INDEX IF NOT EXISTS idx_search_entries_org ON search_index_entries(organization_id, is_searchable);
CREATE INDEX IF NOT EXISTS idx_chunks_title_trgm ON chunks USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_lookup ON graph_nodes(organization_id, node_id);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_name_trgm ON graph_nodes USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(organization_id, source_node_type, source_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(organization_id, target_node_type, target_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(organization_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_chunk_entities_org_name ON chunk_entities(organization_id, lower(entity_name));
CREATE INDEX IF NOT EXISTS idx_sessions_developer ON sessions(developer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_client_idempotency
  ON sessions(organization_id, developer_id, client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_processing_status ON sessions(searchable_status, enrichment_status);
CREATE INDEX IF NOT EXISTS idx_chunks_processing_status ON chunks(session_id, searchable_status, enrichment_status);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_chunk_processing_status ON chunk_processing_status(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_org ON knowledge_records(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunk ON knowledge_records(chunk_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_records(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_repo ON knowledge_records(repository);
CREATE INDEX IF NOT EXISTS idx_feedback_result ON feedback_events(result_id);
CREATE INDEX IF NOT EXISTS idx_feedback_search ON feedback_events(search_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw ON memory_facts USING hnsw (embedding vector_cosine_ops) WITH (m = 32, ef_construction = 256);
CREATE INDEX IF NOT EXISTS idx_facts_org ON memory_facts(organization_id);
CREATE INDEX IF NOT EXISTS idx_facts_entities ON memory_facts USING gin(entities);
CREATE INDEX IF NOT EXISTS idx_facts_type ON memory_facts(type);
CREATE INDEX IF NOT EXISTS idx_facts_temporal ON memory_facts(organization_id, temporal_valid_until) WHERE temporal_valid_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_source_chunk ON memory_facts(source_chunk_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_source_capture_sequence
  ON memory_facts(source_capture_id, source_capture_sequence)
  WHERE source_capture_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_created ON memory_facts(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_developer ON capture_events(developer_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_capture_unprocessed ON capture_events(organization_id) WHERE processed = false;
CREATE INDEX IF NOT EXISTS idx_capture_type ON capture_events(type, timestamp DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY
-- API transactions set app.* values from verified JWT claims. Worker
-- transactions explicitly set app.is_service=true.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON sessions
  USING (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND (developer_id = NULLIF(current_setting('app.user_id', true), '')
      OR COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'admin'
      OR (COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'team_lead'
        AND team_id IS NOT NULL
        AND COALESCE(NULLIF(current_setting('app.team_ids', true), ''), '[]')::jsonb ? team_id))
  ))
  WITH CHECK (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND developer_id = NULLIF(current_setting('app.user_id', true), '')
  ));

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON chunks
  USING (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND (
      author_id = NULLIF(current_setting('app.user_id', true), '')
      OR COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'admin'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(acl->'sharedWith', '[]'::jsonb)) grant_row
        WHERE grant_row->>'userId' = NULLIF(current_setting('app.user_id', true), '')
      )
      OR (COALESCE(acl->>'classification', 'public') IN ('public', 'internal')
        AND (team_id IS NULL OR COALESCE(NULLIF(current_setting('app.team_ids', true), ''), '[]')::jsonb ? team_id)
        AND (repository IS NULL
          OR jsonb_array_length(COALESCE(NULLIF(current_setting('app.repository_access', true), ''), '[]')::jsonb) = 0
          OR COALESCE(NULLIF(current_setting('app.repository_access', true), ''), '[]')::jsonb ? repository))
      OR (COALESCE(acl->>'classification', 'public') = 'confidential'
        AND COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'team_lead'
        AND team_id IS NOT NULL
        AND COALESCE(NULLIF(current_setting('app.team_ids', true), ''), '[]')::jsonb ? team_id)
    )
  ))
  WITH CHECK (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND author_id = NULLIF(current_setting('app.user_id', true), '')
  ));

ALTER TABLE knowledge_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_records FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON knowledge_records
  USING (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND (author_id = NULLIF(current_setting('app.user_id', true), '')
      OR COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'admin'
      OR ((team_id IS NULL OR COALESCE(NULLIF(current_setting('app.team_ids', true), ''), '[]')::jsonb ? team_id)
        AND (repository IS NULL
          OR jsonb_array_length(COALESCE(NULLIF(current_setting('app.repository_access', true), ''), '[]')::jsonb) = 0
          OR COALESCE(NULLIF(current_setting('app.repository_access', true), ''), '[]')::jsonb ? repository)))
  ))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON memory_facts
  USING (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND (author_id = NULLIF(current_setting('app.user_id', true), '')
      OR COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'admin'
      OR scope = 'organization'
      OR (scope = 'team' AND team_id IS NOT NULL
        AND COALESCE(NULLIF(current_setting('app.team_ids', true), ''), '[]')::jsonb ? team_id))
  ))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE capture_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_events FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON capture_events
  USING (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND (developer_id = NULLIF(current_setting('app.user_id', true), '')
      OR COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'admin')
  ))
  WITH CHECK (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND developer_id = NULLIF(current_setting('app.user_id', true), '')
  ));

ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_events FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON feedback_events
  USING (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND (developer_id = NULLIF(current_setting('app.user_id', true), '')
      OR COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'admin')
  ))
  WITH CHECK (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND developer_id = NULLIF(current_setting('app.user_id', true), '')
  ));

ALTER TABLE chunk_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_clusters FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON chunk_clusters
  USING (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE search_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_index_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON search_index_entries
  USING (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON graph_nodes
  USING (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edges FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON graph_edges
  USING (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE chunk_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON chunk_entities
  USING (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON outbox_events
  USING (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

ALTER TABLE chunk_processing_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_processing_status FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON chunk_processing_status
  USING (current_setting('app.is_service', true) = 'true')
  WITH CHECK (current_setting('app.is_service', true) = 'true');

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY recall_tenant_acl ON audit_log
  USING (current_setting('app.is_service', true) = 'true' OR (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')
    AND (user_id = NULLIF(current_setting('app.user_id', true), '')
      OR COALESCE(NULLIF(current_setting('app.roles', true), ''), '[]')::jsonb ? 'admin')
  ))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED DATA (for local development)
-- ═══════════════════════════════════════════════════════════════════════════

-- No seed data — the system populates via session uploads.
-- Use `npm run seed` for development test data.
