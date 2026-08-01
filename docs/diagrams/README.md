# Diagrams

These Mermaid files describe the tracked Go implementation. Dashed/planned nodes are not operational features.

| File | Scope |
|---|---|
| `data-flow.mmd` | Runtime topology and store ownership |
| `write-path.mmd` | Capture through worker indexing |
| `read-path.mmd` | Cache and three-signal retrieval |
| `status-model.mmd` | Queue, retry, recovery, terminal states |
| `compaction.mmd` | Honest no-op boundary and planned phases |
| `learning-loop.mmd` | Implemented path versus planned learning loop |

Render with a Mermaid-aware Markdown viewer or `mmdc` if installed:

```bash
for f in docs/diagrams/*.mmd; do mmdc -i "$f" -o "${f%.mmd}.svg"; done
```
