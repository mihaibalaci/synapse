# Getting Started

## Native single-server setup

Use the component installer for the quickest supported setup:

```bash
git clone https://github.com/mihaibalaci/synapse.git
cd synapse
cp deploy/install.env.example /root/synapse-install.env
chmod 600 /root/synapse-install.env
sudo deploy/install.sh --interactive
```

See [INSTALLATION.md](INSTALLATION.md) for external services, non-interactive installs, one-component runs, migrations, and security notes.

## Run from source

Requirements: Go matching `go/go.mod`, PostgreSQL with pgvector, Redis, S3/MinIO, and a 768-dimensional embedding provider.

```bash
export DATABASE_URL='postgresql://synapse_app:...@127.0.0.1:5432/synapse'
export REDIS_URL='redis://127.0.0.1:6379'
export S3_ENDPOINT='http://127.0.0.1:9000'
export S3_BUCKET='synapse-raw'
export S3_REGION='us-east-1'
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
export EMBEDDING_PROVIDER=ollama
export EMBEDDING_URL='http://127.0.0.1:11434'
export EMBEDDING_MODEL=nomic-embed-text
export EMBEDDING_DIMENSIONS=768
export AUTH_ISSUER='https://auth.synapse.local'
export AUTH_AUDIENCE=synapse
export AUTH_JWT_SECRET='at-least-32-characters-change-me'

cd go
go run ./cmd/synapse migrate
go run ./cmd/synapse serve
# second terminal, same environment
go run ./cmd/synapse worker
```

Readiness: `curl -fsS http://127.0.0.1:3000/health/ready`.

## Docker Compose

Copy `infra/docker/.env.example` to `.env`, replace all credentials, ensure Ollama is reachable at the configured `EMBEDDING_URL`, then:

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

Compose runs migration before API/worker startup. After the first boot, create an admin user:

```bash
docker compose exec api env \
  AUTH_BOOTSTRAP_EMAIL=admin@synapse.local \
  AUTH_BOOTSTRAP_PASSWORD=ChangeMeNow123 \
  /usr/local/bin/synapse auth-bootstrap
```

Then open `http://localhost:8080` and sign in with those credentials.

## Service-token authenticated capture test

For non-browser clients (MCP, CLI, CI pipelines), mint a JWT with HS256 and claims like:

```json
{
  "sub": "developer-1",
  "organization_id": "default",
  "roles": ["admin"],
  "team_ids": [],
  "repository_access": [],
  "iss": "https://auth.synapse.local",
  "aud": "synapse",
  "exp": 1999999999
}
```

Then:

```bash
curl -fsS -X POST http://127.0.0.1:3000/api/v1/capture/passive \
  -H "Authorization: Bearer $SYNAPSE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"We decided to use PostgreSQL."},{"role":"assistant","content":"Record that architecture decision."}],"source":"smoke-test","repository":"demo"}'

curl -fsS -X POST http://127.0.0.1:3000/api/v1/search \
  -H "Authorization: Bearer $SYNAPSE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"Which database did we choose?","topK":5,"includeContent":true}'
```

## Development checks

```bash
cd go && go test ./... && go vet ./... && go build ./...
cd ../packages/retrieval-engine && cargo test
cd ../admin-ui && flutter analyze && flutter test && flutter build web
```
