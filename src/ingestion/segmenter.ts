/**
 * Semantic Segmenter
 *
 * The most critical component of the ingestion pipeline.
 * Splits parsed conversations into topically coherent chunks.
 *
 * Strategies (applied in order):
 * 1. LLM-assisted boundary detection — most accurate, used when available
 * 2. Embedding similarity — split when adjacent messages have low cosine similarity
 * 3. Windowing fallback — hard cap at 1200 tokens with 100-token overlap
 *
 * Each chunk becomes an independently searchable unit of knowledge.
 */

import { v4 as uuidv4 } from 'uuid';
import { createChildLogger } from '../utils/logger.js';
import { type Chunk, type ChunkType, type Entity, type CodeReference } from '../models/index.js';
import { type ParsedSession, type ParsedMessage } from './parser.js';
import { EmbeddingClient } from '../utils/embedding.js';

const logger = createChildLogger({ module: 'segmenter' });

// ─── Configuration ───────────────────────────────────────────────────────────

export interface SegmenterConfig {
  /** Maximum tokens per chunk */
  maxChunkTokens: number;
  /** Minimum tokens per chunk (avoid tiny fragments) */
  minChunkTokens: number;
  /** Overlap tokens between adjacent chunks for context continuity */
  overlapTokens: number;
  /** Cosine similarity threshold — below this, start a new chunk */
  similarityThreshold: number;
  /** Whether to use LLM for boundary detection */
  useLLMSegmentation: boolean;
  /** Embedding model to use */
  embeddingModel: string;
}

const DEFAULT_CONFIG: SegmenterConfig = {
  maxChunkTokens: 1200,
  minChunkTokens: 100,
  overlapTokens: 100,
  similarityThreshold: 0.7,
  useLLMSegmentation: true,
  embeddingModel: 'text-embedding-3-large',
};

// ─── Segment Boundary ────────────────────────────────────────────────────────

interface SegmentBoundary {
  /** Message index where this segment starts */
  startIndex: number;
  /** Message index where this segment ends (inclusive) */
  endIndex: number;
  /** Detected topic */
  topic: string;
  /** Confidence in this boundary (0-1) */
  confidence: number;
}

// ─── Segmenter ───────────────────────────────────────────────────────────────

export class SemanticSegmenter {
  private config: SegmenterConfig;
  private embeddingClient: EmbeddingClient;

  constructor(config: Partial<SegmenterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingClient = new EmbeddingClient();
  }

  /**
   * Segment a parsed session into topical chunks.
   * This is the main entry point called by the pipeline worker.
   */
  async segment(
    session: ParsedSession,
    metadata: {
      organizationId: string;
      developerId: string;
      repository?: string;
      branch?: string;
      commitSha?: string;
    },
  ): Promise<Chunk[]> {
    logger.info({
      sessionId: session.sessionId,
      messageCount: session.messages.length,
      totalTokens: session.totalTokens,
    }, 'Starting semantic segmentation');

    // Step 1: Detect segment boundaries
    let boundaries: SegmentBoundary[];

    if (this.config.useLLMSegmentation && session.messages.length > 3) {
      boundaries = await this.detectBoundariesWithLLM(session);
    } else {
      boundaries = await this.detectBoundariesWithEmbeddings(session);
    }

    // Step 2: Apply hard token limits (split any oversized segments)
    boundaries = this.enforceTokenLimits(boundaries, session.messages);

    // Step 3: Convert boundaries to chunks
    const chunks = await this.buildChunks(boundaries, session, metadata);

    logger.info({
      sessionId: session.sessionId,
      chunkCount: chunks.length,
      avgTokens: Math.round(chunks.reduce((s, c) => s + c.tokenCount, 0) / chunks.length),
    }, 'Segmentation complete');

    return chunks;
  }

  /**
   * LLM-assisted boundary detection.
   * Sends the conversation to an LLM and asks it to identify topic boundaries.
   */
  private async detectBoundariesWithLLM(session: ParsedSession): Promise<SegmentBoundary[]> {
    logger.debug({ sessionId: session.sessionId }, 'Using LLM boundary detection');

    // Build a condensed view of the conversation for the LLM
    const condensed = session.messages.map((m, i) => {
      const preview = m.content.substring(0, 200).replace(/\n/g, ' ');
      return `[${i}] ${m.role}: ${preview}${m.content.length > 200 ? '...' : ''}`;
    }).join('\n');

    const prompt = `Analyze this conversation and identify distinct topic segments.
For each segment, provide the start message index, end message index, and a short topic title.

Conversation:
${condensed}

Respond in JSON format:
[{"startIndex": 0, "endIndex": 3, "topic": "S3 multipart uploads"}, ...]

Rules:
- Each segment should cover ONE coherent topic
- Minimum 2 messages per segment
- Topics should be specific and descriptive
- Cover all messages (no gaps)`;

    try {
      // TODO: Call LLM API (Claude/GPT) with the prompt
      // const response = await this.llmClient.complete(prompt);
      // const parsed = JSON.parse(response);

      // Fallback to embedding-based detection until LLM client is wired
      return this.detectBoundariesWithEmbeddings(session);
    } catch (error) {
      logger.warn({ err: error }, 'LLM segmentation failed, falling back to embeddings');
      return this.detectBoundariesWithEmbeddings(session);
    }
  }

