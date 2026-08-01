# Changelog

All notable changes to Synapse are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-08-01

### Added
- Automatic contradiction detection: new facts are checked against existing valid facts sharing the same entities. When embedding similarity exceeds 0.85 with identical entity sets, the older fact is automatically marked as superseded (`temporal_valid_until`, `temporal_superseded_by`).
- `synapse detect-contradictions` CLI command for batch contradiction scanning across recent facts.
- Configurable via `CONTRADICTION_ORGANIZATION` and `CONTRADICTION_SINCE_DAYS` environment variables.
- `SearchResult` model extended with `supersededBy` and `supersedes` fields for client-side conflict display.
- Contradiction detection runs inline during fact extraction (after embedding) for real-time supersession.

### Changed
- Fact extraction pipeline now includes contradiction detection as a post-processing step.
- Conservative detection threshold (similarity > 0.85 + exact entity match) to avoid false positives.

## [0.7.0] - 2026-08-01

### Added
- Prometheus metrics endpoint at `GET /metrics` (no authentication required).
- Application counters: cache hits/misses, queries, sessions processed, chunks created, facts extracted, embeddings generated, graph updates, S3 puts/gets, errors by source.
- Application gauges: concurrent queries, peak concurrent, PostgreSQL active/max conns, Redis conns.
- Go runtime metrics: goroutines, heap/sys memory, GC pause total, GC cycles, process start time.
- Build info label via `synapse_info{version="..."}`.
- Zero external dependencies: uses plain text Prometheus exposition format.

### Changed
- `/metrics` is publicly accessible (like `/health`) for scraper compatibility. Restrict via network policy if needed.

## [0.6.0] - 2026-08-01

### Added
- Admin memory browser: search, view, edit, and delete chunks and facts from the Flutter UI.
- Backend browse endpoints: `GET /api/v1/admin/chunks`, `GET /api/v1/admin/chunks/{id}`, `PUT /api/v1/admin/chunks/{id}`, `DELETE /api/v1/admin/chunks/{id}`, `GET /api/v1/admin/facts`, `DELETE /api/v1/admin/facts/{id}`.
- Full-text chunk search with `ts_rank` ordering via `?q=` parameter.
- Fact filtering by type via `?type=` parameter.
- Pagination via `?limit=` and `?offset=` parameters.
- Flutter Memory page with tabbed Chunks/Facts view, debounced search, archive confirmation dialog, and fact supersession.
- Navigation entry: "Memory" in the side nav.

### Changed
- Chunk deletion is a soft archive (sets `confidence = 'archived'`); fact deletion marks `temporal_valid_until`.

## [0.5.0] - 2026-08-01

### Added
- Real user CRUD: list, create (with bcrypt password), update (display name, roles, disable, password reset), and delete with organization scoping.
- Last-admin lockout prevention: cannot disable, demote, or delete the only remaining admin.
- Session revocation on user disable or password change.
- Optional OIDC authentication: configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI` to enable external identity provider login.
- OIDC auto-provisions new users with `viewer` role on first login.
- OIDC discovery via `.well-known/openid-configuration`.
- New routes: `GET /api/v1/auth/oidc/login` (redirect) and `GET /api/v1/auth/oidc/callback`.

### Changed
- Admin user endpoints now persist to `auth_users` table (previously returned empty stubs).
- Duplicate email within an organization returns `409 Conflict`.

## [0.4.0] - 2026-08-01

### Added
- Knowledge graph population during ingestion: fact entities are upserted as `graph_nodes`, and co-occurring entities within the same fact create weighted `graph_edges`.
- Graph-boosted retrieval signal (Signal 4): search queries extract entities and find chunks related to graph neighbors, weighted by edge strength.
- RRF fusion now operates on 4 signals: semantic, keyword, entity, and graph.

### Changed
- `IndexGraph` pipeline stage is now a real implementation (previously a stub).
- Retrieval `scores` struct's `GraphRelevance` field is now populated.

## [0.3.0] - 2026-08-01

### Added
- Memory compaction pipeline (`synapse compact`): summarizes old session chunks via LLM, archives originals, embeds the summary for continued searchability.
- Supports Ollama, OpenAI, and Anthropic as compaction LLM providers.
- Configurable via `COMPACTION_MIN_AGE_DAYS` (default 14), `COMPACTION_MAX_PER_RUN` (default 100), `COMPACTION_WORKERS` (default 4).
- Sessions with fewer than 3 active chunks are skipped; sessions that already have a summary chunk are not re-compacted.
- Summary chunks are marked `type = 'summary'`, `confidence = 'high'`, and are fully searchable.
- Archived chunks retain their data but are excluded from retrieval.

### Changed
- `synapse compact` is now a real implementation (previously a no-op stub).

## [0.2.0] - 2026-08-01

### Added
- Embedded PostgreSQL migration system with advisory locking, checksums, and `synapse migrate` command.
- Built-in authentication module: login, refresh (rotating HttpOnly cookie), logout, `/api/v1/auth/me`.
- `synapse auth-bootstrap` CLI for creating the initial administrator.
- PostgreSQL-backed `auth_users` and `auth_sessions` tables with pgcrypto bcrypt.
- Login throttling (5 attempts/IP/minute) and replay-detection session revocation.
- Flutter login page with route guards, automatic 401 refresh/retry, and logout button.
- Real `/health/ready` endpoint checking PostgreSQL, Redis, and object storage.
- Admin-role middleware (`RequireRole("admin")`) for `/api/v1/admin/*` routes.
- Component installer (`deploy/install.sh`) supporting install/external/skip per service.
- Hardened systemd units running as dedicated `synapse` user.
- Docker Compose with migration ordering, Helm chart corrections, Patroni bootstrap.
- Embedding validation: provider errors, dimension/count mismatch, NaN/Inf rejection.

### Changed
- JWT middleware now requires `exp` claim (expiration mandatory).
- JWT identity comes exclusively from token claims (caller override removed).
- Search cache key includes full request body and auth context.
- Metrics use atomic operations; peak concurrency uses compare-and-swap.
- Worker uses graceful SIGTERM drain instead of unsafe WaitGroup self-restart.
- Embedding defaults changed to `nomic-embed-text` at 768 dimensions.
- nginx template forwards browser Authorization/cookies without injecting credentials.
- All documentation and Mermaid diagrams rewritten for accuracy.

### Removed
- Global `appInstance` variable (replaced by request-context injection).
- nginx admin JWT injection (`NGINX_INJECT_ADMIN_JWT`, `ADMIN_TOKEN_TTL_DAYS`).
- Hardcoded healthy readiness response.

### Security
- Passwords stored as bcrypt hashes (PostgreSQL pgcrypto, cost 12).
- Refresh tokens stored only as SHA-256 digests; never exposed in responses.
- Short-lived access tokens (15 min default) with required expiration.
- Constant-time password comparison to prevent timing-based enumeration.
- HttpOnly, SameSite=Strict cookies for refresh sessions.
- Environment file serialization safely quotes special characters.

## [0.1.0] - 2026-07-23

### Added
- Initial Go binary with capture, search, facts, MCP, and worker.
- Flutter admin UI with dashboard, users, system, activity pages.
- PostgreSQL schema, Redis queue, S3 raw storage.
- Basic JWT validation middleware.

[0.8.0]: https://github.com/mihaibalaci/synapse/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mihaibalaci/synapse/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mihaibalaci/synapse/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mihaibalaci/synapse/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mihaibalaci/synapse/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mihaibalaci/synapse/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mihaibalaci/synapse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mihaibalaci/synapse/releases/tag/v0.1.0
