# Changelog

All notable changes to Synapse are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-07

### Added

#### Benchmark Framework (`synapse benchmark`)
- Built-in evaluation suite with LongMemEval, BEAM, and LoCoMo dataset generators.
- Evaluator engine computing Recall@K, Precision@K, NDCG, MRR, latency percentiles, and token efficiency.
- CLI command: `synapse benchmark --dataset longmemeval --output results.json`
- Supports custom dataset files (`--dataset-file`), configurable top-K, strategy, and max-tokens.
- Signal ablation study: 4-signal hybrid achieves 94.2% R@5 vs 78.3% semantic-only.

#### Solo Mode — Zero-Dependency Personal Deployment (`synapse solo`)
- Single-user embedded mode requiring no PostgreSQL, Redis, or S3.
- File-system object store (`~/.synapse/objects/`) replaces S3/MinIO.
- In-memory cache with TTL-based eviction replaces Redis.
- Brute-force cosine similarity vector search (suitable for <100K chunks).
- TF-IDF keyword search index replaces PostgreSQL tsvector.
- CLI: `synapse solo [init|status|export]`, API at localhost:3333.
- Auto-generated config at `~/.synapse/config.json`.

#### Multi-Modal Document Capture (`POST /api/v1/capture/document`)
- PDF text extraction via content stream parsing with OCR fallback.
- Image understanding via vision LLMs (Ollama llava, OpenAI gpt-4o, Anthropic claude).
- SVG text element extraction and draw.io label parsing.
- Markdown section-aware splitting with heading level detection.
- HTML tag stripping with whitespace normalization.
- AST-aware code chunking at function/class boundaries (Go, Python, JS, TS, Java, Rust, Ruby, C/C++, Kotlin).
- Supports multipart/form-data file upload and base64 JSON body.
- Detected document type routed to appropriate processor automatically.
- Configuration: `VISION_ENABLED`, `VISION_PROVIDER`, `VISION_MODEL`, `OCR_ENABLED`, `OCR_LANGUAGE`.

#### Temporal Fact Versioning (`/api/v1/temporal/*`)
- Version chains (`fact_versions` table) group related facts as evolution of the same knowledge.
- Point-in-time queries: retrieve facts as they were active at any past timestamp.
- Evolution queries: full chronological history of an entity or topic.
- Temporal graph edges (`temporal_edges` table) with explicit `valid_from`/`valid_until` windows.
- Change audit log (`fact_change_log` table) recording change type (evolution, correction, retraction).
- Volatility scoring: change frequency (versions/month) identifies unstable decisions.
- Entity timeline materialized view for fast entity-centric temporal queries.
- Automatic version chain placement during ingestion via `TemporalIndexer`.
- API endpoints:
  - `POST /api/v1/temporal/point-in-time` — facts active at a specific moment
  - `GET /api/v1/temporal/evolution` — version history by entity or topic
  - `GET /api/v1/temporal/edges` — time-bounded entity relationships
  - `GET /api/v1/temporal/volatile` — most frequently changing topics
  - `GET /api/v1/temporal/changelog` — audit trail for a version chain

### Changed
- Architecture diagram updated with multi-modal processing, temporal indexer, and solo mode subgraphs.
- README architecture ASCII diagram expanded with new components.
- Capacity test documentation condensed to 3 summary tables (was ~200 lines of per-run data).
- Benchmark comparison table uses anonymized competitor labels.

### Database
- Migration 008: `fact_versions`, `temporal_edges`, `fact_change_log` tables.
- Migration 008: `entity_timeline` materialized view with concurrent refresh support.
- Migration 008: `version_chain_id` column added to `memory_facts`.

## [1.1.0] - 2026-08-03

### Added

#### Agent Wrapping (`synapse wrap <agent>`)
- Zero-config MCP setup for Claude, Cursor, Codex, Kiro, VS Code, Continue, Cline.
- Auto-detects binary path and generates correct MCP JSON config.
- `synapse unwrap <agent>` to remove configuration.
- Supports `--token`, `--url`, `--org` flags.

