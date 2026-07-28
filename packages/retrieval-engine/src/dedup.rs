//! Deduplication & Embedding Pipeline — Rust native
//!
//! CPU-bound operations for the dedup and embedding pipeline:
//! - MinHash signature computation (128 hash functions × N shingles)
//! - MinHash Jaccard similarity
//! - Shingle extraction (character n-grams)
//! - Batch dedup scoring (weighted multi-signal)
//! - Vector validation (1536-dim finite check)
//! - Local pseudo-embedding generation
//! - Text fingerprinting (FNV-1a)

use napi_derive::napi;
use rayon::prelude::*;

// ─── MinHash ─────────────────────────────────────────────────────────────────

/// Compute MinHash signature for a text string.
/// Uses character 3-grams (shingles) and 128 FNV-1a hash functions.
/// Returns a 128-element signature array.
#[napi]
pub fn compute_minhash(text: String, num_hashes: u32, shingle_size: u32) -> Vec<u32> {
    let normalized = text.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    let shingle_size = shingle_size as usize;
    let num_hashes = num_hashes as usize;

    if normalized.len() < shingle_size {
        return vec![u32::MAX; num_hashes];
    }

    let bytes = normalized.as_bytes();
    let num_shingles = bytes.len() - shingle_size + 1;

    // For each hash function, find the minimum hash across all shingles
    let mut signature = vec![u32::MAX; num_hashes];

    for i in 0..num_shingles {
        let shingle = &bytes[i..i + shingle_size];
        for h in 0..num_hashes {
            let hash = fnv1a_with_seed(shingle, h as u32);
            if hash < signature[h] {
                signature[h] = hash;
            }
        }
    }

    signature
}

/// Compute MinHash signatures for a batch of texts in parallel.
#[napi]
pub fn batch_compute_minhash(texts: Vec<String>, num_hashes: u32, shingle_size: u32) -> Vec<Vec<u32>> {
    texts
        .par_iter()
        .map(|text| {
            let normalized = text.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
            let shingle_size = shingle_size as usize;
            let num_hashes = num_hashes as usize;

            if normalized.len() < shingle_size {
                return vec![u32::MAX; num_hashes];
            }

            let bytes = normalized.as_bytes();
            let num_shingles = bytes.len() - shingle_size + 1;
            let mut signature = vec![u32::MAX; num_hashes];

            for i in 0..num_shingles {
                let shingle = &bytes[i..i + shingle_size];
                for h in 0..num_hashes {
                    let hash = fnv1a_with_seed(shingle, h as u32);
                    if hash < signature[h] {
                        signature[h] = hash;
                    }
                }
            }

            signature
        })
        .collect()
}

/// Estimate Jaccard similarity from two MinHash signatures.
#[napi]
pub fn minhash_jaccard(sig_a: Vec<u32>, sig_b: Vec<u32>) -> f64 {
    if sig_a.len() != sig_b.len() || sig_a.is_empty() {
        return 0.0;
    }
    let agreements = sig_a.iter().zip(sig_b.iter()).filter(|(a, b)| a == b).count();
    agreements as f64 / sig_a.len() as f64
}

/// Batch compare one signature against many candidates in parallel.
/// Returns Jaccard similarity for each candidate.
#[napi]
pub fn batch_minhash_jaccard(query_sig: Vec<u32>, candidate_sigs: Vec<Vec<u32>>) -> Vec<f64> {
    let qlen = query_sig.len();
    candidate_sigs
        .par_iter()
        .map(|c_sig| {
            if c_sig.len() != qlen || qlen == 0 {
                return 0.0;
            }
            let agreements = query_sig.iter().zip(c_sig.iter()).filter(|(a, b)| a == b).count();
            agreements as f64 / qlen as f64
        })
        .collect()
}

