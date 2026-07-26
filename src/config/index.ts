/**
 * Application Configuration
 *
 * Centralized config loaded from environment variables.
 * Validated at startup to fail fast on misconfiguration.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // PostgreSQL
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/recall'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // S3 / Object Storage
  S3_BUCKET: z.string().default('recall-raw'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(), // For MinIO in local dev

  // Queue (BullMQ uses Redis)
  QUEUE_CONCURRENCY: z.coerce.number().default(10),

  // Embedding (multi-provider: openai, ollama, vllm, tei, local)
  EMBEDDING_PROVIDER: z.enum(['openai', 'ollama', 'vllm', 'tei', 'local']).default('local'),
  EMBEDDING_URL: z.string().default('http://localhost:8080'),  // For self-hosted (ollama/vllm/tei)
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().refine(
    value => value === 1536,
    'Recall requires one globally consistent 1536-dimensional embedding space',
  ).default(1536),

  // LLM (multi-provider: claude, openai, ollama, vllm, local-none)
  LLM_PROVIDER: z.enum(['claude', 'openai', 'ollama', 'vllm', 'local-none']).default('local-none'),
  LLM_URL: z.string().default('http://localhost:11434'),  // For self-hosted (ollama/vllm)
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('llama3.1:8b'),

  // Auth
  AUTH_ISSUER: z.string().default('https://auth.company.com'),
  AUTH_AUDIENCE: z.string().default('recall'),
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  AUTH_JWT_PUBLIC_KEY: z.string().optional(),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let _config: AppConfig | null = null;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  forceReload: boolean = false,
): AppConfig {
  if (_config && !forceReload) return _config;

  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    throw new Error(`Configuration validation failed: ${result.error.message}`);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) return loadConfig();
  return _config;
}
