/**
 * Storage Layer Index
 *
 * Re-exports all storage components for convenient importing.
 * The system uses polyglot persistence:
 *   - PostgreSQL (pgvector) → chunks, knowledge, sessions, metadata
 *   - S3 → raw immutable session data
 *   - Neo4j → relationship graph
 *   - OpenSearch → BM25 full-text search
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

// Graph (Neo4j)
export {
  GraphRepository,
  checkGraphHealth,
  closeGraph,
} from './graph-repository.js';

// Search Index (OpenSearch)
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
