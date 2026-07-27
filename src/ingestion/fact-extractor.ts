/**
 * Fact Extractor (v3 — ADD-only, single-pass)
 *
 * Extracts atomic facts from conversation chunks using a single LLM pass.
 * Each fact is a small, precise, independently retrievable unit of knowledge.
 *
 * Key design principles:
 *   1. Single-pass extraction — one LLM call, no reconciliation step
 *   2. ADD-only — never overwrite or delete existing facts
 *   3. Agent facts are first-class — assistant responses contain solutions
 *   4. Entity linking — every fact tagged with its entities for retrieval boost
 *   5. Temporal context — when was this true? is it still valid?
 *
 * A single chunk might produce 2-8 atomic facts:
 *   "Team uses Kafka for event streaming between auth and billing"
 *   "Lambda cold starts in VPC take 3-5 seconds due to ENI attachment"
 *   "Always use VPC endpoints instead of NAT gateway for S3 access"
 */

import { v5 as uuidv5 } from 'uuid';
import { Worker, Job, Queue } from 'bullmq';
import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { QUEUE_NAMES, type ChunkProcessingJob } from './queue.js';
import { runTrackedChunkJob } from './tracked-job.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { FactRepository } from '../storage/fact-repository.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { LlmClient } from '../utils/llm.js';
import { OBSERVATION_QUEUE_NAME, type ObservationJob } from './observation-generator.js';
import { OpinionReinforcementEngine } from './opinion-reinforcement.js';
import { type Chunk, type MemoryFact, type FactType } from '../models/index.js';

const logger = createChildLogger({ module: 'fact-extractor' });

// ─── Extraction Prompt ───────────────────────────────────────────────────────

const FACT_EXTRACTION_PROMPT = `Extract atomic facts from this engineering conversation.

Rules:
- Each fact should be ONE self-contained statement (10-50 words)
- Extract decisions, preferences, patterns, lessons, constraints, procedures, definitions, relationships, opinions
- Include facts from BOTH user and assistant messages (assistant often has the solution)
- Be specific: include technology names, version numbers, service names
- DO NOT extract trivial/obvious statements
- DO NOT extract questions (only answers/decisions)
- Each fact should be useful to a future engineer encountering a similar situation

For each fact, provide:
- content: the atomic fact statement
- type: one of [decision, preference, pattern, lesson, constraint, procedure, definition, relationship, opinion]
- entities: array of key entities mentioned (technologies, services, concepts)
- extractedFrom: "user" or "assistant" or "both"

Respond in JSON array format:
[{"content": "...", "type": "...", "entities": ["..."], "extractedFrom": "..."}]

If no meaningful facts can be extracted, return an empty array: []`;

// ─── Narrative Fact Extraction Prompt ────────────────────────────────────────

const NARRATIVE_EXTRACTION_PROMPT = `Extract 2-5 narrative facts from this engineering conversation. Unlike atomic facts, narrative facts are comprehensive summaries that preserve cross-turn context and reasoning.

Rules:
- Each narrative fact should be 50-200 words — self-contained and readable
- Preserve the full reasoning chain, not just the conclusion
- Include who said what, what was tried, what worked, and why
- Capture the "story" of the conversation, not just isolated statements
- Each narrative should cover one complete topic/exchange
- Include relevant entities (technologies, services, concepts)

For each narrative, provide:
- content: the narrative fact (50-200 words, complete story)
- type: one of [decision, lesson, pattern, procedure, opinion]
- entities: array of key entities mentioned
- extractedFrom: "both" (narratives span multiple turns)

Respond in JSON array format:
[{"content": "...", "type": "...", "entities": ["..."], "extractedFrom": "both"}]

If no meaningful narratives can be extracted, return an empty array: []`;

// ─── Fact Extractor ──────────────────────────────────────────────────────────

export class FactExtractor {
  private chunkRepo: ChunkRepository;
  private factRepo: FactRepository;
  private embeddingClient: EmbeddingClient;
  private llm: LlmClient;

  constructor() {
    this.chunkRepo = new ChunkRepository();
    this.factRepo = new FactRepository();
    this.embeddingClient = new EmbeddingClient();
    this.llm = new LlmClient();
  }

