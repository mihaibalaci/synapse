/**
 * Deduplication Engine
 *
 * 600 engineers will solve "Fix Docker build" 500 times.
 * We don't want 500 copies — we want one canonical answer that improves over time.
 *
 * Pipeline:
 * 1. Embedding similarity — fast ANN search for candidate duplicates (>0.90 cosine)
 * 2. MinHash LSH — content fingerprinting for near-duplicate text detection
 * 3. Title similarity — Jaccard similarity on tokenized titles
 * 4. Repository overlap — same repo + similar topic = likely duplicate
 * 5. Merge decision — if combined score > threshold, merge into Knowledge Cluster
 *
 * Clusters have a "canonical" representative (highest quality score) and
 * member chunks that contribute to it. New duplicates strengthen the cluster
 * rather than polluting the index.
 */

import { v4 as uuidv4 } from 'uuid';
import { Worker, Job } from 'bullmq';
import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { QUEUE_NAMES, type ChunkProcessingJob } from './queue.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { ClusterRepository } from '../storage/cluster-repository.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { type Chunk, type ChunkCluster } from '../models/index.js';

const logger = createChildLogger({ module: 'deduplication' });

// ─── Configuration ───────────────────────────────────────────────────────────

export interface DeduplicationConfig {
  /** Cosine similarity threshold for embedding match */
  embeddingSimilarityThreshold: number;
  /** MinHash Jaccard similarity threshold */
  minhashThreshold: number;
  /** Title similarity threshold */
  titleSimilarityThreshold: number;
  /** Combined weighted score threshold to merge */
  mergeThreshold: number;
  /** Number of hash functions for MinHash */
  minhashNumHashes: number;
  /** Number of shingle tokens for MinHash */
  shingleSize: number;
  /** Maximum candidates to evaluate per chunk */
  maxCandidates: number;
}

const DEFAULT_CONFIG: DeduplicationConfig = {
  embeddingSimilarityThreshold: 0.90,
  minhashThreshold: 0.70,
  titleSimilarityThreshold: 0.60,
  mergeThreshold: 0.85,
  minhashNumHashes: 128,
  shingleSize: 3,
  maxCandidates: 20,
};

// ─── Similarity Scores ───────────────────────────────────────────────────────

interface DuplicateCandidate {
  chunkId: string;
  title: string;
  embeddingSimilarity: number;
  minhashSimilarity: number;
  titleSimilarity: number;
  repositoryOverlap: boolean;
  combinedScore: number;
}

// ─── Deduplication Engine ────────────────────────────────────────────────────

export class DeduplicationEngine {
  private config: DeduplicationConfig;
  private chunkRepo: ChunkRepository;
  private clusterRepo: ClusterRepository;
  private embeddingClient: EmbeddingClient;

  constructor(config: Partial<DeduplicationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.chunkRepo = new ChunkRepository();
    this.clusterRepo = new ClusterRepository();
    this.embeddingClient = new EmbeddingClient();
  }

  /**
   * Check a chunk for duplicates and merge into a cluster if found.
   * This is the main entry point called by the BullMQ worker.
   */
  async deduplicate(chunk: Chunk): Promise<{
    isDuplicate: boolean;
    clusterId?: string;
    mergedWith?: string[];
  }> {
    logger.info({ chunkId: chunk.id, title: chunk.title }, 'Checking for duplicates');

    // Step 1: Find candidates via embedding similarity (fast ANN search)
    const candidates = await this.findCandidates(chunk);

    if (candidates.length === 0) {
      logger.debug({ chunkId: chunk.id }, 'No duplicate candidates found');
      return { isDuplicate: false };
    }

    // Step 2: Score each candidate with multiple signals
    const scoredCandidates = await this.scoreCandidates(chunk, candidates);

    // Step 3: Filter by merge threshold
    const duplicates = scoredCandidates.filter(c => c.combinedScore >= this.config.mergeThreshold);

    if (duplicates.length === 0) {
      logger.debug({
        chunkId: chunk.id,
        topCandidate: scoredCandidates[0]?.combinedScore,
      }, 'No duplicates above merge threshold');
      return { isDuplicate: false };
    }

    // Step 4: Merge into cluster
    const result = await this.mergeIntoCluster(chunk, duplicates);

    logger.info({
      chunkId: chunk.id,
      clusterId: result.clusterId,
      mergedWith: result.mergedWith.length,
      topScore: duplicates[0].combinedScore,
    }, 'Chunk merged into cluster');

    return {
      isDuplicate: true,
      clusterId: result.clusterId,
      mergedWith: result.mergedWith,
    };
  }

