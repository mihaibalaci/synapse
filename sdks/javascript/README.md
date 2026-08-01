# Synapse JavaScript SDK

Zero-dependency JavaScript/TypeScript client for the Synapse memory API.
Requires Node.js 18+ (uses global `fetch`).

## Installation

```bash
npm install @synapse/sdk
```

## Quick Start

```javascript
const { SynapseClient, SessionTracker } = require('@synapse/sdk');

// Initialize
const client = new SynapseClient({
  baseUrl: 'http://localhost:3000',
  token: 'sk_synapse_...',
});

// Search knowledge
const results = await client.search('How does the Redis cache expire?');

// Get AI-ready context
const context = await client.getContext('authentication flow', { maxTokens: 4000 });

// Capture a session
await client.capture([
  { role: 'user', content: 'We chose Redis for caching' },
  { role: 'assistant', content: 'Noted the 5-min TTL decision' },
], { repository: 'org/repo' });

// Automatic session tracking
const tracker = new SessionTracker(client, { repository: 'org/repo' });
tracker.add('user', "Let's use PostgreSQL for this");
tracker.add('assistant', 'Good choice for ACID compliance');
// Auto-flushes at 10 messages or every 5 minutes
await tracker.close();
```

## Environment Variables

- `SYNAPSE_URL` — API base URL (default: `http://localhost:3000`)
- `SYNAPSE_TOKEN` — Bearer token or API key
