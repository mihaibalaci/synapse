/**
 * Reflect Engine (v3 — Hindsight-inspired)
 *
 * The Reflect operation goes beyond retrieval: it retrieves memories from the
 * knowledge base, then reasons over them with an LLM to produce a synthesized
 * answer. This is the key difference between "search" and "understand."
 *
 * Inspired by Hindsight's CARA (Coherent Adaptive Reasoning Agents) component,
 * adapted for our team-scale use case:
 *
 *   - Hindsight: per-agent personality with disposition parameters
 *   - Recall: team-scale, organization-scoped, factual (no persona)
 *
 * The reflect operation:
 *   1. Retrieves relevant memories via the 5-signal retrieval engine
 *   2. Loads related facts and their temporal chains
 *   3. Synthesizes a direct answer using an LLM
 *   4. Optionally generates observations (entity summaries) as a side-effect
 *   5. Returns the synthesized answer + sources + confidence
 *
 * Use cases:
 *   - "What should I know about our auth architecture?"
 *   - "Why did we switch from RabbitMQ to Kafka?"
 *   - "What are the risks in our deployment pipeline?"
 *   - "Summarize what the team learned about Lambda cold starts"
 *
 * Target latency: 1-5 seconds (LLM-bound, not retrieval-bound)
 */

import { v4 as uuidv4 } from 'uuid';
import { createChildLogger } from '../utils/logger.js';
import { LlmClient, type LlmResponse } from '../utils/llm.js';
import { EmbeddingClient } from '../utils/embedding.js';
import { RetrievalEngine } from './engine.js';
import { FactRepository } from '../storage/fact-repository.js';
import { ObservationRepository } from '../storage/observation-repository.js';
import {
  type SearchRequest,
  type SearchResultItem,
  type MemoryFact,
  type FactType,
} from '../models/index.js';
import {
  type ReflectRequest,
  type ReflectResponse,
  type ReflectSource,
  type Observation,
} from '../models/reflect.js';

const logger = createChildLogger({ module: 'reflect-engine' });

// ─── Prompts ─────────────────────────────────────────────────────────────────

const REFLECT_SYSTEM = `You are an expert engineering knowledge synthesizer for a software organization. Your job is to reason over retrieved memories (facts, conversations, decisions) and produce a direct, actionable answer.

Rules:
- Synthesize information from multiple sources into a coherent answer
- Be specific and technical — include service names, versions, and concrete details
- Cite your sources using [Source N] notation
- If facts contradict each other, note the contradiction and prefer the most recent
- If you don't have enough information, say so clearly — don't fabricate
- If temporal context matters, mention when things happened or changed
- Keep the answer concise but complete (target: 200-500 tokens)
- Use markdown formatting for readability

Output format:
ANSWER:
<your synthesized answer>

CONFIDENCE: <high|medium|low>
REASONING: <1-2 sentence explanation of your confidence level>`;

const OBSERVATION_SYSTEM = `You are an entity summarizer. Given facts about a specific entity (technology, service, person, concept), produce a concise, objective observation that summarizes the key information.

Rules:
- Be factual and objective — no opinions or speculation
- Include: what it is, how it's used, key constraints, relevant decisions
- Keep it under 100 tokens
- Write in third person

Output format:
OBSERVATION: <concise entity summary>`;

const INSIGHT_EXTRACTION_PROMPT = `You are extracting learned insights from a synthesized answer. The answer was produced by reasoning over organizational memory. Extract any NEW conclusions, opinions, or learnings that aren't just restating the source facts.

Rules:
- Extract only genuinely NEW insights (conclusions derived from combining multiple facts)
- Each insight should be a self-contained statement (20-80 words)
- Focus on: opinions formed, conclusions drawn, recommendations made, patterns identified
- Do NOT extract: restated source facts, obvious truths, or question reformulations
- If the answer is just summarizing sources with no new synthesis, return empty array

For each insight, provide:
- content: the insight statement
- type: one of [opinion, lesson, pattern, decision]
- entities: key entities mentioned
- confidence: 0.0-1.0 (how confident is this insight based on the evidence)

Respond in JSON array format:
[{"content": "...", "type": "...", "entities": ["..."], "confidence": 0.8}]

If no new insights are present, return: []`;

// ─── Reflect Engine ──────────────────────────────────────────────────────────

export class ReflectEngine {
  private llm: LlmClient;
  private embeddingClient: EmbeddingClient;
  private retrievalEngine: RetrievalEngine;
  private factRepo: FactRepository;
  private observationRepo: ObservationRepository;