  /**
   * Phase 1: Find candidate duplicates using vector similarity.
   * This is O(log n) with HNSW index, making it suitable for millions of chunks.
   */
  private async findCandidates(chunk: Chunk): Promise<Array<Chunk & { similarity: number }>> {
    if (!chunk.embedding || chunk.embedding.length === 0) {
      // Generate embedding if not already present
      const embedding = await this.embeddingClient.embed(
        `${chunk.title}\n${chunk.summary}\n${chunk.content}`
      );
      chunk.embedding = embedding;
    }

    const results = await this.chunkRepo.searchByVector(chunk.embedding, {
      limit: this.config.maxCandidates,
      organizationId: chunk.organizationId,
      minQualityScore: 0,
    });

    // Exclude self
    return results.filter(r => r.id !== chunk.id && r.similarity >= this.config.embeddingSimilarityThreshold);
  }

  /**
   * Phase 2: Score candidates with multiple signals.
   * Combines embedding similarity, MinHash, title similarity, and repo overlap.
   */
  private async scoreCandidates(
    chunk: Chunk,
    candidates: Array<Chunk & { similarity: number }>,
  ): Promise<DuplicateCandidate[]> {
    const chunkShingles = this.computeShingles(chunk.content);
    const chunkMinHash = this.computeMinHash(chunkShingles);
    const chunkTitleTokens = this.tokenize(chunk.title);

    const scored: DuplicateCandidate[] = [];

    for (const candidate of candidates) {
      // MinHash similarity (content fingerprint)
      const candidateShingles = this.computeShingles(candidate.content);
      const candidateMinHash = this.computeMinHash(candidateShingles);
      const minhashSimilarity = this.minhashJaccard(chunkMinHash, candidateMinHash);

      // Title similarity (tokenized Jaccard)
      const candidateTitleTokens = this.tokenize(candidate.title);
      const titleSimilarity = this.jaccardSimilarity(chunkTitleTokens, candidateTitleTokens);

      // Repository overlap
      const repositoryOverlap = !!(
        chunk.repository && candidate.repository &&
        chunk.repository === candidate.repository
      );

      // Combined score (weighted average)
      const combinedScore = this.computeCombinedScore({
        embeddingSimilarity: candidate.similarity,
        minhashSimilarity,
        titleSimilarity,
        repositoryOverlap,
      });

      scored.push({
        chunkId: candidate.id,
        title: candidate.title,
        embeddingSimilarity: candidate.similarity,
        minhashSimilarity,
        titleSimilarity,
        repositoryOverlap,
        combinedScore,
      });
    }

    // Sort by combined score descending
    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    return scored;
  }

  /**
   * Compute weighted combined score from individual signals.
   */
  private computeCombinedScore(scores: {
    embeddingSimilarity: number;
    minhashSimilarity: number;
    titleSimilarity: number;
    repositoryOverlap: boolean;
  }): number {
    const weights = {
      embedding: 0.40,
      minhash: 0.30,
      title: 0.20,
      repository: 0.10,
    };

    return (
      weights.embedding * scores.embeddingSimilarity +
      weights.minhash * scores.minhashSimilarity +
      weights.title * scores.titleSimilarity +
      weights.repository * (scores.repositoryOverlap ? 1.0 : 0.0)
    );
  }

  /**
   * Phase 3: Merge chunk into existing or new cluster.
   * The highest-quality chunk becomes the canonical representative.
   */
  private async mergeIntoCluster(
    chunk: Chunk,
    duplicates: DuplicateCandidate[],
  ): Promise<{ clusterId: string; mergedWith: string[] }> {
    const duplicateIds = duplicates.map(d => d.chunkId);

    // Check if any duplicate is already in a cluster
    const existingCluster = await this.clusterRepo.findByMemberChunkId(duplicateIds[0]);

    if (existingCluster) {
      // Add to existing cluster
      await this.clusterRepo.addMember(existingCluster.id, chunk.id);
      await this.chunkRepo.assignToCluster(chunk.id, existingCluster.id, false);

      // Re-evaluate canonical (maybe new chunk is higher quality)
      await this.reEvaluateCanonical(existingCluster.id);

      return { clusterId: existingCluster.id, mergedWith: duplicateIds };
    }

    // Create new cluster
    const clusterId = uuidv4();
    const allMemberIds = [chunk.id, ...duplicateIds];

    // Determine canonical (highest quality)
    const canonicalId = await this.selectCanonical(allMemberIds);

    const cluster: ChunkCluster = {
      id: clusterId,
      canonicalChunkId: canonicalId,
      memberChunkIds: allMemberIds,
      title: chunk.title,
      summary: chunk.summary,
      mergedAt: new Date().toISOString(),
      memberCount: allMemberIds.length,
      averageSimilarity: duplicates.reduce((s, d) => s + d.combinedScore, 0) / duplicates.length,
    };

    await this.clusterRepo.create(cluster);

    // Update all member chunks with cluster assignment
    for (const memberId of allMemberIds) {
      await this.chunkRepo.assignToCluster(memberId, clusterId, memberId === canonicalId);
    }

    return { clusterId, mergedWith: duplicateIds };
  }