  /**
   * Embedding similarity-based boundary detection.
   * Computes embeddings for each message and splits when cosine
   * similarity between adjacent messages drops below threshold.
   */
  private async detectBoundariesWithEmbeddings(session: ParsedSession): Promise<SegmentBoundary[]> {
    logger.debug({ sessionId: session.sessionId }, 'Using embedding-based boundary detection');

    const messages = session.messages;
    if (messages.length <= 2) {
      return [{
        startIndex: 0,
        endIndex: messages.length - 1,
        topic: session.topics[0] ?? 'General discussion',
        confidence: 0.5,
      }];
    }

    // Get embeddings for all messages
    const texts = messages.map(m => m.content.substring(0, 500)); // Truncate for efficiency
    const embeddings = await this.embeddingClient.embedBatch(texts);

    // Compute similarity between adjacent messages
    const similarities: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) {
      similarities.push(this.cosineSimilarity(embeddings[i], embeddings[i + 1]));
    }

    // Find boundaries where similarity drops below threshold
    const boundaries: SegmentBoundary[] = [];
    let segmentStart = 0;

    for (let i = 0; i < similarities.length; i++) {
      const shouldSplit = similarities[i] < this.config.similarityThreshold;
      const isLastMessage = i === similarities.length - 1;

      if (shouldSplit || isLastMessage) {
        const endIndex = isLastMessage ? messages.length - 1 : i;

        boundaries.push({
          startIndex: segmentStart,
          endIndex,
          topic: this.inferTopic(messages.slice(segmentStart, endIndex + 1)),
          confidence: shouldSplit ? (1 - similarities[i]) : 0.5,
        });

        segmentStart = i + 1;
      }
    }

    // Handle remaining messages
    if (segmentStart < messages.length) {
      boundaries.push({
        startIndex: segmentStart,
        endIndex: messages.length - 1,
        topic: this.inferTopic(messages.slice(segmentStart)),
        confidence: 0.5,
      });
    }