  /**
   * Extract atomic facts from a chunk. Single-pass, ADD-only.
   * Returns the list of facts created (never modifies existing facts).
   */
  async extract(chunk: Chunk): Promise<MemoryFact[]> {
    logger.info({
      chunkId: chunk.id,
      tokenCount: chunk.tokenCount,
      type: chunk.type,
    }, 'Extracting facts from chunk');

    // Step 1: Try LLM extraction (preferred)
    let rawFacts = await this.llmExtract(chunk);

    // Step 2: Fallback to heuristic extraction if LLM fails or is unavailable
    if (rawFacts.length === 0) {
      rawFacts = this.heuristicExtract(chunk);
    }

    if (rawFacts.length === 0) {
      logger.debug({ chunkId: chunk.id }, 'No facts extractable from chunk');
      return [];
    }

    // Step 3: Build MemoryFact objects
    const now = new Date().toISOString();
    const facts: MemoryFact[] = rawFacts.map((raw, index) => ({
      id: uuidv5(`${chunk.id}:fact:${index}:${raw.content}`, 'e585bb5c-7b92-430e-824d-cc1b5876b922'),
      content: raw.content,
      type: raw.type as FactType,
      entities: raw.entities,
      temporal: {
        observedAt: now,
        validFrom: chunk.createdAt,
        temporalSource: 'inferred' as const,
      },
      sourceChunkId: chunk.id,
      sourceSessionId: chunk.sessionId,
      extractedFrom: raw.extractedFrom as 'user' | 'assistant' | 'both',
      authorId: chunk.authorId,
      organizationId: chunk.organizationId,
      teamId: chunk.teamId,
      scope: 'organization' as const,
      confidence: this.assessConfidence(raw, chunk),
      usageCount: 0,
      upvotes: 0,
      repository: chunk.repository,
      language: chunk.language,
      frameworks: chunk.frameworks,
      createdAt: now,
      updatedAt: now,
    }));

    // Step 4: Generate embeddings for all facts (batch)
    const factContents = facts.map(f => `${f.content} [${f.entities.join(', ')}]`);
    const embeddings = await this.embeddingClient.embedBatch(factContents);
    for (let i = 0; i < facts.length; i++) {
      facts[i].embedding = embeddings[i];
      facts[i].embeddingModel = this.embeddingClient.getModelName();
    }

    // Step 5: Deduplicate against existing facts (ADD-only, but avoid exact dupes)
    const dedupedFacts = await this.deduplicateFacts(facts);

    // Step 6: Persist (ADD-only — we never touch existing facts)
    if (dedupedFacts.length > 0) {
      await this.factRepo.createBatch(dedupedFacts);
    }

    logger.info({
      chunkId: chunk.id,
      extracted: rawFacts.length,
      afterDedup: dedupedFacts.length,
    }, 'Fact extraction complete');

    return dedupedFacts;
  }

  /**
   * LLM-based fact extraction (single-pass).
   */
  private async llmExtract(chunk: Chunk): Promise<RawExtractedFact[]> {
    if (this.llm.disabled) return [];

    try {
      const response = await this.llm.generate(FACT_EXTRACTION_PROMPT, chunk.content);
      if (!response) return [];

      // Parse JSON array from LLM response
      const jsonMatch = response.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      // Validate and normalize each fact
      return parsed
        .filter((item: any) =>
          item.content && typeof item.content === 'string'
          && item.content.length >= 10 && item.content.length <= 300
          && item.type && item.entities,
        )
        .map((item: any) => ({
          content: item.content.trim(),
          type: item.type,
          entities: Array.isArray(item.entities) ? item.entities : [],
          extractedFrom: item.extractedFrom ?? 'both',
        }))
        .slice(0, 10); // Cap at 10 facts per chunk
    } catch (error) {
      logger.warn({ err: error, chunkId: chunk.id }, 'LLM fact extraction failed, falling back to heuristic');
      return [];
    }
  }

