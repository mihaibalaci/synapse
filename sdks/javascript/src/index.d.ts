export interface SynapseClientOptions {
  baseUrl?: string;
  token?: string;
  timeout?: number;
}

export interface SearchOptions {
  topK?: number;
  maxTokens?: number;
  repository?: string;
  includeContent?: boolean;
}

export interface CaptureOptions {
  source?: string;
  repository?: string;
  language?: string;
  /** Shared by every batch of one conversation so compaction can consolidate them. */
  conversationId?: string;
}

export interface SessionTrackerOptions {
  repository?: string;
  language?: string;
  /** Messages buffered before an automatic push (default: 4, minimum: 2). */
  flushThreshold?: number;
  flushIntervalMs?: number;
  /** Reuse an existing conversation id instead of generating one. */
  conversationId?: string;
}

export declare class SynapseClient {
  constructor(options?: SynapseClientOptions);
  health(): Promise<any>;
  search(query: string, options?: SearchOptions): Promise<any>;
  getContext(query: string, options?: { maxTokens?: number; repository?: string }): Promise<any>;
  capture(messages: Array<{ role: string; content: string }>, options?: CaptureOptions): Promise<any>;
  getFacts(options?: { entities?: string[]; types?: string[]; limit?: number }): Promise<any>;
  createFact(content: string, type: string, entities: string[], confidence?: number): Promise<any>;
  reflect(query: string, options?: { writeBack?: boolean }): Promise<any>;
  feedback(resultId: string, score: number, query?: string): Promise<any>;
}

export declare class SessionTracker {
  constructor(client: SynapseClient, options?: SessionTrackerOptions);
  readonly conversationId: string;
  /** Messages buffered but not yet pushed. */
  readonly pending: number;
  add(role: string, content: string): Promise<any>;
  /** Pass final to also send a lone trailing message, paired with the previous one. */
  flush(options?: { final?: boolean }): Promise<any>;
  newConversation(conversationId?: string): Promise<string>;
  close(): Promise<any>;
}

export declare class SynapseAPIError extends Error {
  statusCode: number;
  body: any;
}
