-- Upgrade pre-migration Recall databases to the reliability and tenant model.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS searchable_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'pending';
UPDATE sessions SET searchable_status = 'pending'
  WHERE searchable_status NOT IN ('pending', 'processing', 'searchable', 'blocked', 'failed');
UPDATE sessions SET enrichment_status = 'pending'
  WHERE enrichment_status NOT IN ('pending', 'not_required', 'processing', 'complete', 'partial', 'failed');
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_searchable_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_searchable_status_check CHECK (
  searchable_status IN ('pending', 'processing', 'searchable', 'blocked', 'failed'));
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_enrichment_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_enrichment_status_check CHECK (
  enrichment_status IN ('pending', 'not_required', 'processing', 'complete', 'partial', 'failed'));

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS acl JSONB NOT NULL DEFAULT '{}';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS searchable_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'pending';
UPDATE chunks SET searchable_status = 'pending'
  WHERE searchable_status NOT IN ('pending', 'processing', 'searchable', 'blocked', 'failed');
UPDATE chunks SET enrichment_status = 'pending'
  WHERE enrichment_status NOT IN ('pending', 'not_required', 'processing', 'complete', 'partial', 'failed');
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_searchable_status_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_searchable_status_check CHECK (
  searchable_status IN ('pending', 'processing', 'searchable', 'blocked', 'failed'));
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_enrichment_status_check;
ALTER TABLE chunks ADD CONSTRAINT chunks_enrichment_status_check CHECK (
  enrichment_status IN ('pending', 'not_required', 'processing', 'complete', 'partial', 'failed'));

ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS last_error TEXT;
UPDATE capture_events SET processing_status = 'pending'
  WHERE processing_status NOT IN ('pending', 'processing', 'complete', 'blocked', 'failed');
ALTER TABLE capture_events DROP CONSTRAINT IF EXISTS capture_events_processing_status_check;
ALTER TABLE capture_events ADD CONSTRAINT capture_events_processing_status_check CHECK (
  processing_status IN ('pending', 'processing', 'complete', 'blocked', 'failed'));

ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS source_capture_id UUID REFERENCES capture_events(id);
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS source_capture_sequence INTEGER;

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  organization_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  deduplication_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chunk_processing_status (
  chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('index', 'facts', 'knowledge', 'deduplicate', 'graph')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'blocked', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chunk_id, action)
);

CREATE TABLE IF NOT EXISTS search_index_entries (
  chunk_id UUID PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  is_searchable BOOLEAN NOT NULL DEFAULT true,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Convert incompatible legacy vectors without pretending they remain comparable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'chunks'::regclass
      AND attname = 'embedding' AND format_type(atttypid, atttypmod) <> 'vector(1536)'
  ) THEN
    DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
    ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1536) USING NULL::vector(1536);
    UPDATE chunks SET embedding_version = 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'memory_facts'::regclass
      AND attname = 'embedding' AND format_type(atttypid, atttypmod) <> 'vector(1536)'
  ) THEN
    DROP INDEX IF EXISTS idx_facts_embedding_hnsw;
    ALTER TABLE memory_facts ALTER COLUMN embedding TYPE vector(1536) USING NULL::vector(1536);
  END IF;
END $$;

-- Make deduplication clusters first-class tenant resources.
ALTER TABLE chunk_clusters ADD COLUMN IF NOT EXISTS organization_id TEXT;
UPDATE chunk_clusters clusters
SET organization_id = canonical.organization_id
FROM chunks canonical
WHERE canonical.id = clusters.canonical_chunk_id AND clusters.organization_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM chunk_clusters clusters
    WHERE clusters.organization_id IS NULL
      OR clusters.canonical_chunk_id <> ALL(clusters.member_chunk_ids)
      OR EXISTS (
        SELECT 1 FROM unnest(clusters.member_chunk_ids) member_id
        LEFT JOIN chunks member ON member.id = member_id
        WHERE member.id IS NULL OR member.organization_id <> clusters.organization_id
      )
  ) THEN
    RAISE EXCEPTION 'chunk_clusters contains missing or cross-organization members; quarantine before retrying';
  END IF;
END $$;

ALTER TABLE chunk_clusters ALTER COLUMN organization_id SET NOT NULL;
CREATE OR REPLACE FUNCTION enforce_chunk_cluster_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.canonical_chunk_id <> ALL(NEW.member_chunk_ids)
    OR NOT EXISTS (
      SELECT 1 FROM chunks WHERE id = NEW.canonical_chunk_id
        AND organization_id = NEW.organization_id
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
DROP TRIGGER IF EXISTS trg_chunk_clusters_tenant ON chunk_clusters;
CREATE TRIGGER trg_chunk_clusters_tenant BEFORE INSERT OR UPDATE ON chunk_clusters
  FOR EACH ROW EXECUTE FUNCTION enforce_chunk_cluster_tenant();

ALTER TABLE chunk_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunk_clusters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recall_tenant_acl ON chunk_clusters;
CREATE POLICY recall_tenant_acl ON chunk_clusters
  USING (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''))
  WITH CHECK (current_setting('app.is_service', true) = 'true'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), ''));

CREATE INDEX IF NOT EXISTS idx_chunk_clusters_org
  ON chunk_clusters(organization_id, member_count DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_chunk_processing_status ON chunk_processing_status(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_search_entries_org ON search_index_entries(organization_id, is_searchable);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw ON memory_facts USING hnsw (embedding vector_cosine_ops)
  WITH (m = 32, ef_construction = 256);
