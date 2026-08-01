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

  /** Capture a conversation session. */
  capture(messages, { source = 'sdk-js', repository = '', language = '' } = {}) {
    return this._request('POST', '/api/v1/capture/passive', { messages, source, repository, language });
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
 * Automatic session tracker — accumulates messages and captures periodically.
 */
class SessionTracker {
  /**
   * @param {SynapseClient} client
   * @param {Object} options
   * @param {string} [options.repository]
   * @param {string} [options.language]
   * @param {number} [options.flushThreshold] - Messages before auto-flush (default: 10)
   * @param {number} [options.flushIntervalMs] - Auto-flush interval in ms (default: 300000)
   */
  constructor(client, { repository = '', language = '', flushThreshold = 10, flushIntervalMs = 300000 } = {}) {
    this.client = client;
    this.repository = repository;
    this.language = language;
    this.flushThreshold = flushThreshold;
    this._messages = [];
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

  /** Flush accumulated messages to Synapse. */
  async flush() {
    if (this._messages.length < 2) return null;
    const messages = this._messages.splice(0);
    try {
      return await this.client.capture(messages, {
        source: 'sdk-js-tracker',
        repository: this.repository,
        language: this.language,
      });
    } catch (err) {
      // Re-queue on failure
      this._messages.unshift(...messages);
      return null;
    }
  }

  /** Stop the timer and flush remaining messages. */
  async close() {
    if (this._timer) clearInterval(this._timer);
    return this.flush();
  }
}

class SynapseAPIError extends Error {
  constructor(statusCode, body) {
    super(`Synapse API ${statusCode}: ${JSON.stringify(body).slice(0, 200)}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

module.exports = { SynapseClient, SessionTracker, SynapseAPIError };
