/**
 * Embedding Client (v3 — Multi-provider)
 *
 * Supports multiple embedding providers for flexible deployment:
 *   - openai: OpenAI API (text-embedding-3-small/large)
 *   - ollama: Self-hosted Ollama (nomic-embed-text, mxbai-embed-large)
 *   - vllm: Self-hosted vLLM with embedding models
 *   - tei: HuggingFace Text Embeddings Inference (recommended for on-prem)
 *   - local: Deterministic pseudo-embeddings (dev/test only)
 *
 * Provider is selected via EMBEDDING_PROVIDER env var.
 * Self-hosted providers connect to EMBEDDING_URL.
 */

import { getConfig } from '../config/index.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ module: 'embedding' });

export class EmbeddingClient {
  private model: string;
  private dimensions: number;
  private provider: string;
  private selfHostedUrl: string;

  constructor() {
    const config = getConfig();
    this.model = config.EMBEDDING_MODEL;
    this.dimensions = config.EMBEDDING_DIMENSIONS;
    this.provider = config.EMBEDDING_PROVIDER;
    this.selfHostedUrl = (config as any).EMBEDDING_URL ?? '';
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    logger.debug({ count: texts.length, provider: this.provider }, 'Generating embeddings');

    const truncated = texts.map(t => t.substring(0, 8000));
    const batchSize = this.provider === 'openai' ? 100 : 32;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < truncated.length; i += batchSize) {
      const batch = truncated.slice(i, i + batchSize);
      const embeddings = await this.callProvider(batch);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  private async callProvider(texts: string[]): Promise<number[][]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        switch (this.provider) {
          case 'openai':
            return await this.callOpenAI(texts);
          case 'ollama':
            return await this.callOllama(texts);
          case 'vllm':
            return await this.callVLLM(texts);
          case 'tei':
            return await this.callTEI(texts);
          case 'local':
            return this.generateLocalEmbeddings(texts);
          default:
            throw new Error(`Unknown embedding provider: ${this.provider}`);
        }
      } catch (error) {
        lastError = error as Error;
        logger.warn({ attempt, err: error, provider: this.provider }, 'Embedding call failed, retrying');
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }

    throw new Error(`Embedding failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  // ─── OpenAI ──────────────────────────────────────────────────────────────

  private async callOpenAI(texts: string[]): Promise<number[][]> {
    const config = getConfig();
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI embeddings failed: ${response.status} ${err}`);
    }

    const data = await response.json() as any;
    return data.data.map((d: any) => d.embedding);
  }

  // ─── Ollama ──────────────────────────────────────────────────────────────

  private async callOllama(texts: string[]): Promise<number[][]> {
    // Ollama processes one text at a time via /api/embeddings
    const results: number[][] = [];

    for (const text of texts) {
      const response = await fetch(`${this.selfHostedUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding failed: ${response.status}`);
      }

      const data = await response.json() as any;
      results.push(data.embedding);
    }

    return results;
  }

  // ─── vLLM ────────────────────────────────────────────────────────────────

  private async callVLLM(texts: string[]): Promise<number[][]> {
    // vLLM uses OpenAI-compatible API at /v1/embeddings
    const response = await fetch(`${this.selfHostedUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`vLLM embedding failed: ${response.status}`);
    }

    const data = await response.json() as any;
    return data.data.map((d: any) => d.embedding);
  }

  // ─── HuggingFace Text Embeddings Inference (TEI) ─────────────────────────

  private async callTEI(texts: string[]): Promise<number[][]> {
    // TEI uses POST /embed with { inputs: [...] }
    const response = await fetch(`${this.selfHostedUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts, truncate: true }),
    });

    if (!response.ok) {
      throw new Error(`TEI embedding failed: ${response.status}`);
    }

    const data = await response.json() as any;
    // TEI returns array of arrays directly
    return data;
  }

  // ─── Local (dev/test only) ───────────────────────────────────────────────

  private generateLocalEmbeddings(texts: string[]): number[][] {
    return texts.map(text => {
      const embedding = new Array(this.dimensions).fill(0);
      for (let i = 0; i < text.length && i < this.dimensions; i++) {
        embedding[i % this.dimensions] += text.charCodeAt(i) / 1000;
      }
      const norm = Math.sqrt(embedding.reduce((s: number, v: number) => s + v * v, 0));
      return norm > 0 ? embedding.map((v: number) => v / norm) : embedding;
    });
  }

  getModelName(): string { return this.model; }
  getDimensions(): number { return this.dimensions; }
}
