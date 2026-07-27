# ADR-004: Hindsight-Inspired Improvements

**Status:** Accepted  
**Date:** 2026-07-27  
**References:** [Hindsight paper (arXiv:2512.12818)](https://arxiv.org/html/2512.12818v1), [Hindsight GitHub](https://github.com/vectorize-io/hindsight)

---

## Context

Hindsight by Vectorize.io is the current state-of-the-art in agent memory systems, achieving 91.4% on LongMemEval (vs ~60% for full-context GPT-4o) and 89.61% on LoCoMo. Its architecture (described in the paper "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects") introduces several concepts that overlap with and extend our Synapse system.

This ADR documents the gap analysis between Hindsight and Synapse, identifies which Hindsight features we should adopt, and specifies how they map into our existing architecture.

---

## Feature Comparison

| Capability | Hindsight | Recall (current) | Gap |
|---|---|---|---|
| **Fact extraction** | Narrative facts (2-5 per conversation, coarse-grained) | Atomic facts (10-50 tokens each, fine-grained) | Different granularity — we should support BOTH |
| **Memory organization** | 4 networks: World, Experience, Opinion, Observation | 4 layers: Facts, Chunks, Clusters, Canonicals | We lack explicit opinion/belief separation |
| **Reflect operation** | First-class operation: retrieves memories → reasons over them → forms opinions → generates answer | No reflect — only raw search results returned | **Critical gap** — our system retrieves but doesn't reason |
| **Observations/Mental models** | Synthesized entity profiles, updated async when new facts arrive | None (closest: compacted canonicals per cluster) | **Gap** — we have no entity-level summaries |
| **Opinion network** | Explicit opinions with confidence scores that evolve via reinforcement | Facts have confidence but no explicit subjective opinion layer | **Gap** — no belief evolution mechanism |
| **Temporal retrieval** | Dedicated temporal channel with date parser (rule-based + T5 fallback) | Temporal scoring (signal 4) applied as metadata multiplier | Recall applies temporal as a score; Hindsight has a dedicated temporal filter/channel |
| **Multi-signal retrieval** | 4 channels: Semantic, BM25, Graph (spreading activation), Temporal | 5 signals: Semantic, BM25, Entity match, Temporal score, Graph expansion | **Recall is STRONGER here** — we have 5 signals vs their 4 |
| **RRF fusion** | Standard RRF | Standard RRF | Equivalent |
| **Cross-encoder reranking** | Neural cross-encoder (ms-marco-MiniLM) | Stubbed with heuristic boost (TODO) | Gap — we need to add a real cross-encoder |
| **Token budget** | Caller specifies token budget; greedy packing to fill it | top-K with token estimation reported but not capping | Minor gap — add budget-aware packing |
| **Graph structure** | 4 edge types: temporal, semantic, entity, causal | 14 edge types (richer) but no causal/temporal links | We have more types but lack causal edges |
| **Fact supersession** | LLM-based contradiction detection during retain (automatic) | LLM-based contradiction detection during compaction (batch) | Similar — ours is batch, theirs is inline |
| **ADD-only principle** | Yes — never overwrite | Yes — never overwrite | **Equivalent** |
| **Behavioral profile** | Disposition parameters (skepticism, literalism, empathy) shape reasoning | No behavioral profiling | Different use case — Synapse is team-scale, not per-agent personality |
| **Passive capture** | Yes | Yes | **Equivalent** |
| **Deduplication** | Not explicitly described in paper | Bloom filter + MinHash + cosine | **Recall is stronger** |
| **Knowledge compaction** | Observations regenerated async | Weekly cluster synthesis + fact supersession + pruning | **Recall is stronger** |
| **Scale focus** | Single-user/agent memory banks | 600+ engineer org-wide deduplication | **Recall is stronger** — team-scale |
| **Permission model** | Per-bank isolation (metadata filters) | RLS + ACLs + classification levels | **Recall is stronger** |
| **LLM wrapper** | 2-line integration wrapping OpenAI/Anthropic client | MCP server with 6 tools | Different approach; both valid |

---

## Key Learnings from Hindsight

### 1. Reflect is the killer feature

Hindsight's strongest insight: **retrieval alone isn't enough**. The reflect operation takes retrieved memories, reasons over them with an LLM, and produces a synthesized answer. This is what makes it score 91.4% on benchmarks — it's not just finding memories, it's _thinking with them_.

Our system currently returns ranked chunks/facts to the caller and lets the caller's LLM figure it out. Adding a reflect operation would:
- Produce higher-quality answers from the same memory base
- Enable the system to form new observations as a side-effect
- Support "deep reasoning" queries that require connecting multiple memories

### 2. Observations (Entity Summaries) are a powerful cache

Instead of retrieving 20 facts about "Alice" and letting the LLM synthesize every time, Hindsight maintains a pre-computed observation: "Alice is a software engineer at Google specializing in ML". This:
- Reduces retrieval latency
- Reduces downstream token usage
- Provides consistent entity profiles
- Gets regenerated when underlying facts change

### 3. Narrative facts complement atomic facts

Hindsight extracts 2-5 narrative facts per conversation (preserving cross-turn context) rather than 8+ atomic facts. Both approaches have value:
- **Atomic facts** (what we do): precise retrieval, entity matching, quick answers
- **Narrative facts** (what Hindsight does): preserve reasoning chains, better for multi-hop questions

We should support **both granularities**.

### 4. Causal links enable explanatory retrieval

Hindsight's graph has explicit causal edges (causes, caused_by, enables, prevents). When someone asks "why did we switch to Kafka?", causal traversal surfaces the decision _and the reasoning_ behind it. Our graph has 14 edge types but none capture causality.

### 5. Token-budget retrieval respects LLM constraints

Hindsight's recall accepts a token budget and packs results greedily until the budget is filled. This is cleaner than our top-K approach for IDE integrations where context window is precious.

---

## What We Already Do Better

1. **5-signal fusion** (vs Hindsight's 4) — our entity match signal is a distinct channel
2. **Organization-scale deduplication** — Bloom + MinHash + cosine; Hindsight is single-agent
3. **Tiered ingestion** — cheap heuristic path for 80% of sessions, LLM only for high-value
4. **Knowledge compaction** — weekly synthesis of canonical articles
5. **Rich permission model** — RLS, classification levels, per-team ACLs
6. **Graph richness** — 14 edge types vs 4
7. **Hierarchical memory** — 4 layers (facts → chunks → clusters → canonicals) vs flat 4-network

---

## Decisions

### ADOPT:

1. **Reflect operation** — Add `/api/v1/reflect` that retrieves memories then reasons over them
2. **Observation layer** — Pre-computed entity summaries, regenerated when facts change
3. **Causal graph edges** — Add `causes`, `caused_by`, `enables`, `prevents` edge types
4. **Token-budget retrieval** — Accept `maxTokens` parameter and pack greedily
5. **Narrative fact extraction** — Add a coarse-grained extraction mode alongside atomic
6. **Opinion facts** — Extend FactType with `opinion` type that carries evolving confidence

### SKIP (for now):

- **Behavioral profiles** — Not relevant for team-scale system (we serve an org, not a persona)
- **Opinion reinforcement** — Complex, and our compaction supersession covers the same ground
- **Neural cross-encoder** — Add later as a performance optimization (current heuristic is fine for our latency targets)

---

## Implementation Plan

### Phase 1: Reflect Operation
- New endpoint `/api/v1/reflect`
- Accepts query + optional token budget + optional entity focus
- Internally: recall → LLM synthesis → return answer + optional observation
- MCP tool: `reflect_on_knowledge`

### Phase 2: Observation Layer
- New table `observations` (entity_id, entity_name, summary, source_fact_ids, embedding, updated_at)
- Background job: when new facts mention an entity with 3+ existing facts, regenerate observation
- Retrieval integration: observations returned alongside facts for entity queries

### Phase 3: Supporting Improvements
- Add causal edge types to graph model
- Add `maxTokens` to SearchRequest, implement greedy packing
- Add `narrative` extraction mode to fact extractor
- Add `opinion` to FactType enum

---

## Consequences

- Reflect operation adds LLM latency (~1-3s) but produces much higher quality answers
- Observation layer adds background compute but reduces per-query token usage
- Causal edges require LLM extraction during Tier 2 processing (cost increase ~5%)
- Token-budget retrieval is a non-breaking addition to existing search API