  constructor() {
    this.llm = new LlmClient();
    this.embeddingClient = new EmbeddingClient();
    this.retrievalEngine = new RetrievalEngine();
    this.factRepo = new FactRepository();
    this.observationRepo = new ObservationRepository();
  }

  /**
   * Reflect on a query: retrieve memories, reason over them, produce a synthesized answer.
   */
  async reflect(request: ReflectRequest): Promise<ReflectResponse> {
    const reflectId = uuidv4();
    const startTime = Date.now();

    logger.info({
      reflectId,
      query: request.query.substring(0, 100),
      maxTokens: request.maxTokens,
      entityFocus: request.entityFocus,
    }, 'Reflect started');

    // 1. Check if LLM is available
    if (this.llm.disabled) {
      return this.fallbackReflect(request, reflectId, startTime);
    }

    // 2. Retrieve relevant memories
    const searchRequest: SearchRequest = {
      query: request.query,
      context: request.context,
      filters: request.filters,
      topK: request.maxSources ?? 10,
      offset: 0,
      strategy: 'hybrid',
      includeContent: true,
      developerId: request.developerId,
      organizationId: request.organizationId,
      teamIds: request.teamIds ?? [],
      roles: request.roles ?? [],
      repositoryAccess: request.repositoryAccess ?? [],
    };

    const searchResponse = await this.retrievalEngine.search(searchRequest);

    // 3. Load related facts (especially for entity-focused queries)
    const relatedFacts = await this.loadRelatedFacts(request);

    // 4. Check for existing observations about the focused entity
    let existingObservation: Observation | null = null;
    if (request.entityFocus) {
      existingObservation = await this.observationRepo.findByEntity(
        request.entityFocus,
        request.organizationId,
      );
    }

    // 5. Build LLM context from retrieved memories
    const { contextText, sources } = this.buildReflectContext(
      searchResponse.results,
      relatedFacts,
      existingObservation,
      request.maxTokens ?? 6000,
    );

    // 6. Generate synthesized answer via LLM
    const userPrompt = this.buildUserPrompt(request.query, contextText, request.entityFocus);
    const llmResponse = await this.llm.generate(REFLECT_SYSTEM, userPrompt);

    if (!llmResponse) {
      return this.fallbackReflect(request, reflectId, startTime);
    }

    // 7. Parse LLM response
    const { answer, confidence, reasoning } = this.parseReflectResponse(llmResponse.text);

    // 8. Optionally generate/update observation as a side-effect
    let generatedObservation: Observation | null = null;
    if (request.entityFocus && request.generateObservation !== false) {
      generatedObservation = await this.maybeGenerateObservation(
        request.entityFocus,
        relatedFacts,
        request.organizationId,
      );
    }

    // 9. LEARNING LOOP: Write insights back into memory
    //    When reflect produces a high-confidence answer, extract new insights
    //    and store them as facts. This closes the loop: reflect → new facts →
    //    influence future retrieval and opinion reinforcement.
    let learnedInsights: MemoryFact[] = [];
    if (confidence === 'high' && request.writeBack !== false) {
      learnedInsights = await this.writeBackInsights(
        answer,
        request.query,
        request.organizationId,
        request.developerId,
        request.entityFocus,
      );
    }

    // 10. LEARNING SIGNAL: Boost sources that contributed to a successful reflection
    //     High-confidence answers signal that the retrieved sources were useful.
    //     Increment usage counts so they rank higher in future retrieval.
    if (confidence === 'high' || confidence === 'medium') {
      await this.boostContributingSources(sources);
    }

    const response: ReflectResponse = {
      reflectId,
      query: request.query,
      answer,
      confidence,
      reasoning,
      sources,
      observation: generatedObservation ?? existingObservation ?? undefined,
      learnedInsights: learnedInsights.length > 0
        ? learnedInsights.map(f => ({ id: f.id, content: f.content, type: f.type }))
        : undefined,
      retrievalLatencyMs: searchResponse.latencyMs,
      totalLatencyMs: Date.now() - startTime,
      llmTokensUsed: {
        input: llmResponse.inputTokens,
        output: llmResponse.outputTokens,
        model: llmResponse.model,
      },
    };

    logger.info({
      reflectId,
      confidence,
      sourceCount: sources.length,
      totalLatencyMs: response.totalLatencyMs,
      llmModel: llmResponse.model,
    }, 'Reflect completed');

    return response;
  }

  // ─── Internal Methods ────────────────────────────────────────────────────

