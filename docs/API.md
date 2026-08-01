# API Reference

Default base URL: `http://localhost:3000`. All endpoints except `/health`, `/health/ready`, and the `/api/v1/auth/*` authentication endpoints require `Authorization: Bearer <JWT>`.

JWT requirements: HS256, configured issuer/audience, mandatory `exp` claim, and non-empty `sub` plus `organization_id`. Admin routes also require `roles` to contain `admin`.

## Authentication

The API provides built-in browser authentication via short-lived access tokens and rotating HttpOnly refresh cookies.

### Login

`POST /api/v1/auth/login`

```json
{
  "email": "admin@synapse.local",
  "password": "...",
  "organizationId": "default"
}
```

Returns `200` with `accessToken`, `tokenType`, `expiresIn`, and `user`. Sets an HttpOnly `synapse_refresh` cookie. Throttled to 5 attempts per IP per minute.

### Refresh

`POST /api/v1/auth/refresh`

No body required; reads the `synapse_refresh` cookie. Returns a new access token and rotates the cookie. Reuse of a revoked token triggers revocation of all user sessions.

### Logout

`POST /api/v1/auth/logout`

Revokes the current refresh session and clears the cookie. Returns `204`.

### Current user

`GET /api/v1/auth/me` (authenticated)

Returns the current user profile from the database.

### Bootstrap

First administrator is created via the CLI:

```bash
AUTH_BOOTSTRAP_EMAIL=admin@synapse.local \
AUTH_BOOTSTRAP_PASSWORD='...' \
synapse auth-bootstrap
```

This is idempotent and refuses to create a second user once any user exists in the organization.

## Implemented endpoints

### Capture

`POST /api/v1/capture/passive` and `POST /api/v1/capture/active`

Both currently use the same pipeline. Body:

```json
{
  "messages": [
    {"role": "user", "content": "We chose Redis for the short-lived cache."},
    {"role": "assistant", "content": "Record the five minute TTL and no-refresh behavior."}
  ],
  "source": "kiro",
  "repository": "org/repo",
  "language": "go"
}
```

At least two messages are required. Body `developerId`/`organizationId` values are ignored; identity comes from JWT claims. Success is `202` with `sessionId`. A raw-object or PostgreSQL failure returns `503`. Redis enqueue failure is logged but still returns `202` because the reaper can reconstruct the job.

### Search

`POST /api/v1/search`

```json
{
  "query": "How does the Redis cache expire?",
  "context": {"repository": "org/repo"},
  "topK": 5,
  "maxTokens": 3000,
  "strategy": "hybrid",
  "includeContent": true
}
```

The response contains `results`, `totalCount`, `estimatedTokens`, `latencyMs`, and `cached`. `filters` and `offset` are parsed but not yet applied.

`POST /api/v1/context` uses the same engine, defaults `topK=10`, `maxTokens=3000`, and always includes content.

### Facts

- `GET /api/v1/facts?entities=Redis,PostgreSQL&types=decision&limit=10`
- `GET /api/v1/facts/{entity}/history?limit=50`
- `POST /api/v1/facts`

Create body:

```json
{
  "content": "Search responses expire after five minutes.",
  "type": "constraint",
  "entities": ["Redis"],
  "repository": "org/repo",
  "confidence": 0.9
}
```

Types: `decision`, `lesson`, `pattern`, `constraint`, `opinion`.

### Administration

Admin role required:

- `GET|POST /api/v1/admin/users`, `PUT|DELETE /api/v1/admin/users/{id}` — currently placeholder responses, not persistent user management.
- `GET /api/v1/admin/roles` — static role list.
- `GET|PUT /api/v1/admin/settings/llm` — persisted LLM settings; API key masked on read.
- `POST /api/v1/admin/settings/llm/test` — real provider probe.
- `GET /api/v1/admin/settings/llm/models?provider=ollama&baseUrl=...` — Ollama model discovery.

LLM settings are stored in PostgreSQL JSONB. Masking protects API responses, not storage encryption.

### Status and metrics

- `GET /health` — process liveness, no dependency checks.
- `GET /health/ready` — PostgreSQL, Redis, and object-storage checks; `503` if unavailable.
- `GET /api/v1/stats` — database counts and recent activity.
- `GET /api/v1/stats/metrics` — JSON cache/object/retrieval/ingestion counters.

## Registered but not implemented

The following return placeholders and must not be integrated as complete APIs: capture events/batches, similar chunks, reflect, observations, feedback, legacy session upload/batch/status, learning trigger/stats, trending, and user CRUD. `POST /api/v1/reflect` does not call the configured LLM.

## Errors

Most handlers return:

```json
{"error": "ERROR_CODE", "message": "human-readable detail"}
```

Common statuses: `400` validation, `401` invalid/missing token, `403` missing admin role, `429` rate limit, `500` query failure, `503` durable dependency failure.
