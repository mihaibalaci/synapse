import pg from 'pg';
import { EmbeddingClient } from '../dist/utils/embedding.js';
import { loadConfig } from '../dist/config/index.js';

const { Client } = pg;
const config = loadConfig();
const connectionString = process.env.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
const batchSize = Math.max(1, Math.min(Number(process.env.BACKFILL_BATCH_SIZE ?? 50), 500));
const targetVersion = Math.max(1, Number(process.env.EMBEDDING_VERSION ?? 1));
const client = new Client({ connectionString, application_name: 'synapse-embedding-backfill' });
const embeddings = new EmbeddingClient();

const vector = values => `[${values.join(',')}]`;

async function backfillChunks() {
  let total = 0;
  while (true) {
    const result = await client.query(`
      SELECT id, title, summary, content
      FROM chunks
      WHERE embedding IS NULL OR embedding_version < $1 OR embedding_model <> $2
      ORDER BY id
      LIMIT $3
    `, [targetVersion, embeddings.getModelName(), batchSize]);
    if (result.rows.length === 0) return total;

    const generated = await embeddings.embedBatch(
      result.rows.map(row => `${row.title}\n${row.summary}\n${row.content}`),
    );
    await client.query('BEGIN');
    try {
      for (let index = 0; index < result.rows.length; index++) {
        await client.query(`
          UPDATE chunks
          SET embedding = $2::vector, embedding_model = $3,
              embedding_version = $4, updated_at = NOW()
          WHERE id = $1
            AND (embedding IS NULL OR embedding_version < $4 OR embedding_model <> $3)
        `, [result.rows[index].id, vector(generated[index]), embeddings.getModelName(), targetVersion]);
      }
      await client.query('COMMIT');
      total += result.rows.length;
      console.log(`Backfilled ${total} chunks`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

async function backfillFacts() {
  let total = 0;
  while (true) {
    const result = await client.query(`
      SELECT id, content FROM memory_facts
      WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM $1
      ORDER BY id LIMIT $2
    `, [embeddings.getModelName(), batchSize]);
    if (result.rows.length === 0) return total;
    const generated = await embeddings.embedBatch(result.rows.map(row => row.content));
    await client.query('BEGIN');
    try {
      for (let index = 0; index < result.rows.length; index++) {
        await client.query(`
          UPDATE memory_facts SET embedding = $2::vector, embedding_model = $3, updated_at = NOW()
          WHERE id = $1 AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $3)
        `, [result.rows[index].id, vector(generated[index]), embeddings.getModelName()]);
      }
      await client.query('COMMIT');
      total += result.rows.length;
      console.log(`Backfilled ${total} facts`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

async function main() {
  await client.connect();
  const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('synapse-embedding-backfill')) AS acquired");
  if (!lock.rows[0]?.acquired) throw new Error('Another embedding backfill is already running');
  try {
    const chunks = await backfillChunks();
    const facts = await backfillFacts();
    console.log(JSON.stringify({ chunks, facts, dimensions: embeddings.getDimensions(), model: embeddings.getModelName() }));
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('synapse-embedding-backfill'))");
    await client.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
