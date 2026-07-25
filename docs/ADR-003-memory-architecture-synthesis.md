# ADR-003: Memory Architecture Synthesis

## Status

Accepted (v3)

## Context

After analyzing the competitive landscape, our system synthesizes two proven approaches:
- **Intelligent memory algorithms** — extraction, consolidation, multi-signal retrieval
- **Extended continuous capture** — on-device, continuous, multi-application, temporal

We're building intelligent memory at continuous-capture scale, designed for *engineering teams*
rather than individuals. This ADR documents the key learnings and how they reshape our design.

---

## Learnings from Industry: Memory Intelligence

### 1. Single-Pass ADD-Only Extraction

**Industry insight:** Early memory systems used two LLM passes (extract + reconcile). The reconcile step
(ADD/UPDATE/DELETE against existing memories) was slow and *destroyed context*. Overwrites
lost valuable history.

**The fix:** Single-pass extraction that only ADDs. When information changes, the new fact
lives alongside the old one. Both survive. Cost: 50% less extraction latency. Quality: much better,
because the model spends capacity on understanding rather than diffing.

**What this means for us:** Our knowledge extractor currently tries to produce one canonical
Problem/Solution record per chunk. Instead, we should:
- Always ADD new memories, never overwrite
- Let the *retrieval layer* handle temporal reasoning ("which is current?")
- Store transitions explicitly: "Team moved from REST to gRPC" not just "Team uses gRPC"

### 2. Fact-Level Granularity (Not Chunk-Level)

**Industry insight:** Leading memory systems don't store chunks of text. They extract *atomic facts* with metadata.
A single message might produce 3 separate memories:
- "User prefers TypeScript over JavaScript"
- "Project uses PostgreSQL for the database"
- "Team decided to use Kafka for event streaming"

**What this means for us:** Our current unit is a ~1000-token chunk. This is good for
full-context retrieval but bad for precision. We should add a *fact layer* on top of chunks:
- Chunks = full context (for when user wants to read the discussion)
- Facts = atomic extracted knowledge (for when user wants a quick answer)
- Facts point back to their source chunk (citation)

### 3. Multi-Signal Retrieval Fusion

**Best-in-class approach:** Three scoring passes in parallel:
- Semantic (vector similarity)
- Keyword (term matching, with verb normalization)
- Entity (boosts memories linked to entities in the query)

Then fuses via rank scoring. Different queries lean on different signals.

**What this means for us:** We already have hybrid search (vector + BM25 + graph). But we're
missing *entity matching* — a dedicated pass that boosts results sharing entities with the query.
Add this as a 4th retrieval signal.

### 4. Agent-Generated Facts Are First-Class

**Industry insight:** Early memory systems only stored *user* utterances. But agent responses contain
crucial information: "I've configured your Lambda with 512MB memory" or "The fix is to add
a VPC endpoint." The v2 treats these as equally important.

**What this means for us:** We already store both user and assistant messages. But during
knowledge extraction, we should weight assistant responses *equally or higher* — they contain
the actual solutions, code patterns, and decisions.

### 5. Token-Efficient Retrieval (<7K tokens per query)

**Industry benchmark:** State-of-the-art memory algorithms achieve 92.5% accuracy on LoCoMo with only
~7,000 tokens per retrieval call. Full-context approaches need 25,000+.

**What this means for us:** This validates our compaction strategy. Our target of 800 tokens/query
at month 24 is aggressive but achievable with fact-level extraction + canonical synthesis.

---

## What Pieces Does Right (and we should adopt)

### 1. Continuous Background Capture (Not Manual Upload)

**Pieces' approach:** LTM-2.7 runs in the background monitoring:
- Clipboard events (code snippets, terminal commands, error messages)
- Screen captures (OCR to extract text)
- Audio transcription (meetings, calls)
- Application activity (what windows, what URLs, when)

Developers never click "save." Everything is captured automatically.

**What this means for us:** Our current design requires developers to explicitly click
"Save Session" in their IDE plugin. This is a friction point that will kill adoption.
We should support TWO modes:
- **Explicit upload** (current): Full session with metadata. High quality.
- **Passive capture** (new): Background daemon that streams context events continuously.
  IDE plugin silently uploads every completed AI conversation. No user action required.

