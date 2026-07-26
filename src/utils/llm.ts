/**
 * LLM Client — multi-provider text generation.
 *
 * Supports: claude, openai, ollama, vllm, local-none.
 * Provider is selected via LLM_PROVIDER env. Self-hosted providers connect to
 * LLM_URL. local-none returns null, signalling callers to skip LLM-dependent
 * work rather than crash.
 */

import { getConfig } from '../config/index.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ module: 'llm' });

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class LlmClient {
  private provider: string;
  private model: string;
  private url: string;

  constructor() {
    const config = getConfig();
    this.provider = config.LLM_PROVIDER;
    this.model = config.LLM_MODEL;
    this.url = (config as any).LLM_URL ?? '';
  }

  /** True when no LLM is configured and callers should skip LLM-dependent work. */
  get disabled(): boolean {
    return this.provider === 'local-none';
  }

  /**
   * Generate text from a system + user prompt pair.
   * Returns null when the provider is local-none.
   */
  async generate(system: string, user: string): Promise<LlmResponse | null> {
    if (this.disabled) return null;

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        switch (this.provider) {
          case 'claude':
            return await this.callClaude(system, user);
          case 'openai':
            return await this.callOpenAI(system, user);
          case 'ollama':
            return await this.callOllama(system, user);
          case 'vllm':
            return await this.callVLLM(system, user);
          default:
            return null;
        }
      } catch (error) {
        lastError = error as Error;
        logger.warn({ attempt, err: error, provider: this.provider }, 'LLM call failed, retrying');
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }

    throw new Error(`LLM generation failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  private async callClaude(system: string, user: string): Promise<LlmResponse> {
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
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API failed: ${response.status} ${err.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    return {
      text: data.content?.[0]?.text ?? '',
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: data.model ?? this.model,
    };
  }

  private async callOpenAI(system: string, user: string): Promise<LlmResponse> {
    const config = getConfig();
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.OPENAI_API_KEY ?? ''}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API failed: ${response.status} ${err.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      model: data.model ?? this.model,
    };
  }

  private async callOllama(system: string, user: string): Promise<LlmResponse> {
    const response = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama failed: ${response.status}`);
    }

    const data = await response.json() as any;
    return {
      text: data.message?.content ?? '',
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      model: this.model,
    };
  }

  private async callVLLM(system: string, user: string): Promise<LlmResponse> {
    const response = await fetch(`${this.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`vLLM failed: ${response.status}`);
    }

    const data = await response.json() as any;
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      model: this.model,
    };
  }

  getModel(): string { return this.model; }
  getProvider(): string { return this.provider; }
}
