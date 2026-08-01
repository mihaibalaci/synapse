-- These projections make metrics and future enrichment schema-stable. The
-- current Go worker does not yet populate clusters, knowledge, or graph rows.
CREATE TABLE IF NOT EXISTS chunk_clusters (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL,
    canonical_chunk_id uuid REFERENCES chunks(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_records (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL,
    source_chunk_id uuid REFERENCES chunks(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT '',
    content jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS graph_nodes (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name, kind)
);

CREATE TABLE IF NOT EXISTS graph_edges (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL,
    source_id uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    target_id uuid NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    relation text NOT NULL,
    weight double precision NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, source_id, target_id, relation)
);

CREATE TABLE IF NOT EXISTS system_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text NOT NULL DEFAULT ''
);
