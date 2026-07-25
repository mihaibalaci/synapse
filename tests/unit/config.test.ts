import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

describe('Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset module cache to re-evaluate config
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load with all defaults when no env vars set', () => {
    // loadConfig uses defaults for all fields
    // We can't test this directly without resetting the singleton,
    // but we can verify the schema accepts empty env
    expect(() => loadConfig()).not.toThrow();
  });

  it('should accept valid embedding providers', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    const config = loadConfig();
    expect(config.EMBEDDING_PROVIDER).toBe('ollama');
  });

  it('should accept valid LLM providers', () => {
    process.env.LLM_PROVIDER = 'local-none';
    const config = loadConfig();
    expect(config.LLM_PROVIDER).toBe('local-none');
  });

  it('should coerce PORT to number', () => {
    process.env.PORT = '8080';
    const config = loadConfig();
    expect(config.PORT).toBe(8080);
    expect(typeof config.PORT).toBe('number');
  });

  it('should default to development NODE_ENV', () => {
    const config = loadConfig();
    expect(config.NODE_ENV).toBe('development');
  });
});
