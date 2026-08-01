# Getting Started

## Docker Compose (recommended)

```bash
git clone https://github.com/mihaibalaci/synapse.git
cd synapse
docker compose -f infra/docker/docker-compose.yml up --build
```

Compose starts PostgreSQL, Redis, MinIO, Ollama, the API, worker, and Flutter UI. Migrations run automatically.

### Bootstrap admin

```bash
docker compose exec api env \
  AUTH_BOOTSTRAP_EMAIL=admin@synapse.local \
  AUTH_BOOTSTRAP_PASSWORD=ChangeMeNow123 \
  /usr/local/bin/synapse auth-bootstrap
```

Open `http://localhost:8080` and sign in.

## Native Installation

See [INSTALLATION.md](INSTALLATION.md) for the component-by-component installer.

## First Capture

### Using curl

```bash
export TOKEN=$(curl -sS -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@synapse.local","password":"ChangeMeNow123","organizationId":"default"}' \
  | jq -r .accessToken)

curl -X POST http://localhost:3000/api/v1/capture/passive \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      {"role": "user", "content": "We chose Redis for the session cache with a 5-minute TTL."},
      {"role": "assistant", "content": "Recorded. The short TTL avoids stale data without explicit invalidation."}
    ],
    "source": "manual",
    "repository": "org/my-service"
  }'
```

### Using Python SDK

```bash
pip install -e sdks/python
```

```python
from synapse_sdk import SynapseClient
client = SynapseClient(base_url="http://localhost:3000", token=TOKEN)
client.capture(messages=[...], repository="org/repo")
results = client.search("How does the cache expire?")
```

### Using MCP (IDE integration)

Add to your IDE's MCP configuration:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "/usr/local/bin/synapse",
      "args": ["mcp"],
      "env": { "SYNAPSE_TOKEN": "sk_synapse_..." }
    }
  }
}
```

### Using Git capture

```bash
curl -X POST http://localhost:3000/api/v1/capture/git \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type": "pr", "repository": "org/repo", "title": "Add auth module", "body": "Implements login/logout..."}'
```

## Search

```bash
curl -X POST http://localhost:3000/api/v1/search \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query": "How does our caching work?", "topK": 5, "includeContent": true}'
```

Or use the Search page in the admin UI.

## API Keys (for CI/MCP/CLI)

Create a key from the UI (API Keys page) or via API:

```bash
curl -X POST http://localhost:3000/api/v1/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name": "CI Pipeline", "scopes": ["read", "write"]}'
```

The full key is shown only once. Use it as a bearer token in subsequent requests.

## Next Steps

- Explore the [API Reference](API.md)
- Set up [webhooks](API.md#webhooks) for event-driven workflows
- Configure an [LLM provider](API.md#llm-settings) for reflection and compaction
- Browse the [Knowledge Graph](API.md#graph-reasoning) from the admin panel
