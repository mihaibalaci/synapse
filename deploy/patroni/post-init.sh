#!/usr/bin/env bash
set -euo pipefail

: "${RECALL_APP_PASSWORD:?RECALL_APP_PASSWORD is required}"
: "${RECALL_MIGRATOR_PASSWORD:?RECALL_MIGRATOR_PASSWORD is required}"

psql --username postgres --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=app_password="$RECALL_APP_PASSWORD" \
  --set=migrator_password="$RECALL_MIGRATOR_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE recall_migrator LOGIN PASSWORD %L NOINHERIT', :'migrator_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recall_migrator') \gexec
SELECT format('ALTER ROLE recall_migrator PASSWORD %L', :'migrator_password') \gexec

SELECT format('CREATE ROLE recall_app LOGIN PASSWORD %L NOINHERIT', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recall_app') \gexec
SELECT format('ALTER ROLE recall_app PASSWORD %L', :'app_password') \gexec

SELECT 'CREATE DATABASE recall OWNER recall_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'recall') \gexec
REVOKE CONNECT ON DATABASE recall FROM PUBLIC;
GRANT CONNECT ON DATABASE recall TO recall_app, recall_migrator;
SQL

psql --username postgres --dbname recall --set=ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
ALTER SCHEMA public OWNER TO recall_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO recall_app;
ALTER DEFAULT PRIVILEGES FOR ROLE recall_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recall_app;
ALTER DEFAULT PRIVILEGES FOR ROLE recall_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO recall_app;
SELECT vector_dims(array_fill(0::real, ARRAY[1536])::vector) AS required_vector_dimensions;
SQL

echo "Patroni bootstrap complete; run the Recall migration Job with recall_migrator credentials."
