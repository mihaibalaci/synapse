# IDE and MCP Setup

The Go binary runs an MCP stdio server and forwards tools to the HTTP API.

## Prerequisites

1. Install/copy the Synapse binary on the machine running the IDE.
2. Create a JWT with the correct issuer, audience, `sub`, and `organization_id`.
3. Store it in a user-only file:

```bash
install -m 0600 /dev/null "$HOME/.synapse-token"
printf '%s' "$SYNAPSE_TOKEN" >"$HOME/.synapse-token"
```

Using `SYNAPSE_TOKEN_FILE` avoids putting credentials directly in IDE configuration.

## Kiro / compatible MCP configuration

```json
{
  "mcpServers": {
    "synapse": {
      "command": "/usr/local/bin/synapse",
      "args": ["mcp"],
      "env": {
        "SYNAPSE_API_URL": "https://synapse.example.com",
        "SYNAPSE_TOKEN_FILE": "/Users/you/.synapse-token"
      }
    }
  }
}
```

Use the equivalent absolute token path on Linux or Windows. Restart/reconnect the MCP server after changing configuration.

## Tools

The server exposes search/context/facts/history, session/insight save, and reflect-facing tools. The HTTP reflect endpoint is currently a placeholder, so the reflect tool does not yet perform LLM synthesis.

## Zero-Config Setup

```bash
# Recommended: auto-generate config for your agent
synapse wrap claude     # Claude Code / Claude Desktop
synapse wrap cursor     # Cursor IDE
synapse wrap codex      # OpenAI Codex CLI
synapse wrap kiro       # Kiro IDE
synapse wrap muse       # Meta Muse Code
synapse wrap vscode     # VS Code
synapse wrap continue   # Continue.dev
synapse wrap cline      # Cline

# With options
synapse wrap muse --token sk_synapse_abc123 --url http://192.168.1.100:3000

# Remove configuration
synapse unwrap muse
```

## Meta Muse Code

Muse Code supports MCP servers via its `~/.muse/mcp.json` configuration file, the same format used by other MCP-compatible agents.

### Automatic Setup

```bash
synapse wrap muse
```

### Manual Setup

Create or edit `~/.muse/mcp.json`:

```json
{
  "mcpServers": {
    "synapse": {
      "command": "/usr/local/bin/synapse",
      "args": ["mcp"],
      "env": {
        "SYNAPSE_API_URL": "http://localhost:3000",
        "SYNAPSE_TOKEN_FILE": "/Users/you/.synapse-token"
      }
    }
  }
}
```

Restart Muse Code to pick up the new MCP server. Synapse provides 11 tools that Muse Code's Spark 1.2 model can call:

- `search_knowledge` — 4-signal hybrid search over team memory
- `get_context` — retrieve relevant context for current task
- `get_facts` — query atomic facts by entity/type
- `get_fact_history` — temporal evolution of an entity
- `reflect_on_knowledge` — LLM reasoning over stored knowledge
- `save_session` — capture the current conversation
- `save_insight` — store a quick insight or decision
- `capture_git` — ingest git commits/PRs/diffs
- `graph_entity` — explore entity relationships
- `graph_path` — find shortest path between entities
- `feedback` — rate search result quality

### Using with Meta Model API

If using Muse Code with a remote Synapse deployment, set the API URL to your server:

```bash
synapse wrap muse --url https://synapse.yourteam.com --token sk_synapse_...
```

## Diagnose

```bash
SYNAPSE_API_URL=https://synapse.example.com \
SYNAPSE_TOKEN_FILE="$HOME/.synapse-token" \
/usr/local/bin/synapse mcp
```

MCP uses stdin/stdout JSON-RPC, so it will wait for input. Check API connectivity separately:

```bash
curl -fsS https://synapse.example.com/health/ready
curl -fsS -H "Authorization: Bearer $(cat "$HOME/.synapse-token")" \
  https://synapse.example.com/api/v1/stats
```

Do not commit token files or use the nginx-injected admin token for IDE clients.
