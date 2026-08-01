# API Reference — v1.0.0

Base URL: `http://localhost:3000`

## Authentication

All endpoints except `/health`, `/health/ready`, `/metrics`, and `/api/v1/auth/*` require `Authorization: Bearer <JWT>`.

JWT requirements: HS256, configured issuer/audience, mandatory `exp`, non-empty `sub` and `organization_id`. Admin routes require `roles` containing `admin`. Team/repository isolation is enforced via `team_ids` and `repository_access` claims.

### Login

`POST /api/v1/auth/login`

```json
{ "email": "admin@synapse.local", "password": "...", "organizationId": "default" }
```

Returns `200` with `accessToken`, `tokenType`, `expiresIn`, `user`. Sets HttpOnly `synapse_refresh` cookie. Throttled to 5 attempts/IP/minute.

### Refresh

`POST /api/v1/auth/refresh` — reads cookie, returns new access token, rotates refresh. Replay triggers full session revocation.

### Logout

`POST /api/v1/auth/logout` — revokes session, clears cookie. Returns `204`.

### Current User

`GET /api/v1/auth/me` (authenticated) — returns user profile.

### OIDC

- `GET /api/v1/auth/oidc/login` — redirects to configured OIDC provider
- `GET /api/v1/auth/oidc/callback` — exchanges code, provisions user, sets cookie

### Password Reset

- `POST /api/v1/auth/password-reset/request` — `{"email": "...", "organizationId": "..."}`
- `POST /api/v1/auth/password-reset/execute` — `{"token": "...", "password": "..."}`

### Accept Invitation

`POST /api/v1/auth/accept-invite` — `{"token": "...", "password": "...", "displayName": "..."}`

### Bootstrap

```bash
AUTH_BOOTSTRAP_EMAIL=admin@synapse.local AUTH_BOOTSTRAP_PASSWORD='...' synapse auth-bootstrap
```

---

## Capture

### Passive/Active Session

`POST /api/v1/capture/passive` | `POST /api/v1/capture/active`

```json
{
  "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
  "source": "kiro", "repository": "org/repo", "language": "go"
}
```

Returns `202` with `sessionId`. Identity from JWT claims only.

### Git-Aware Capture

`POST /api/v1/capture/git`

```json
{
  "type": "pr",
  "repository": "org/repo",
  "branch": "feature/auth",
  "commitSha": "abc123",
  "author": "dev-alice",
  "title": "Add authentication module",
  "body": "Implements login/logout...",
  "files": [{"path": "auth.go", "action": "added", "diff": "...", "language": "go"}],
  "comments": [{"author": "reviewer", "body": "Consider rate limiting", "path": "auth.go", "line": 42}],
  "labels": ["security"]
}
```

Accepts: `commit`, `pr`, `diff`, `review` types. Converts to session messages for the standard pipeline.

---

## Search & Retrieval

### Search

`POST /api/v1/search`

```json
{
  "query": "How does the Redis cache expire?",
  "context": {"repository": "org/repo"},
  "topK": 5, "maxTokens": 3000,
  "strategy": "hybrid", "includeContent": true
}
```

4-signal retrieval: semantic (pgvector), keyword (FTS), entity overlap, graph neighbors. Results include `supersededBy`/`supersedes` for contradiction lineage.

### Context

`POST /api/v1/context` — same as search with `topK=10`, `maxTokens=3000`, `includeContent=true`.

### Reflect (Learning Loop)

`POST /api/v1/reflect`

```json
{ "query": "What authentication patterns does the team prefer?", "writeBack": true, "maxFacts": 3 }
```

Uses configured LLM to reason over stored knowledge. With `writeBack: true`, extracts new facts and persists them. Returns `answer`, `confidence`, `sources`, `insights`.

---

## Facts

- `GET /api/v1/facts?entities=Redis,PostgreSQL&types=decision&limit=10`
- `GET /api/v1/facts/{entity}/history?limit=50`
- `POST /api/v1/facts` — create with `content`, `type`, `entities`, `confidence`

Types: `decision`, `lesson`, `pattern`, `constraint`, `opinion`.

---

## Feedback

`POST /api/v1/feedback`

```json
{ "resultId": "chunk-uuid", "score": 1, "query": "original query" }
```

Positive score boosts chunk quality/fact confidence; negative weakens it. Wired into adaptive retrieval.

