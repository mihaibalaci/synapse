/**
 * Compaction Job entrypoint.
 *
 * Runs as a Kubernetes CronJob (separate from the ingestion workers) to
 * synthesize cluster canonicals, detect fact supersession, and archive stale
 * chunks. Per-organization advisory locking ensures concurrent pods or retries
 * cannot collide.
 *
 * Env:
 *   COMPACTION_ORGANIZATIONS  comma-separated org ids, or "all" to discover from DB
 *   COMPACTION_MAX_CLUSTERS   max clusters to synthesize per org (default 50)
 *   COMPACTION_MAX_PRUNE      max chunks to archive per org (default 500)
 *   COMPACTION_ARCHIVE_DAYS   days without usage before archival (default 90)
 *
 * Exit codes:
 *   0 — completed (some orgs may have been skipped if locked)
 *   1 — fatal startup error
 */

import { loadConfig } from './config/index.js';
import { getLogger } from './utils/logger.js';
import { CompactionEngine, type CompactionResult } from './ingestion/compaction.js';
import { query, closeDatabase, enterDatabaseContext } from './storage/database.js';

const LOCK_NAMESPACE = 2_000_000_000; // pg_advisory_lock key space for compaction

async function discoverOrganizations(): Promise<string[]> {
  const result = await query<{ organization_id: string }>(`
    SELECT DISTINCT organization_id FROM sessions
    WHERE searchable_status = 'searchable'
    ORDER BY organization_id
  `);
  return result.rows.map(row => row.organization_id);
}

function lockKey(organizationId: string): number {
  // Stable 32-bit hash of the org id within the compaction namespace
  let hash = 0;
  for (let i = 0; i < organizationId.length; i++) {
    hash = ((hash << 5) - hash + organizationId.charCodeAt(i)) | 0;
  }
  return LOCK_NAMESPACE + (hash & 0x7fffffff) % 1_000_000_000;
}

async function tryLockOrg(organizationId: string): Promise<boolean> {
  const result = await query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [lockKey(organizationId)],
  );
  return result.rows[0]?.acquired === true;
}

async function unlockOrg(organizationId: string): Promise<void> {
  await query('SELECT pg_advisory_unlock($1)', [lockKey(organizationId)]);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger();

  // Compaction runs as a service context — no tenant RLS restrictions.
  enterDatabaseContext({
    userId: 'synapse-compaction',
    organizationId: '',
    teamIds: [],
    roles: ['service'],
    repositoryAccess: [],
    isService: true,
  });

  const maxClusters = Number(process.env.COMPACTION_MAX_CLUSTERS ?? 50);
  const maxPrune = Number(process.env.COMPACTION_MAX_PRUNE ?? 500);
  const archiveDays = Number(process.env.COMPACTION_ARCHIVE_DAYS ?? 90);

  const engine = new CompactionEngine({
    maxClustersPerRun: maxClusters,
    maxPrunePerRun: maxPrune,
    archiveAfterDays: archiveDays,
  });

  // Determine which organizations to compact
  const orgEnv = process.env.COMPACTION_ORGANIZATIONS?.trim();
  let organizations: string[];
  if (!orgEnv || orgEnv === 'all') {
    organizations = await discoverOrganizations();
    logger.info({ count: organizations.length }, 'Discovered organizations for compaction');
  } else {
    organizations = orgEnv.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (organizations.length === 0) {
    logger.info('No organizations to compact');
    await closeDatabase();
    return;
  }

  const results: CompactionResult[] = [];
  let skipped = 0;

  for (const organizationId of organizations) {
    const locked = await tryLockOrg(organizationId);
    if (!locked) {
      logger.info({ organizationId }, 'Organization locked by another compaction instance, skipping');
      skipped++;
      continue;
    }

    try {
      const result = await engine.run(organizationId);
      results.push(result);
    } catch (error) {
      logger.error({ err: error, organizationId }, 'Compaction failed for organization');
      results.push({
        organizationId,
        clustersSynthesized: 0,
        clustersSkipped: 0,
        factsSuperseded: 0,
        opinionsReinforced: 0,
        chunksArchived: 0,
        observationsRefreshed: 0,
        tokensSaved: 0,
        llmCalls: 0,
        errors: [(error as Error).message],
      });
    } finally {
      await unlockOrg(organizationId);
    }
  }

  // Summary
  const totals = results.reduce(
    (acc, r) => ({
      synthesized: acc.synthesized + r.clustersSynthesized,
      superseded: acc.superseded + r.factsSuperseded,
      archived: acc.archived + r.chunksArchived,
      tokensSaved: acc.tokensSaved + r.tokensSaved,
      llmCalls: acc.llmCalls + r.llmCalls,
      errors: acc.errors + r.errors.length,
    }),
    { synthesized: 0, superseded: 0, archived: 0, tokensSaved: 0, llmCalls: 0, errors: 0 },
  );

  logger.info({
    organizations: organizations.length,
    processed: results.length,
    skipped,
    ...totals,
  }, 'Compaction job finished');

  // Print JSON summary for Job log aggregation
  console.log(JSON.stringify({ ...totals, organizations: results.length, skipped }, null, 2));

  await closeDatabase();
}

main().catch(error => {
  console.error('Fatal compaction error:', error);
  process.exitCode = 1;
});
