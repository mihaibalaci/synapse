-- nomic-embed-text produces 768 dimensions. Existing vectors in any other
-- space cannot be converted meaningfully, so clear only incompatible columns,
-- change the typmod, and let `synapse embed-backfill` regenerate them.
DO $$
DECLARE
    chunk_type text;
    fact_type text;
BEGIN
    SELECT format_type(a.atttypid, a.atttypmod) INTO chunk_type
      FROM pg_attribute a
     WHERE a.attrelid = 'chunks'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped;
    IF chunk_type IS DISTINCT FROM 'vector(768)' THEN
        DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;
        ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(768) USING NULL::vector(768);
    END IF;

    SELECT format_type(a.atttypid, a.atttypmod) INTO fact_type
      FROM pg_attribute a
     WHERE a.attrelid = 'memory_facts'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped;
    IF fact_type IS DISTINCT FROM 'vector(768)' THEN
        DROP INDEX IF EXISTS idx_facts_embedding_hnsw;
        ALTER TABLE memory_facts ALTER COLUMN embedding TYPE vector(768) USING NULL::vector(768);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw ON chunks
    USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_embedding_hnsw ON memory_facts
    USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
