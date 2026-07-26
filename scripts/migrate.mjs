import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = join(root, 'migrations');
const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
}

const client = new Client({
  connectionString,
  application_name: 'recall-migrator',
  ssl: process.env.PGSSLMODE === 'disable' ? false : undefined,
});

const checksum = content => createHash('sha256').update(content).digest('hex');

async function relationExists(name) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${name}`]);
  return result.rows[0]?.exists === true;
}

async function main() {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtext('recall-schema-migrations'))");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        execution_ms INTEGER NOT NULL,
        baselined BOOLEAN NOT NULL DEFAULT false
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter(file => /^\d+_.+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const sql = await readFile(join(migrationsDirectory, file), 'utf8');
      const digest = checksum(sql);
      const applied = await client.query(
        'SELECT checksum FROM schema_migrations WHERE id = $1',
        [file],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== digest) {
          throw new Error(`Applied migration ${file} has been modified`);
        }
        continue;
      }

      // Adopt databases created before migrations existed. The following
      // upgrade migration remains responsible for converging their schema.
      if (file.startsWith('001_') && await relationExists('sessions')) {
        await client.query(
          `INSERT INTO schema_migrations (id, checksum, execution_ms, baselined)
           VALUES ($1, $2, 0, true)`,
          [file, digest],
        );
        console.log(`Baselined ${file}`);
        continue;
      }

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '10min'");
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (id, checksum, execution_ms)
           VALUES ($1, $2, $3)`,
          [file, digest, Date.now() - startedAt],
        );
        await client.query('COMMIT');
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('recall-schema-migrations'))");
    await client.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