    return boundaries;
  }

  /**
   * Enforce hard token limits on segments.
   * If any segment exceeds maxChunkTokens, split it using a sliding window.
   */
  private enforceTokenLimits(
    boundaries: SegmentBoundary[],
    messages: ParsedMessage[],
  ): SegmentBoundary[] {
    const result: SegmentBoundary[] = [];

    for (const boundary of boundaries) {
      const segmentMessages = messages.slice(boundary.startIndex, boundary.endIndex + 1);
      const totalTokens = segmentMessages.reduce((s, m) => s + m.tokenCount, 0);

      if (totalTokens <= this.config.maxChunkTokens) {
        result.push(boundary);
        continue;
      }

      // Split oversized segment using sliding window
      let windowStart = boundary.startIndex;
      let windowTokens = 0;

      for (let i = boundary.startIndex; i <= boundary.endIndex; i++) {
        windowTokens += messages[i].tokenCount;

        if (windowTokens > this.config.maxChunkTokens || i === boundary.endIndex) {
          result.push({
            startIndex: windowStart,
            endIndex: i === boundary.endIndex ? i : i - 1,
            topic: boundary.topic,
            confidence: boundary.confidence * 0.8, // Slightly lower confidence for forced splits
          });

          // Start next window with overlap
          windowStart = Math.max(boundary.startIndex, i - 1); // 1 message overlap
          windowTokens = messages[windowStart]?.tokenCount ?? 0;
        }
      }
    }

    return result;
  }

  /**
   * Build Chunk objects from segment boundaries.
   */
  private async buildChunks(
    boundaries: SegmentBoundary[],
    session: ParsedSession,
    metadata: {
      organizationId: string;
      developerId: string;
      repository?: string;
      branch?: string;
      commitSha?: string;
    },
  ): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const now = new Date().toISOString();

    for (const boundary of boundaries) {
      const segmentMessages = session.messages.slice(boundary.startIndex, boundary.endIndex + 1);

      // Build content from messages
      const content = segmentMessages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');

      const tokenCount = segmentMessages.reduce((s, m) => s + m.tokenCount, 0);

      // Skip segments that are too small
      if (tokenCount < this.config.minChunkTokens) continue;

      // Collect code references
      const codeReferences: CodeReference[] = segmentMessages
        .flatMap(m => m.codeBlocks)
        .map(block => ({
          filePath: block.filePath ?? 'unknown',
          language: block.language,
          snippet: block.content.substring(0, 500),
          repository: metadata.repository,
          commitSha: metadata.commitSha,
        }));

      // Detect chunk type
      const chunkType = this.classifyChunkType(segmentMessages);

      // Extract entities from content
      const entities = this.extractEntities(content);

      // Generate summary (first user message + key points)
      const summary = this.generateSummary(segmentMessages, boundary.topic);

      const chunk: Chunk = {
        id: uuidv4(),
        sessionId: session.sessionId,
        title: boundary.topic,
        summary,
        content,
        tokenCount,
        type: chunkType,
        entities,
        codeReferences,
        repository: metadata.repository,
        branch: metadata.branch,
        commitSha: metadata.commitSha,
        language: session.languages[0] ?? 'unknown',
        languages: session.languages,
        frameworks: session.frameworks,
        authorId: metadata.developerId,
        organizationId: metadata.organizationId,
        confidence: 'high',
        qualityScore: 0.5,
        usageCount: 0,
        upvotes: 0,
        downvotes: 0,
        isCanonical: false,
        embeddingModel: this.config.embeddingModel,
        embeddingVersion: 1,
        createdAt: now,
        updatedAt: now,
      };

      chunks.push(chunk);
    }

    return chunks;
  }

  /**
   * Classify the type of a chunk based on its content.
   */
  private classifyChunkType(messages: ParsedMessage[]): ChunkType {
    const fullText = messages.map(m => m.content).join(' ').toLowerCase();

    if (/\b(error|exception|stack\s?trace|bug|fix|debug|issue)\b/.test(fullText)) {
      return 'debugging';
    }
    if (/\b(architect|design|system|microservice|scale|pattern)\b/.test(fullText)) {
      return 'architecture';
    }
    if (/\b(config|configuration|yaml|env|environment|setup|install)\b/.test(fullText)) {
      return 'configuration';
    }
    if (/\b(best\s?practice|convention|standard|pattern|recommend)\b/.test(fullText)) {
      return 'best_practice';
    }
    if (/\b(deploy|ci\/cd|pipeline|production|release|rollback)\b/.test(fullText)) {
      return 'troubleshooting';
    }
    if (/\b(how\s?to|step|tutorial|guide|walkthrough)\b/.test(fullText)) {
      return 'tutorial';
    }
    if (/\b(decide|choice|tradeoff|trade-off|versus|vs|compare)\b/.test(fullText)) {
      return 'decision';
    }
    if (/\b(review|feedback|suggestion|improve|refactor)\b/.test(fullText)) {
      return 'review';
    }
    if (/\b(explain|what\s?is|how\s?does|understand|concept)\b/.test(fullText)) {
      return 'code_explanation';
    }

    return 'discussion';
  }

  /**
   * Extract named entities from content using regex patterns.
   * In production, this would also use NER models.
   */
  private extractEntities(content: string): Entity[] {
    const entities: Entity[] = [];
    const seen = new Set<string>();

    // AWS services
    const awsServices = content.match(/\b(S3|EC2|Lambda|DynamoDB|SQS|SNS|ECS|EKS|RDS|CloudFront|API\s?Gateway|CloudWatch|IAM|KMS|VPC)\b/gi);
    if (awsServices) {
      for (const service of awsServices) {
        const name = service.toUpperCase();
        if (!seen.has(name)) {
          entities.push({ name, type: 'service' });
          seen.add(name);
        }
      }
    }

    // npm packages (from import/require statements)
    const imports = content.match(/(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g);
    if (imports) {
      for (const imp of imports) {
        const match = imp.match(/['"]([^'"]+)['"]/);
        if (match && !match[1].startsWith('.') && !match[1].startsWith('/')) {
          const name = match[1].split('/')[0];
          if (!seen.has(name)) {
            entities.push({ name, type: 'library' });
            seen.add(name);
          }
        }
      }
    }

    // Error types
    const errors = content.match(/\b(\w+Error|\w+Exception)\b/g);
    if (errors) {
      for (const err of errors) {
        if (!seen.has(err)) {
          entities.push({ name: err, type: 'error' });
          seen.add(err);
        }
      }
    }

    // File paths
    const filePaths = content.match(/\b[\w-]+(?:\/[\w.-]+)+\.\w+\b/g);
    if (filePaths) {
      for (const fp of filePaths.slice(0, 10)) { // Limit to avoid noise
        if (!seen.has(fp)) {
          entities.push({ name: fp, type: 'file' });
          seen.add(fp);
        }
      }
    }

    return entities;
  }

  /**
   * Generate a brief summary of the segment.
   */
  private generateSummary(messages: ParsedMessage[], topic: string): string {
    const userMessages = messages.filter(m => m.role === 'user');
    const firstQuestion = userMessages[0]?.content.substring(0, 150) ?? '';
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    const keyPoint = assistantMessages[0]?.content.substring(0, 150) ?? '';

    return `${topic}: ${firstQuestion}${keyPoint ? ` → ${keyPoint}` : ''}`.substring(0, 300);
  }

  /**
   * Infer topic from a group of messages.
   * Uses the first user message as the primary signal.
   */
  private inferTopic(messages: ParsedMessage[]): string {
    const firstUser = messages.find(m => m.role === 'user');
    if (firstUser) {
      // Take the first sentence or first 80 chars
      const content = firstUser.content.replace(/```[\s\S]*?```/g, '').trim();
      const firstSentence = content.split(/[.!?\n]/)[0]?.trim();
      if (firstSentence && firstSentence.length > 5) {
        return firstSentence.substring(0, 80);
      }
    }
    return 'Technical discussion';
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }
}
