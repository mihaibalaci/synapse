# Diagrams

Mermaid source files for the Recall data flow. Render with any Mermaid-aware
viewer (GitHub, GitLab, VS Code Mermaid Preview, `mmdc` CLI, or
[mermaid.live](https://mermaid.live)).

| File | What it shows |
|------|---------------|
| [`data-flow.mmd`](data-flow.mmd) | Complete system topology: clients, API, workers, stores, AI providers, compaction, and migration |
| [`write-path.mmd`](write-path.mmd) | Session upload sequence: synchronous 202 boundary, outbox, pipeline, enrichment, reconciliation |
| [`read-path.mmd`](read-path.mmd) | Search request sequence: cache, embedding LRU, parallel signals, batched hydration, ACL, ranking |
| [`compaction.mmd`](compaction.mmd) | Weekly compaction CronJob: synthesis, fact supersession, stale archival |
| [`status-model.mmd`](status-model.mmd) | Chunk/session status state machine and confidence lifecycle |

## Rendering locally

```bash
# Install the Mermaid CLI
npm install -g @mermaid-js/mermaid-cli

# Render all diagrams to SVG
for f in docs/diagrams/*.mmd; do
  mmdc -i "$f" -o "${f%.mmd}.svg" -t dark
done
```

## Key conventions

- Synchronous (request-scoped) work is in dark blue boxes
- Asynchronous (queue/outbox) work is in purple boxes
- Data stores are green
- AI providers are amber
- Compaction is teal
- Dashed lines indicate health/probe connections, not data flow