  /**
   * Heuristic fact extraction — pattern-based, no LLM needed.
   * Catches common fact patterns in engineering conversations.
   */
  private heuristicExtract(chunk: Chunk): RawExtractedFact[] {
    const facts: RawExtractedFact[] = [];
    const content = chunk.content;
    const lines = content.split('\n');

    for (const line of lines) {
      const cleaned = line.replace(/^(USER|ASSISTANT):\s*/i, '').trim();
      if (cleaned.length < 20 || cleaned.length > 300) continue;

      // Decision patterns: "we should use X", "decided to use X", "going with X"
      if (/\b(decided|chose|going with|we('ll| will) use|switched to|migrated to)\b/i.test(cleaned)) {
        facts.push({
          content: cleaned.substring(0, 200),
          type: 'decision',
          entities: this.extractEntitiesFromText(cleaned),
          extractedFrom: line.startsWith('ASSISTANT') ? 'assistant' : 'user',
        });
      }

      // Lesson patterns: "the issue was", "root cause", "turned out", "the fix is"
      else if (/\b(the issue was|root cause|turned out|the fix is|problem was|solution is)\b/i.test(cleaned)) {
        facts.push({
          content: cleaned.substring(0, 200),
          type: 'lesson',
          entities: this.extractEntitiesFromText(cleaned),
          extractedFrom: line.startsWith('ASSISTANT') ? 'assistant' : 'user',
        });
      }

      // Pattern: "always use X", "never do Y", "best practice is"
      else if (/\b(always|never|best practice|recommend|should use|avoid|prefer)\b/i.test(cleaned)) {
        facts.push({
          content: cleaned.substring(0, 200),
          type: 'pattern',
          entities: this.extractEntitiesFromText(cleaned),
          extractedFrom: line.startsWith('ASSISTANT') ? 'assistant' : 'user',
        });
      }

      // Constraint: numbers, limits, timeouts, sizes
      else if (/\b(max(imum)?|limit|timeout|must be|cannot exceed|up to|at least)\b/i.test(cleaned)
        && /\d/.test(cleaned)) {
        facts.push({
          content: cleaned.substring(0, 200),
          type: 'constraint',
          entities: this.extractEntitiesFromText(cleaned),
          extractedFrom: line.startsWith('ASSISTANT') ? 'assistant' : 'user',
        });
      }

      // Procedure: step-by-step, numbered instructions
      else if (/^(\d+[.)]\s|step \d|first,|then,|finally,)/i.test(cleaned)) {
        facts.push({
          content: cleaned.substring(0, 200),
          type: 'procedure',
          entities: this.extractEntitiesFromText(cleaned),
          extractedFrom: line.startsWith('ASSISTANT') ? 'assistant' : 'user',
        });
      }

      // Opinion: "I think X is better", "X is preferred over Y", "we believe"
      else if (/\b(better than|preferred over|I think|we believe|in my experience|my opinion|recommend .+ over)\b/i.test(cleaned)) {
        facts.push({
          content: cleaned.substring(0, 200),
          type: 'opinion',
          entities: this.extractEntitiesFromText(cleaned),
          extractedFrom: line.startsWith('ASSISTANT') ? 'assistant' : 'user',
        });
      }
    }

    // Limit to most confident facts
    return facts.slice(0, 8);
  }

  /**
   * Extract narrative facts from a chunk (coarse-grained, 2-5 per chunk).
   * Narrative facts preserve cross-turn context and reasoning chains.
   * Complements atomic facts for multi-hop retrieval.
   *
   * Inspired by Hindsight's TEMPR narrative extraction paradigm.
   */
  async extractNarrative(chunk: Chunk): Promise<MemoryFact[]> {
    logger.info({ chunkId: chunk.id }, 'Extracting narrative facts from chunk');

    // Narrative extraction requires LLM — no heuristic fallback
    let rawFacts: RawExtractedFact[] = [];
    try {
      if (!this.llm.disabled) {
        const response = await this.llm.generate(NARRATIVE_EXTRACTION_PROMPT, chunk.content);
        if (response) {
          const jsonMatch = response.text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
              rawFacts = parsed
                .filter((item: any) =>
                  item.content && typeof item.content === 'string'
                  && item.content.length >= 50 && item.content.length <= 500
                  && item.type && item.entities,
                )
                .map((item: any) => ({
                  content: item.content.trim(),
                  type: item.type,
                  entities: Array.isArray(item.entities) ? item.entities : [],
                  extractedFrom: item.extractedFrom ?? 'both',
                }))
                .slice(0, 5);
            }
          }
        }
      }

      // Fallback to heuristic if LLM is disabled or produced nothing
      if (rawFacts.length === 0) {
        rawFacts = this.heuristicNarrative(chunk);
      }
    } catch (error) {
      logger.warn({ err: error, chunkId: chunk.id }, 'Narrative extraction failed');
      return [];
    }

    if (rawFacts.length === 0) return [];

    // Build MemoryFact objects (same as atomic, but longer content)
    const now = new Date().toISOString();
    const facts: MemoryFact[] = rawFacts.map((raw, index) => ({
      id: uuidv5(`${chunk.id}:narrative:${index}:${raw.content.substring(0, 50)}`, 'e585bb5c-7b92-430e-824d-cc1b5876b922'),
      content: raw.content,
      type: raw.type as FactType,
      entities: raw.entities,
      temporal: {
        observedAt: now,
        validFrom: chunk.createdAt,
        temporalSource: 'inferred' as const,
      },
      sourceChunkId: chunk.id,
      sourceSessionId: chunk.sessionId,
      extractedFrom: raw.extractedFrom as 'user' | 'assistant' | 'both',
      authorId: chunk.authorId,
      organizationId: chunk.organizationId,
      teamId: chunk.teamId,
      scope: 'organization' as const,
      confidence: 0.75, // Narratives get slightly higher base confidence
      usageCount: 0,
      upvotes: 0,
      repository: chunk.repository,
      language: chunk.language,
      frameworks: chunk.frameworks,
      createdAt: now,
      updatedAt: now,
    }));

