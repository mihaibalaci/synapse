/** Redis cache with authorization-safe keys and non-blocking invalidation. */

import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { type SearchRequest, type SearchResponse } from '../models/index.js';

const logger = createChildLogger({ module: 'cache' });
let redis: Redis | null = null;

export function getRedis(): Redis {
  if (redis) return redis;
  const config = getConfig();
  redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: times => Math.min(times * 50, 2000),
    lazyConnect: true,
  });
  redis.on('error', err => logger.error({ err }, 'Redis connection error'));
  redis.on('connect', () => logger.info('Redis connected'));
  return redis;
}

const PREFIXES = {
  SEARCH: 'search:',
  SESSION_DEDUP: 'sdedup:',
  POPULAR: 'popular:',
} as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

/** Includes identity, ACL claims, filters, context, pagination, and output shape. */
function searchKey(request: SearchRequest): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(request)))
    .digest('base64url');
  return `${PREFIXES.SEARCH}${request.organizationId}:${request.developerId}:${digest}`;
}

export class SearchCache {
  constructor(private readonly ttlSeconds: number = 3600) {}

  async get(request: SearchRequest): Promise<SearchResponse | null> {
    const key = searchKey(request);
    try {
      const cached = await getRedis().get(key);
      if (!cached) return null;
      logger.debug({ key }, 'Cache hit');
      return JSON.parse(cached) as SearchResponse;
    } catch (error) {
      logger.warn({ err: error, key }, 'Cache read failed');
      return null;
    }
  }

  async set(request: SearchRequest, response: SearchResponse): Promise<void> {
    const key = searchKey(request);
    try {
      await getRedis().setex(key, this.ttlSeconds, JSON.stringify(response));
      logger.debug({ key, ttl: this.ttlSeconds }, 'Cache set');
    } catch (error) {
      logger.warn({ err: error, key }, 'Cache write failed');
    }
  }

  async invalidateOrg(orgId: string): Promise<void> {
    const client = getRedis();
    let cursor = '0';
    let removed = 0;
    try {
      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          'MATCH',
          `${PREFIXES.SEARCH}${orgId}:*`,
          'COUNT',
          200,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          removed += await client.unlink(...keys);
        }
      } while (cursor !== '0');
      logger.debug({ orgId, count: removed }, 'Cache invalidated');
    } catch (error) {
      logger.warn({ err: error, orgId }, 'Cache invalidation failed');
    }
  }

  async trackQuery(query: string, orgId: string): Promise<void> {
    const key = `${PREFIXES.POPULAR}${orgId}`;
    try {
      const client = getRedis();
      await client.zincrby(key, 1, query.toLowerCase().trim());
      await client.zremrangebyrank(key, 0, -1001);
    } catch {
      // Analytics is non-critical.
    }
  }

  async getPopularQueries(
    orgId: string,
    limit: number = 50,
  ): Promise<Array<{ query: string; count: number }>> {
    try {
      const results = await getRedis().zrevrange(
        `${PREFIXES.POPULAR}${orgId}`,
        0,
        limit - 1,
        'WITHSCORES',
      );
      const queries: Array<{ query: string; count: number }> = [];
      for (let index = 0; index < results.length; index += 2) {
        queries.push({ query: results[index], count: Number(results[index + 1]) });
      }
      return queries;
    } catch {
      return [];
    }
  }
}

export async function checkSessionIdempotency(clientId: string): Promise<boolean> {
  try {
    const result = await getRedis().set(
      `${PREFIXES.SESSION_DEDUP}${clientId}`,
      '1',
      'EX',
      86400,
      'NX',
    );
    return result === 'OK';
  } catch {
    return true;
  }
}

export async function checkCacheHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    await getRedis().ping();
    return { healthy: true, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  }
}

export async function closeCache(): Promise<void> {
  if (!redis) return;
  await redis.quit();
  redis = null;
  logger.info('Redis connection closed');
}
