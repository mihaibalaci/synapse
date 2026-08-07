# Synapse Solo Mode

Solo mode lets individual developers use Synapse without deploying PostgreSQL, Redis, or S3. Everything runs in a single process and stores data in `~/.synapse/`.

## Quick Start

```bash
# Initialize (creates ~/.synapse/)
synapse solo init

# Start the server
synapse solo

# That's it. API is at http://localhost:3333
```

## What You Get

- Full capture API (passive and active sessions)
- Keyword search (TF-IDF based, no external DB needed)
- Vector search (when Ollama is available locally)
- MCP server support (same config as full mode)
- File-based object storage (no S3/MinIO)
- In-memory cache (no Redis)
- Zero-config setup

## What's Different from Full Mode

| Feature | Solo Mode | Full Mode |
|---------|-----------|-----------|
| Storage | Filesystem (~/.synapse/) | PostgreSQL + S3 |
| Cache | In-memory | Redis |
| Vector search | Brute-force cosine (fast for <100K chunks) | pgvector HNSW ANN |
| Keyword search | TF-IDF | PostgreSQL tsvector + BM25 |
| Team isolation | Single user | Multi-tenant RBAC |
| Horizontal scaling | Single process | Multi-node |
| Queue processing | Synchronous (inline) | Async worker pool |
| Auth | None (localhost only) | JWT + OIDC + API keys |

## Configuration

Solo mode config lives at `~/.synapse/config.json`:

```json
{
  "dataDir": "/Users/you/.synapse",
  "port": 3333,
  "embeddingModel": "nomic-embed-text",
  "embeddingUrl": "http://localhost:11434",
  "llmProvider": "local-none",
  "llmModel": "",
  "autoCapture": true,
  "maxChunks": 0,
  "compactionHours": 24
}
```

### Options

- `port` — API server port (default: 3333)
- `embeddingModel` — Ollama model name for embeddings
- `embeddingUrl` — Ollama API URL
- `autoCapture` — Enable passive capture from IDE plugins
- `maxChunks` — Cap on stored chunks (0 = unlimited)
- `compactionHours` — Auto-compaction interval (0 = disabled)

## MCP Integration

Solo mode works with the same MCP server. Point it at localhost:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "synapse",
      "args": ["mcp"],
      "env": {
        "SYNAPSE_API_URL": "http://localhost:3333"
      }
    }
  }
}
```

## IDE Plugin Setup

For Claude, Cursor, Kiro, or any MCP-compatible tool:

```bash
# Set the environment variable
export SYNAPSE_API_URL=http://localhost:3333

# Or use a token file (solo mode accepts any token)
echo "solo" > ~/.synapse/token
export SYNAPSE_TOKEN_FILE=~/.synapse/token
```

## Commands

```bash
synapse solo              # Start the server
synapse solo init         # Initialize data directory
synapse solo status       # Show memory statistics
synapse solo export       # Export all data as JSON
synapse solo --data-dir /path/to/dir  # Use custom data directory
```

## Data Directory Structure

```
~/.synapse/
├── config.json           — Configuration
├── objects/              — Raw session payloads
│   └── sessions/
│       └── solo-*.json   — Captured conversations
└── cache/                — Optional disk cache
```

## Upgrading to Full Mode

When you outgrow solo mode (team use, >100K memories, need for RBAC):

```bash
# Export solo data
synapse solo export > my-knowledge.json

# Set up full mode
docker compose -f infra/docker/docker-compose.yml up -d
synapse migrate

# Import (coming soon)
synapse import --file my-knowledge.json
```

## Performance Expectations

Solo mode is optimized for personal scale:

| Metric | Expected |
|--------|----------|
| Keyword search latency | <10ms for 10K chunks |
| Vector search latency | <50ms for 10K chunks, ~500ms for 100K |
| Memory usage | ~100MB base + ~1KB per indexed chunk |
| Disk usage | ~2KB per captured session |
| Startup time | <100ms |
