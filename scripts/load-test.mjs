/**
 * Retrieval load test.
 *
 * Measures real p50/p95/p99 for the hybrid search path instead of trusting the
 * architecture's estimated budget. Two phases:
 *
 *   seed  — upload a corpus and wait until every session is searchable, so the
 *           keyword/entity/graph signals actually return tens of candidates.
 *           With a one-chunk corpus the fan-in cost is invisible.
 *   load  — closed-loop concurrent search for a fixed duration.
 *
 * Queries are unique by default so cache hits do not mask database cost. Run
 * with RECALL_LOAD_CACHED=true to measure the warm-cache path instead.
 *
 * Env:
 *   RECALL_API_URL         default http://localhost:3000
 *   RECALL_LOAD_SESSIONS   corpus size, default 120
 *   RECALL_LOAD_CONCURRENCY default 16
 *   RECALL_LOAD_DURATION_MS default 20000
 *   RECALL_LOAD_SEED_ONLY  seed and exit
 *   RECALL_LOAD_ORG        reuse an existing seeded corpus
 *   RECALL_LOAD_CACHED     repeat one query to measure cache-hit latency
 */

import { createHmac, randomUUID } from 'node:crypto';

const apiUrl = process.env.RECALL_API_URL ?? 'http://localhost:3000';
const secret = process.env.AUTH_JWT_SECRET ?? 'synapse-local-development-secret-change-before-sharing';
const issuer = process.env.AUTH_ISSUER ?? 'https://auth.synapse.local';
const audience = process.env.AUTH_AUDIENCE ?? 'synapse';
const organizationId = process.env.RECALL_LOAD_ORG ?? `load-org-${Date.now()}`;
const developerId = 'load-developer';
const sessionCount = Number(process.env.RECALL_LOAD_SESSIONS ?? 120);
const concurrency = Number(process.env.RECALL_LOAD_CONCURRENCY ?? 16);
const durationMs = Number(process.env.RECALL_LOAD_DURATION_MS ?? 20_000);
const seedOnly = process.env.RECALL_LOAD_SEED_ONLY === 'true';
const cachedMode = process.env.RECALL_LOAD_CACHED === 'true';
const reuseCorpus = Boolean(process.env.RECALL_LOAD_ORG);