  /**
   * Load facts related to the query (entity-focused or temporal).
   */
  private async loadRelatedFacts(request: ReflectRequest): Promise<MemoryFact[]> {
    const facts: MemoryFact[] = [];

    if (request.entityFocus) {
      const entityFacts = await this.factRepo.findByEntities(
        [request.entityFocus],
        request.organizationId,
        { limit: 20, onlyValid: true },
      );
      facts.push(...entityFacts);
    }

    // Also load any facts from temporal context
    if (request.temporalContext) {
      const temporalFacts = await this.factRepo.findByTemporal(
        request.organizationId,
        {
          from: request.temporalContext.from,
          to: request.temporalContext.to,
          onlyCurrentlyValid: true,
          includeSuperseded: false,
        },
        { limit: 10 },
      );
      // Deduplicate by ID
      const existingIds = new Set(facts.map(f => f.id));
      for (const f of temporalFacts) {
        if (!existingIds.has(f.id)) facts.push(f);
      }
    }

    return facts;
  }

  /**
   * Build the context text for the LLM from search results and facts.
   * Respects a token budget and greedily packs sources.
   */
  private buildReflectContext(
    results: SearchResultItem[],
    facts: MemoryFact[],
    existingObservation: Observation | null,
    maxTokens: number,
  ): { contextText: string; sources: ReflectSource[] } {
    const sources: ReflectSource[] = [];
    const parts: string[] = [];
    let tokenBudget = maxTokens;

    // Include existing observation first (if available) — it's pre-synthesized
    if (existingObservation) {
      const obsText = `[Existing Observation] ${existingObservation.summary}`;
      const obsTokens = Math.ceil(obsText.length / 4);
      if (obsTokens < tokenBudget) {
        parts.push(obsText);
        tokenBudget -= obsTokens;
      }
    }

    // Include facts (short, high-precision)
    if (facts.length > 0) {
      const factSection = facts.map((f, i) => {
        sources.push({
          sourceIndex: sources.length + 1,
          type: 'fact',
          id: f.id,
          content: f.content,
          factType: f.type,
          confidence: f.confidence,
          createdAt: f.createdAt,
          entities: f.entities,
        });
        const temporal = f.temporal.validUntil
          ? `(superseded ${f.temporal.validUntil.substring(0, 10)})`
          : '(current)';
        return `[Source ${sources.length}] [${f.type}] ${f.content} ${temporal}`;
      }).join('\n');

      const factTokens = Math.ceil(factSection.length / 4);
      if (factTokens < tokenBudget) {
        parts.push(`FACTS:\n${factSection}`);
        tokenBudget -= factTokens;
      }
    }

    // Include search results (longer, full context)
    for (const result of results) {
      const content = result.content ?? result.summary;
      const estimatedTokens = Math.ceil(content.length / 4);

      if (estimatedTokens > tokenBudget) continue;

      sources.push({
        sourceIndex: sources.length + 1,
        type: 'chunk',
        id: result.id,
        title: result.title,
        content: result.summary,
        score: result.finalScore,
        repository: result.repository,
        createdAt: result.createdAt,
      });

      parts.push(
        `[Source ${sources.length}] ${result.title}\n${content}`,
      );
      tokenBudget -= estimatedTokens;
    }

    return { contextText: parts.join('\n\n---\n\n'), sources };
  }

  /**
   * Build the user prompt for the reflect LLM call.
   */
  private buildUserPrompt(
    query: string,
    contextText: string,
    entityFocus?: string,
  ): string {
    let prompt = `QUERY: ${query}\n\n`;

    if (entityFocus) {
      prompt += `ENTITY FOCUS: ${entityFocus}\n\n`;
    }

    prompt += `RETRIEVED MEMORIES:\n\n${contextText}\n\n`;
    prompt += `Based on the above memories, provide a synthesized answer to the query.`;

    return prompt;
  }

  /**
   * Parse the LLM reflect response into structured fields.
   */
  private parseReflectResponse(text: string): {
    answer: string;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  } {
    const answerMatch = text.match(/^ANSWER:\s*\n?([\s\S]*?)(?=\nCONFIDENCE:|$)/m);
    const confidenceMatch = text.match(/^CONFIDENCE:\s*(.+)/m);
    const reasoningMatch = text.match(/^REASONING:\s*(.+)/m);

    const rawConfidence = (confidenceMatch?.[1]?.trim().toLowerCase() ?? 'medium');
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    if (rawConfidence.startsWith('high')) confidence = 'high';
    else if (rawConfidence.startsWith('low')) confidence = 'low';

    return {
      answer: answerMatch?.[1]?.trim() ?? text.trim(),
      confidence,
      reasoning: reasoningMatch?.[1]?.trim() ?? 'Based on available memories.',
    };
  }

