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
}

export interface SessionTrackerOptions {
  repository?: string;
  language?: string;
  flushThreshold?: number;
  flushIntervalMs?: number;
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
  add(role: string, content: string): Promise<any>;
  flush(): Promise<any>;
  close(): Promise<any>;
}

export declare class SynapseAPIError extends Error {
  statusCode: number;
  body: any;
}
