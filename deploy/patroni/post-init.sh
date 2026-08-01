#!/usr/bin/env bash
set -euo pipefail

SYNAPSE_APP_PASSWORD=${SYNAPSE_APP_PASSWORD:-${RECALL_APP_PASSWORD:-}}
SYNAPSE_MIGRATOR_PASSWORD=${SYNAPSE_MIGRATOR_PASSWORD:-${RECALL_MIGRATOR_PASSWORD:-}}
: "${SYNAPSE_APP_PASSWORD:?SYNAPSE_APP_PASSWORD is required}"
: "${SYNAPSE_MIGRATOR_PASSWORD:?SYNAPSE_MIGRATOR_PASSWORD is required}"

psql --username postgres --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=app_password="$SYNAPSE_APP_PASSWORD" \
  --set=migrator_password="$SYNAPSE_MIGRATOR_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE synapse_migrator LOGIN PASSWORD %L NOINHERIT', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synapse_migrator') \gexec
SELECT format('ALTER ROLE synapse_migrator PASSWORD %L', :'migrator_password') \gexec
SELECT format('CREATE ROLE synapse_app LOGIN PASSWORD %L NOINHERIT', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'synapse_app') \gexec
SELECT format('ALTER ROLE synapse_app PASSWORD %L', :'app_password') \gexec
SELECT 'CREATE DATABASE synapse OWNER synapse_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'synapse') \gexec
REVOKE CONNECT ON DATABASE synapse FROM PUBLIC;
GRANT CONNECT ON DATABASE synapse TO synapse_app, synapse_migrator;
SQL

psql --username postgres --dbname synapse --set=ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
ALTER SCHEMA public OWNER TO synapse_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO synapse_app;
ALTER DEFAULT PRIVILEGES FOR ROLE synapse_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO synapse_app;
ALTER DEFAULT PRIVILEGES FOR ROLE synapse_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO synapse_app;
SELECT vector_dims(array_fill(0::real, ARRAY[768])::vector) AS required_vector_dimensions;
SQL

echo "Patroni bootstrap complete; run 'synapse migrate' with synapse_migrator credentials."