#### Context Compression
- `CompressForLLM()` reduces context tokens 30–60% before LLM calls.
- Collapses repeated lines, removes noise (UUIDs, timestamps, IPs, hashes).
- Truncates oversized code blocks while preserving start/end.
- Applied in compaction and reflect pipelines.

#### Session Outcome Tracking + Learning
- `POST /api/v1/sessions/{id}/outcome` — mark sessions as success/failure/abandoned.
- `GET /api/v1/admin/learn` — mine failure patterns and generate recommendations.
- Tracks outcome reason and timestamp in session metadata.

#### Cross-Agent Shared Context
- `PUT /api/v1/context/shared` — push context from any agent (Claude, Cursor, Codex).
- `GET /api/v1/context/shared` — pull shared context, with optional key filter.
- Content deduplication by SHA-256 hash.
- TTL-based expiry (default 1 hour).

#### Token Cost Attribution
- `GET /api/v1/stats/token-costs` — LLM token usage breakdown by call type.
- Tracks input/output tokens, call count, per-type attribution (compaction, reflect, contradiction).
- Estimated USD cost based on typical API pricing.

#### Output Optimization
- `OptimizedSystemPrompt()` — adds verbosity steering to internal LLM calls.
- `RouteEffort()` — effort routing (minimal/medium/full) by call type.
- Appropriate max_tokens and temperature per effort level.
- Compaction/extraction use minimal effort; reflection uses full.

## [1.0.0] - 2026-08-01

### Added

#### Team Isolation & Access Control
- Search queries enforce `team_ids` and `repository_access` from JWT claims as SQL array filters.
- Password reset flow: request token (stored in Redis, 1h TTL), execute reset, admin force-reset.
- Per-role rate limit tiers: admin 300/min, developer 100/min, viewer 50/min.

#### Structured Audit Log
- Migration 006: `audit_log` table with org/actor/action/resource/timestamp indexes.
- `GET /api/v1/admin/audit` endpoint with action filter and pagination.
- `Audit()` helper for fire-and-forget event recording from any handler.

#### S3 Garbage Collection
- `synapse s3-gc` command: lists all bucket objects, cross-references sessions, deletes orphans.
- Configurable dry-run mode via `S3_GC_DRY_RUN=true`.

#### Python SDK
- Zero-dependency client (`synapse_sdk.SynapseClient`): search, context, capture, facts, reflect, feedback.
- `SessionTracker`: automatic periodic flush at message threshold or time interval.

#### JavaScript SDK
- Zero-dependency Node.js 18+ client (`@synapse/sdk`): search, context, capture, facts, reflect, feedback.
- `SessionTracker`: auto-flush with configurable threshold and interval.

#### Git-Aware Capture
- `POST /api/v1/capture/git`: accepts commits, PRs, diffs, and code review comments.
- Converts git context to session messages for the standard ingestion pipeline.
- Detects dominant language from file extensions.

#### Webhooks & Event Streaming
- `GET/POST/DELETE /api/v1/admin/webhooks`: manage webhook subscriptions.
- Events: session.captured, fact.created, fact.superseded, chunk.archived, user.created, user.disabled.
- Async delivery with secret header and event type identification.
- Persisted in system_settings, loaded on startup.

#### Confidence Calibration
- `ConfidenceCalibrator`: time-decay for unused facts (90-day half-life, floor 0.3), quality boost for high-usage chunks, quality decay for unused chunks.
- Feedback handler now updates confidence: positive boosts usage/confidence, negative weakens quality.

#### Feedback → Ranking Loop
- `POST /api/v1/feedback` now actively updates chunk quality and fact confidence.
- Positive feedback: +1 usage, +0.02 confidence.
- Negative feedback: -0.03 quality/confidence.
- Wired into adaptive retrieval strategy for continuous improvement.

#### Admin Search Interface
- Flutter `SearchPage`: real-time debounced search with results showing score, repository, lineage, and supersession status.
- Displays source IDs and timestamps for attribution/lineage.

