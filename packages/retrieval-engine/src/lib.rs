//! Synapse Retrieval Engine — High-performance native module
//!
//! Implements the compute-heavy portions of the retrieval pipeline in Rust
//! with parallel execution via Rayon:
//!
//! - Reciprocal Rank Fusion (RRF) — merge multiple ranked lists
//! - Composite scoring — 9-weight formula over 100+ candidates
//! - Token-budget packing — greedy pack results within a budget
//! - Temporal scoring — exponential decay with recency boost
//! - Diversity enforcement — penalize same-session clusters
//! - MinHash deduplication — 128-hash fingerprinting with parallel comparison
//! - Batch vector operations — cosine similarity, validation, local embeddings

mod dedup;

#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::*;
use ordered_float::OrderedFloat;
use rayon::prelude::*;
use std::collections::HashMap;

// ─── Types ───────────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Debug)]
pub struct CandidateScores {
    pub semantic: f64,
    pub keyword: f64,
    pub entity_match: f64,
    pub temporal: f64,
    pub graph_relevance: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct CandidateInput {
    pub id: String,
    pub session_id: Option<String>,
    pub content_length: u32,
    pub token_count: u32,
    pub quality_score: f64,
    pub usage_count: u32,
    pub upvotes: u32,
    pub created_at_ms: f64,
    pub last_accessed_at_ms: Option<f64>,
    pub confidence: String,
    pub repository: Option<String>,
    pub scores: CandidateScores,
    pub source: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RankingWeights {
    pub semantic: f64,
    pub keyword: f64,
    pub freshness: f64,
    pub repo_match: f64,
    pub author_reputation: f64,
    pub usage: f64,
    pub upvotes: f64,
    pub quality: f64,
    pub graph: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct RankingContext {
    pub query_repository: Option<String>,
    pub now_ms: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct ScoredCandidate {
    pub id: String,
    pub final_score: f64,
    pub semantic_contribution: f64,
    pub keyword_contribution: f64,
    pub freshness_contribution: f64,
    pub repo_match_contribution: f64,
    pub usage_contribution: f64,
    pub quality_contribution: f64,
    pub graph_contribution: f64,
    pub diversity_penalty: f64,
}

// ─── RRF Fusion ──────────────────────────────────────────────────────────────

/// Reciprocal Rank Fusion — merge multiple ranked lists into one.
/// Each list contributes 1/(k + rank) for each item. Items appearing
/// in multiple lists accumulate more evidence.
///
/// Runs in parallel across the input lists using Rayon.
#[napi]
pub fn rrf_fuse(ranked_lists: Vec<Vec<String>>, k: u32) -> Vec<String> {
    let k = k as f64;

    // Parallel: compute RRF score contributions from each list
    let scores: HashMap<String, f64> = ranked_lists
        .par_iter()
        .map(|list| {
            let mut local_scores: HashMap<String, f64> = HashMap::new();
            for (rank, id) in list.iter().enumerate() {
                let score = 1.0 / (k + rank as f64 + 1.0);
                *local_scores.entry(id.clone()).or_default() += score;
            }
            local_scores
        })
        .reduce(HashMap::new, |mut acc, local| {
            for (id, score) in local {
                *acc.entry(id).or_default() += score;
            }
            acc
        });

    // Sort by fused score descending
    let mut items: Vec<(String, f64)> = scores.into_iter().collect();
    items.sort_unstable_by(|a, b| OrderedFloat(b.1).cmp(&OrderedFloat(a.1)));
    items.into_iter().map(|(id, _)| id).collect()
}

// ─── Composite Ranking ───────────────────────────────────────────────────────

/// Score and rank all candidates using the composite formula.
/// Runs the scoring in parallel across all candidates.
///
/// Returns candidates sorted by final_score descending.
#[napi]
pub fn rank_candidates(
    candidates: Vec<CandidateInput>,
    weights: RankingWeights,
    context: RankingContext,
) -> Vec<ScoredCandidate> {
    let now_ms = context.now_ms;
    let query_repo = context.query_repository.as_deref();

    // Parallel scoring
    let mut scored: Vec<ScoredCandidate> = candidates
        .par_iter()
        .map(|c| score_candidate(c, &weights, query_repo, now_ms))
        .collect();

    // Sort descending by final_score
    scored.sort_unstable_by(|a, b| OrderedFloat(b.final_score).cmp(&OrderedFloat(a.final_score)));

    // Apply diversity penalty (sequential — needs order awareness)
    apply_diversity(&mut scored, &candidates);

    scored
}

fn score_candidate(
    c: &CandidateInput,
    w: &RankingWeights,
    query_repo: Option<&str>,
    now_ms: f64,
) -> ScoredCandidate {
    // Semantic contribution
    let semantic = c.scores.semantic * w.semantic;

    // Keyword contribution
    let keyword = c.scores.keyword * w.keyword;

    // Freshness: exponential decay with 130-day half-life
    let age_days = (now_ms - c.created_at_ms) / 86_400_000.0;
    let freshness_raw = (-age_days / 130.0_f64).exp();
    // Recency boost if accessed in last 7 days
    let recency_boost = match c.last_accessed_at_ms {
        Some(ts) if (now_ms - ts) < 7.0 * 86_400_000.0 => 0.15,
        _ => 0.0,
    };
    let freshness = (freshness_raw + recency_boost).min(1.0) * w.freshness;

    // Repository match
    let repo_match = match (query_repo, c.repository.as_deref()) {
        (Some(qr), Some(cr)) if qr == cr => w.repo_match,
        _ => 0.0,
    };

    // Usage (normalized, cap at 100)
    let usage = (c.usage_count as f64 / 100.0).min(1.0) * w.usage;

    // Quality score
    let quality = c.quality_score * w.quality;

    // Graph relevance
    let graph = c.scores.graph_relevance * w.graph;

    // Confidence penalty
    let confidence_multiplier = match c.confidence.as_str() {
        "high" => 1.0,
        "medium" => 0.85,
        "low" => 0.6,
        "archived" => 0.3,
        _ => 1.0,
    };

    let raw_score = semantic + keyword + freshness + repo_match + usage + quality + graph;
    let final_score = raw_score * confidence_multiplier;

    ScoredCandidate {
        id: c.id.clone(),
        final_score,
        semantic_contribution: semantic,
        keyword_contribution: keyword,
        freshness_contribution: freshness,
        repo_match_contribution: repo_match,
        usage_contribution: usage,
        quality_contribution: quality,
        graph_contribution: graph,
        diversity_penalty: 0.0,
    }
}

/// Penalize candidates from the same session appearing consecutively.
/// Ensures diversity in results.
fn apply_diversity(scored: &mut Vec<ScoredCandidate>, candidates: &[CandidateInput]) {
    let session_map: HashMap<&str, &str> = candidates
        .iter()
        .filter_map(|c| c.session_id.as_deref().map(|s| (c.id.as_str(), s)))
        .collect();

    let mut seen_sessions: HashMap<&str, usize> = HashMap::new();
    let penalty_factor = 0.15;

    for item in scored.iter_mut() {
        if let Some(&session_id) = session_map.get(item.id.as_str()) {
            let count = seen_sessions.entry(session_id).or_insert(0);
            if *count > 0 {
                let penalty = penalty_factor * (*count as f64);
                item.final_score *= 1.0 - penalty.min(0.6);
                item.diversity_penalty = penalty;
            }
            *count += 1;
        }
    }

    // Re-sort after diversity adjustment
    scored.sort_unstable_by(|a, b| OrderedFloat(b.final_score).cmp(&OrderedFloat(a.final_score)));
}

// ─── Token Budget Packing ────────────────────────────────────────────────────

/// Greedy token-budget packing: iterate over ranked candidates and include
/// each one until the cumulative token count reaches the budget.
/// Always returns at least one result.
#[napi]
pub fn pack_by_token_budget(
    ranked_ids: Vec<String>,
    token_counts: Vec<u32>,
    max_tokens: u32,
) -> Vec<String> {
    let mut result = Vec::new();
    let mut remaining = max_tokens;

    for (id, tokens) in ranked_ids.into_iter().zip(token_counts.into_iter()) {
        if tokens > remaining {
            if result.is_empty() {
                result.push(id); // Always return at least 1
            }
            break;
        }
        remaining -= tokens;
        result.push(id);
    }

    result
}

// ─── Temporal Scoring (Batch) ────────────────────────────────────────────────

/// Compute temporal scores for a batch of items in parallel.
/// Uses exponential decay with configurable half-life.
#[napi]
pub fn compute_temporal_scores(
    created_at_ms_list: Vec<f64>,
    last_accessed_ms_list: Vec<Option<f64>>,
    confidence_list: Vec<String>,
    now_ms: f64,
    half_life_days: f64,
) -> Vec<f64> {
    created_at_ms_list
        .par_iter()
        .zip(last_accessed_ms_list.par_iter())
        .zip(confidence_list.par_iter())
        .map(|((created_ms, last_accessed_ms), confidence)| {
            let age_days = (now_ms - created_ms) / 86_400_000.0;
            let mut score = (-age_days / half_life_days).exp();

            // Recency boost
            if let Some(ts) = last_accessed_ms {
                let access_age_days = (now_ms - ts) / 86_400_000.0;
                if access_age_days < 7.0 {
                    score = (score + 0.2).min(1.0);
                }
            }

            // Confidence penalty
            match confidence.as_str() {
                "low" => score *= 0.6,
                "archived" => score *= 0.3,
                _ => {}
            }

            score
        })
        .collect()
}

// ─── Cosine Similarity (Batch) ───────────────────────────────────────────────

/// Compute cosine similarity between a query vector and multiple candidate vectors.
/// Runs in parallel across candidates. Used for dedup threshold checks.
#[napi]
pub fn batch_cosine_similarity(
    query_vec: Vec<f64>,
    candidate_vecs: Vec<Vec<f64>>,
) -> Vec<f64> {
    let q_norm: f64 = query_vec.iter().map(|x| x * x).sum::<f64>().sqrt();

    if q_norm == 0.0 {
        return vec![0.0; candidate_vecs.len()];
    }

    candidate_vecs
        .par_iter()
        .map(|c_vec| {
            if c_vec.len() != query_vec.len() {
                return 0.0;
            }
            let dot: f64 = query_vec.iter().zip(c_vec.iter()).map(|(a, b)| a * b).sum();
            let c_norm: f64 = c_vec.iter().map(|x| x * x).sum::<f64>().sqrt();
            if c_norm == 0.0 {
                0.0
            } else {
                dot / (q_norm * c_norm)
            }
        })
        .collect()
}

// ─── Entity Overlap (Batch) ──────────────────────────────────────────────────

/// Compute Jaccard overlap between query entities and each candidate's entities.
/// Runs in parallel.
#[napi]
pub fn batch_entity_overlap(
    query_entities: Vec<String>,
    candidate_entities: Vec<Vec<String>>,
) -> Vec<f64> {
    let query_set: std::collections::HashSet<String> = query_entities
        .into_iter()
        .map(|e| e.to_lowercase())
        .collect();

    if query_set.is_empty() {
        return vec![0.0; candidate_entities.len()];
    }

    candidate_entities
        .par_iter()
        .map(|entities| {
            if entities.is_empty() {
                return 0.0;
            }
            let candidate_set: std::collections::HashSet<String> =
                entities.iter().map(|e| e.to_lowercase()).collect();
            let intersection = query_set.intersection(&candidate_set).count();
            let union = query_set.len() + candidate_set.len() - intersection;
            if union == 0 {
                0.0
            } else {
                intersection as f64 / union as f64
            }
        })
        .collect()
}
