/**
 * Ingestion Pipeline Worker
 *
 * The main orchestrator that processes uploaded sessions through
 * the full pipeline: parse → segment → embed → extract → deduplicate → index.
 *
 * Runs as a BullMQ worker consuming from the session-processing queue.
 */

import { v5 as uuidv5 } from 'uuid';
import { Worker, Job } from 'bullmq';
import { getConfig } from '../config/index.js';
import { createChildLogger } from '../utils/logger.js';
import {
  QUEUE_NAMES,
  type SessionProcessingJob,
} from './queue.js';
import { SessionParser } from './parser.js';
import { SemanticSegmenter } from './segmenter.js';
import { SessionRepository } from '../storage/session-repository.js';
import { ObjectStorageClient } from '../storage/object-storage.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { ProcessingStatusRepository } from '../storage/processing-status-repository.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { GovernanceScanner } from '../utils/governance.js';
import { type SessionRecord, type Chunk } from '../models/index.js';

const logger = createChildLogger({ module: 'pipeline-worker' });

// ─── Pipeline Processor ──────────────────────────────────────────────────────

export class IngestionPipeline {
  private parser: SessionParser;
  private segmenter: SemanticSegmenter;
  private embeddingClient: EmbeddingClient;
  private governanceScanner: GovernanceScanner;
  private sessionRepo: SessionRepository;
  private chunkRepo: ChunkRepository;
  private objectStorage: ObjectStorageClient;

  constructor() {
    this.parser = new SessionParser();
    this.segmenter = new SemanticSegmenter();
    this.embeddingClient = new EmbeddingClient();
    this.governanceScanner = new GovernanceScanner();
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

    const existingSession = await this.sessionRepo.findById(sessionId);
    if (existingSession?.searchableStatus === 'searchable'
      || existingSession?.searchableStatus === 'blocked') {
      const existingChunks = await this.chunkRepo.findBySessionId(sessionId);
      return {
        chunkCount: existingChunks.length,
        tier: existingSession.enrichmentStatus === 'not_required' ? 'fast' : 'deep',
      };
    }

    try {
      // 1. Update status → parsing
      await this.sessionRepo.updateStatus(sessionId, 'parsing');

      // 2. Retrieve raw session from S3
      const config = getConfig();
      const { body } = await this.objectStorage.getObject(config.S3_BUCKET, rawStorageKey);
      const storedSession = JSON.parse(body) as SessionRecord;
      // Raw objects intentionally preserve the original upload shape, which has
      // no database-generated id. Reapply canonical job identity before parsing
      // so chunks cannot inherit a missing or client-controlled session id.
      const session: SessionRecord = {
        ...storedSession,
        id: sessionId,
        organizationId,
        developerId,
        rawStorageKey,
      };

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
      chunks.forEach((chunk, index) => {
        chunk.id = uuidv5(`${sessionId}:chunk:${index}:v1`, '5d4f2e72-30ad-4eb8-9c99-4c67c8bb7077');
      });

      // 5. Governance is a hard gate before embeddings, database FTS, graph,
      // facts, or any downstream searchable representation is created.
      const scanResults = chunks.map(chunk => this.governanceScanner.scanChunk(chunk));
      const governedChunks = scanResults.map(result => result.chunk);
      const searchableChunks = scanResults
        .filter(result => result.scanResult.classification !== 'restricted')
        .map(result => result.chunk);
      const restrictedCount = governedChunks.length - searchableChunks.length;

      // Restricted chunks are retained only as redacted, owner-accessible source
      // records. They receive no embedding or indexing/enrichment jobs.
      const contents = searchableChunks.map(chunk => `${chunk.title}\n${chunk.summary}\n${chunk.content}`);
      const embeddings = await this.embeddingClient.embedBatch(contents);
      for (let index = 0; index < searchableChunks.length; index++) {
        searchableChunks[index].embedding = embeddings[index];
      }

      // Tier is decided before the transaction so the outbox and expected
      // action ledger are committed atomically with every chunk.
      const tier = this.classifyTier(session, parsed, governedChunks);
      if (tier === 'deep') await this.sessionRepo.updateStatus(sessionId, 'extracting');

      const created = await this.chunkRepo.createBatchWithOutbox(governedChunks, {
        sessionId,
        searchableChunkIds: new Set(searchableChunks.map(chunk => chunk.id)),
        deep: tier === 'deep',
      });
      if (!created && governedChunks[0]) {
        await new ProcessingStatusRepository().reconcileChunkAndSession(governedChunks[0].id);
      }

      if (restrictedCount > 0) {
        logger.warn({ sessionId, restrictedCount }, 'Restricted chunks blocked from searchable processing');
      }

      if (searchableChunks.length === 0) {
        await this.sessionRepo.updateStatus(sessionId, 'indexed');
      }

      logger.info({ sessionId, chunkCount: chunks.length, tier }, 'Session processing scheduled');
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
