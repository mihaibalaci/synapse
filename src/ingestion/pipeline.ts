/**
 * Ingestion Pipeline Worker
 *
 * The main orchestrator that processes uploaded sessions through
 * the full pipeline: parse → segment → embed → extract → deduplicate → index.
 *
 * Runs as a BullMQ worker consuming from the session-processing queue.
 */

import { Worker, Job } from 'bullmq';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import { QUEUE_NAMES, type SessionProcessingJob, enqueueChunkProcessing } from './queue.js';
import { SessionParser } from './parser.js';
import { SemanticSegmenter } from './segmenter.js';
import { SessionRepository } from '../storage/session-repository.js';
import { ObjectStorageClient } from '../storage/object-storage.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { type SessionRecord, type Chunk } from '../models/index.js';

const logger = createChildLogger({ module: 'pipeline-worker' });

// ─── Pipeline Processor ──────────────────────────────────────────────────────

export class IngestionPipeline {
  private parser: SessionParser;
  private segmenter: SemanticSegmenter;
  private embeddingClient: EmbeddingClient;
  private sessionRepo: SessionRepository;
  private chunkRepo: ChunkRepository;
  private objectStorage: ObjectStorageClient;

  constructor() {
    this.parser = new SessionParser();
    this.segmenter = new SemanticSegmenter();
    this.embeddingClient = new EmbeddingClient();
    this.sessionRepo = new SessionRepository();
    this.chunkRepo = new ChunkRepository();
    this.objectStorage = new ObjectStorageClient();
  }

  /**
   * Process a single session through the pipeline.
   * v2: Tiered processing — fast path for all, deep path for high-value only.
   */
  async processSession(job: SessionProcessingJob): Promise<{ chunkCount: number; tier: 'fast' | 'deep' }> {
    const { sessionId, rawStorageKey, organizationId, developerId } = job;

    logger.info({ sessionId, tokens: job.totalTokens }, 'Starting session processing');

    try {
      // 1. Update status → parsing
      await this.sessionRepo.updateStatus(sessionId, 'parsing');

      // 2. Retrieve raw session from S3
      const config = getConfig();
      const { body } = await this.objectStorage.getObject(config.S3_BUCKET, rawStorageKey);
      const session: SessionRecord = JSON.parse(body);

      // 3. Parse → normalize messages, extract code blocks
      const parsed = await this.parser.parse(session);

      logger.info({
        sessionId,
        parsedMessages: parsed.messages.length,
        languages: parsed.languages,
      }, 'Session parsed');

      // 4. Segment → split into topical chunks (heuristic, no LLM)
      await this.sessionRepo.updateStatus(sessionId, 'segmenting');
      const chunks = await this.segmenter.segment(parsed, {
        organizationId,
        developerId,
        repository: session.git?.repository,
        branch: session.git?.branch,
        commitSha: session.git?.commitSha,
      });

      // 5. Generate embeddings for all chunks (batch, cheap)
      const contents = chunks.map(c => `${c.title}\n${c.summary}\n${c.content}`);
      const embeddings = await this.embeddingClient.embedBatch(contents);

      for (let i = 0; i < chunks.length; i++) {
        chunks[i].embedding = embeddings[i];
      }

      // 6. Persist chunks (immediately searchable after this step)
      await this.chunkRepo.createBatch(chunks);

      // ═══ TIER DECISION ═══
      // Determine if this session warrants deep processing (LLM extraction + dedup + graph)
      const tier = this.classifyTier(session, parsed, chunks);

      if (tier === 'deep') {
        // 7. Enqueue downstream processing (knowledge extraction + dedup + graph)
        await this.sessionRepo.updateStatus(sessionId, 'extracting');

        for (const chunk of chunks) {
          await enqueueChunkProcessing({ chunkId: chunk.id, sessionId, action: 'extract' });
          await enqueueChunkProcessing({ chunkId: chunk.id, sessionId, action: 'deduplicate' });
        }
      }

      // 8. Mark session as indexed (searchable even if deep processing is pending)
      await this.sessionRepo.updateStatus(sessionId, 'indexed');

      logger.info({ sessionId, chunkCount: chunks.length, tier }, 'Session processing complete');
      return { chunkCount: chunks.length, tier };
    } catch (error) {
      logger.error({ err: error, sessionId }, 'Session processing failed');
      await this.sessionRepo.updateStatus(sessionId, 'failed', (error as Error).message);
      throw error;
    }
  }

  /**
   * Classify whether a session deserves deep (expensive) processing.
   * Criteria for promotion to Tier 2:
   *   - Contains code diffs (likely debugging / problem-solving)
   *   - High message count (substantive conversation, not one-shot)
   *   - Contains error patterns (likely a resolved issue = high value)
   *   - Developer flagged it as useful
   */
  private classifyTier(
    session: SessionRecord,
    parsed: any,
    chunks: Chunk[],
  ): 'fast' | 'deep' {
    let score = 0;

    // Code diffs present = likely debugging session
    if (session.git?.codeDiffs && session.git.codeDiffs.length > 0) score += 3;

    // Substantive conversation (not just "write me a function")
    if (session.messages.length >= 10) score += 2;

    // Contains error patterns
    const hasErrors = chunks.some(c =>
      /\b(error|exception|stack\s?trace|timeout|crash|fix)\b/i.test(c.content)
    );
    if (hasErrors) score += 2;

    // Multiple languages/frameworks (complex problem)
    if (parsed.languages?.length >= 2) score += 1;
    if (parsed.frameworks?.length >= 2) score += 1;

    // Total tokens > 10K (substantial session)
    if (session.totalTokens > 10000) score += 1;

    // Threshold: score >= 4 → deep processing
    return score >= 4 ? 'deep' : 'fast';
  }
}

// ─── Worker Setup ────────────────────────────────────────────────────────────

let worker: Worker | null = null;

export function startPipelineWorker(): Worker {
  if (worker) return worker;

  const config = getConfig();
  const pipeline = new IngestionPipeline();

  worker = new Worker(
    QUEUE_NAMES.SESSION_PROCESSING,
    async (job: Job<SessionProcessingJob>) => {
      return pipeline.processSession(job.data);
    },
    {
      connection: { url: config.REDIS_URL },
      concurrency: config.QUEUE_CONCURRENCY,
      limiter: {
        max: 50,
        duration: 60000, // 50 jobs per minute max
      },
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, sessionId: job.data.sessionId }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({
      jobId: job?.id,
      sessionId: job?.data.sessionId,
      err,
      attempts: job?.attemptsMade,
    }, 'Job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  logger.info({ concurrency: config.QUEUE_CONCURRENCY }, 'Pipeline worker started');
  return worker;
}

export async function stopPipelineWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Pipeline worker stopped');
  }
}