    // Embed and persist
    const factContents = facts.map(f => `${f.content} [${f.entities.join(', ')}]`);
    const embeddings = await this.embeddingClient.embedBatch(factContents);
    for (let i = 0; i < facts.length; i++) {
      facts[i].embedding = embeddings[i];
      facts[i].embeddingModel = this.embeddingClient.getModelName();
    }

    const dedupedFacts = await this.deduplicateFacts(facts);
    if (dedupedFacts.length > 0) {
      await this.factRepo.createBatch(dedupedFacts);
    }

    logger.info({
      chunkId: chunk.id,
      narratives: dedupedFacts.length,
    }, 'Narrative fact extraction complete');

    return dedupedFacts;
  }

  /**
   * Heuristic narrative extraction — builds a summary narrative from chunk content.
   * Tries to capture the "story" of the conversation segment.
   */
  private heuristicNarrative(chunk: Chunk): RawExtractedFact[] {
    const content = chunk.content;
    if (content.length < 200) return []; // Too short for a narrative

    // Build a single narrative from the full chunk
    const lines = content.split('\n').filter(l => l.trim().length > 20);
    const userLines = lines.filter(l => /^USER:/i.test(l));
    const assistantLines = lines.filter(l => /^ASSISTANT:/i.test(l));

    // Extract the topic from user's first substantive message
    const topic = userLines[0]?.replace(/^USER:\s*/i, '').substring(0, 100) ?? chunk.title;

    // Extract the resolution from assistant's last substantive message
    const resolution = assistantLines[assistantLines.length - 1]
      ?.replace(/^ASSISTANT:\s*/i, '')
      .substring(0, 200) ?? '';

    if (!resolution) return [];

    // Compose narrative
    const narrative = `${topic}. ${resolution}`.substring(0, 500);
    const entities = this.extractEntitiesFromText(narrative);

    // Only produce if it's meaningfully different from the topic alone
    if (narrative.length < 80) return [];

    return [{
      content: narrative,
      type: 'lesson',
      entities,
      extractedFrom: 'both',
    }];
  }

  /**
   * Extract entity names from a text string.
   */
  private extractEntitiesFromText(text: string): string[] {
    const entities: string[] = [];
    const seen = new Set<string>();

    // Technology/service names (capitalized words, acronyms, known patterns)
    const techPatterns = text.match(
      /\b(AWS|S3|EC2|Lambda|DynamoDB|Kafka|Redis|PostgreSQL?|Postgres|MongoDB|Docker|Kubernetes|K8s|React|Node\.?js?|TypeScript|Python|Go|Rust|GraphQL|REST|gRPC|Terraform|CDK|CloudFormation|IAM|VPC|ECS|EKS|RDS|SQS|SNS|CloudFront|API\s?Gateway|CloudWatch|Datadog|Grafana|Jenkins|GitHub|GitLab|Jira|Confluence|Slack)\b/gi
    );
    if (techPatterns) {
      for (const t of techPatterns) {
        const normalized = t.trim();
        if (!seen.has(normalized.toLowerCase())) {
          entities.push(normalized);
          seen.add(normalized.toLowerCase());
        }
      }
    }

    // CamelCase/PascalCase identifiers (service names, class names)
    const camelCase = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g);
    if (camelCase) {
      for (const c of camelCase.slice(0, 3)) {
        if (!seen.has(c.toLowerCase())) {
          entities.push(c);
          seen.add(c.toLowerCase());
        }
      }
    }

    return entities.slice(0, 6);
  }

  /**
   * Deduplicate new facts against existing ones in the store.
   * ADD-only means we don't modify existing facts — we just skip exact duplicates.
   *
   * A fact is considered a duplicate if:
   * - Same organization + embedding cosine similarity > 0.95
   * - AND same entities overlap > 80%
   */
  private async deduplicateFacts(facts: MemoryFact[]): Promise<MemoryFact[]> {
    const results: MemoryFact[] = [];

    for (const fact of facts) {
      if (!fact.embedding) {
        results.push(fact);
        continue;
      }

      // Check for near-duplicates in existing facts
      const duplicates = await this.factRepo.findSimilar(
        fact.embedding,
        fact.organizationId,
        0.95, // Very high threshold — only skip near-exact matches
      );

      if (duplicates.length === 0) {
        results.push(fact);
      } else {
        // Check entity overlap to confirm it's truly the same fact
        const topMatch = duplicates[0];
        const entityOverlap = this.entityOverlap(fact.entities, topMatch.entities);
        if (entityOverlap < 0.8) {
          // Different entities — not actually a duplicate
          results.push(fact);
        } else {
          logger.debug({
            skipped: fact.content.substring(0, 50),
            matchedWith: topMatch.id,
          }, 'Fact deduplicated (exact match exists)');
        }
      }
    }

    return results;
  }

  /**
   * Jaccard overlap between two entity arrays.
   */
  private entityOverlap(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a.map(e => e.toLowerCase()));
    const setB = new Set(b.map(e => e.toLowerCase()));
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
  }

  /**
   * Assess confidence of an extracted fact (0-1).
   */
  private assessConfidence(raw: RawExtractedFact, chunk: Chunk): number {
    let confidence = 0.6; // Base

    // Facts from assistant responses are typically more authoritative
    if (raw.extractedFrom === 'assistant') confidence += 0.1;

    // Facts with more entities are more specific/useful
    if (raw.entities.length >= 2) confidence += 0.1;

    // Facts from high-quality chunks inherit quality
    if (chunk.qualityScore > 0.7) confidence += 0.1;

    // Facts with repository context are more traceable
    if (chunk.repository) confidence += 0.05;

    // Short, precise facts are more reliable than long vague ones
    if (raw.content.length < 100) confidence += 0.05;

    return Math.min(confidence, 1.0);
  }
}