// ─── Dedup Scoring ───────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DedupCandidate {
    pub id: String,
    pub embedding_similarity: f64,
    pub minhash_similarity: f64,
    pub title_similarity: f64,
    pub repository_overlap: bool,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DedupWeights {
    pub embedding: f64,
    pub minhash: f64,
    pub title: f64,
    pub repository: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DedupResult {
    pub id: String,
    pub combined_score: f64,
}

/// Score dedup candidates using weighted multi-signal formula.
/// Runs in parallel across all candidates.
#[napi]
pub fn score_dedup_candidates(
    candidates: Vec<DedupCandidate>,
    weights: DedupWeights,
    merge_threshold: f64,
) -> Vec<DedupResult> {
    let mut results: Vec<DedupResult> = candidates
        .par_iter()
        .map(|c| {
            let score = weights.embedding * c.embedding_similarity
                + weights.minhash * c.minhash_similarity
                + weights.title * c.title_similarity
                + weights.repository * if c.repository_overlap { 1.0 } else { 0.0 };
            DedupResult {
                id: c.id.clone(),
                combined_score: score,
            }
        })
        .filter(|r| r.combined_score >= merge_threshold)
        .collect();

    results.sort_unstable_by(|a, b| b.combined_score.partial_cmp(&a.combined_score).unwrap_or(std::cmp::Ordering::Equal));
    results
}

// ─── Title / Token Similarity ────────────────────────────────────────────────

/// Compute Jaccard similarity between two tokenized texts.
/// Tokenizes by splitting on whitespace and punctuation, lowercasing,
/// filtering tokens < 3 chars.
#[napi]
pub fn title_jaccard_similarity(text_a: String, text_b: String) -> f64 {
    let tokens_a = tokenize(&text_a);
    let tokens_b = tokenize(&text_b);

    if tokens_a.is_empty() && tokens_b.is_empty() {
        return 1.0;
    }
    if tokens_a.is_empty() || tokens_b.is_empty() {
        return 0.0;
    }

    let set_a: std::collections::HashSet<&str> = tokens_a.iter().map(|s| s.as_str()).collect();
    let set_b: std::collections::HashSet<&str> = tokens_b.iter().map(|s| s.as_str()).collect();

    let intersection = set_a.intersection(&set_b).count();
    let union = set_a.len() + set_b.len() - intersection;

    if union == 0 { 0.0 } else { intersection as f64 / union as f64 }
}

/// Batch title similarity — compare one title against many in parallel.
#[napi]
pub fn batch_title_similarity(query_title: String, candidate_titles: Vec<String>) -> Vec<f64> {
    let query_tokens = tokenize(&query_title);
    let query_set: std::collections::HashSet<&str> = query_tokens.iter().map(|s| s.as_str()).collect();

    candidate_titles
        .par_iter()
        .map(|title| {
            let tokens = tokenize(title);
            if query_set.is_empty() && tokens.is_empty() {
                return 1.0;
            }
            if query_set.is_empty() || tokens.is_empty() {
                return 0.0;
            }
            let cand_set: std::collections::HashSet<&str> = tokens.iter().map(|s| s.as_str()).collect();
            let intersection = query_set.intersection(&cand_set).count();
            let union = query_set.len() + cand_set.len() - intersection;
            if union == 0 { 0.0 } else { intersection as f64 / union as f64 }
        })
        .collect()
}

// ─── Vector Validation ───────────────────────────────────────────────────────

/// Validate that all values in an embedding vector are finite.
/// Returns true if valid, false if any NaN/Inf detected.
#[napi]
pub fn validate_embedding(embedding: Vec<f64>, expected_dimensions: u32) -> bool {
    embedding.len() == expected_dimensions as usize
        && embedding.iter().all(|v| v.is_finite())
}

/// Batch validate embeddings in parallel.
/// Returns indices of invalid embeddings (empty = all valid).
#[napi]
pub fn batch_validate_embeddings(embeddings: Vec<Vec<f64>>, expected_dimensions: u32) -> Vec<u32> {
    let dim = expected_dimensions as usize;
    embeddings
        .par_iter()
        .enumerate()
        .filter_map(|(i, emb)| {
            if emb.len() != dim || !emb.iter().all(|v| v.is_finite()) {
                Some(i as u32)
            } else {
                None
            }
        })
        .collect()
}

// ─── Local Pseudo-Embeddings ─────────────────────────────────────────────────

/// Generate deterministic pseudo-embeddings for development/testing.
/// Produces normalized vectors from text content (not semantically meaningful).
/// Runs in parallel across all texts.
#[napi]
pub fn generate_local_embeddings(texts: Vec<String>, dimensions: u32) -> Vec<Vec<f64>> {
    let dim = dimensions as usize;
    texts
        .par_iter()
        .map(|text| {
            let mut embedding = vec![0.0f64; dim];
            for (i, byte) in text.bytes().enumerate() {
                embedding[i % dim] += byte as f64 / 1000.0;
            }
            // L2 normalize
            let norm: f64 = embedding.iter().map(|v| v * v).sum::<f64>().sqrt();
            if norm > 0.0 {
                for v in &mut embedding {
                    *v /= norm;
                }
            }
            embedding
        })
        .collect()
}

// ─── Text Fingerprinting ─────────────────────────────────────────────────────

/// Compute FNV-1a fingerprint of a text string.
/// Used for bloom filter registration and fast dedup pre-checks.
#[napi]
pub fn fnv1a_fingerprint(text: String) -> u32 {
    fnv1a_with_seed(text.as_bytes(), 0)
}

/// Batch fingerprint computation in parallel.
#[napi]
pub fn batch_fnv1a_fingerprint(texts: Vec<String>) -> Vec<u32> {
    texts
        .par_iter()
        .map(|text| fnv1a_with_seed(text.as_bytes(), 0))
        .collect()
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

fn fnv1a_with_seed(data: &[u8], seed: u32) -> u32 {
    let mut hash: u32 = 2166136261u32 ^ seed;
    for &byte in data {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 2)
        .map(|t| t.to_string())
        .collect()
}
