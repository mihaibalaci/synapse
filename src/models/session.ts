/**
 * Session Models
 *
 * Represents the raw AI coding session as uploaded by IDE plugins.
 * This is the entry point for all data into the system.
 */

import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const AIProvider = z.enum([
  'claude',
  'openai',
  'copilot',
  'cursor',
  'windsurf',
  'kiro',
  'gemini',
  'custom',
]);
export type AIProvider = z.infer<typeof AIProvider>;

export const MessageRole = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRole>;

export const SessionStatus = z.enum([
  'uploaded',    // Raw data received
  'parsing',     // Being parsed into structured messages
  'segmenting',  // Being split into semantic chunks
  'extracting',  // Knowledge extraction in progress
  'deduplicating', // Dedup engine processing
  'indexed',     // Fully processed and searchable
  'failed',      // Processing failed (will retry)
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ─── Message Schema ──────────────────────────────────────────────────────────

export const CodeBlockSchema = z.object({
  language: z.string(),
  content: z.string(),
  filePath: z.string().optional(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
});
export type CodeBlock = z.infer<typeof CodeBlockSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  role: MessageRole,
  content: z.string(),
  codeBlocks: z.array(CodeBlockSchema).default([]),
  timestamp: z.string().datetime(),
  tokenCount: z.number().int().nonnegative(),
  toolCalls: z.array(z.object({
    name: z.string(),
    input: z.record(z.unknown()),
    output: z.string().optional(),
  })).default([]),
});
export type Message = z.infer<typeof MessageSchema>;

// ─── Git Context ─────────────────────────────────────────────────────────────

export const GitContextSchema = z.object({
  repository: z.string(),                  // e.g. "org/repo-name"
  branch: z.string(),
  commitSha: z.string().optional(),
  filesTouched: z.array(z.string()).default([]),
  codeDiffs: z.array(z.object({
    filePath: z.string(),
    diff: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })).default([]),
});
export type GitContext = z.infer<typeof GitContextSchema>;

// ─── Session Metadata ────────────────────────────────────────────────────────

export const SessionMetadataSchema = z.object({
  project: z.string(),
  language: z.string(),                    // Primary language
  languages: z.array(z.string()).default([]), // All languages in session
  framework: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
  aiProvider: AIProvider,
  aiModel: z.string(),                     // e.g. "claude-sonnet-4-20250514"
  idePlugin: z.string().optional(),        // e.g. "kiro-1.2.0"
  tags: z.array(z.string()).default([]),
  terminalLogs: z.string().optional(),
});
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

// ─── Full Session Upload Schema ──────────────────────────────────────────────

export const SessionUploadSchema = z.object({
  /** Client-generated idempotency key */
  clientId: z.string().uuid(),

  /** Developer identity */
  developerId: z.string(),
  organizationId: z.string(),
  teamId: z.string().optional(),

  /** Conversation content */
  messages: z.array(MessageSchema).min(1),

  /** Git context */
  git: GitContextSchema.optional(),

  /** Session metadata */
  metadata: SessionMetadataSchema,

  /** Timing */
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),

  /** Total token count for the session */
  totalTokens: z.number().int().nonnegative(),
});
export type SessionUpload = z.infer<typeof SessionUploadSchema>;

// ─── Persisted Session (after server assigns ID + status) ────────────────────

export const SessionRecordSchema = SessionUploadSchema.extend({
  id: z.string().uuid(),
  status: SessionStatus,
  rawStorageKey: z.string(),               // S3 key for immutable raw data
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  processingAttempts: z.number().int().default(0),
  lastError: z.string().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
