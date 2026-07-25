# Connecting Your IDE to the Recall

## Overview

Developers connect their IDEs via two mechanisms:

| Mechanism | How it works | What it enables |
|-----------|-------------|-----------------|
| **MCP Server** | AI agent has tools to search/save knowledge | Retrieval + active capture (agent-driven) |
| **Passive capture** | Plugin auto-uploads sessions in background | Zero-friction knowledge accumulation |

For most modern AI IDEs, the MCP Server alone provides both — the agent
searches before answering and saves valuable sessions automatically.

---

## Kiro

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "recall": {
      "command": "node",
      "args": ["/path/to/recall/packages/mcp-server/dist/index.js"],
      "env": {
        "RECALL_API_URL": "https://ctx.internal.company.com",
        "RECALL_TOKEN": "<your-token>",
        "DEVELOPER_ID": "<your-alias>",
        "ORGANIZATION_ID": "<your-org>"
      }
    }
  }
}
```

The agent will automatically use `get_context` before answering questions and
`save_session` when it produces valuable insights.

---

## Cursor

Add to Cursor's MCP settings (Settings → MCP Servers → Add):

```json
{
  "recall": {
    "command": "node",
    "args": ["/path/to/recall/packages/mcp-server/dist/index.js"],
    "env": {
      "RECALL_API_URL": "https://ctx.internal.company.com",
      "RECALL_TOKEN": "<your-token>",
      "DEVELOPER_ID": "<your-alias>",
      "ORGANIZATION_ID": "<your-org>"
    }
  }
}
```

Cursor's agent will call the knowledge tools when relevant to your prompts.

---

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "recall": {
      "command": "node",
      "args": ["/path/to/recall/packages/mcp-server/dist/index.js"],
      "env": {
        "RECALL_API_URL": "https://ctx.internal.company.com",
        "RECALL_TOKEN": "<your-token>",
        "DEVELOPER_ID": "<your-alias>",
        "ORGANIZATION_ID": "<your-org>"
      }
    }
  }
}
```

---

## Windsurf

Add via Windsurf MCP configuration (similar to Cursor):

```json
{
  "recall": {
    "command": "node",
    "args": ["/path/to/packages/mcp-server/dist/index.js"],
    "env": {
      "RECALL_API_URL": "https://ctx.internal.company.com",
      "RECALL_TOKEN": "<your-token>",
      "DEVELOPER_ID": "<your-alias>",
      "ORGANIZATION_ID": "<your-org>"
    }
  }
}
```

---

## VS Code (with GitHub Copilot MCP or Cline)

### Via Cline extension:
Settings → Cline → MCP Servers → Add the same config as above.

### Via Copilot Chat (MCP preview):
`.vscode/mcp.json`:
```json
{
  "servers": {
    "recall": {
      "command": "node",
      "args": ["./packages/mcp-server/dist/index.js"],
      "env": {
        "RECALL_API_URL": "https://ctx.internal.company.com",
        "RECALL_TOKEN": "<your-token>",
        "DEVELOPER_ID": "<your-alias>",
        "ORGANIZATION_ID": "<your-org>"
      }
    }
  }
}
```

---

## Terminal Agents (Claude Code, Codex CLI, Aider)

These support MCP natively or via configuration:

**Claude Code (claude cli):**
```bash
# Add to ~/.claude/mcp_servers.json
```

**Codex CLI:**
```bash
# Uses the same MCP config format as Claude Desktop
```

---

## CLI Tool (any terminal)

For developers who prefer the command line:

```bash
# Install globally
cd packages/cli && npm install && npm link

# Configure
export RECALL_API_URL=https://ctx.internal.company.com
export RECALL_TOKEN=your-token
export DEVELOPER_ID=your-alias
export ORGANIZATION_ID=your-org

# Use
recall search "how do we deploy to production?"
recall facts --entity Kafka
recall history PostgreSQL
recall insight "Lambda cold start takes 3s in VPC due to ENI" --type lesson
```

---

## What Happens After Connection

Once connected, the system works automatically:

```
Developer asks: "How do I fix this Lambda timeout?"
    │
    ├─ Agent calls get_context("Lambda timeout")
    │   → Returns: "VPC DNS resolution causes 3-5s delay. Use VPC endpoints."
    │   → Agent uses this in its response (no hallucination)
    │
    ├─ Conversation resolves the issue
    │
    └─ Agent calls save_session(...) or plugin passively uploads
        → Session processed → facts extracted → knowledge grows
```

Over time:
- Common questions get instant answers from the fact layer
- Token usage per query decreases (12K → 800 tokens over 24 months)
- Knowledge compounds — each engineer benefits from all 600 engineers' sessions

---

## Troubleshooting

**"MCP server not connecting"**
- Verify the path to `packages/mcp-server/dist/index.js` is correct
- Run `cd packages/mcp-server && npm run build` first
- Check that env vars are set correctly

**"No results found"**
- The knowledge base is empty until sessions are captured
- Try saving a session first: use `save_session` tool or `recall capture` CLI

**"Connection refused"**
- Ensure the API server is running (`npm run dev` in the root)
- Check `RECALL_API_URL` points to the running server

**"Unauthorized"**
- Verify `RECALL_TOKEN` is a valid token
- In local dev, the token can be any non-empty string (auth is disabled)