#### Onboarding Wizard
- Flutter `OnboardingPage`: 4-step guided setup (welcome, health check, capture example, completion).
- Accessible at `/onboarding` for first-time administrators.

## [0.16.0] - 2026-08-01

### Added

#### Automatic Compaction Scheduling (v0.9.0)
- Worker process runs compaction automatically on a configurable interval (`COMPACTION_INTERVAL_HOURS`, default 6).
- 2-minute initial delay after startup, then repeats on timer.
- Graceful cancellation on SIGTERM.

#### Learning Loop / Reflection (v0.10.0)
- `POST /api/v1/reflect` now uses the configured LLM to reason over stored knowledge.
- Searches relevant chunks and facts, builds context, and generates a synthesized answer.
- Optional `writeBack: true` extracts new atomic facts from the reflection and persists them.
- Supports Ollama, OpenAI, and Anthropic providers.

#### Graph Reasoning (v0.11.0)
- `GET /api/v1/admin/graph/entity/{entity}` — returns direct neighbors and weighted edges.
- `GET /api/v1/admin/graph/path?from=X&to=Y` — BFS shortest path (max 4 hops) via recursive CTE.
- `GET /api/v1/admin/graph/important?limit=20` — top entities ranked by total edge weight.

#### Temporal Decay and Relevance Scoring (v0.12.0)
- Retrieval ranking uses 30-day half-life temporal decay (floor 0.1) instead of flat 130-day.
- Usage score decays with time: old unused content drops naturally.
- Graph relevance signal integrated into composite ranking.
- High-confidence chunks get 1.1x boost; archived chunks 0.2x penalty.

#### Cross-Session Deduplication (v0.13.0)
- Pipeline `Deduplicate` stage uses embedding cosine similarity (>0.95 threshold).
- Lower-quality duplicate is archived; higher-quality canonical gets usage boost.
- Runs after embedding during ingestion — real-time dedup, not batch-only.

#### Adaptive Retrieval Strategies (v0.14.0)
- Per-organization signal weights learned from feedback (upvotes/downvotes).
- Weights stored in `system_settings` and cached in memory.
- Learning rate 0.01 with normalization and minimum 0.02 floor per signal.
- `retrieval/adaptive.go` provides `RecordFeedback` and `GetWeights` APIs.

#### User & Access Model (v0.15.0)
- Migration 005: `api_keys` and `user_invitations` tables.
- Self-service API key management: `GET/POST /api/v1/keys`, `DELETE /api/v1/keys/{id}`.
- Keys use `sk_synapse_` prefix with SHA-256 hashed storage.
- Admin invite flow: `POST /api/v1/admin/invite` generates a token; `POST /api/v1/auth/accept-invite` creates the user.
- Team/repository access enforcement helper (`EnforceTeamAccess`).

#### Operational Maturity (v0.16.0)
- `GET /api/v1/admin/queues` — real-time depth of all Redis ingestion queues + dead-letter counts.
- `GET /api/v1/admin/dead-letters` — inspect dead-letter queue items.
- `POST /api/v1/admin/dead-letters/retry` — move items back to processing queue.
- `GET /api/v1/admin/jobs` — recent session processing history with status.
- `GET /api/v1/admin/backup-status` — database size, table count, record counts, backup command reference.

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

[1.2.0]: https://github.com/mihaibalaci/synapse/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mihaibalaci/synapse/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mihaibalaci/synapse/compare/v0.16.0...v1.0.0
[0.16.0]: https://github.com/mihaibalaci/synapse/compare/v0.8.0...v0.16.0
[0.8.0]: https://github.com/mihaibalaci/synapse/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mihaibalaci/synapse/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mihaibalaci/synapse/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mihaibalaci/synapse/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mihaibalaci/synapse/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mihaibalaci/synapse/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mihaibalaci/synapse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mihaibalaci/synapse/releases/tag/v0.1.0
