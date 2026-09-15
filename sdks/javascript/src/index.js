/**
 * Synapse JavaScript SDK — zero-dependency client for the Synapse memory API.
 * Works in Node.js 18+ (uses global fetch).
 */

class SynapseClient {
  /**
   * @param {Object} options
   * @param {string} [options.baseUrl] - API base URL (default: SYNAPSE_URL env or http://localhost:3000)
   * @param {string} [options.token] - Bearer token or API key (default: SYNAPSE_TOKEN env)
   * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
   */
  constructor({ baseUrl, token, timeout = 30000 } = {}) {
    this.baseUrl = (baseUrl || process.env.SYNAPSE_URL || 'http://localhost:3000').replace(/\/$/, '');
    this.token = token || process.env.SYNAPSE_TOKEN || '';
    this.timeout = timeout;
  }

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new SynapseAPIError(res.status, data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check API health. */
  health() { return this._request('GET', '/health/ready'); }

  /** Search the knowledge base. */
  search(query, { topK = 5, maxTokens = 3000, repository, includeContent = true } = {}) {
    const body = { query, topK, maxTokens, includeContent };
    if (repository) body.context = { repository };
    return this._request('POST', '/api/v1/search', body);
  }

  /** Get token-budget-aware context for AI prompts. */
  getContext(query, { maxTokens = 3000, repository } = {}) {
    const body = { query, maxTokens };
    if (repository) body.context = { repository };
    return this._request('POST', '/api/v1/context', body);
  }

  /**
   * Capture a batch of conversation messages.
   *
   * Pass the same conversationId for every batch of one conversation so Synapse
   * consolidates them before summarizing. Omit it and the batch is treated as a
   * conversation of its own.
   */
  capture(messages, { source = 'sdk-js', repository = '', language = '', conversationId = '' } = {}) {
    return this._request('POST', '/api/v1/capture/passive', {
      messages, source, repository, language, conversationId,
    });
  }

  /** Query atomic facts. */
  getFacts({ entities, types, limit = 10 } = {}) {
    const params = [];
    if (entities?.length) params.push(`entities=${entities.join(',')}`);
    if (types?.length) params.push(`types=${types.join(',')}`);
    params.push(`limit=${limit}`);
    return this._request('GET', `/api/v1/facts?${params.join('&')}`);
  }

  /** Create a new atomic fact. */
  createFact(content, type, entities, confidence = 0.9) {
    return this._request('POST', '/api/v1/facts', { content, type, entities, confidence });
  }

  /** Reason over stored knowledge using LLM. */
  reflect(query, { writeBack = false } = {}) {
    return this._request('POST', '/api/v1/reflect', { query, writeBack });
  }

  /** Submit feedback on a search result. */
  feedback(resultId, score, query = '') {
    return this._request('POST', '/api/v1/feedback', { resultId, score, query });
  }
}

/**
 * Messages buffered before a batch is pushed. Small on purpose: a crash or a
 * forgotten close() can only lose what is still in the buffer, and every batch
 * carries the conversation id so Synapse reassembles them during compaction.
 */
const DEFAULT_FLUSH_THRESHOLD = 4;

/**
 * Automatic session tracker — accumulates messages and captures periodically.
 *
 * Every batch pushed by one tracker shares a conversation id, so compaction
 * consolidates them back into a single conversation before summarizing. Call
 * newConversation() when a genuinely new discussion starts.
 */
class SessionTracker {
  /**
   * @param {SynapseClient} client
   * @param {Object} options
   * @param {string} [options.repository]
   * @param {string} [options.language]
   * @param {number} [options.flushThreshold] - Messages before auto-flush (default: 4)
   * @param {number} [options.flushIntervalMs] - Auto-flush interval in ms (default: 300000)
   * @param {string} [options.conversationId] - Reuse an existing conversation id
   */
  constructor(client, {
    repository = '',
    language = '',
    flushThreshold = DEFAULT_FLUSH_THRESHOLD,
    flushIntervalMs = 300000,
    conversationId = '',
  } = {}) {
    this.client = client;
    this.repository = repository;
    this.language = language;
    // The API requires at least 2 messages per capture, so a lower threshold
    // would buffer forever without ever producing a valid batch.
    this.flushThreshold = Math.max(2, flushThreshold);
    this.conversationId = conversationId || newConversationId();
    this._messages = [];
    // Last message already pushed. The API requires two messages per batch, so a
    // conversation ending on a single buffered message could never be sent;
    // replaying this one alongside it keeps the final message instead of
    // dropping it. The overlap is handled by ingestion deduplication.
    this._lastSent = null;
    this._timer = flushIntervalMs > 0 ? setInterval(() => this.flush(), flushIntervalMs) : null;
    if (this._timer?.unref) this._timer.unref();
  }

  /** Add a message to the current session. */
  add(role, content) {
    this._messages.push({ role, content });
    if (this._messages.length >= this.flushThreshold) {
      return this.flush();
    }
    return Promise.resolve(null);
  }

  /** Messages buffered but not yet pushed. */
  get pending() {
    return this._messages.length;
  }

  /** Flush accumulated messages to Synapse. */
  async flush({ final = false } = {}) {
    if (this._messages.length === 0) return null;

    let messages = this._messages.slice();
    let replayed = false;
    if (messages.length < 2) {
      // Below the API minimum. Keep buffering unless this is the last chance to
      // send, in which case pair it with the previous message.
      if (!final || !this._lastSent) return null;
      messages = [this._lastSent, ...messages];
      replayed = true;
    }

    this._messages.length = 0;
    try {
      const response = await this.client.capture(messages, {
        source: 'sdk-js-tracker',
        repository: this.repository,
        language: this.language,
        conversationId: this.conversationId,
      });
      this._lastSent = messages[messages.length - 1];
      return response;
    } catch (err) {
      // Re-queue on failure. A replayed message was already stored, so it is not
      // added back to the buffer.
      this._messages.unshift(...(replayed ? messages.slice(1) : messages));
      return null;
    }
  }

  /**
   * Flush the current buffer and start a new conversation. Batches added after
   * this call are grouped separately from earlier ones.
   * @returns {Promise<string>} the new conversation id
   */
  async newConversation(conversationId = '') {
    await this.flush({ final: true });
    this.conversationId = conversationId || newConversationId();
    this._lastSent = null;
    return this.conversationId;
  }

  /** Stop the timer and flush remaining messages. */
  async close() {
    if (this._timer) clearInterval(this._timer);
    return this.flush({ final: true });
  }
}

/** Generate a conversation id, preferring the platform UUID generator. */
function newConversationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

class SynapseAPIError extends Error {
  constructor(statusCode, body) {
    super(`Synapse API ${statusCode}: ${JSON.stringify(body).slice(0, 200)}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

module.exports = { SynapseClient, SessionTracker, SynapseAPIError };