  /**
   * Generate or update an observation for an entity if we have enough facts.
   * Only creates if there are 3+ facts about the entity.
   */
  private async maybeGenerateObservation(
    entityName: string,
    facts: MemoryFact[],
    organizationId: string,
  ): Promise<Observation | null> {
    // Only generate if we have enough material
    const entityFacts = facts.filter(f =>
      f.entities.some(e => e.toLowerCase() === entityName.toLowerCase()),
    );

    if (entityFacts.length < 3) return null;

    // Check if existing observation is still fresh
    const existing = await this.observationRepo.findByEntity(entityName, organizationId);
    if (existing) {
      const ageHours = (Date.now() - new Date(existing.updatedAt).getTime()) / 3600000;
      if (ageHours < 24 && existing.sourceFactCount >= entityFacts.length) {
        return existing; // Still fresh enough
      }
    }

    // Generate new observation
    const factsText = entityFacts.map(f => `- [${f.type}] ${f.content}`).join('\n');
    const userPrompt = `Entity: "${entityName}"\n\nFacts about this entity:\n${factsText}`;

    const llmResponse = await this.llm.generate(OBSERVATION_SYSTEM, userPrompt);
    if (!llmResponse) return null;

    const obsMatch = llmResponse.text.match(/^OBSERVATION:\s*(.+)/m);
    const summary = obsMatch?.[1]?.trim() ?? llmResponse.text.trim();

    const observation: Observation = {
      id: existing?.id ?? uuidv4(),
      entityName,
      organizationId,
      summary,
      sourceFactIds: entityFacts.map(f => f.id),
      sourceFactCount: entityFacts.length,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.observationRepo.upsert(observation);

    logger.info({
      entityName,
      factCount: entityFacts.length,
      observationLength: summary.length,
    }, 'Observation generated/updated');

    return observation;
  }

  /**
   * LEARNING SIGNAL: Boost the usage count and recency of sources that
   * contributed to a successful (high/medium confidence) reflection.
   *
   * This creates a positive feedback loop: facts/chunks that produce
   * good answers get higher usage counts → rank higher in future retrieval
   * → produce even better answers.
   */
  private async boostContributingSources(sources: ReflectSource[]): Promise<void> {
    try {
      for (const source of sources) {
        if (source.type === 'fact') {
          await this.factRepo.incrementUsage(source.id);
        }
        // Chunks get boosted via the search feedback mechanism (already exists)
      }
    } catch (error) {
      // Non-critical: usage boost failures don't affect the response
      logger.debug({ err: error }, 'Source boost failed (non-critical)');
    }
  }

  /**
   * LEARNING LOOP: Extract insights from the reflect answer and store them
   * as new facts in the knowledge base.
   *
   * This is the key mechanism that closes the learning cycle:
   *   reflect() → synthesize answer → extract new insights → store as facts
   *   → influence future retrieval → better reflect answers → ...
   *
   * Only triggered for high-confidence answers to avoid polluting memory
   * with uncertain or hallucinated content.
   */
  private async writeBackInsights(
    answer: string,
    query: string,
    organizationId: string,
    developerId: string,
    entityFocus?: string,
  ): Promise<MemoryFact[]> {
    try {
      const userPrompt = `QUERY: ${query}\n\nANSWER:\n${answer}`;
      const response = await this.llm.generate(INSIGHT_EXTRACTION_PROMPT, userPrompt);
      if (!response) return [];

      // Parse extracted insights
      let rawInsights: Array<{
        content: string;
        type: string;
        entities: string[];
        confidence: number;
      }>;

      try {
        // Find JSON array in response
        const jsonMatch = response.text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return [];
        rawInsights = JSON.parse(jsonMatch[0]);
      } catch {
        logger.debug('Failed to parse insight extraction response');
        return [];
      }

      if (!Array.isArray(rawInsights) || rawInsights.length === 0) return [];

      // Filter to valid insights with reasonable confidence
      const validInsights = rawInsights.filter(i =>
        i.content && i.content.length >= 20 && i.content.length <= 400
        && i.confidence >= 0.6
        && ['opinion', 'lesson', 'pattern', 'decision'].includes(i.type),
      ).slice(0, 3); // Max 3 insights per reflect to control growth

      if (validInsights.length === 0) return [];

      // Build MemoryFact objects
      const now = new Date().toISOString();
      const facts: MemoryFact[] = validInsights.map(insight => ({
        id: uuidv4(),
        content: insight.content,
        type: insight.type as FactType,
        entities: [
          ...(insight.entities ?? []),
          ...(entityFocus ? [entityFocus] : []),
        ].filter((e, i, arr) => arr.indexOf(e) === i), // dedupe
        temporal: {
          observedAt: now,
          validFrom: now,
          temporalSource: 'inferred' as const,
        },
        extractedFrom: 'assistant' as const, // Generated by reflection
        authorId: developerId,
        organizationId,
        scope: 'organization' as const,
        confidence: insight.confidence,
        usageCount: 0,
        upvotes: 0,
        frameworks: [],
        createdAt: now,
        updatedAt: now,
      }));

      // Embed and persist
      const embedTexts = facts.map(f => `${f.content} [${f.entities.join(', ')}]`);
      const embeddings = await this.embeddingClient.embedBatch(embedTexts);
      for (let i = 0; i < facts.length; i++) {
        facts[i].embedding = embeddings[i];
        facts[i].embeddingModel = this.embeddingClient.getModelName();
      }

      // Deduplicate against existing facts (don't store if already known)
      const newFacts: MemoryFact[] = [];
      for (const fact of facts) {
        if (!fact.embedding) { newFacts.push(fact); continue; }
        const dupes = await this.factRepo.findSimilar(
          fact.embedding, organizationId, 0.92,
        );
        if (dupes.length === 0) {
          newFacts.push(fact);
        } else {
          logger.debug({
            skipped: fact.content.substring(0, 50),
          }, 'Reflect insight already known, skipping');
        }
      }

      if (newFacts.length > 0) {
        await this.factRepo.createBatch(newFacts);
        logger.info({
          insightsLearned: newFacts.length,
          organizationId,
        }, 'Learning loop: reflect wrote insights back to memory');
      }

      return newFacts;
    } catch (error) {
      logger.warn({ err: error }, 'Insight write-back failed (non-critical)');
      return [];
    }
  }

  /**
   * Fallback when LLM is disabled: return raw retrieval results formatted nicely.
   */
  private async fallbackReflect(
    request: ReflectRequest,
    reflectId: string,
    startTime: number,
  ): Promise<ReflectResponse> {
    const searchRequest: SearchRequest = {
      query: request.query,
      context: request.context,
      filters: request.filters,
      topK: request.maxSources ?? 10,
      offset: 0,
      strategy: 'hybrid',
      includeContent: true,
      developerId: request.developerId,
      organizationId: request.organizationId,
      teamIds: request.teamIds ?? [],
      roles: request.roles ?? [],
      repositoryAccess: request.repositoryAccess ?? [],
    };

    const searchResponse = await this.retrievalEngine.search(searchRequest);
    const facts = await this.loadRelatedFacts(request);

    // Build answer from raw results (no LLM synthesis)
    const factsSummary = facts.length > 0
      ? `**Key facts:**\n${facts.slice(0, 5).map(f => `- ${f.content}`).join('\n')}\n\n`
      : '';
    const chunkSummary = searchResponse.results.length > 0
      ? `**Related knowledge:**\n${searchResponse.results.slice(0, 3).map(r => `- ${r.title}: ${r.summary}`).join('\n')}`
      : 'No relevant knowledge found.';

    const sources: ReflectSource[] = [
      ...facts.slice(0, 5).map((f, i) => ({
        sourceIndex: i + 1,
        type: 'fact' as const,
        id: f.id,
        content: f.content,
        factType: f.type,
        confidence: f.confidence,
        createdAt: f.createdAt,
        entities: f.entities,
      })),
      ...searchResponse.results.slice(0, 3).map((r, i) => ({
        sourceIndex: facts.length + i + 1,
        type: 'chunk' as const,
        id: r.id,
        title: r.title,
        content: r.summary,
        score: r.finalScore,
        repository: r.repository,
        createdAt: r.createdAt,
      })),
    ];

    return {
      reflectId,
      query: request.query,
      answer: `${factsSummary}${chunkSummary}\n\n_Note: LLM synthesis is disabled. Showing raw retrieval results._`,
      confidence: 'low',
      reasoning: 'LLM is disabled; returning raw retrieval results without synthesis.',
      sources,
      retrievalLatencyMs: searchResponse.latencyMs,
      totalLatencyMs: Date.now() - startTime,
    };
  }
}
