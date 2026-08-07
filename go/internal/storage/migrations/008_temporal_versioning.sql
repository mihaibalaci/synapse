-- Migration 008: Temporal Fact Versioning
--
-- Evolves the fact system from simple supersession into a full temporal
-- knowledge graph. Facts now form version chains with explicit lineage,
-- temporal edges track relationship validity windows, and point-in-time
-- queries become first-class operations.
--
-- Key additions:
--   1. fact_versions: Explicit version chain linking facts as evolution of same knowledge
--   2. temporal_edges: Time-bounded relationships between entities
--   3. fact_change_log: Audit trail of how and why facts changed
--   4. Indexes for temporal range queries

-- ─── Fact Version Chains ─────────────────────────────────────────────────────
-- Links facts that represent the same piece of knowledge evolving over time.
-- Example: "We use PostgreSQL" → "We migrated to CockroachDB" → "We use CockroachDB + read replicas"
CREATE TABLE IF NOT EXISTS fact_versions (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL,
    -- The canonical "topic" this version chain tracks
    canonical_topic text NOT NULL,
    -- Entity tags for this version chain (union of all version entities)
    entities text[] NOT NULL DEFAULT '{}',
    -- Current active fact (head of the chain)
    current_fact_id uuid REFERENCES memory_facts(id) ON DELETE SET NULL,
    -- All facts in chronological order (oldest first)
    version_ids uuid[] NOT NULL DEFAULT '{}',
    -- Version count
    version_count integer NOT NULL DEFAULT 1,
    -- When the first version was observed
    first_observed_at timestamptz NOT NULL DEFAULT now(),
    -- When the latest version was observed
    last_updated_at timestamptz NOT NULL DEFAULT now(),
    -- Change frequency (versions per month, for volatility scoring)
    change_frequency double precision NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, canonical_topic)
);
CREATE INDEX IF NOT EXISTS idx_fact_versions_org
    ON fact_versions (organization_id, last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_versions_entities
    ON fact_versions USING gin (entities);
CREATE INDEX IF NOT EXISTS idx_fact_versions_current
    ON fact_versions (current_fact_id) WHERE current_fact_id IS NOT NULL;

-- ─── Temporal Graph Edges ────────────────────────────────────────────────────
-- Graph edges with explicit validity windows. When a relationship changes,
-- the old edge gets a valid_until timestamp and a new edge is created.
CREATE TABLE IF NOT EXISTS temporal_edges (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL,
    source_entity text NOT NULL,
    target_entity text NOT NULL,
    relation text NOT NULL,
    -- Temporal bounds: when this relationship was/is valid
    valid_from timestamptz NOT NULL DEFAULT now(),
    valid_until timestamptz, -- NULL = still valid
    -- Confidence and weight
    weight double precision NOT NULL DEFAULT 1.0,
    confidence double precision NOT NULL DEFAULT 0.7,
    -- Provenance: which fact established this edge
    source_fact_id uuid REFERENCES memory_facts(id) ON DELETE SET NULL,
    -- Supersession tracking
    superseded_by uuid REFERENCES temporal_edges(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, source_entity, target_entity, relation, valid_from)
);
CREATE INDEX IF NOT EXISTS idx_temporal_edges_org_time
    ON temporal_edges (organization_id, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_temporal_edges_source
    ON temporal_edges (organization_id, source_entity, valid_until NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_temporal_edges_target
    ON temporal_edges (organization_id, target_entity, valid_until NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_temporal_edges_active
    ON temporal_edges (organization_id) WHERE valid_until IS NULL;

-- ─── Fact Change Log ─────────────────────────────────────────────────────────
-- Audit trail tracking why facts changed. Enables answering "what caused
-- the team to change from X to Y?"
CREATE TABLE IF NOT EXISTS fact_change_log (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL,
    version_chain_id uuid NOT NULL REFERENCES fact_versions(id) ON DELETE CASCADE,
    -- The old and new fact
    previous_fact_id uuid REFERENCES memory_facts(id) ON DELETE SET NULL,
    new_fact_id uuid NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
    -- Change metadata
    change_type text NOT NULL DEFAULT 'evolution', -- evolution, correction, supersession, retraction
    change_reason text NOT NULL DEFAULT '', -- Why this changed (auto-detected or user-provided)
    -- Detection method
    detected_by text NOT NULL DEFAULT 'auto', -- auto, user, contradiction-detector
    -- Temporal context
    changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fact_change_log_chain
    ON fact_change_log (version_chain_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_change_log_org
    ON fact_change_log (organization_id, changed_at DESC);

-- ─── Add version_chain_id to memory_facts ───────────────────────────────────
-- Links each fact back to its version chain for quick lookups.
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS version_chain_id uuid REFERENCES fact_versions(id);
CREATE INDEX IF NOT EXISTS idx_facts_version_chain
    ON memory_facts (version_chain_id) WHERE version_chain_id IS NOT NULL;

-- ─── Entity Timeline View ────────────────────────────────────────────────────
-- Materialized view for fast entity timeline queries. Refreshed periodically.
-- Shows the complete history of an entity across all fact versions.
CREATE MATERIALIZED VIEW IF NOT EXISTS entity_timeline AS
SELECT
    mf.organization_id,
    unnest(mf.entities) AS entity,
    mf.id AS fact_id,
    mf.content,
    mf.type AS fact_type,
    mf.confidence,
    mf.temporal_observed_at AS observed_at,
    mf.temporal_valid_from AS valid_from,
    mf.temporal_valid_until AS valid_until,
    mf.temporal_superseded_by AS superseded_by,
    fv.canonical_topic,
    fv.version_count,
    fv.change_frequency,
    CASE
        WHEN mf.temporal_valid_until IS NULL AND mf.temporal_superseded_by IS NULL THEN 'active'
        WHEN mf.temporal_superseded_by IS NOT NULL THEN 'superseded'
        WHEN mf.temporal_valid_until < now() THEN 'expired'
        ELSE 'historical'
    END AS temporal_status
FROM memory_facts mf
LEFT JOIN fact_versions fv ON fv.id = mf.version_chain_id
WHERE mf.organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_timeline_pk
    ON entity_timeline (organization_id, entity, fact_id);
CREATE INDEX IF NOT EXISTS idx_entity_timeline_entity_time
    ON entity_timeline (organization_id, entity, observed_at DESC);
