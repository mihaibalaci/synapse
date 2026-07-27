# Recall — MCP Server

Exposes the organizational knowledge base as MCP tools for any AI agent (Claude Desktop, Cursor, Kiro, Windsurf, Cline).

## Tools

| Tool | Description |
|------|-------------|
| `search_knowledge` | Semantic search across all engineering knowledge |
| `get_context` | Get ranked context for a coding task (token-budget aware) |
| `get_facts` | Query atomic facts by entity, type, or time |
| `get_fact_history` | See how knowledge about an entity evolved |
| `save_session` | Capture a conversation to the knowledge base |
| `save_insight` | Store a single atomic fact/decision |

## Setup

Add to your MCP client configuration (e.g. `.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "RECALL_API_URL": "http://localhost:3000",
        "RECALL_TOKEN": "your-token",
        "DEVELOPER_ID": "your-id",
        "ORGANIZATION_ID": "your-org"
      }
    }
  }
}
```

## Usage Examples

Once connected, AI agents can use the tools naturally:

- "Search our knowledge base for how we handle authentication"
- "What facts do we have about Kafka?"
- "Show me the history of our database decisions"
- "Save this conversation — we just solved a tricky VPC issue"
