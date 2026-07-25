import { describe, it, expect, vi } from 'vitest';
import { EmbeddingClient } from '../../src/utils/embedding.js';

// Mock config to use local provider
vi.mock('../../src/config/index.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    EMBEDDING_PROVIDER: 'local',
    EMBEDDING_MODEL: 'test-model',
    EMBEDDING_DIMENSIONS: 128,
    EMBEDDING_URL: '',
  }),
}));

describe('EmbeddingClient (local provider)', () => {
  const client = new EmbeddingClient();

  it('should generate embeddings of correct dimensions', async () => {
    const embedding = await client.embed('Hello world');
    expect(embedding).toHaveLength(128);
  });

  it('should generate normalized vectors (unit length)', async () => {
    const embedding = await client.embed('Some text for testing');
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it('should handle batch embedding', async () => {
    const texts = ['text one', 'text two', 'text three'];
    const embeddings = await client.embedBatch(texts);

    expect(embeddings).toHaveLength(3);
    for (const emb of embeddings) {
      expect(emb).toHaveLength(128);
    }
  });

  it('should return empty array for empty batch', async () => {
    const embeddings = await client.embedBatch([]);
    expect(embeddings).toHaveLength(0);
  });

  it('should produce different embeddings for different texts', async () => {
    const emb1 = await client.embed('Kubernetes pod networking');
    const emb2 = await client.embed('React component lifecycle');

    // Should not be identical
    const identical = emb1.every((v, i) => v === emb2[i]);
    expect(identical).toBe(false);
  });

  it('should produce consistent embeddings for same text', async () => {
    const emb1 = await client.embed('Consistent embedding test');
    const emb2 = await client.embed('Consistent embedding test');

    expect(emb1).toEqual(emb2);
  });

  it('should report model name', () => {
    expect(client.getModelName()).toBe('test-model');
  });

  it('should report dimensions', () => {
    expect(client.getDimensions()).toBe(128);
  });
});
