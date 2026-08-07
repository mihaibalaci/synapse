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


---

## Temporal Versioning

Temporal versioning tracks how facts evolve over time, enabling point-in-time queries, evolution tracking, and change frequency analysis.

### Point-in-Time Query

`POST /api/v1/temporal/point-in-time`

Returns facts that were active at a specific moment in time. Useful for answering "what did we believe about X on date Y?"

```json
{
  "asOf": "2026-03-15T10:00:00Z",
  "entities": ["PostgreSQL", "caching"],
  "types": ["decision"],
  "limit": 20
}
```

Response:
```json
{
  "asOf": "2026-03-15T10:00:00Z",
  "results": [
    {
      "factId": "uuid",
      "content": "Decision: We will use PostgreSQL with JSONB for the event store.",
      "factType": "decision",
      "confidence": 0.85,
      "observedAt": "2026-02-01T09:00:00Z",
      "validFrom": "2026-02-01T09:00:00Z",
      "validUntil": null,
      "canonicalTopic": "PostgreSQL:event-store",
      "versionCount": 2,
      "changeFrequency": 0.5,
      "temporalStatus": "active"
    }
  ],
  "count": 1
}
```

### Evolution Query

`GET /api/v1/temporal/evolution?entity=PostgreSQL&limit=50`
`GET /api/v1/temporal/evolution?topic=PostgreSQL:caching&limit=50`

Returns the full version history of an entity or topic, ordered chronologically. Shows how knowledge evolved.

Response:
```json
{
  "entity": "PostgreSQL",
  "results": [
    {
      "factId": "uuid-v1",
      "content": "Decision: Use PostgreSQL for all persistent storage.",
      "factType": "decision",
      "observedAt": "2026-01-15T10:00:00Z",
      "temporalStatus": "superseded"
    },
    {
      "factId": "uuid-v2",
      "content": "Decision: Use PostgreSQL for OLTP, but add ClickHouse for analytics workloads.",
      "factType": "decision",
      "observedAt": "2026-04-20T14:30:00Z",
      "temporalStatus": "active"
    }
  ],
  "count": 2
}
```

### Temporal Edges

`GET /api/v1/temporal/edges?entity=Redis&asOf=2026-06-01T00:00:00Z`

Returns time-bounded relationships between entities as of a specific date.

Response:
```json
{
  "entity": "Redis",
  "asOf": "2026-06-01T00:00:00Z",
  "edges": [
    {
      "sourceEntity": "Redis",
      "targetEntity": "session-management",
      "relation": "decided-for",
      "validFrom": "2026-03-01T10:00:00Z",
      "validUntil": null,
      "weight": 2.1,
      "confidence": 0.85
    }
  ],
  "count": 1
}
```

### Volatile Topics

`GET /api/v1/temporal/volatile?limit=20`

Returns topics that change most frequently, ordered by change frequency (versions per month). Useful for identifying unstable decisions that may need review.

Response:
```json
{
  "topics": [
    {
      "canonicalTopic": "CI-CD:pipeline",
      "entities": ["GitHub-Actions", "Buildkite", "CI-CD"],
      "versionCount": 4,
      "changeFrequency": 1.33,
      "firstObservedAt": "2026-01-01T10:00:00Z",
      "lastUpdatedAt": "2026-06-15T09:00:00Z"
    }
  ],
  "count": 1
}
```

### Change Log

`GET /api/v1/temporal/changelog?chainId=<uuid>&limit=50`

Returns the audit trail for a specific version chain, showing what changed and why.

Response:
```json
{
  "chainId": "uuid",
  "changes": [
    {
      "changeType": "evolution",
      "changeReason": "",
      "detectedBy": "auto",
      "changedAt": "2026-04-20T14:30:00Z",
      "previousFactId": "uuid-v1",
      "newFactId": "uuid-v2"
    }
  ],
  "count": 1
}
```

---

## Multi-Modal Document Capture

### Upload Document

`POST /api/v1/capture/document`

Accepts multipart/form-data or JSON with base64-encoded content.

**Multipart form:**
```
POST /api/v1/capture/document
Content-Type: multipart/form-data

file: <binary file data>
repository: my-service (optional)
source: manual-upload (optional)
```

**JSON:**
```json
{
  "filename": "architecture.pdf",
  "content": "<base64-encoded file data>",
  "contentType": "application/pdf",
  "repository": "my-service",
  "source": "manual-upload"
}
```

Supported formats: PDF, PNG, JPEG, WEBP, SVG, draw.io, Markdown, HTML, plain text, code files (Go, Python, JS, TS, Java, Rust, Ruby, C/C++, Kotlin).

Response:
```json
{
  "documentId": "uuid",
  "sessionId": "uuid",
  "filename": "architecture.pdf",
  "documentType": "pdf",
  "extractedText": "First 500 chars of extracted text...",
  "sections": 5,
  "pages": 12,
  "tokens": 3400,
  "status": "processing"
}
```