---

## API Keys (Self-Service)

- `GET /api/v1/keys` — list your active API keys
- `POST /api/v1/keys` — `{"name": "CI Pipeline", "scopes": ["read","write"], "expiresInDays": 90}`
- `DELETE /api/v1/keys/{id}` — revoke a key

Keys use `sk_synapse_` prefix. Full key shown only on creation.

---

## Administration (admin role required)

### Users

- `GET /api/v1/admin/users` — list organization users
- `POST /api/v1/admin/users` — `{"email": "...", "password": "...", "displayName": "...", "roles": ["developer"]}`
- `PUT /api/v1/admin/users/{id}` — update `displayName`, `roles`, `disabled`, `password`
- `DELETE /api/v1/admin/users/{id}` — delete (last-admin protection)
- `GET /api/v1/admin/roles` — list available roles
- `POST /api/v1/admin/invite` — `{"email": "...", "roles": ["viewer"]}`
- `POST /api/v1/admin/reset-password` — `{"userId": "...", "password": "..."}`

### Memory Browser

- `GET /api/v1/admin/chunks?q=search&limit=25&offset=0` — paginated chunk search
- `GET /api/v1/admin/chunks/{id}` — full chunk content
- `PUT /api/v1/admin/chunks/{id}` — edit `title`, `summary`, `confidence`
- `DELETE /api/v1/admin/chunks/{id}` — archive chunk
- `GET /api/v1/admin/facts?q=search&type=decision&limit=25&offset=0` — browse facts
- `DELETE /api/v1/admin/facts/{id}` — supersede fact

### Graph Reasoning

- `GET /api/v1/admin/graph/entity/{entity}` — neighbors and edge weights
- `GET /api/v1/admin/graph/path?from=Redis&to=PostgreSQL` — BFS shortest path (max 4 hops)
- `GET /api/v1/admin/graph/important?limit=20` — top entities by edge weight

### LLM Settings

- `GET /api/v1/admin/settings/llm` — current config (key masked)
- `PUT /api/v1/admin/settings/llm` — update provider/model/temperature
- `POST /api/v1/admin/settings/llm/test` — probe provider with real completion
- `GET /api/v1/admin/settings/llm/models` — discover available models

### Webhooks

- `GET /api/v1/admin/webhooks` — list subscriptions
- `POST /api/v1/admin/webhooks` — `{"url": "https://...", "events": ["fact.created", "*"], "secret": "..."}`
- `DELETE /api/v1/admin/webhooks/{id}` — remove

Events: `session.captured`, `fact.created`, `fact.superseded`, `chunk.archived`, `user.created`, `user.disabled`

### Operations

- `GET /api/v1/admin/queues` — queue depths and dead-letter counts
- `GET /api/v1/admin/dead-letters?limit=20` — inspect dead-letter items
- `POST /api/v1/admin/dead-letters/retry?limit=10` — move back to processing
- `GET /api/v1/admin/jobs?limit=50` — recent session processing history
- `GET /api/v1/admin/backup-status` — database size, counts, backup command
- `GET /api/v1/admin/audit?action=login&limit=50&offset=0` — audit log

---

## Observability

- `GET /health` — process liveness
- `GET /health/ready` — dependency checks (PostgreSQL, Redis, S3)
- `GET /metrics` — Prometheus OpenMetrics format (counters, gauges, Go runtime)

---

## CLI Commands

```
synapse serve              # API server
synapse worker             # Ingestion worker + auto-compaction
synapse migrate            # Apply schema migrations
synapse auth-bootstrap     # Create first admin
synapse compact            # Run compaction manually
synapse detect-contradictions  # Batch contradiction scan
synapse s3-gc              # Garbage collect orphaned S3 objects
synapse embed-backfill     # Fill missing embeddings
synapse verify-storage     # Check S3 consistency
synapse mcp                # MCP server (stdin/stdout)
```

---

## Rate Limiting

Per-role tiers: admin 300/min, team_lead 200/min, developer 100/min, viewer 50/min. Login endpoint independently throttled at 5/min/IP.

## Errors

```json
{"error": "ERROR_CODE", "message": "human-readable detail"}
```

Common: `400` validation, `401` invalid token, `403` missing role, `409` conflict, `429` rate limit, `500` internal, `503` dependency failure.