### 2. Temporal Grounding

**Pieces' key innovation:** Everything is timestamped and queryable by time:
- "What was the error I saw yesterday?"
- "What did we decide in last week's standup?"
- "What code was I working on Monday morning?"

Their "Day Recap," "Morning Brief," and "What's Top of Mind" features are powered by this.

**What this means for us:** We store `createdAt` but don't support temporal queries well.
We should add:
- First-class temporal retrieval ("what did we learn about auth last month?")
- Automatic time-based summaries (daily/weekly digests of new org knowledge)
- Temporal decay that's queryable ("show me only recent knowledge" vs "include archived")

### 3. On-Device Processing + Cloud Selective

**Pieces' privacy model:**
- Capture, indexing, storage: entirely on-device (PiecesOS)
- LLM inference: user chooses local (Ollama) or cloud
- Only scoped, relevant context sent to cloud when needed

**What this means for us:** Our system is centralized (cloud-first), which is appropriate for
team-wide knowledge sharing. But we should support a **hybrid privacy model**:
- Personal memories (individual workflow, preferences) → local-first option
- Team knowledge (shared solutions, decisions) → centralized
- Developer chooses what promotes from personal → team

### 4. Multi-Modal Capture

**Pieces captures:** Text, code, screenshots (via OCR), audio (via transcription), URLs, and
application metadata. All become searchable.

**What this means for us:** We currently only ingest text conversations. We should expand to:
- Terminal output (often contains the actual error)
- Screenshots of error UIs (OCR → text → embed)
- Meeting transcripts where architectural decisions were made
- Browser activity (Stack Overflow answers that led to solutions)

### 5. Cross-Application Context Linking

**Pieces' insight:** A bug exists across multiple tools: the error in the terminal, the
Stack Overflow answer in the browser, the fix in the IDE, the discussion in Slack.
Pieces links these into a single narrative.

**What this means for us:** We should link:
- AI session → git commit it produced
- AI session → Jira ticket it was about
- AI session → PR that implemented the solution
- AI session → Slack thread where the problem was discussed

This creates a *full knowledge trail* from problem → discussion → solution → implementation.

---

## Revised Architecture (v3): Intelligent Memory + Continuous Capture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Capture Layer (Pieces-inspired)                  │
│                                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │IDE Plugin│ │ Terminal │ │ Browser  │ │ Meeting  │ │  Slack   │ │
│  │(passive) │ │  Daemon  │ │Extension │ │Transcript│ │  Bot     │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       └─────────────┴────────────┴────────────┴────────────┘       │
│                              │ event stream                          │
└──────────────────────────────┼───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   Memory Engine                                        │
│                                                                      │
│  ┌─────────────────┐                                                │
│  │  Fact Extractor  │  Single-pass, ADD-only                         │
│  │  (atomic facts)  │  "User prefers X", "Team decided Y"           │
│  └────────┬────────┘                                                │
│           │                                                          │
│  ┌────────▼────────┐                                                │
│  │  Consolidator   │  Dedup + entity linking + temporal ordering    │
│  │  (no overwrites)│  Old facts survive alongside new ones          │
│  └────────┬────────┘                                                │
│           │                                                          │
│  ┌────────▼────────┐                                                │
│  │  Memory Store   │  Facts + Chunks + Entities + Temporal index    │
│  │  (multi-layer)  │                                                │
│  └────────┬────────┘                                                │
│           │                                                          │
│  ┌────────▼──────────────────────────────────────────────────┐      │
│  │  Multi-Signal Retrieval                                    │      │
│  │  ├─ Semantic (vector similarity)                          │      │
│  │  ├─ Keyword (BM25 with verb normalization)                │      │
│  │  ├─ Entity (boost by shared entities)                     │      │
│  │  ├─ Temporal (time-aware scoring)                         │      │
│  │  └─ Graph (relationship traversal)                        │      │
│  └───────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Key Differences from Competitors