// ─── Raw Extracted Fact (before becoming MemoryFact) ─────────────────────────

interface RawExtractedFact {
  content: string;
  type: string;
  entities: string[];
  extractedFrom: string;
}

// ─── Worker Setup ────────────────────────────────────────────────────────────

let factWorker: Worker | null = null;

export function startFactExtractionWorker(): Worker {
  if (factWorker) return factWorker;

  const config = getConfig();
  const extractor = new FactExtractor();
  const chunkRepo = new ChunkRepository();
  const opinionEngine = new OpinionReinforcementEngine();

  // Observation queue for triggering entity summary generation
  const observationQueue = new Queue(OBSERVATION_QUEUE_NAME, {
    connection: { url: config.REDIS_URL },
    defaultJobOptions: {
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 10000 },
    },
  });

  factWorker = new Worker(
    QUEUE_NAMES.FACT_EXTRACTION,
    async (job: Job<ChunkProcessingJob>) => runTrackedChunkJob(job.data, async () => {
      const { chunkId } = job.data;
      const chunk = await chunkRepo.findById(chunkId);
      if (!chunk) throw new Error(`Chunk ${chunkId} not found for fact extraction`);
      if (chunk.acl?.classification === 'restricted' || chunk.acl?.discoverable === false) {
        logger.warn({ chunkId }, 'Restricted chunk blocked from fact extraction');
        return { factCount: 0, blocked: true };
      }

      const facts = await extractor.extract(chunk);

      // Trigger observation refresh for entities mentioned in extracted facts
      if (facts.length > 0) {
        const entities = new Set<string>();
        for (const fact of facts) {
          for (const entity of fact.entities) {
            entities.add(entity);
          }
        }
        for (const entityName of entities) {
          await observationQueue.add('observe', {
            entityName,
            organizationId: chunk.organizationId,
            triggerFactId: facts[0].id,
          } satisfies ObservationJob, {
            jobId: `observe-${chunk.organizationId}-${entityName.toLowerCase()}`,
            delay: 30000, // Wait 30s to batch multiple facts from same session
          });
        }

        // Inline opinion reinforcement: evaluate new facts against existing opinions
        // This closes the learning loop at ingestion time (not just during compaction)
        for (const fact of facts) {
          if (fact.type !== 'opinion' && fact.entities.length > 0) {
            try {
              await opinionEngine.evaluateNewFact(fact, chunk.organizationId);
            } catch {
              // Non-critical: inline reinforcement failures don't block ingestion
            }
          }
        }
      }

      return { factCount: facts.length, factIds: facts.map(f => f.id) };
    }),
    {
      connection: { url: config.REDIS_URL },
      concurrency: 8,
      limiter: { max: 30, duration: 60000 },
    },
  );

  factWorker.on('failed', (job, err) => {
    logger.error({ chunkId: job?.data.chunkId, err }, 'Fact extraction job failed');
  });

  logger.info('Fact extraction worker started');
  return factWorker;
}

export async function stopFactExtractionWorker(): Promise<void> {
  if (factWorker) { await factWorker.close(); factWorker = null; }
}
