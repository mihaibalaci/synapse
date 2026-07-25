/**
 * LLM Client (v3 — Multi-provider)
 *
 * Supports multiple LLM providers for flexible deployment:
 *   - claude: Anthropic API
 *   - openai: OpenAI API (GPT-4o, etc.)
 *   - ollama: Self-hosted Ollama (llama3, mistral, etc.)
 *   - vllm: Self-hosted vLLM
 *   - local-none: Disable LLM (heuristic-only mode for Tier 1)
 *
 * Used by:
 *   - Fact Extractor (Tier 2 — structured extraction)
 *   - Knowledge Extractor (Tier 2 — problem/solution records)
 *   - Segmenter (Tier 2 — LLM boundary detection)
 *   - Compaction Engine (weekly canonical synthesis)
 */

import { getConfig } from '../config/index.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ module: 'llm-client' });

export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class LLMClient {
  private provider: string;
  private model: string;
  private selfHostedUrl: string;

  constructor() {
    const config = getConfig();
    this.provider = config.LLM_PROVIDER;
    this.model = config.LLM_MODEL;
    this.selfHostedUrl = (config as any).LLM_URL ?? '';
  }

  /**
   * Check if LLM is available (disabled in local-none mode).
   */
  isAvailable(): boolean {
    return this.provider !== 'local-none';
  }

  /**
   * Complete a prompt. Returns structured response with token counts.
   */
  async complete(params: {
    system?: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<LLMResponse> {
    if (!this.isAvailable()) {
      throw new Error('LLM is disabled (provider=local-none). Use heuristic extraction only.');
    }

    const { system, prompt, maxTokens = 2000, temperature = 0.3 } = params;

    logger.debug({ provider: this.provider, model: this.model, promptLen: prompt.length }, 'LLM call');

    switch (this.provider) {
      case 'claude':
        return this.callClaude(system, prompt, maxTokens, temperature);
      case 'openai':
        return this.callOpenAI(system, prompt, maxTokens, temperature);
      case 'ollama':
        return this.callOllama(system, prompt, maxTokens, temperature);
      case 'vllm':
        return this.callVLLM(system, prompt, maxTokens, temperature);
      default:
        throw new Error(`Unknown LLM provider: ${this.provider}`);
    }
  }

  // ─── Claude (Anthropic) ────────────────────────────────────────────────────

  private async callClaude(
    system: string | undefined, prompt: string, maxTokens: number, temperature: number,
  ): Promise<LLMResponse> {
    const config = getConfig();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: system ?? undefined,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API failed: ${response.status} ${err}`);
    }

    const data = await response.json() as any;
    return {
      content: data.content[0]?.text ?? '',
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: data.model,
    };
  }

  // ─── OpenAI ────────────────────────────────────────────────────────────────

  private async callOpenAI(
    system: string | undefined, prompt: string, maxTokens: number, temperature: number,
  ): Promise<LLMResponse> {
    const config = getConfig();
    const messages: any[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API failed: ${response.status} ${err}`);
    }

    const data = await response.json() as any;
    return {
      content: data.choices[0]?.message?.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      model: data.model,
    };
  }

  // ─── Ollama (self-hosted) ──────────────────────────────────────────────────

  private async callOllama(
    system: string | undefined, prompt: string, maxTokens: number, temperature: number,
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.selfHostedUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API failed: ${response.status}`);
    }

    const data = await response.json() as any;
    return {
      content: data.message?.content ?? '',
      inputTokens: data.prompt_eval_count ?? Math.ceil(prompt.length / 4),
      outputTokens: data.eval_count ?? Math.ceil((data.message?.content ?? '').length / 4),
      model: this.model,
    };
  }

  // ─── vLLM (OpenAI-compatible, self-hosted) ─────────────────────────────────

  private async callVLLM(
    system: string | undefined, prompt: string, maxTokens: number, temperature: number,
  ): Promise<LLMResponse> {
    const messages: any[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const response = await fetch(`${this.selfHostedUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`vLLM API failed: ${response.status}`);
    }

    const data = await response.json() as any;
    return {
      content: data.choices[0]?.message?.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      model: this.model,
    };
  }
}
