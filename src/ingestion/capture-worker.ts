/** Processes ambient captures into governance-filtered atomic facts. */

import { Job, Worker } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { getConfig } from '../config/index.js';
import { type Chunk, type MemoryFact } from '../models/index.js';
import { CaptureRepository } from '../storage/capture-repository.js';
import { FactRepository } from '../storage/fact-repository.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { GovernanceScanner } from '../utils/governance.js';
import { createChildLogger } from '../utils/logger.js';
import { QUEUE_NAMES, type CaptureProcessingJob } from './queue.js';

const logger = createChildLogger({ module: 'capture-worker' });
let captureWorker: Worker<CaptureProcessingJob> | null = null;

function factType(content: string): MemoryFact['type'] {
  if (/\b(decided|chose|going with|switched to)\b/i.test(content)) return 'decision';
  if (/\b(root cause|the issue was|the fix is|solution)\b/i.test(content)) return 'lesson';
  if (/\b(always|never|recommend|should|avoid|prefer)\b/i.test(content)) return 'pattern';
  if (/\b(maximum|limit|timeout|must|cannot exceed|at least)\b/i.test(content)) return 'constraint';
  return 'definition';
}

function extractStatements(content: string): string[] {
  const lines = content.split(/\n+/)
    .map(line => line.replace(/^[$>#*-]+\s*/, '').trim())
    .filter(line => line.length >= 20 && line.length <= 500);
  return [...new Set(lines)].slice(0, 8);
}

async function processCapture(job: CaptureProcessingJob): Promise<{ factCount: number; blocked?: boolean }> {
  const captures = new CaptureRepository();
  const facts = new FactRepository();
  const scanner = new GovernanceScanner();
  const embeddings = new EmbeddingClient();
  const event = await captures.findById(job.captureId);
  if (!event) throw new Error(`Capture ${job.captureId} not found`);
  const claim = await captures.claimProcessing(event.id);
  if (claim === 'terminal') {
    return { factCount: event.factIds.length, blocked: event.processingStatus === 'blocked' };
  }
  if (claim === 'busy') throw new Error(`Capture ${event.id} is already processing`);
  try {
    const now = new Date().toISOString();
    const syntheticChunk: Chunk = {
      id: event.id,
      sessionId: event.id,
      title: `${event.type} capture from ${event.source}`,
      summary: event.content.slice(0, 240),
      content: event.content,
      tokenCount: Math.ceil(event.content.length / 4),
      type: event.type === 'terminal' ? 'troubleshooting' : 'discussion',
      entities: [],
      codeReferences: [],
      language: String(event.metadata.language ?? 'unknown'),
      languages: [],
      frameworks: [],
      authorId: event.developerId,
      organizationId: event.organizationId,
      confidence: 'high',
      qualityScore: 0.5,
      usageCount: 0,
      upvotes: 0,
      downvotes: 0,
      isCanonical: false,
      embeddingModel: embeddings.getModelName(),
      embeddingVersion: 1,
      createdAt: event.timestamp,
      updatedAt: now,
    };
    const governed = scanner.scanChunk(syntheticChunk);
    if (governed.scanResult.classification === 'restricted') {
      await captures.markBlocked(event.id);
      return { factCount: 0, blocked: true };
    }

    const statements = extractStatements(governed.chunk.content);
    const vectors = statements.length > 0 ? await embeddings.embedBatch(statements) : [];
    const extracted: MemoryFact[] = statements.map((content, index) => ({
      id: uuidv4(),
      content,
      type: factType(content),
      entities: [],
      temporal: { observedAt: event.timestamp, temporalSource: 'inferred' },
      sourceCaptureId: event.id,
      sourceCaptureSequence: index,
      extractedFrom: 'user',
      authorId: event.developerId,
      organizationId: event.organizationId,
      scope: 'personal',
      confidence: 0.6,
      usageCount: 0,
      upvotes: 0,
      embedding: vectors[index],
      embeddingModel: embeddings.getModelName(),
      frameworks: [],
      createdAt: now,
      updatedAt: now,
    }));

    await facts.createForCaptureAndMarkProcessed(event.id, extracted);
    return { factCount: extracted.length };
  } catch (error) {
    await captures.markFailed(event.id, (error as Error).message);
    throw error;
  }
}

export function startCaptureWorker(): Worker<CaptureProcessingJob> {
  if (captureWorker) return captureWorker;
  const config = getConfig();
  captureWorker = new Worker<CaptureProcessingJob>(
    QUEUE_NAMES.CAPTURE_PROCESSING,
    (job: Job<CaptureProcessingJob>) => processCapture(job.data),
    {
      connection: { url: config.REDIS_URL },
      concurrency: Math.max(1, Math.floor(config.QUEUE_CONCURRENCY / 2)),
      limiter: { max: 100, duration: 60_000 },
    },
  );
  captureWorker.on('failed', (job, error) => {
    logger.error({ captureId: job?.data.captureId, err: error }, 'Capture processing failed');
  });
  captureWorker.on('error', error => logger.error({ err: error }, 'Capture worker error'));
  logger.info('Ambient capture worker started');
  return captureWorker;
}

export async function stopCaptureWorker(): Promise<void> {
  if (!captureWorker) return;
  await captureWorker.close();
  captureWorker = null;
  logger.info('Ambient capture worker stopped');
}
