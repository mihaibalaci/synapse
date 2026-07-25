#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Post-initialization script for Patroni Postgres cluster.
# Runs once after the cluster is bootstrapped.
# Installs required extensions and creates the database schema.
# ══════════════════════════════════════════════════════════════════════════════

set -e

echo "Installing PostgreSQL extensions..."

psql -U postgres -d recall <<'SQL'
-- Required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Verify pgvector is working
SELECT vector_dims('[1,2,3]'::vector);

-- Create application user
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app WITH LOGIN PASSWORD 'app_password';
  END IF;
END
$$;

GRANT ALL PRIVILEGES ON DATABASE recall TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO app;
SQL

echo "Extensions installed. Running schema initialization..."

# The application handles its own schema migration on startup.
# This just ensures extensions are available.

echo "Post-init complete."
