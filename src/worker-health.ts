/**
 * Worker health endpoint.
 *
 * Workers have no request surface, so liveness and readiness are exposed on a
 * dedicated port. Both answers are derived from observable state rather than a
 * process that merely exits zero:
 *
 *   /health       liveness  — the dispatch loop completed recently, which means
 *                             the event loop is running and PostgreSQL answered.
 *   /health/ready readiness — every dependency the workers need is reachable.
 */

import { createServer, type Server } from 'node:http';
import { getConfig } from './config/index.js';
import { createChildLogger } from './utils/logger.js';
import { getOutboxHeartbeat } from './ingestion/outbox-dispatcher.js';
import { checkDatabaseHealth } from './storage/database.js';
import { checkCacheHealth } from './storage/cache.js';
import { getQueueHealth } from './ingestion/queue.js';
import { ObjectStorageClient } from './storage/object-storage.js';

const logger = createChildLogger({ module: 'worker-health' });

let server: Server | null = null;
let shuttingDown = false;

/** A hung or event-loop-blocked worker stops refreshing its heartbeat. */
export function getWorkerLiveness(staleAfterMs: number): {
  alive: boolean;
  heartbeatAgeMs: number | null;
} {
  const heartbeat = getOutboxHeartbeat();
  if (heartbeat === null) {
    return { alive: false, heartbeatAgeMs: null };
  }
  const heartbeatAgeMs = Date.now() - heartbeat;
  return { alive: heartbeatAgeMs <= staleAfterMs, heartbeatAgeMs };
}

async function readiness(): Promise<{
  ready: boolean;
  checks: Record<string, string>;
}> {
  const config = getConfig();
  const [database, cache, objectStorage, queue] = await Promise.all([
    checkDatabaseHealth().catch(() => ({ healthy: false })),
    checkCacheHealth().catch(() => ({ healthy: false })),
    new ObjectStorageClient().checkBucket(config.S3_BUCKET).catch(() => ({ healthy: false })),
    getQueueHealth().then(() => ({ healthy: true })).catch(() => ({ healthy: false })),
  ]);
  const checks = {
    database: database.healthy ? 'ok' : 'unavailable',
    redis: cache.healthy ? 'ok' : 'unavailable',
    objectStorage: objectStorage.healthy ? 'ok' : 'unavailable',
    queue: queue.healthy ? 'ok' : 'unavailable',
  };
  return {
    ready: database.healthy && cache.healthy && objectStorage.healthy && queue.healthy,
    checks,
  };
}

export function startWorkerHealthServer(options?: {
  port?: number;
  staleAfterMs?: number;
}): Server {
  if (server) return server;

  const port = options?.port ?? Number(process.env.WORKER_HEALTH_PORT ?? 3001);
  const staleAfterMs = options?.staleAfterMs ?? Number(process.env.WORKER_HEARTBEAT_STALE_MS ?? 60_000);

  server = createServer((request, response) => {
    const send = (status: number, body: Record<string, unknown>): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    };

    const url = (request.url ?? '/').split('?')[0];

    if (request.method !== 'GET') {
      send(405, { error: 'method_not_allowed' });
      return;
    }

    if (url === '/health') {
      // While draining, report unhealthy so the orchestrator stops counting
      // this replica, but never mid-job restart it: SIGTERM already drains.
      const { alive, heartbeatAgeMs } = getWorkerLiveness(staleAfterMs);
      const healthy = alive && !shuttingDown;
      send(healthy ? 200 : 503, {
        status: healthy ? 'healthy' : 'unhealthy',
        shuttingDown,
        heartbeatAgeMs,
        staleAfterMs,
      });
      return;
    }

    if (url === '/health/ready') {
      void readiness().then(({ ready, checks }) => {
        const { alive, heartbeatAgeMs } = getWorkerLiveness(staleAfterMs);
        const isReady = ready && alive && !shuttingDown;
        send(isReady ? 200 : 503, {
          status: isReady ? 'ready' : 'not_ready',
          shuttingDown,
          heartbeatAgeMs,
          checks,
        });
      }).catch(error => {
        logger.error({ err: error }, 'Worker readiness check failed');
        send(503, { status: 'not_ready' });
      });
      return;
    }

    send(404, { error: 'not_found' });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port, staleAfterMs }, 'Worker health server started');
  });

  return server;
}

export function beginWorkerDrain(): void {
  shuttingDown = true;
}

export async function stopWorkerHealthServer(): Promise<void> {
  const current = server;
  server = null;
  shuttingDown = false;
  if (!current) return;
  await new Promise<void>(resolve => current.close(() => resolve()));
  logger.info('Worker health server stopped');
}
