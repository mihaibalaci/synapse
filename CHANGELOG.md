# Changelog

All notable changes to Synapse are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/mihaibalaci/synapse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mihaibalaci/synapse/releases/tag/v0.1.0
