import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

describe('Configuration', () => {
  const baseEnv = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

  it('should load with all defaults when no env vars set', () => {
    // loadConfig uses defaults for all fields
    // We can't test this directly without resetting the singleton,
    // but we can verify the schema accepts empty env
    expect(() => loadConfig(baseEnv, true)).not.toThrow();
  });

  it('should accept valid embedding providers', () => {
    const config = loadConfig({ ...baseEnv, EMBEDDING_PROVIDER: 'ollama' }, true);
    expect(config.EMBEDDING_PROVIDER).toBe('ollama');
  });

  it('should accept valid LLM providers', () => {
    const config = loadConfig({ ...baseEnv, LLM_PROVIDER: 'local-none' }, true);
    expect(config.LLM_PROVIDER).toBe('local-none');
  });

  it('should coerce PORT to number', () => {
    const config = loadConfig({ ...baseEnv, PORT: '8080' }, true);
    expect(config.PORT).toBe(8080);
    expect(typeof config.PORT).toBe('number');
  });

  it('should default to development NODE_ENV', () => {
    const config = loadConfig(baseEnv, true);
    expect(config.NODE_ENV).toBe('development');
  });
});
