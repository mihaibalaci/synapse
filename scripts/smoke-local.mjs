import { createHmac, randomUUID } from 'node:crypto';

const apiUrl = process.env.RECALL_API_URL ?? 'http://localhost:3000';
const secret = process.env.AUTH_JWT_SECRET ?? 'synapse-local-development-secret-change-before-sharing';
const issuer = process.env.AUTH_ISSUER ?? 'https://auth.synapse.local';
const audience = process.env.AUTH_AUDIENCE ?? 'synapse';
const organizationId = `smoke-org-${Date.now()}`;
const developerId = 'smoke-developer';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const header = encode({ alg: 'HS256', typ: 'JWT' });
const payload = encode({
  sub: developerId,
  organization_id: organizationId,
  team_ids: ['smoke-team'],
  roles: ['developer'],
  repository_access: ['synapse/smoke'],
  iss: issuer,
  aud: audience,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
});
const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
const token = `${header}.${payload}.${signature}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${text}`);
  return body;
}

const ready = await request('/health/ready', { headers: {} });
if (ready.status !== 'ready') throw new Error(`API is not ready: ${JSON.stringify(ready)}`);

const now = new Date();
const messages = Array.from({ length: 10 }, (_, index) => ({
  id: randomUUID(),
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: index === 8
    ? 'The root cause was a Recall smoke retry timeout in the queue worker.'
    : index === 9
      ? 'The fix is to always persist queue intent in the transactional outbox before publishing.'
      : `Recall smoke diagnostic step ${index + 1} verifies durable ingestion and searchable context.`,
  codeBlocks: [],
  timestamp: new Date(now.getTime() + index * 1000).toISOString(),
  tokenCount: 20,
  toolCalls: [],
}));
const clientId = randomUUID();
const upload = await request('/api/v1/sessions', {
  method: 'POST',
  body: JSON.stringify({
    clientId,
    messages,
    metadata: {
      project: 'synapse-smoke',
      language: 'typescript',
      languages: ['typescript'],
      frameworks: ['fastify'],
      aiProvider: 'kiro',
      aiModel: 'local-smoke',
      tags: ['smoke-test'],
    },
    git: { repository: 'synapse/smoke', branch: 'main', filesTouched: [], codeDiffs: [] },
    startedAt: messages[0].timestamp,
    endedAt: messages.at(-1).timestamp,
    totalTokens: 200,
  }),
});

let status;
for (let attempt = 0; attempt < 90; attempt += 1) {
  status = await request(`/api/v1/sessions/${upload.sessionId}/status`);
  const searchTerminal = ['searchable', 'blocked', 'failed'].includes(status.searchableStatus);
  const enrichmentTerminal = ['complete', 'partial', 'failed', 'not_required'].includes(status.enrichmentStatus);
  if (searchTerminal && enrichmentTerminal) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (status.searchableStatus !== 'searchable') {
  throw new Error(`Session did not become searchable: ${JSON.stringify(status)}`);
}
if (!['complete', 'partial'].includes(status.enrichmentStatus)) {
  throw new Error(`Deep enrichment did not finish: ${JSON.stringify(status)}`);
}

const search = await request('/api/v1/search', {
  method: 'POST',
  body: JSON.stringify({
    query: 'Recall smoke retry timeout transactional outbox',
    topK: 10,
    strategy: 'hybrid',
    includeContent: true,
  }),
});
if (!Array.isArray(search.results) || search.results.length === 0) {
  throw new Error(`Search returned no results: ${JSON.stringify(search)}`);
}

const facts = await request('/api/v1/facts?limit=50');
if (!Array.isArray(facts.facts) || facts.facts.length === 0) {
  throw new Error(`Fact extraction returned no facts: ${JSON.stringify(facts)}`);
}

console.log(JSON.stringify({
  ready: true,
  sessionId: upload.sessionId,
  searchableStatus: status.searchableStatus,
  enrichmentStatus: status.enrichmentStatus,
  searchResults: search.results.length,
  facts: facts.facts.length,
}, null, 2));
