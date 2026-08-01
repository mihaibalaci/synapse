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
