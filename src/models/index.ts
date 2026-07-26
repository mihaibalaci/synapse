/**
 * Models Index
 *
 * Re-exports all model types and schemas for convenient importing.
 */

// Session models
export {
  AIProvider,
  MessageRole,
  SessionStatus,
  SearchableStatus,
  EnrichmentStatus,
  CodeBlockSchema,
  MessageSchema,
  GitContextSchema,
  SessionMetadataSchema,
  SessionUploadSchema,
  SessionRecordSchema,
  type CodeBlock,
  type Message,
  type GitContext,
  type SessionMetadata,
  type SessionUpload,
  type SessionRecord,
} from './session.js';

// Chunk models
export {
  ChunkType,
  ConfidenceLevel,
  CodeReferenceSchema,
  EntitySchema,
  ChunkSchema,
  ChunkClusterSchema,
  type CodeReference,
  type Entity,
  type Chunk,
  type ChunkCluster,
} from './chunk.js';

// Knowledge models
export {
  KnowledgeType,
  ProblemSolutionSchema,
  ArchitectureDecisionSchema,
  BestPracticeSchema,
  HowToSchema,
  KnowledgeRecordSchema,
  type ProblemSolution,
  type ArchitectureDecision,
  type BestPractice,
  type HowTo,
  type KnowledgeRecord,
} from './knowledge.js';

// Retrieval models
export {
  SearchRequestSchema,
  SearchResultItemSchema,
  SearchResponseSchema,
  RankingWeightsSchema,
  FeedbackEventSchema,
  type SearchRequest,
  type SearchResultItem,
  type SearchResponse,
  type RankingWeights,
  type FeedbackEvent,
} from './retrieval.js';

// Permission models
export {
  SecurityClassification,
  ACLSchema,
  PermissionCheckSchema,
  GovernancePolicySchema,
  AuditLogSchema,
  type ACL,
  type PermissionCheck,
  type GovernancePolicy,
  type AuditLog,
} from './permissions.js';

// Graph models
export {
  GraphNodeType,
  GraphEdgeType,
  GraphNodeSchema,
  GraphEdgeSchema,
  GraphExpansionRequestSchema,
  GraphExpansionResultSchema,
  type GraphNode,
  type GraphEdge,
  type GraphExpansionRequest,
  type GraphExpansionResult,
} from './graph.js';

// Memory Fact models (v3)
export {
  FactType,
  TemporalContextSchema,
  MemoryFactSchema,
  CaptureEventSchema,
  TemporalQuerySchema,
  type TemporalContext,
  type MemoryFact,
  type CaptureEvent,
  type TemporalQuery,
} from './memory-fact.js';
