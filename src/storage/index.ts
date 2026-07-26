/**
 * Storage Layer Index
 *
 * Re-exports all storage components for convenient importing.
 * The mandatory stores are:
 *   - PostgreSQL (pgvector + FTS + relational graph) → derived knowledge
 *   - S3/MinIO → raw immutable session data
 *   - Redis → cache, queues, rate limiting
 */

// Database (PostgreSQL + pgvector)
export {
  getPool,
  query,
  withTransaction,
  checkDatabaseHealth,
  initializeSchema,
  closeDatabase,
} from './database.js';

// Object Storage (S3/MinIO)
export { ObjectStorageClient } from './object-storage.js';

// Repositories
export { SessionRepository } from './session-repository.js';
export { ChunkRepository } from './chunk-repository.js';
export { KnowledgeRepository } from './knowledge-repository.js';
export { ClusterRepository } from './cluster-repository.js';
export { CaptureRepository } from './capture-repository.js';
export { FactRepository } from './fact-repository.js';
export { OutboxRepository } from './outbox-repository.js';
export { ProcessingStatusRepository } from './processing-status-repository.js';

// Graph (PostgreSQL relational tables)
export {
  GraphRepository,
  checkGraphHealth,
  closeGraph,
} from './graph-repository.js';

// Search Index (PostgreSQL FTS + pg_trgm)
export {
  SearchIndex,
  checkSearchHealth,
} from './search-index.js';

// Cache (Redis)
export {
  SearchCache,
  checkSessionIdempotency,
  checkCacheHealth,
  closeCache,
  getRedis,
} from './cache.js';