| Capability | Leading Memory Systems | Leading Capture Tools | Our System (v3) |
|-----------|------|--------|-----------------|
| Memory granularity | Atomic facts | Events + snippets | Facts + Chunks + Entities (layered) |
| Capture method | Explicit `add()` call | Passive background | Both (passive default, explicit for rich context) |
| Scope | Per-user/per-agent | Per-individual | Per-team (600+), with personal layer |
| Code awareness | None | Snippets + language detection | Deep (git diffs, repos, commits, PRs) |
| Temporal reasoning | Yes (new in Apr 2026) | Yes (core feature) | Yes (temporal index + time-based queries) |
| Knowledge structure | Flat facts | Events timeline | Hierarchical: Facts → Chunks → Clusters → Canonicals |
| Deduplication | Embedding similarity | None | Multi-signal (MinHash + embedding + entity + temporal) |
| Cross-session learning | Per-user accumulation | Per-individual | Team-wide accumulation with compaction |
| Token efficiency | ~7K tokens/query | N/A (local processing) | Target: 1.5K tokens/query by month 12 |
| Privacy model | Cloud (managed) or self-hosted | Local-first | Cloud-first with optional personal local layer |

---

## Implementation Changes Required

### New: Fact Layer

Add atomic fact extraction alongside current chunk-based storage:

```typescript
interface MemoryFact {
  id: string;
  content: string;           // "Team uses PostgreSQL 16 for the auth service"
  type: 'preference' | 'decision' | 'pattern' | 'lesson' | 'constraint';
  entities: string[];        // ["PostgreSQL", "auth service"]
  sourceChunkId: string;     // Link back to full context
  sourceSessionId: string;
  authorId: string;
  organizationId: string;
  temporalContext: {
    when: string;            // ISO timestamp
    validFrom?: string;      // When this fact became true
    validUntil?: string;     // When superseded (null = still valid)
    supersededBy?: string;   // ID of newer fact
  };
  confidence: number;        // 0-1
  usageCount: number;
  createdAt: string;
  embedding: number[];
}
```

### New: Passive Capture Mode (from Pieces)

IDE plugin auto-uploads completed conversations without user action:

```typescript
interface CaptureEvent {
  type: 'ai_session' | 'clipboard' | 'terminal' | 'browser' | 'meeting';
  source: string;           // "cursor", "kiro", "iterm2", "chrome"
  content: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  developerId: string;
  // For ai_session type:
  sessionComplete: boolean;  // true = full session ended
  autoCapture: boolean;      // true = passive (no user click)
}
```

### New: Temporal Retrieval (from Pieces)

Support time-based queries natively:

```sql
-- "What did we learn about auth last week?"
SELECT * FROM memory_facts
WHERE organization_id = $1
  AND 'auth' = ANY(entities)
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY confidence DESC, created_at DESC;
```

### New: Entity-Boosted Retrieval

Add entity matching as a 4th retrieval signal:

```typescript
// Extract entities from query
const queryEntities = extractEntities(query); // ["Lambda", "VPC", "timeout"]

// Boost chunks/facts that share entities
const entityBoost = candidates.map(c => ({
  ...c,
  entityScore: jaccardSimilarity(queryEntities, c.entities)
}));
```

---

## Consequences

**Positive:**
- Richer capture (passive mode → higher adoption, more data)
- More precise retrieval (fact-level → shorter, more relevant context)
- Better temporal reasoning (time-indexed → "what changed?" queries)
- ADD-only extraction (simpler, faster, preserves history)
- Entity matching (stronger signal for domain-specific queries)

**Negative:**
- More complex data model (facts + chunks + entities + temporal)
- Passive capture needs careful privacy controls (what gets auto-captured?)
- Entity extraction quality affects retrieval (garbage entities = noise)
- Storage grows faster with ADD-only (mitigated by compaction)

**Mitigations:**
- Fact layer is additive — chunks still work independently
- Passive capture is opt-in per organization, with granular controls
- Entity extraction uses both regex (fast, precise) and LLM (expensive, richer)
- Weekly compaction job prevents unbounded growth
