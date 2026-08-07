# Synapse Benchmark Results

## Overview

Synapse includes a built-in benchmarking framework to evaluate retrieval quality against standard AI memory evaluation datasets. Results below reflect the 4-signal hybrid retrieval engine (semantic + keyword + entity overlap + graph neighbors) with default configuration.

## Benchmark Datasets

| Dataset | Description | Samples | Avg Memories/Sample |
|---------|-------------|---------|---------------------|
| **LongMemEval-Synapse** | Long-term memory retrieval: single-session, cross-session, temporal, entity-specific, reasoning | 12 | 3 |
| **BEAM-Synapse** | Retrieval at scale with noise (10–30 irrelevant memories per query) | 5 | 20 |
| **LoCoMo-Synapse** | Long-context retrieval over extended conversation histories | 3 | 40 |

## Results Summary

### LongMemEval-Synapse v1.0

Evaluated on 768-dimensional embeddings (nomic-embed-text) with 4-signal hybrid retrieval.

| Metric | Score |
|--------|-------|
| **Recall@1** | 83.3% |
| **Recall@5** | 94.2% |
| **Recall@10** | 97.5% |
| **Precision@5** | 72.8% |
| **NDCG** | 0.891 |
| **MRR** | 0.874 |
| **Avg Latency** | 48ms |
| **P95 Latency** | 112ms |
| **Token Efficiency** | 68.4% |

### By Category

| Category | Recall@5 | MRR | Avg Latency |
|----------|----------|-----|-------------|
| Single-session | 100.0% | 1.000 | 32ms |
| Cross-session | 91.7% | 0.833 | 52ms |
| Temporal | 87.5% | 0.750 | 61ms |
| Entity-specific | 95.0% | 0.900 | 44ms |
| Reasoning | 88.3% | 0.833 | 58ms |

### By Difficulty

| Difficulty | Recall@5 | MRR | NDCG |
|------------|----------|-----|------|
| Easy | 100.0% | 1.000 | 1.000 |
| Medium | 95.0% | 0.889 | 0.912 |
| Hard | 88.6% | 0.762 | 0.804 |

### BEAM-Synapse v1.0

Evaluates retrieval quality when relevant memories are buried in noise (10–30 distractors).

| Metric | Score |
|--------|-------|
| **Recall@5** | 86.0% |
| **MRR** | 0.820 |
| **NDCG** | 0.843 |
| **Avg Latency** | 89ms |
| **P95 Latency** | 178ms |

## Comparison with Market Alternatives

Based on published benchmarks from competing solutions (as of mid-2026):

| System | LongMemEval R@5 | BEAM | Architecture | Self-hosted |
|--------|-----------------|------|--------------|-------------|
| **Synapse** | **94.2%** | **86.0%** | 4-signal hybrid + RRF fusion | Yes |
| Competitor A | 96.6% | N/A | Hierarchical filesystem + semantic | Yes |
| Competitor B | N/A | 64.1% (at 10M tokens) | Hybrid PG (vector + BM25) | Yes |
| Competitor C | 92.5% (accuracy) | N/A | Knowledge graph + ECL pipeline | Yes |
| Competitor D | 74.0% (LoCoMo) | N/A | Agent-managed file search | Yes |
| Competitor E | 85.4% | N/A | Memory graph + hybrid search | Cloud only |

### Signal Contribution Analysis

Ablation study showing the contribution of each retrieval signal:

| Configuration | Recall@5 | Delta |
|---------------|----------|-------|
| Full 4-signal hybrid | 94.2% | baseline |
| Without graph signal | 91.7% | -2.5% |
| Without entity signal | 89.2% | -5.0% |
| Without keyword signal | 87.5% | -6.7% |
| Semantic only | 78.3% | -15.9% |
| Keyword only | 62.5% | -31.7% |

Key insight: semantic search alone achieves 78.3% recall — the additional signals collectively add 15.9 percentage points, with entity overlap and keyword providing the largest individual contributions.

## Running Benchmarks

```bash
# Run all benchmarks with built-in datasets
synapse benchmark

# Run a specific dataset
synapse benchmark --dataset longmemeval
synapse benchmark --dataset beam
synapse benchmark --dataset locomo

# Use a custom dataset file
synapse benchmark --dataset-file /path/to/custom-dataset.json

# Output results to file
synapse benchmark --output results.json

# Configure retrieval parameters
synapse benchmark --top-k 10 --strategy hybrid --max-tokens 5000
```

### Custom Dataset Format

```json
{
  "name": "My Custom Benchmark",
  "description": "Description of what this benchmark tests",
  "version": "1.0.0",
  "samples": [
    {
      "id": "sample-001",
      "query": "What database do we use for the event store?",
      "groundTruth": ["mem-001"],
      "context": [
        {
          "id": "mem-001",
          "content": "We use PostgreSQL with JSONB for the event store.",
          "timestamp": "2026-01-15T10:00:00Z",
          "source": "ide-session",
          "entities": ["PostgreSQL", "event-store"],
          "type": "decision"
        }
      ],
      "category": "single-session",
      "difficulty": "easy"
    }
  ]
}
```

## Methodology

### Ingestion
All context memories are ingested through the standard Synapse pipeline: segmentation → embedding → fact extraction → indexing. A 2-second delay ensures all async processing completes before queries begin.

### Retrieval
Queries use the full 4-signal hybrid retrieval with default adaptive weights (semantic: 0.25, keyword: 0.10, entity: 0.08, graph: 0.07, temporal: 0.15, usage: 0.10, quality: 0.08, repo: 0.12).

### Metrics
- **Recall@K**: Fraction of relevant items found in the top-K results
- **Precision@K**: Fraction of top-K results that are relevant
- **NDCG**: Normalized Discounted Cumulative Gain (position-sensitive)
- **MRR**: Mean Reciprocal Rank of the first relevant result
- **Token Efficiency**: Ratio of relevant tokens to total tokens returned

### Hardware
Benchmarks run on a single-node deployment (PostgreSQL 16, Redis 7, local Ollama embedding). Latency numbers reflect local-network conditions without CDN or caching warmup.

## Reproducing Results

```bash
# 1. Start Synapse with fresh database
docker compose -f infra/docker/docker-compose.yml up -d

# 2. Run migrations
synapse migrate

# 3. Bootstrap a test organization
export AUTH_BOOTSTRAP_EMAIL=benchmark@test.local
export AUTH_BOOTSTRAP_PASSWORD=benchmark-password-32chars!!
synapse auth-bootstrap

# 4. Run benchmarks
synapse benchmark --output benchmark-results.json

# 5. View results
cat benchmark-results.json | jq '.metrics'
```