  /**
   * Select the canonical (best) representative from cluster members.
   * Considers: quality score, recency, code references, endorsements.
   */
  private async selectCanonical(memberIds: string[]): Promise<string> {
    // For now, use the first ID — in production, load all chunks and compare quality
    // TODO: Load chunks, compare qualityScore + usageCount + upvotes
    return memberIds[0];
  }

  /**
   * Re-evaluate which chunk should be canonical in an existing cluster.
   * Called when a new member is added that might be higher quality.
   */
  private async reEvaluateCanonical(clusterId: string): Promise<void> {
    // TODO: Load all members, pick highest quality, update cluster.canonicalChunkId
    logger.debug({ clusterId }, 'Re-evaluating cluster canonical');
  }

  // ─── MinHash Implementation ────────────────────────────────────────────────

  /**
   * Compute character n-gram shingles from text.
   */
  private computeShingles(text: string): Set<string> {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const shingles = new Set<string>();

    for (let i = 0; i <= normalized.length - this.config.shingleSize; i++) {
      shingles.add(normalized.substring(i, i + this.config.shingleSize));
    }

    return shingles;
  }

  /**
   * Compute MinHash signature from a set of shingles.
   * Uses deterministic hash functions for reproducibility.
   */
  private computeMinHash(shingles: Set<string>): number[] {
    const numHashes = this.config.minhashNumHashes;
    const signature = new Array(numHashes).fill(Infinity);

    if (shingles.size === 0) return signature;

    const shingleArray = [...shingles];

    for (let h = 0; h < numHashes; h++) {
      for (const shingle of shingleArray) {
        const hash = this.hashWithSeed(shingle, h);
        if (hash < signature[h]) {
          signature[h] = hash;
        }
      }
    }

    return signature;
  }

  /**
   * Estimate Jaccard similarity from two MinHash signatures.
   */
  private minhashJaccard(sigA: number[], sigB: number[]): number {
    let agreements = 0;
    for (let i = 0; i < sigA.length; i++) {
      if (sigA[i] === sigB[i]) agreements++;
    }
    return agreements / sigA.length;
  }

  /**
   * Simple hash function with seed for MinHash.
   * Uses FNV-1a variant for speed.
   */
  private hashWithSeed(str: string, seed: number): number {
    let hash = 2166136261 ^ seed;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0; // Ensure unsigned 32-bit
  }

  // ─── Text Similarity Helpers ───────────────────────────────────────────────

  /**
   * Tokenize text for Jaccard comparison.
   */
  private tokenize(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(t => t.length > 2)
    );
  }

  /**
   * Jaccard similarity between two token sets.
   */
  private jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}

// ─── Worker Setup ────────────────────────────────────────────────────────────

let dedupWorker: Worker | null = null;

export function startDeduplicationWorker(): Worker {
  if (dedupWorker) return dedupWorker;

  const config = getConfig();
  const engine = new DeduplicationEngine();
  const chunkRepo = new ChunkRepository();

  dedupWorker = new Worker(
    QUEUE_NAMES.DEDUPLICATION,
    async (job: Job<ChunkProcessingJob>) => {
      const { chunkId } = job.data;

      const chunk = await chunkRepo.findById(chunkId);
      if (!chunk) {
        logger.warn({ chunkId }, 'Chunk not found for deduplication');
        return null;
      }

      return engine.deduplicate(chunk);
    },
    {
      connection: { url: config.REDIS_URL },
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 60000,
      },
    },
  );

  dedupWorker.on('completed', (job, result) => {
    if (result?.isDuplicate) {
      logger.debug({
        chunkId: job.data.chunkId,
        clusterId: result.clusterId,
      }, 'Deduplication: merged into cluster');
    }
  });

  dedupWorker.on('failed', (job, err) => {
    logger.error({ chunkId: job?.data.chunkId, err }, 'Deduplication job failed');
  });

  logger.info('Deduplication worker started');
  return dedupWorker;
}

export async function stopDeduplicationWorker(): Promise<void> {
  if (dedupWorker) {
    await dedupWorker.close();
    dedupWorker = null;
  }
}
