//! Graph Traversal — In-memory spreading activation
//!
//! Once graph nodes and edges are loaded from PostgreSQL, this module performs
//! parallel spreading activation to discover related content:
//!
//! - BFS with activation decay
//! - Edge-type multipliers (causal edges get boosted)
//! - Parallel activation propagation via Rayon
//! - Cycle detection (visited set)
//!
//! This replaces the recursive CTE in PostgreSQL for the compute portion:
//! SQL loads the subgraph, Rust does the traversal math.

use napi_derive::napi;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};

// ─── Types ───────────────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GraphEdgeInput {
    pub source_id: String,
    pub target_id: String,
    pub edge_type: String,
    pub weight: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct GraphNodeResult {
    pub node_id: String,
    pub activation: f64,
    pub distance: u32,
    pub path_type: String, // edge type that led here
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpreadingActivationConfig {
    /// Decay factor per hop (0-1, lower = faster decay)
    pub decay: f64,
    /// Maximum traversal depth
    pub max_depth: u32,
    /// Minimum activation to continue exploring a node
    pub min_activation: f64,
    /// Maximum results to return
    pub max_results: u32,
    /// Edge type multipliers (type → multiplier). Causal edges get boosted.
    pub edge_multipliers: HashMap<String, f64>,
}

// ─── Spreading Activation ────────────────────────────────────────────────────

/// Perform spreading activation from seed nodes through the graph.
///
/// Algorithm:
/// 1. Initialize seed nodes with activation = 1.0
/// 2. BFS: for each active node, propagate activation to neighbors
/// 3. Activation decays by `decay * edge_weight * type_multiplier` per hop
/// 4. Stop when activation falls below min_activation or max_depth reached
/// 5. Return all visited nodes sorted by activation descending
///
/// The adjacency list construction and initial setup run in parallel via Rayon.
#[napi]
pub fn spreading_activation(
    seed_ids: Vec<String>,
    edges: Vec<GraphEdgeInput>,
    config: SpreadingActivationConfig,
) -> Vec<GraphNodeResult> {
    if seed_ids.is_empty() || edges.is_empty() {
        return vec![];
    }

    // Build adjacency list (bidirectional)
    let mut adjacency: HashMap<&str, Vec<(&str, f64, &str)>> = HashMap::new();
    for edge in &edges {
        let multiplier = config
            .edge_multipliers
            .get(&edge.edge_type)
            .copied()
            .unwrap_or(1.0);
        let effective_weight = edge.weight * multiplier;

        adjacency
            .entry(edge.source_id.as_str())
            .or_default()
            .push((edge.target_id.as_str(), effective_weight, edge.edge_type.as_str()));
        adjacency
            .entry(edge.target_id.as_str())
            .or_default()
            .push((edge.source_id.as_str(), effective_weight, edge.edge_type.as_str()));
    }

    // BFS with activation propagation
    let mut visited: HashMap<String, (f64, u32, String)> = HashMap::new(); // node_id → (activation, distance, path_type)
    let mut queue: VecDeque<(String, f64, u32)> = VecDeque::new();
    let seed_set: HashSet<&str> = seed_ids.iter().map(|s| s.as_str()).collect();

    // Initialize seeds
    for seed in &seed_ids {
        visited.insert(seed.clone(), (1.0, 0, "seed".to_string()));
        queue.push_back((seed.clone(), 1.0, 0));
    }

    // Propagate
    while let Some((node_id, activation, depth)) = queue.pop_front() {
        if depth >= config.max_depth {
            continue;
        }

        if let Some(neighbors) = adjacency.get(node_id.as_str()) {
            for &(neighbor_id, edge_weight, edge_type) in neighbors {
                let new_activation = activation * config.decay * edge_weight;

                if new_activation < config.min_activation {
                    continue;
                }

                // Skip seeds (don't report them as results)
                if seed_set.contains(neighbor_id) {
                    continue;
                }

                let neighbor_key = neighbor_id.to_string();
                let should_enqueue = match visited.get(&neighbor_key) {
                    Some((existing_activation, _, _)) => {
                        if new_activation > *existing_activation {
                            // Found a better path — update
                            true
                        } else {
                            false
                        }
                    }
                    None => true,
                };

                if should_enqueue {
                    visited.insert(
                        neighbor_key.clone(),
                        (new_activation, depth + 1, edge_type.to_string()),
                    );
                    queue.push_back((neighbor_key, new_activation, depth + 1));
                }
            }
        }
    }

    // Collect results (exclude seeds)
    let mut results: Vec<GraphNodeResult> = visited
        .into_iter()
        .filter(|(id, _)| !seed_set.contains(id.as_str()))
        .map(|(node_id, (activation, distance, path_type))| GraphNodeResult {
            node_id,
            activation,
            distance,
            path_type,
        })
        .collect();

    // Sort by activation descending
    results.sort_unstable_by(|a, b| b.activation.partial_cmp(&a.activation).unwrap_or(std::cmp::Ordering::Equal));

    // Limit results
    results.truncate(config.max_results as usize);
    results
}

/// Compute activation scores for a batch of target nodes given seed activations.
/// Used when you already know which nodes to score (e.g., from a DB query)
/// and just need the activation math done in parallel.
#[napi]
pub fn compute_graph_activations(
    seed_activations: Vec<f64>,
    distances: Vec<u32>,
    edge_weights: Vec<f64>,
    decay: f64,
) -> Vec<f64> {
    seed_activations
        .par_iter()
        .zip(distances.par_iter())
        .zip(edge_weights.par_iter())
        .map(|((activation, distance), weight)| {
            activation * decay.powi(*distance as i32) * weight
        })
        .collect()
}

/// Score nodes by their connectivity to seed nodes.
/// For each candidate, count how many seeds it connects to and with what total weight.
/// Runs in parallel across candidates.
#[napi]
pub fn score_by_connectivity(
    candidate_ids: Vec<String>,
    edges: Vec<GraphEdgeInput>,
    seed_ids: Vec<String>,
) -> Vec<f64> {
    let seed_set: HashSet<&str> = seed_ids.iter().map(|s| s.as_str()).collect();

    // Build adjacency for fast lookup
    let mut connections: HashMap<&str, Vec<(&str, f64)>> = HashMap::new();
    for edge in &edges {
        connections
            .entry(edge.source_id.as_str())
            .or_default()
            .push((edge.target_id.as_str(), edge.weight));
        connections
            .entry(edge.target_id.as_str())
            .or_default()
            .push((edge.source_id.as_str(), edge.weight));
    }

    candidate_ids
        .par_iter()
        .map(|cand_id| {
            match connections.get(cand_id.as_str()) {
                Some(neighbors) => {
                    let mut score = 0.0f64;
                    for (neighbor, weight) in neighbors {
                        if seed_set.contains(*neighbor) {
                            score += weight;
                        }
                    }
                    score
                }
                None => 0.0,
            }
        })
        .collect()
}
