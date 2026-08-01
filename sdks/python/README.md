# Synapse Python SDK

Zero-dependency Python client for the Synapse memory API.

## Installation

```bash
pip install synapse-sdk
```

## Quick Start

```python
from synapse_sdk import SynapseClient, SessionTracker

# Initialize
client = SynapseClient(
    base_url="http://localhost:3000",
    token="sk_synapse_..."
)

# Search knowledge
results = client.search("How does the Redis cache expire?")

# Get AI-ready context
context = client.get_context("authentication flow", max_tokens=4000)

# Capture a session
client.capture(messages=[
    {"role": "user", "content": "We chose Redis for caching"},
    {"role": "assistant", "content": "Noted the 5-min TTL decision"}
], repository="org/repo")

# Automatic session tracking
with SessionTracker(client, repository="org/repo") as tracker:
    tracker.add("user", "Let's use PostgreSQL for this")
    tracker.add("assistant", "Good choice for ACID compliance")
    # Auto-flushes at 10 messages or every 5 minutes
```

## Environment Variables

- `SYNAPSE_URL` — API base URL (default: `http://localhost:3000`)
- `SYNAPSE_TOKEN` — Bearer token or API key
