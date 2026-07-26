/**
 * Knowledge Compaction Engine
 *
 * Three scheduled operations that reduce token usage over time:
 *
 *   1. Cluster Synthesis — For clusters with enough members, synthesize one
 *      concise canonical article via LLM, re-embed it, and demote siblings.
 *   2. Fact Supersession — Detect when a newly extracted fact contradicts an
 *      older one for the same entities and mark the old one superseded.
 *   3. Stale Pruning — Archive unused, low-quality, non-canonical chunks that
 *      are older than a configured threshold.
 *
 * Designed to run as a scheduled CronJob, separate from the ingestion workers,
 * with per-organization advisory locking so concurrent pods cannot collide.
 */

import { createHash } from 'node:crypto';
import { createChildLogger } from '../utils/logger.js';
import { LlmClient, type LlmResponse } from '../utils/llm.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { ClusterRepository } from '../storage/cluster-repository.js';
import { FactRepository } from '../storage/fact-repository.js';
import { type Chunk, type ChunkCluster, type MemoryFact } from '../models/index.js';
import { query, withTransaction } from '../storage/database.js';

const logger = createChildLogger({ module: 'compaction' });

// ─── Configuration ───────────────────────────────────────────────────────────

export interface CompactionConfig {
  /** Minimum cluster members before synthesis triggers */
  minClusterSize: number;
  /** Maximum tokens for the synthesized canonical article */
  maxCanonicalTokens: number;
  /** Days without usage before a chunk is eligible for archival */
  archiveAfterDays: number;
  /** Minimum quality score to keep (below this → archive) */
  archiveQualityThreshold: number;
  /** Maximum clusters to synthesize per run */
  maxClustersPerRun: number;
  /** Maximum chunks to archive per run */
  maxPrunePerRun: number;
  /** Embedding similarity threshold for fact contradiction detection */
  factContradictionThreshold: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
  minClusterSize: 5,
  maxCanonicalTokens: 400,
  archiveAfterDays: 90,
  archiveQualityThreshold: 0.3,
  maxClustersPerRun: 50,
  maxPrunePerRun: 500,
  factContradictionThreshold: 0.88,
};

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = `You are a technical knowledge synthesizer. Given multiple knowledge chunks about the same topic, produce ONE concise canonical article.

Requirements:
- Maximum {maxTokens} tokens
- Include: the core problem/topic, the best solution or explanation, one key code example if present, common pitfalls
- Cite source chunks by number [Source N] where relevant
- Use markdown formatting
- Be specific and actionable, not generic
- Preserve technical accuracy — prefer source material over inference

Output format:
TITLE: <concise title>
SUMMARY: <1-2 sentence summary>
CONTENT:
<the synthesized article>`;

const CONTRADICTION_SYSTEM = `You detect whether two technical facts contradict each other. Two facts contradict when they make incompatible claims about the same entity or concept — one cannot be true while the other is.

Respond with exactly one word: CONTRADICTS or COMPATIBLE

Examples:
- "Team uses Kafka for events" vs "Team migrated from Kafka to SQS" → CONTRADICTS
- "Lambda timeout is 30s" vs "Lambda timeout increased to 60s" → CONTRADICTS
- "Service uses PostgreSQL" vs "Service caches results in Redis" → COMPATIBLE
- "Deploy uses Terraform" vs "Terraform state stored in S3" → COMPATIBLE`;

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface CompactionResult {
  organizationId: string;
  clustersSynthesized: number;
  clustersSkipped: number;
  factsSuperseded: number;
  chunksArchived: number;
  tokensSaved: number;
  llmCalls: number;
  errors: string[];
}