const topics = [
  { subject: 'lambda timeout', entity: 'Lambda', detail: 'VPC DNS resolution delay exhausted the socket timeout' },
  { subject: 'postgres lock contention', entity: 'PostgreSQL', detail: 'a long autovacuum held a conflicting lock' },
  { subject: 'redis eviction', entity: 'Redis', detail: 'maxmemory-policy evicted queue keys under pressure' },
  { subject: 'kubernetes crashloop', entity: 'Kubernetes', detail: 'the readiness probe raced container startup' },
  { subject: 'docker build cache', entity: 'Docker', detail: 'layer ordering invalidated the dependency cache' },
  { subject: 'terraform drift', entity: 'Terraform', detail: 'an out-of-band console change diverged from state' },
  { subject: 'grpc deadline', entity: 'gRPC', detail: 'the client deadline was shorter than the server retry budget' },
  { subject: 'fastify backpressure', entity: 'Fastify', detail: 'unbounded body parsing blocked the event loop' },
  { subject: 'pgvector recall', entity: 'pgvector', detail: 'ef_search was too low for the requested top-k' },
  { subject: 'typescript build slowness', entity: 'TypeScript', detail: 'project references were not incremental' },
];

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function mintToken() {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: developerId,
    organization_id: organizationId,
    team_ids: ['load-team'],
    roles: ['developer'],
    repository_access: ['synapse/load'],
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const token = mintToken();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new HttpError(response.status, `${options.method ?? 'GET'} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
  }
  return body;
}

/**
 * Seeding is throughput work, not the measurement, so it yields to the API rate
 * limiter instead of failing. The load phase deliberately does not retry: a 429
 * there means the limiter is capping the test and the result would be invalid.
 */
async function requestWithRateLimitRetry(path, options, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request(path, options);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 429 || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  throw new Error('unreachable');
}

function buildSession(index) {
  const topic = topics[index % topics.length];
  const start = new Date(Date.now() - (sessionCount - index) * 60_000);
  const messages = Array.from({ length: 12 }, (_, messageIndex) => ({
    id: randomUUID(),
    role: messageIndex % 2 === 0 ? 'user' : 'assistant',
    content: messageIndex === 0
      ? `We hit a ${topic.subject} problem in ${topic.entity} on service ${index}. How do we debug it?`
      : messageIndex === 11
        ? `Root cause: ${topic.detail}. The fix was applied and verified in service ${index}.`
        : `Investigating ${topic.subject} with ${topic.entity}: step ${messageIndex} produced an error trace and a timeout while retrying.`,
    codeBlocks: [],
    timestamp: new Date(start.getTime() + messageIndex * 1000).toISOString(),
    tokenCount: 40,
  toolCalls: [],
  }));

  return {
    clientId: randomUUID(),
    messages,
    metadata: {
      project: `load-service-${index % 12}`,
      language: 'typescript',
      languages: ['typescript'],
      frameworks: ['fastify'],
      aiProvider: 'kiro',
      aiModel: 'load-test',
      tags: [topic.entity.toLowerCase(), 'load-test'],
    },
    git: { repository: 'synapse/load', branch: 'main', filesTouched: [], codeDiffs: [] },
    startedAt: messages[0].timestamp,
    endedAt: messages.at(-1).timestamp,
    totalTokens: 480,
  };
}

async function mapWithLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

async function seedCorpus() {
  process.stdout.write(`Seeding ${sessionCount} sessions into ${organizationId}\n`);
  const uploads = await mapWithLimit(
    Array.from({ length: sessionCount }, (_, index) => index),
    8,
    async index => {
      const body = buildSession(index);
      const result = await requestWithRateLimitRetry('/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return result.sessionId;
    },
  );

  const deadline = Date.now() + 10 * 60_000;
  const pending = new Set(uploads);
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const ids = [...pending];
    const statuses = await mapWithLimit(ids, 12, async id =>
      requestWithRateLimitRetry(`/api/v1/sessions/${id}/status`, {}).catch(() => null));
    statuses.forEach((status, index) => {
      if (!status) return;
      if (['searchable', 'blocked', 'failed'].includes(status.searchableStatus)) pending.delete(ids[index]);
    });
    process.stdout.write(`  waiting on ${pending.size} sessions\r`);
  }
  process.stdout.write('\n');
  if (pending.size > 0) throw new Error(`${pending.size} sessions never became searchable`);
  return uploads.length;
}

async function runLoad() {
  const runId = randomUUID().slice(0, 8);
  const queries = topics.map(topic => `${topic.subject} ${topic.entity} timeout error root cause`);
  const latencies = [];
  const serverLatencies = [];
  let requests = 0;
  let errors = 0;
  let rateLimited = 0;
  let cacheHits = 0;
  let emptyResults = 0;

  // Warm the connection pool and JIT so the first samples are not outliers.
  for (let index = 0; index < 5; index += 1) {
    await request('/api/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query: queries[index % queries.length], topK: 10, strategy: 'hybrid' }),
    }).catch(() => null);
  }

  const endAt = Date.now() + durationMs;
  const startedAt = Date.now();

  await Promise.all(Array.from({ length: concurrency }, async (_unused, workerIndex) => {
    let counter = 0;
    while (Date.now() < endAt) {
      const base = queries[(workerIndex + counter) % queries.length];
      // The nonce is per run, so repeat runs cannot inherit the previous run's
      // cached responses and silently report cache latency as search latency.
      const query = cachedMode ? base : `${base} variant ${runId}-${workerIndex}-${counter}`;
      counter += 1;
      const started = process.hrtime.bigint();
      try {
        const body = await request('/api/v1/search', {
          method: 'POST',
          body: JSON.stringify({ query, topK: 10, strategy: 'hybrid', includeContent: false }),
        });
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
        latencies.push(elapsedMs);
        if (typeof body.latencyMs === 'number') serverLatencies.push(body.latencyMs);
        if (body.cached) cacheHits += 1;
        if (!body.results?.length) emptyResults += 1;
      } catch (error) {
        if (error instanceof HttpError && error.status === 429) rateLimited += 1;
        else errors += 1;
      }
      requests += 1;
    }
  }));

  const wallMs = Date.now() - startedAt;
  const sorted = [...latencies].sort((a, b) => a - b);
  const sortedServer = [...serverLatencies].sort((a, b) => a - b);
  const round = value => Math.round(value * 100) / 100;

  return {
    mode: cachedMode ? 'warm-cache' : 'cache-bypassed',
    runId,
    organizationId,
    concurrency,
    durationMs: wallMs,
    requests,
    errors,
    rateLimited,
    cacheHits,
    emptyResults,
    // A non-zero value invalidates the percentiles below: raise RATE_LIMIT_MAX.
    rateLimitCappedRun: rateLimited > 0,
    throughputRps: round(requests / (wallMs / 1000)),
    clientLatencyMs: {
      min: round(sorted[0] ?? 0),
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)),
      max: round(sorted.at(-1) ?? 0),
    },
    serverReportedLatencyMs: {
      p50: round(percentile(sortedServer, 0.5)),
      p95: round(percentile(sortedServer, 0.95)),
      p99: round(percentile(sortedServer, 0.99)),
    },
  };
}

const ready = await request('/health/ready', { headers: {} });
if (ready.status !== 'ready') throw new Error(`API is not ready: ${JSON.stringify(ready)}`);

if (!reuseCorpus) {
  const seeded = await seedCorpus();
  process.stdout.write(`Seeded ${seeded} searchable sessions\n`);
} else {
  process.stdout.write(`Reusing corpus ${organizationId}\n`);
}

if (seedOnly) {
  console.log(JSON.stringify({ seeded: true, organizationId }, null, 2));
} else {
  console.log(JSON.stringify(await runLoad(), null, 2));
}
