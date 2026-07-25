# ADR-002: Tiered Ingestion Pipeline

## Status

Accepted (v2)

## Context

The v1 pipeline processed every uploaded session through the full extraction pipeline:
Parse → Segment (LLM) → Embed → Extract (LLM) → Deduplicate → Graph Index

At 24,000 sessions/day averaging 15K tokens each:
- LLM segmentation: ~$315/day (Claude Sonnet at $3/M input tokens)
- LLM extraction: ~$735/day
- Total LLM cost: **~$1,050/day = $31,500/month**

Most sessions are routine ("write me a function", "explain this code") and don't
produce high-value reusable knowledge. Only ~20% contain debugging insights,
architecture decisions, or novel solutions worth structured extraction.

## Decision

Implement a two-tier processing pipeline:

**Tier 1: Fast Path (all sessions)**
- Parse + heuristic segmentation (embedding similarity, no LLM)
- Embed + index (immediately searchable)
- Cost: ~$18/day (embeddings only)
- Latency: <5 seconds

**Tier 2: Deep Path (promoted sessions only, ~20%)**
- LLM-refined segmentation
- Structured knowledge extraction
- Deduplication + cluster management
- Graph relationship indexing
- Cost: ~$210/day (LLM on 20% of sessions)
- Latency: minutes (async, background)

**Promotion criteria (score-based):**
| Signal | Score |
|--------|-------|
| Has code diffs | +3 |
| ≥10 messages | +2 |
| Contains error/fix patterns | +2 |
| Multiple languages | +1 |
| Multiple frameworks | +1 |
| >10K tokens | +1 |
| Developer flagged "useful" | +5 (immediate promote) |
| High query demand for topic | +3 (demand-driven promote) |

Threshold: score ≥ 4 → Deep Path

## Rationale

- 80% cost reduction on LLM spend ($1,050 → $210/day)
- All sessions are still searchable via embeddings (Tier 1 quality is sufficient for most retrievals)
- High-value sessions still get full treatment (quality where it matters)
- Demand-driven promotion means knowledge extraction happens for topics people actually query

## Consequences

**Positive:**
- $25K/month savings on LLM costs
- Sessions become searchable in <5 seconds (vs minutes for full pipeline)
- System can handle 10x growth without proportional cost increase
- Developers see their sessions immediately in search results

**Negative:**
- Tier 1 chunks have lower retrieval quality (no structured extraction, raw content only)
- Some valuable sessions may not be promoted (false negative on tier classification)
- Two-tier creates eventual consistency — chunk starts raw, may be enriched later

**Mitigations:**
- Nightly job scans Tier 1 chunks with high usage but no extraction → auto-promotes
- "Mark as useful" button in plugin gives developers manual promotion control
- Tier classification threshold is tunable per organization
