/**
 * Knowledge Extractor
 *
 * Transforms raw conversational chunks into structured knowledge records.
 * Uses LLM to identify and extract:
 *   - Problem/Solution pairs (debugging sessions)
 *   - Architecture decisions (design discussions)
 *   - Best practices (recommendations, standards)
 *   - How-to guides (step-by-step procedures)
 *   - Anti-patterns (what NOT to do)
 *
 * This is where conversation becomes high-value, reusable knowledge.
 * The structured format dramatically improves retrieval quality —
 * instead of finding "a chat about Lambda timeouts," we find
 * "Problem: VPC DNS resolution → Solution: Move endpoint to public subnet."
 */

import { v4 as uuidv4 } from 'uuid';
import { Worker, Job } from 'bullmq';
import { createChildLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { QUEUE_NAMES, type ChunkProcessingJob } from './queue.js';
import { ChunkRepository } from '../storage/chunk-repository.js';
import { KnowledgeRepository } from '../storage/knowledge-repository.js';
import {
  type Chunk,
  type KnowledgeRecord,
  type KnowledgeType,
  type ProblemSolution,
  type ArchitectureDecision,
  type BestPractice,
  type HowTo,
  type Entity,
  type CodeReference,
} from '../models/index.js';

const logger = createChildLogger({ module: 'knowledge-extractor' });

// ─── Extraction Prompts ──────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction system for a software engineering knowledge base.
Given a conversation chunk, extract structured knowledge that would be useful for other engineers.

Rules:
- Be specific and actionable
- Include code examples when available
- Preserve technical accuracy
- Identify the knowledge TYPE first, then extract accordingly
- If no meaningful knowledge can be extracted, return null`;

const TYPE_DETECTION_PROMPT = `Classify this conversation chunk into exactly ONE knowledge type:

- problem_solution: Contains a bug, error, or issue AND its resolution
- architecture_decision: Discusses system design choices with tradeoffs
- best_practice: Recommends a specific coding/operational approach
- anti_pattern: Describes what NOT to do and why
- how_to: Step-by-step procedure to accomplish something
- concept: Explains a technical concept or how something works
- configuration: How to configure a tool, service, or system
- performance: Performance optimization or insight
- security: Security-related guidance
- deployment: Deployment, CI/CD, or operational knowledge

If the chunk is just casual conversation with no extractable knowledge, respond with: none

Respond with ONLY the type name (one word, lowercase with underscores).`;

const PROBLEM_SOLUTION_PROMPT = `Extract a Problem/Solution record from this conversation.

Respond in JSON:
{
  "problem": "Clear description of the issue",
  "symptoms": ["Observable symptom 1", "Symptom 2"],
  "rootCause": "The underlying cause",
  "solution": "How it was fixed",
  "solutionSteps": ["Step 1", "Step 2"],
  "impact": "What improved after the fix",
  "workarounds": ["Temporary fix if any"],
  "relatedErrors": ["ErrorType1", "error message pattern"]
}`;

const ARCHITECTURE_DECISION_PROMPT = `Extract an Architecture Decision Record from this conversation.

Respond in JSON:
{
  "context": "What situation or requirement drove this decision",
  "decision": "What was decided",
  "rationale": "Why this choice was made",
  "alternatives": [
    {"option": "Alternative A", "proscons": "Pros and cons", "rejected": true}
  ],
  "consequences": ["Consequence 1", "Consequence 2"],
  "status": "accepted"
}`;

const BEST_PRACTICE_PROMPT = `Extract a Best Practice record from this conversation.

Respond in JSON:
{
  "practice": "Clear statement of the recommended practice",
  "rationale": "Why this is recommended",
  "examples": [
    {"description": "Example scenario", "code": "code if available", "language": "typescript"}
  ],
  "exceptions": ["When this does NOT apply"],
  "references": ["Links or references mentioned"]
}`;

const HOW_TO_PROMPT = `Extract a How-To guide from this conversation.

Respond in JSON:
{
  "goal": "What this achieves",
  "prerequisites": ["Required before starting"],
  "steps": [
    {"order": 1, "instruction": "Do this", "code": "optional code", "notes": "optional notes"}
  ],
  "validation": "How to verify it worked",
  "commonPitfalls": ["Common mistake to avoid"]
}`;

// ─── Knowledge Extractor Class ───────────────────────────────────────────────

export class KnowledgeExtractor {
  private chunkRepo: ChunkRepository;
  private knowledgeRepo: KnowledgeRepository;

  constructor() {
    this.chunkRepo = new ChunkRepository();
    this.knowledgeRepo = new KnowledgeRepository();
  }

  /**
   * Extract structured knowledge from a single chunk.
   * Returns null if no meaningful knowledge can be extracted.
   */
  async extract(chunk: Chunk): Promise<KnowledgeRecord | null> {
    logger.info({
      chunkId: chunk.id,
      type: chunk.type,
      tokenCount: chunk.tokenCount,
    }, 'Extracting knowledge from chunk');

    try {
      // Step 1: Detect knowledge type
      const knowledgeType = await this.detectKnowledgeType(chunk);
      if (!knowledgeType) {
        logger.debug({ chunkId: chunk.id }, 'No extractable knowledge in chunk');
        return null;
      }

      // Step 2: Extract structured content based on type
      const structured = await this.extractStructured(chunk, knowledgeType);
      if (!structured) return null;

      // Step 3: Extract citations from the content
      const citations = this.extractCitations(chunk);

      // Step 4: Build the knowledge record
      const now = new Date().toISOString();
      const record: KnowledgeRecord = {
        id: uuidv4(),
        chunkId: chunk.id,
        sessionId: chunk.sessionId,
        type: knowledgeType,
        title: this.generateTitle(chunk, knowledgeType, structured),
        summary: this.generateKnowledgeSummary(knowledgeType, structured),
        ...structured,
        entities: chunk.entities,
        codeReferences: chunk.codeReferences,
        citations,
        repository: chunk.repository,
        language: chunk.language,
        frameworks: chunk.frameworks,
        tags: this.generateTags(chunk, knowledgeType),
        authorId: chunk.authorId,
        organizationId: chunk.organizationId,
        teamId: chunk.teamId,
        endorsedBy: [],
        qualityScore: this.assessQuality(chunk, structured),
        isValidated: false,
        createdAt: now,
        updatedAt: now,
      };

      // Step 5: Persist
      await this.knowledgeRepo.create(record);

      logger.info({
        chunkId: chunk.id,
        knowledgeId: record.id,
        type: knowledgeType,
        title: record.title,
      }, 'Knowledge extracted and stored');

      return record;
    } catch (error) {
      logger.error({ err: error, chunkId: chunk.id }, 'Knowledge extraction failed');
      return null;
    }
  }

  /**
   * Detect what type of knowledge a chunk contains.
   * Uses chunk.type as a strong hint, then confirms with content analysis.
   */
  private async detectKnowledgeType(chunk: Chunk): Promise<KnowledgeType | null> {
    // Use chunk type as primary signal
    const typeMapping: Record<string, KnowledgeType> = {
      debugging: 'problem_solution',
      architecture: 'architecture_decision',
      best_practice: 'best_practice',
      configuration: 'configuration',
      tutorial: 'how_to',
      troubleshooting: 'problem_solution',
      decision: 'architecture_decision',
      code_explanation: 'concept',
    };

    const mapped = typeMapping[chunk.type];
    if (mapped) return mapped;

    // For generic types, analyze content patterns
    const content = chunk.content.toLowerCase();

    if (this.containsProblemSolutionPatterns(content)) return 'problem_solution';
    if (this.containsDecisionPatterns(content)) return 'architecture_decision';
    if (this.containsHowToPatterns(content)) return 'how_to';
    if (this.containsBestPracticePatterns(content)) return 'best_practice';

    // If no clear pattern, attempt LLM classification
    // For now, return null (no extractable knowledge)
    // TODO: Call LLM with TYPE_DETECTION_PROMPT for ambiguous chunks
    return null;
  }

  /**
   * Extract structured knowledge content based on detected type.
   */
  private async extractStructured(
    chunk: Chunk,
    type: KnowledgeType,
  ): Promise<Record<string, unknown> | null> {
    switch (type) {
      case 'problem_solution':
        return { problemSolution: await this.extractProblemSolution(chunk) };
      case 'architecture_decision':
        return { architectureDecision: await this.extractArchitectureDecision(chunk) };
      case 'best_practice':
        return { bestPractice: await this.extractBestPractice(chunk) };
      case 'how_to':
        return { howTo: await this.extractHowTo(chunk) };
      default:
        // For other types, store as free-form content
        return { content: chunk.summary };
    }
  }

  /**
   * Extract Problem/Solution structure from chunk content.
   */
  private async extractProblemSolution(chunk: Chunk): Promise<ProblemSolution> {
    // TODO: Use LLM with PROBLEM_SOLUTION_PROMPT for production quality
    // For now, use heuristic extraction

    const content = chunk.content;
    const lines = content.split('\n');

    // Find problem indicators
    const problemLines = lines.filter(l =>
      /\b(error|issue|problem|bug|fail|broken|crash|timeout)\b/i.test(l)
    );

    // Find solution indicators
    const solutionLines = lines.filter(l =>
      /\b(fix|solution|resolve|solved|works?|change|update|use instead)\b/i.test(l)
    );

    // Extract error messages/types
    const relatedErrors = this.extractErrorPatterns(content);

    return {
      problem: problemLines[0]?.replace(/^(USER|ASSISTANT):\s*/i, '').trim()
        || chunk.title,
      symptoms: problemLines.slice(1, 4).map(l => l.replace(/^(USER|ASSISTANT):\s*/i, '').trim()),
      rootCause: undefined,
      solution: solutionLines[0]?.replace(/^(USER|ASSISTANT):\s*/i, '').trim()
        || 'See conversation for details',
      solutionSteps: solutionLines.slice(0, 5).map(l => l.replace(/^(USER|ASSISTANT):\s*/i, '').trim()),
      impact: undefined,
      workarounds: [],
      relatedErrors,
    };
  }

  /**
   * Extract Architecture Decision structure.
   */
  private async extractArchitectureDecision(chunk: Chunk): Promise<ArchitectureDecision> {
    // TODO: LLM extraction with ARCHITECTURE_DECISION_PROMPT
    return {
      context: chunk.summary,
      decision: chunk.title,
      rationale: 'Extracted from AI session — see original conversation for full context.',
      alternatives: [],
      consequences: [],
      status: 'accepted',
    };
  }

  /**
   * Extract Best Practice structure.
   */
  private async extractBestPractice(chunk: Chunk): Promise<BestPractice> {
    // TODO: LLM extraction with BEST_PRACTICE_PROMPT
    const codeExamples = chunk.codeReferences.slice(0, 3).map(ref => ({
      description: `Example from ${ref.filePath}`,
      code: ref.snippet,
      language: ref.language,
    }));

    return {
      practice: chunk.title,
      rationale: chunk.summary,
      examples: codeExamples,
      exceptions: [],
      references: [],
    };
  }

  /**
   * Extract How-To structure.
   */
  private async extractHowTo(chunk: Chunk): Promise<HowTo> {
    // TODO: LLM extraction with HOW_TO_PROMPT

    // Heuristic: find numbered steps or sequential instructions
    const content = chunk.content;
    const stepPattern = /(?:^|\n)\s*(?:\d+[.)]\s*|[-*]\s*|step\s*\d+[.:]\s*)(.*)/gi;
    const steps: Array<{ order: number; instruction: string; code?: string }> = [];

    let match: RegExpExecArray | null;
    let order = 1;
    while ((match = stepPattern.exec(content)) !== null) {
      steps.push({
        order: order++,
        instruction: match[1].trim(),
      });
      if (steps.length >= 10) break;
    }

    // If no steps found, treat entire content as one step
    if (steps.length === 0) {
      steps.push({ order: 1, instruction: chunk.summary });
    }

    return {
      goal: chunk.title,
      prerequisites: [],
      steps,
      validation: undefined,
      commonPitfalls: [],
    };
  }

  // ─── Pattern Detection ─────────────────────────────────────────────────────

  private containsProblemSolutionPatterns(content: string): boolean {
    const problemPatterns = /\b(error|exception|fail|bug|issue|crash|timeout|not working|broken)\b/;
    const solutionPatterns = /\b(fix|solved|solution|resolved|works now|the issue was|root cause)\b/;
    return problemPatterns.test(content) && solutionPatterns.test(content);
  }

  private containsDecisionPatterns(content: string): boolean {
    return /\b(decide|decision|choose|chose|option|alternative|tradeoff|trade-off|approach|vs\b|versus)\b/.test(content);
  }

  private containsHowToPatterns(content: string): boolean {
    return /\b(step\s*\d|how to|first.*then|procedure|instructions|walkthrough|1\.\s|2\.\s|3\.\s)\b/.test(content);
  }

  private containsBestPracticePatterns(content: string): boolean {
    return /\b(best practice|recommend|should always|never do|convention|standard|prefer|avoid)\b/.test(content);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private extractErrorPatterns(content: string): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();

    // Error class names
    const errorClasses = content.match(/\b\w+(Error|Exception|Failure)\b/g);
    if (errorClasses) {
      for (const e of errorClasses) {
        if (!seen.has(e)) { errors.push(e); seen.add(e); }
      }
    }

    // HTTP status codes
    const httpCodes = content.match(/\b[45]\d{2}\b/g);
    if (httpCodes) {
      for (const code of httpCodes) {
        const key = `HTTP ${code}`;
        if (!seen.has(key)) { errors.push(key); seen.add(key); }
      }
    }

    return errors.slice(0, 10);
  }

  private extractCitations(chunk: Chunk): Array<{ type: string; reference: string; url?: string; title?: string }> {
    const citations: Array<{ type: string; reference: string; url?: string; title?: string }> = [];

    // Always cite the original conversation
    citations.push({
      type: 'conversation',
      reference: `Session ${chunk.sessionId}, Chunk ${chunk.id}`,
    });

    // Cite commit if available
    if (chunk.commitSha) {
      citations.push({
        type: 'commit',
        reference: chunk.commitSha,
      });
    }

    // Extract URLs from content
    const urls = chunk.content.match(/https?:\/\/[^\s)>"']+/g);
    if (urls) {
      for (const url of urls.slice(0, 5)) {
        citations.push({ type: 'doc', reference: url, url });
      }
    }

    return citations;
  }

  private generateTitle(chunk: Chunk, type: KnowledgeType, structured: Record<string, unknown>): string {
    // Try to use structured data for a better title
    if (type === 'problem_solution') {
      const ps = structured.problemSolution as ProblemSolution | undefined;
      if (ps?.problem) return ps.problem.substring(0, 100);
    }
    if (type === 'architecture_decision') {
      const ad = structured.architectureDecision as ArchitectureDecision | undefined;
      if (ad?.decision) return ad.decision.substring(0, 100);
    }

    return chunk.title;
  }

  private generateKnowledgeSummary(type: KnowledgeType, structured: Record<string, unknown>): string {
    if (type === 'problem_solution') {
      const ps = structured.problemSolution as ProblemSolution | undefined;
      if (ps) return `Problem: ${ps.problem} → Solution: ${ps.solution}`.substring(0, 300);
    }
    if (type === 'architecture_decision') {
      const ad = structured.architectureDecision as ArchitectureDecision | undefined;
      if (ad) return `Decision: ${ad.decision}. Rationale: ${ad.rationale}`.substring(0, 300);
    }
    if (type === 'best_practice') {
      const bp = structured.bestPractice as BestPractice | undefined;
      if (bp) return `${bp.practice}. ${bp.rationale}`.substring(0, 300);
    }
    if (type === 'how_to') {
      const ht = structured.howTo as HowTo | undefined;
      if (ht) return `How to: ${ht.goal}`.substring(0, 300);
    }
    return '';
  }

  private generateTags(chunk: Chunk, type: KnowledgeType): string[] {
    const tags = new Set<string>();

    tags.add(type);
    if (chunk.language !== 'unknown') tags.add(chunk.language);
    for (const fw of chunk.frameworks) tags.add(fw);
    for (const entity of chunk.entities) {
      if (entity.type === 'service' || entity.type === 'library') {
        tags.add(entity.name.toLowerCase());
      }
    }

    return [...tags];
  }

  /**
   * Assess quality of extracted knowledge (0-1).
   * Higher quality = better structured, more code examples, clearer resolution.
   */
  private assessQuality(chunk: Chunk, structured: Record<string, unknown>): number {
    let score = 0.3; // Base score

    // Has code references
    if (chunk.codeReferences.length > 0) score += 0.1;

    // Has entities (well-identified topics)
    if (chunk.entities.length >= 3) score += 0.1;

    // Reasonable content length (not too short, not too long)
    if (chunk.tokenCount >= 200 && chunk.tokenCount <= 1000) score += 0.1;

    // Has structured extraction
    if (structured.problemSolution || structured.architectureDecision ||
        structured.bestPractice || structured.howTo) {
      score += 0.2;
    }

    // Has repository context
    if (chunk.repository) score += 0.1;

    // Has commit SHA (directly traceable)
    if (chunk.commitSha) score += 0.1;

    return Math.min(score, 1.0);
  }
}

// ─── Worker Setup ────────────────────────────────────────────────────────────

let extractionWorker: Worker | null = null;

export function startExtractionWorker(): Worker {
  if (extractionWorker) return extractionWorker;

  const config = getConfig();
  const extractor = new KnowledgeExtractor();
  const chunkRepo = new ChunkRepository();

  extractionWorker = new Worker(
    QUEUE_NAMES.KNOWLEDGE_EXTRACTION,
    async (job: Job<ChunkProcessingJob>) => {
      const { chunkId } = job.data;

      const chunk = await chunkRepo.findById(chunkId);
      if (!chunk) {
        logger.warn({ chunkId }, 'Chunk not found for extraction');
        return null;
      }

      const knowledge = await extractor.extract(chunk);
      return knowledge ? { knowledgeId: knowledge.id } : null;
    },
    {
      connection: { url: config.REDIS_URL },
      concurrency: 5, // Lower concurrency — LLM calls are expensive
      limiter: {
        max: 20,
        duration: 60000, // 20 extractions per minute (LLM rate limit friendly)
      },
    },
  );

  extractionWorker.on('completed', (job, result) => {
    if (result?.knowledgeId) {
      logger.debug({ chunkId: job.data.chunkId, knowledgeId: result.knowledgeId }, 'Extraction complete');
    }
  });

  extractionWorker.on('failed', (job, err) => {
    logger.error({ chunkId: job?.data.chunkId, err }, 'Extraction job failed');
  });

  logger.info('Knowledge extraction worker started');
  return extractionWorker;
}

export async function stopExtractionWorker(): Promise<void> {
  if (extractionWorker) {
    await extractionWorker.close();
    extractionWorker = null;
  }
}