export class CompactionEngine {
  private config: CompactionConfig;
  private llm: LlmClient;
  private embeddingClient: EmbeddingClient;
  private chunkRepo: ChunkRepository;
  private clusterRepo: ClusterRepository;
  private factRepo: FactRepository;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llm = new LlmClient();
    this.embeddingClient = new EmbeddingClient();
    this.chunkRepo = new ChunkRepository();
    this.clusterRepo = new ClusterRepository();
    this.factRepo = new FactRepository();
  }

  /**
   * Run the full compaction pipeline for one organization.
   */
  async run(organizationId: string): Promise<CompactionResult> {
    const result: CompactionResult = {
      organizationId,
      clustersSynthesized: 0,
      clustersSkipped: 0,
      factsSuperseded: 0,
      chunksArchived: 0,
      tokensSaved: 0,
      llmCalls: 0,
      errors: [],
    };

    logger.info({ organizationId, llmEnabled: !this.llm.disabled }, 'Compaction started');

    // Phase 1: Cluster synthesis
    if (!this.llm.disabled) {
      await this.synthesizeClusters(organizationId, result);
    } else {
      // Fallback: re-canonicalize by quality score without synthesis
      await this.recanonicalizeByQuality(organizationId, result);
    }

    // Phase 2: Fact supersession
    if (!this.llm.disabled) {
      await this.detectFactSupersession(organizationId, result);
    }

    // Phase 3: Stale pruning
    await this.pruneStaleChunks(organizationId, result);

    logger.info({
      org: organizationId,
      synthesized: result.clustersSynthesized,
      superseded: result.factsSuperseded,
      archived: result.chunksArchived,
      tokensSaved: result.tokensSaved,
      llmCalls: result.llmCalls,
      errors: result.errors.length,
    }, 'Compaction completed');

    return result;
  }

  // ─── Phase 1: Cluster Synthesis ──────────────────────────────────────────

  private async synthesizeClusters(
    organizationId: string,
    result: CompactionResult,
  ): Promise<void> {
    const clusters = await this.clusterRepo.findTopClusters(organizationId, {
      minMembers: this.config.minClusterSize,
      limit: this.config.maxClustersPerRun,
    });

    for (const cluster of clusters) {
      try {
        const synthesized = await this.synthesizeCluster(cluster, organizationId);
        if (synthesized) {
          result.clustersSynthesized++;
          result.tokensSaved += synthesized.tokensSaved;
          result.llmCalls++;
        } else {
          result.clustersSkipped++;
        }
      } catch (error) {
        const message = `Cluster ${cluster.id}: ${(error as Error).message}`;
        result.errors.push(message);
        logger.error({ err: error, clusterId: cluster.id }, 'Cluster synthesis failed');
      }
    }
  }

  private async synthesizeCluster(
    cluster: ChunkCluster,
    organizationId: string,
  ): Promise<{ tokensSaved: number } | null> {
    // Load member chunks (cap at 20 for LLM context window)
    const memberChunks: Chunk[] = [];
    for (const memberId of cluster.memberChunkIds.slice(0, 20)) {
      const chunk = await this.chunkRepo.findById(memberId);
      if (chunk) memberChunks.push(chunk);
    }

    if (memberChunks.length < this.config.minClusterSize) return null;

    // Check idempotency: skip if canonical was already synthesized with same sources
    const sourceHash = this.computeSourceHash(memberChunks);
    const canonical = memberChunks.find(c => c.id === cluster.canonicalChunkId);
    if (canonical?.linkedVersion === `synth:${sourceHash}`) {
      logger.debug({ clusterId: cluster.id }, 'Cluster already synthesized with same sources');
      return null;
    }

    // Build synthesis input
    const sourceMaterial = memberChunks.map((chunk, index) =>
      `[Source ${index + 1}] ${chunk.title}\n${chunk.summary}\n${chunk.content.substring(0, 800)}`
    ).join('\n\n---\n\n');

    const systemPrompt = SYNTHESIS_SYSTEM.replace('{maxTokens}', String(this.config.maxCanonicalTokens));
    const userPrompt = `Topic: "${cluster.title}"\n\nCluster has ${memberChunks.length} chunks. Synthesize into one canonical article:\n\n${sourceMaterial}`;

    const response = await this.llm.generate(systemPrompt, userPrompt);
    if (!response) return null;

    // Parse LLM response
    const { title, summary, content } = this.parseSynthesisResponse(response.text, cluster.title);
    const tokenCount = Math.ceil(content.length / 4);

    // Re-embed the synthesized content
    const embedding = await this.embeddingClient.embed(`${title}\n${summary}\n${content}`);

    // Total tokens across all members (what retrieval would have returned before)
    const totalMemberTokens = memberChunks.reduce((s, c) => s + c.tokenCount, 0);

    // Atomic update: rewrite canonical and demote siblings
    await withTransaction(async client => {
      const canonicalId = cluster.canonicalChunkId;

      await client.query(`
        UPDATE chunks SET
          title = $2, summary = $3, content = $4, token_count = $5,
          embedding = $6::vector, embedding_model = $7, embedding_version = $8,
          linked_version = $9, quality_score = GREATEST(quality_score, 0.9),
          is_canonical = true, updated_at = NOW()
        WHERE id = $1
      `, [
        canonicalId, title, summary, content, tokenCount,
        `[${embedding.join(',')}]`, this.embeddingClient.getModelName(), 1,
        `synth:${sourceHash}`,
      ]);

      // Demote all non-canonical members
      for (const chunk of memberChunks) {
        if (chunk.id === canonicalId) continue;
        await client.query(`
          UPDATE chunks SET is_canonical = false, quality_score = LEAST(quality_score, 0.4),
                            updated_at = NOW()
          WHERE id = $1 AND is_canonical = true
        `, [chunk.id]);
      }

      // Update cluster metadata
      await client.query(`
        UPDATE chunk_clusters SET title = $2, summary = $3
        WHERE organization_id = $4 AND id = $1
      `, [cluster.id, title, summary, organizationId]);
    });

    const tokensSaved = Math.max(0, totalMemberTokens - tokenCount);
    logger.info({
      clusterId: cluster.id,
      members: memberChunks.length,
      tokensBefore: totalMemberTokens,
      tokensAfter: tokenCount,
      saved: tokensSaved,
    }, 'Cluster synthesized');

    return { tokensSaved };
  }

  /** Fallback when LLM is disabled: pick highest-quality member as canonical. */
  private async recanonicalizeByQuality(
    organizationId: string,
    result: CompactionResult,
  ): Promise<void> {
    const clusters = await this.clusterRepo.findTopClusters(organizationId, {
      minMembers: this.config.minClusterSize,
      limit: this.config.maxClustersPerRun,
    });

    for (const cluster of clusters) {
      const members: Chunk[] = [];
      for (const id of cluster.memberChunkIds.slice(0, 20)) {
        const chunk = await this.chunkRepo.findById(id);
        if (chunk) members.push(chunk);
      }
      if (members.length < this.config.minClusterSize) continue;

      const best = members.reduce((a, b) =>
        (b.qualityScore + b.usageCount * 0.01 + b.upvotes * 0.05) >
        (a.qualityScore + a.usageCount * 0.01 + a.upvotes * 0.05) ? b : a
      );

      if (best.id !== cluster.canonicalChunkId) {
        await this.clusterRepo.updateCanonical(organizationId, cluster.id, best.id);
        await this.chunkRepo.assignToCluster(best.id, cluster.id, true);
        await this.chunkRepo.assignToCluster(cluster.canonicalChunkId, cluster.id, false);
        result.clustersSynthesized++;
      }
    }
  }

  // ─── Phase 2: Fact Supersession ──────────────────────────────────────────

  /**
   * Find recently created facts that contradict older facts about the same
   * entities, and mark the older ones superseded.
   */
  async detectFactSupersession(
    organizationId: string,
    result: CompactionResult,
  ): Promise<void> {
    // Get facts created since the last compaction (approximate: last 7 days)
    const recentFacts = await this.factRepo.findByTemporal(organizationId, {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      onlyCurrentlyValid: true,
      includeSuperseded: false,
    }, { limit: 200 });

    for (const newFact of recentFacts) {
      if (!newFact.embedding || newFact.entities.length === 0) continue;

      // Find older facts with high embedding similarity and entity overlap
      const candidates = await this.factRepo.findSimilar(
        newFact.embedding,
        organizationId,
        this.config.factContradictionThreshold,
      );

      for (const oldFact of candidates) {
        // Skip self and already-superseded facts
        if (oldFact.id === newFact.id) continue;
        if (oldFact.temporal?.validUntil) continue;
        // Skip if the new fact is older than the candidate
        if (newFact.createdAt <= oldFact.createdAt) continue;

        // Check entity overlap
        const overlap = this.entityOverlap(newFact.entities, oldFact.entities);
        if (overlap < 0.5) continue;

        // Ask LLM whether these contradict
        const contradicts = await this.checkContradiction(newFact, oldFact);
        result.llmCalls++;

        if (contradicts) {
          await this.factRepo.markSuperseded(oldFact.id, newFact.id);
          result.factsSuperseded++;
          logger.info({
            oldFactId: oldFact.id,
            newFactId: newFact.id,
            oldContent: oldFact.content.substring(0, 80),
            newContent: newFact.content.substring(0, 80),
          }, 'Fact superseded');
        }
      }
    }
  }

  private async checkContradiction(newFact: MemoryFact, oldFact: MemoryFact): Promise<boolean> {
    const userPrompt = `Fact A (older): "${oldFact.content}"\nFact B (newer): "${newFact.content}"`;
    const response = await this.llm.generate(CONTRADICTION_SYSTEM, userPrompt);
    if (!response) return false;
    return response.text.trim().toUpperCase().startsWith('CONTRADICT');
  }

  private entityOverlap(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a.map(e => e.toLowerCase()));
    const setB = new Set(b.map(e => e.toLowerCase()));
    let intersection = 0;
    for (const item of setA) if (setB.has(item)) intersection++;
    return intersection / (setA.size + setB.size - intersection);
  }

  // ─── Phase 3: Stale Pruning ──────────────────────────────────────────────

  private async pruneStaleChunks(
    organizationId: string,
    result: CompactionResult,
  ): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.archiveAfterDays * 24 * 60 * 60 * 1000);

    const stale = await query<{ id: string }>(`
      SELECT id FROM chunks
      WHERE organization_id = $1
        AND confidence <> 'archived'
        AND is_canonical = false
        AND usage_count = 0
        AND quality_score < $2
        AND created_at < $3
        AND (last_accessed_at IS NULL OR last_accessed_at < $3)
      ORDER BY quality_score ASC, created_at ASC
      LIMIT $4
    `, [organizationId, this.config.archiveQualityThreshold, cutoff.toISOString(), this.config.maxPrunePerRun]);

    if (stale.rows.length === 0) return;

    const ids = stale.rows.map(row => row.id);
    await this.chunkRepo.bulkUpdateConfidence(
      ids.map(id => ({ id, confidence: 'archived' as const })),
    );

    result.chunksArchived = ids.length;
    logger.info({ organizationId, archived: ids.length }, 'Stale chunks archived');
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private computeSourceHash(chunks: Chunk[]): string {
    const content = chunks
      .map(c => c.id)
      .sort()
      .join(':');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private parseSynthesisResponse(
    text: string,
    fallbackTitle: string,
  ): { title: string; summary: string; content: string } {
    const titleMatch = text.match(/^TITLE:\s*(.+)/m);
    const summaryMatch = text.match(/^SUMMARY:\s*(.+)/m);
    const contentMatch = text.match(/^CONTENT:\s*\n([\s\S]+)/m);

    return {
      title: titleMatch?.[1]?.trim() ?? fallbackTitle,
      summary: summaryMatch?.[1]?.trim() ?? text.substring(0, 200),
      content: contentMatch?.[1]?.trim() ?? text,
    };
  }
}
