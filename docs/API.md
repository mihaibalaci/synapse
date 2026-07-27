# Synapse — API Reference

## Base URL

```
Production:  https://api.context-store.internal.company.com
Local dev:   http://localhost:3000
```

## Authentication

All endpoints require a Bearer token (OAuth2):
```
Authorization: Bearer <token>
```

Tokens are org-scoped. The `organization_id` is extracted from the token claims.

---

## Endpoints

### Capture (v3 — Passive + Active + Ambient)

#### `POST /api/v1/capture/passive`

**Auto-upload AI sessions silently.** The IDE plugin calls this when a conversation ends.
Developer does nothing — zero friction.

**Request (minimal payload):**
```json
{
  "messages": [
    { "role": "user", "content": "How do I fix Lambda timeout in VPC?", "timestamp": "2025-07-25T10:00:00Z" },
    { "role": "assistant", "content": "Lambda timeouts in VPCs are usually caused by DNS...", "timestamp": "2025-07-25T10:00:05Z" }
  ],
  "source": "kiro",
  "repository": "org/my-service",
  "branch": "main",
  "language": "typescript",
  "filePath": "src/handler.ts",
  "developerId": "dev-123",
  "organizationId": "org-456"
}
```

**Response (202):**
```json
{
  "sessionId": "uuid",
  "status": "captured",
  "mode": "passive",
  "message": "Session captured automatically"
}
```

#### `POST /api/v1/capture/active`

**Explicit save with enrichment.** Developer chose to save — can add tags, annotation, link tickets.
These get higher processing priority and optionally force Tier 2 deep extraction.

**Request (full payload + active-only fields):**
```json
{
  "clientId": "uuid",
  "developerId": "dev-123",
  "organizationId": "org-456",
  "messages": [...],
  "metadata": { "language": "python", "aiProvider": "claude", ... },
  "git": { "repository": "org/service", "branch": "fix/timeout", "codeDiffs": [...] },
  "startedAt": "...",
  "endedAt": "...",
  "totalTokens": 15000,
  "tags": ["debugging", "lambda", "vpc"],
  "annotation": "This solved a 3-day issue with VPC DNS resolution",
  "linkedTicket": "JIRA-1234",
  "promoteTier2": true
}
```

**Response (202):**
```json
{
  "sessionId": "uuid",
  "status": "captured",
  "mode": "active",
  "tier": "deep",
  "message": "Session saved successfully"
}
```

#### `POST /api/v1/capture/event`

**Ambient capture.** Terminal commands, browser activity, meeting transcripts.

**Request:**
```json
{
  "type": "terminal",
  "source": "iterm2",
  "content": "$ kubectl get pods -n production\nNAME                    READY   STATUS             RESTARTS\nauth-svc-7d4b8c-x2k9   0/1     CrashLoopBackOff   5",
  "metadata": { "cwd": "/Users/dev/projects/infra" },
  "captureMode": "passive",
  "developerId": "dev-123",
  "organizationId": "org-456",
  "timestamp": "2025-07-25T10:30:00Z"
}
```

Event types: `ai_session`, `ai_turn`, `clipboard`, `terminal`, `browser`, `meeting`, `commit`, `pr_review`, `slack_thread`

**Response (201):**
```json
{ "id": "uuid", "captured": true }
```

#### `POST /api/v1/capture/events`

**Batch ambient capture** — up to 200 events per request. Same schema as single event, wrapped in `{ "events": [...] }`.

---

### Session Upload (Legacy)

#### `POST /api/v1/sessions`

Upload a single AI coding session for processing.

**Request:**
```json
{
  "clientId": "uuid-v4 (idempotency key)",
  "developerId": "dev-123",
  "organizationId": "org-456",
  "teamId": "team-frontend",
  "messages": [
    {
      "id": "msg-uuid",
      "role": "user",
      "content": "How do I optimize S3 uploads?",
      "codeBlocks": [],
      "timestamp": "2025-07-25T10:00:00Z",
      "tokenCount": 12,
      "toolCalls": []
    },
    {
      "id": "msg-uuid-2",
      "role": "assistant",
      "content": "Use multipart uploads for files >100MB...",
      "codeBlocks": [
        { "language": "typescript", "content": "const upload = new Upload({...})" }
      ],
      "timestamp": "2025-07-25T10:00:05Z",
      "tokenCount": 450,
      "toolCalls": []
    }
  ],
  "git": {
    "repository": "org/my-service",
    "branch": "feature/upload-optimization",
    "commitSha": "abc123",
    "filesTouched": ["src/upload.ts"],
    "codeDiffs": [
      { "filePath": "src/upload.ts", "diff": "...", "additions": 12, "deletions": 3 }
    ]
  },
  "metadata": {
    "project": "my-service",
    "language": "typescript",
    "languages": ["typescript"],
    "frameworks": ["aws-sdk"],
    "aiProvider": "claude",
    "aiModel": "claude-sonnet-4-20250514",
    "idePlugin": "kiro-1.5.0",
    "tags": ["s3", "performance"]
  },
  "startedAt": "2025-07-25T10:00:00Z",
  "endedAt": "2025-07-25T10:15:00Z",
  "totalTokens": 15000
}
```

**Response (202 Accepted):**
```json
{
  "sessionId": "uuid",
  "status": "uploaded",
  "message": "Session accepted for processing",
  "estimatedProcessingTime": "~30 seconds",
  "trackingUrl": "/api/v1/sessions/uuid/status"
}
```

#### `POST /api/v1/sessions/batch`

Upload up to 50 sessions in one request.

#### `GET /api/v1/sessions/:sessionId/status`

Check processing status.

**Response:**
```json
{
  "sessionId": "uuid",
  "status": "indexed",
  "createdAt": "2025-07-25T10:15:30Z",
  "updatedAt": "2025-07-25T10:15:35Z",
  "processingAttempts": 1,
  "tier": "fast"
}
```

Status values: `uploaded` → `parsing` → `segmenting` → `extracting` → `indexed` | `failed`

---

### Retrieval

#### `POST /api/v1/context` (Primary plugin endpoint)

Get context for an AI prompt. Returns ranked knowledge chunks optimized for token budget.

**Request:**
```json
{
  "query": "How do we authenticate GitHub webhooks?",
  "repository": "org/webhook-service",
  "filePath": "src/webhooks/handler.ts",
  "language": "typescript",
  "maxTokens": 4000,
  "developerId": "dev-123",
  "organizationId": "org-456"
}
```

**Response:**
```json
{
  "context": [
    {
      "title": "GitHub webhook HMAC verification",
      "content": "Use crypto.timingSafeEqual to compare the X-Hub-Signature-256 header...",
      "score": 0.94
    },
    {
      "title": "Webhook secret rotation procedure",
      "content": "Store secrets in Secrets Manager, rotate every 90 days...",
      "score": 0.87
    }
  ],
  "totalResults": 12,
  "returnedResults": 2,
  "estimatedTokens": 1850,
  "latencyMs": 95,
  "cached": false
}
```

#### `POST /api/v1/search` (Full search with all options)

Advanced search with filters, strategy selection, and pagination.

**Request:**
```json
{
  "query": "Lambda timeout VPC DNS",
  "context": {
    "repository": "org/lambda-service",
    "language": "python",
    "frameworks": ["aws-lambda", "boto3"]
  },
  "filters": {
    "repositories": ["org/lambda-service", "org/shared-infra"],
    "languages": ["python", "typescript"],
    "types": ["debugging", "problem_solution"],
    "minQualityScore": 0.5,
    "dateRange": { "from": "2025-01-01T00:00:00Z" }
  },
  "topK": 10,
  "offset": 0,
  "strategy": "hybrid",
  "includeContent": true,
  "developerId": "dev-123",
  "organizationId": "org-456"
}
```

**Response:**
```json
{
  "results": [
    {
      "id": "chunk-uuid",
      "type": "chunk",
      "title": "Lambda timeout due to VPC DNS resolution",
      "summary": "Problem: Lambda times out... → Solution: Move to public subnet or use VPC endpoints",
      "content": "...",
      "finalScore": 0.96,
      "scores": {
        "semantic": 0.94,
        "keyword": 0.88,
        "freshness": 0.85,
        "repositoryMatch": 1.0,
        "authorReputation": 0.7,
        "usageCount": 0.6,
        "qualityScore": 0.9
      },
      "scoreExplanation": {
        "primary_factor": "semantic_similarity (0.94)",
        "boosted_by": ["same_repository", "high_usage_count"],
        "penalized_by": []
      },
      "repository": "org/lambda-service",
      "language": "python",
      "frameworks": ["aws-lambda"],
      "citations": [
        { "type": "conversation", "reference": "Session abc-123" },
        { "type": "commit", "reference": "def456" }
      ],
      "codeSnippets": [
        { "language": "python", "code": "import boto3\n...", "filePath": "handler.py" }
      ],
      "createdAt": "2025-06-15T14:30:00Z"
    }
  ],
  "totalCount": 12,
  "query": "Lambda timeout VPC DNS",
  "strategy": "hybrid",
  "latencyMs": 142,
  "cached": false,
  "estimatedTokens": 2400,
  "relatedQueries": ["Lambda cold start optimization", "VPC endpoint configuration"]
}
```

#### `GET /api/v1/chunks/:chunkId/similar`

Find chunks similar to a given chunk.

**Query params:** `limit` (default: 5)

---

### Facts (v3 — Atomic Memory)

#### `GET /api/v1/facts`

Query atomic facts with entity and temporal filtering.

**Query params:**
| Param | Description |
|-------|-------------|
| `entities` | Comma-separated entity names to match (e.g. `Lambda,VPC`) |
| `types` | Fact types to filter (e.g. `decision,lesson`) |
| `from` / `to` | Temporal range (ISO datetime) |
| `onlyValid` | `true` = exclude superseded facts (default: true) |
| `repository` | Filter by repository |
| `limit` | Max results (default: 20) |

**Example:** `GET /api/v1/facts?entities=Kafka,Redis&types=decision&onlyValid=true`

**Response:**
```json
{
  "facts": [
    {
      "id": "uuid",
      "content": "Team uses Kafka for event streaming between auth and billing services",
      "type": "decision",
      "entities": ["Kafka", "auth", "billing"],
      "confidence": 0.92,
      "temporal": {
        "observedAt": "2025-06-15T10:00:00Z",
        "validFrom": "2025-06-15T10:00:00Z",
        "validUntil": null,
        "supersededBy": null
      },
      "source": { "chunkId": "uuid", "sessionId": "uuid" },
      "repository": "org/platform",
      "usageCount": 14,
      "createdAt": "2025-06-15T10:05:00Z"
    }
  ],
  "total": 3
}
```

#### `GET /api/v1/facts/:entity/history`

Get the temporal evolution of facts about an entity.

**Example:** `GET /api/v1/facts/Kafka/history`

**Response:**
```json
{
  "entity": "Kafka",
  "history": [
    {
      "id": "fact-1",
      "content": "Team evaluated RabbitMQ vs Kafka, chose RabbitMQ for simplicity",
      "type": "decision",
      "temporal": { "validFrom": "2024-11-01", "validUntil": "2025-03-15", "supersededBy": "fact-2" }
    },
    {
      "id": "fact-2",
      "content": "Team migrated from RabbitMQ to Kafka for better throughput at scale",
      "type": "decision",
      "temporal": { "validFrom": "2025-03-15", "validUntil": null, "supersedes": "fact-1" }
    }
  ]
}
```

This enables temporal reasoning: "When did we switch?" "What was the old approach?"

---

### Reflect (v3 — Learning Loop)

The Reflect API goes beyond retrieval: it retrieves memories, reasons over them with an LLM, and returns a synthesized answer. As a side-effect, high-confidence answers write learned insights back into memory (the learning loop).

#### `POST /api/v1/reflect`

Reflect on a query — retrieve memories, reason over them, produce a synthesized answer.

**Request:**
```json
{
  "query": "Why did we switch from RabbitMQ to Kafka?",
  "entityFocus": "Kafka",
  "context": {
    "repository": "org/event-platform",
    "language": "typescript"
  },
  "filters": {
    "repositories": ["org/event-platform"],
    "types": ["decision", "lesson"]
  },
  "maxTokens": 6000,
  "maxSources": 10,
  "generateObservation": true,
  "writeBack": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `query` | string (required) | The question or topic to reflect on |
| `entityFocus` | string | Focus the reflection on a specific entity |
| `temporalContext` | object | `{ from, to }` — restrict to a time range |
| `context` | object | Repository, file, language context for retrieval |
| `filters` | object | Repository, language, type, team filters |
| `maxTokens` | number | Token budget for LLM context (default: 6000) |
| `maxSources` | number | Max source items to retrieve (default: 10) |
| `generateObservation` | boolean | Generate/update entity observation as side-effect (default: true) |
| `writeBack` | boolean | Write learned insights back to memory (default: true) |

**Response:**
```json
{
  "reflectId": "uuid",
  "query": "Why did we switch from RabbitMQ to Kafka?",
  "answer": "The team switched from RabbitMQ to Kafka in March 2025 due to throughput limitations at scale. The event platform was processing 50K events/sec and RabbitMQ's single-queue model became a bottleneck [Source 1]. Kafka's partition-based architecture allowed horizontal scaling across 12 consumer groups [Source 2]. The migration took 3 weeks with zero downtime using a dual-write strategy [Source 4].",
  "confidence": "high",
  "reasoning": "Multiple sources consistently describe the migration timeline and rationale with specific details.",
  "sources": [
    {
      "sourceIndex": 1,
      "type": "fact",
      "id": "fact-uuid-1",
      "content": "Team migrated from RabbitMQ to Kafka for better throughput at scale",
      "factType": "decision",
      "confidence": 0.92,
      "entities": ["Kafka", "RabbitMQ"],
      "createdAt": "2025-03-15T10:00:00Z"
    },
    {
      "sourceIndex": 2,
      "type": "chunk",
      "id": "chunk-uuid-1",
      "title": "Kafka migration planning session",
      "content": "Discussed partition strategy for 12 consumer groups...",
      "score": 0.91,
      "repository": "org/event-platform",
      "createdAt": "2025-03-10T14:00:00Z"
    }
  ],
  "observation": {
    "id": "obs-uuid",
    "entityName": "Kafka",
    "summary": "Kafka is the primary event streaming platform, adopted March 2025 replacing RabbitMQ. Used across 12 consumer groups handling 50K+ events/sec. Deployed on MSK with 6 brokers.",
    "sourceFactCount": 8,
    "updatedAt": "2025-07-27T10:00:00Z"
  },
  "learnedInsights": [
    {
      "id": "insight-uuid",
      "content": "Dual-write strategy is the preferred approach for message broker migrations to achieve zero downtime",
      "type": "pattern"
    }
  ],
  "retrievalLatencyMs": 95,
  "totalLatencyMs": 2340,
  "llmTokensUsed": {
    "input": 4200,
    "output": 380,
    "model": "claude-sonnet-4-20250514"
  }
}
```

**Learning Loop behavior:**
- When `confidence` is `"high"` and `writeBack` is `true`, the system extracts new insights from the answer and stores them as new facts
- These insights influence future retrieval (they get embedded and indexed)
- Contributing source facts get their `usageCount` incremented (ranking boost)
- If `entityFocus` is set, the entity's observation is regenerated

---

### Observations (Mental Models)

Pre-computed entity summaries that cache what the system knows about key entities.

#### `GET /api/v1/observations/:entity`

Get the pre-computed observation for a specific entity.

**Example:** `GET /api/v1/observations/Kafka`

**Response:**
```json
{
  "observation": {
    "id": "obs-uuid",
    "entityName": "Kafka",
    "organizationId": "org-456",
    "summary": "Kafka is the primary event streaming platform, adopted March 2025 replacing RabbitMQ. Used across 12 consumer groups handling 50K+ events/sec.",
    "sourceFactIds": ["fact-1", "fact-2"],
    "sourceFactCount": 8,
    "createdAt": "2025-06-01T10:00:00Z",
    "updatedAt": "2025-07-27T10:00:00Z"
  }
}
```

#### `GET /api/v1/observations`

List observations. **Query params:** `entities` (comma-separated, e.g. `?entities=Kafka,Lambda,Redis`)

---

### Learning Loop Metrics

#### `GET /api/v1/stats/learning`

Get learning loop health and metrics for the organization.

**Response:**
```json
{
  "metrics": {
    "period": { "from": "2025-07-20T00:00:00Z", "to": "2025-07-27T00:00:00Z" },
    "inline": {
      "factsExtracted": 1240,
      "opinionsReinforced": 34,
      "opinionsWeakened": 8,
      "opinionsContradicted": 2,
      "observationsTriggered": 156
    },
    "reflect": {
      "reflectCalls": 89,
      "highConfidenceAnswers": 52,
      "insightsWrittenBack": 31,
      "sourcesBosted": 420
    },
    "health": {
      "isLearning": true,
      "confidenceTrend": 0.74,
      "observationCoverage": 0.42
    }
  },
  "health": { "healthy": true, "reasons": [] },
  "config": {
    "inlineReinforcementEnabled": true,
    "reflectWriteBackEnabled": true,
    "sourceBoostEnabled": true,
    "writeBackMinConfidence": "high",
    "maxInsightsPerReflect": 3,
    "observationRefreshDelay": 30
  }
}
```

#### `POST /api/v1/stats/learning/trigger`

Manually trigger a full learning cycle (opinion reinforcement + observation refresh + discovery).

**Response:**
```json
{
  "triggered": true,
  "result": {
    "opinionsReinforced": 5,
    "observationsRefreshed": 3,
    "observationsDiscovered": 7
  }
}
```

---

### Feedback

#### `POST /api/v1/feedback`

Record a feedback event for ranking improvement.

**Request:**
```json
{
  "searchId": "search-uuid",
  "resultId": "chunk-uuid",
  "developerId": "dev-123",
  "action": "thumbs_up",
  "comment": "This solved my issue exactly",
  "conversationSuccessful": true
}
```

Actions: `shown`, `clicked`, `copied`, `used`, `thumbs_up`, `thumbs_down`, `reported`, `dismissed`

#### `POST /api/v1/feedback/batch`

Submit up to 100 feedback events at once (for plugins that batch interactions).

---

### Health

#### `GET /health`
```json
{ "status": "healthy", "timestamp": "...", "version": "0.1.0" }
```

#### `GET /health/ready`
```json
{
  "status": "ready",
  "checks": { "database": "ok", "redis": "ok", "objectStorage": "ok" }
}
```

---

## Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| Per developer | 100 requests | 60 seconds |
| Global | 50,000 requests | 60 seconds |
| Upload payload | 10 MB max | — |
| Batch upload | 50 sessions max | — |
| Batch feedback | 100 events max | — |

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1721900000
```

---

## Error Responses

All errors follow this format:
```json
{
  "error": "VALIDATION_ERROR",
  "message": "Human-readable description",
  "details": [...],
  "requestId": "uuid"
}
```

Error codes: `VALIDATION_ERROR`, `AUTH_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL_ERROR`, `SEARCH_ERROR`

---

## SDK / Plugin Integration

IDE plugins should implement two background behaviors:

**1. Passive Capture (always-on, no user action):**
```
AI conversation ends in IDE
  → Plugin calls POST /api/v1/capture/passive with messages + git context
  → Server returns 202 (session captured)
  → Developer sees nothing — zero friction
```

**2. Context Retrieval (before every AI prompt):**
```
Developer asks question in IDE
  → Plugin calls POST /api/v1/context with query + current file/repo
  → Receives ranked facts + chunks (avg 1500 tokens)
  → Injects as system context into AI prompt
  → AI answers using org knowledge (accurate, no hallucination)
  → Plugin reports feedback POST /api/v1/feedback (was it useful?)
```

**3. Active Save (optional, developer-triggered):**
```
Developer clicks "Save to Knowledge Base" or "This was useful"
  → Plugin calls POST /api/v1/capture/active with full session + tags
  → Session promoted to Tier 2 deep processing
  → Structured knowledge extracted, graph updated
```

**4. Ambient Capture (optional daemon):**
```
Terminal daemon detects error output / interesting commands
  → Sends POST /api/v1/capture/event with terminal content
  → Indexed for future retrieval ("I saw this error before...")
```

**5. Reflect (deep understanding queries):**
```
Developer asks a "why?" or "what should I know?" question
  → Plugin calls POST /api/v1/reflect with query + entity focus
  → System retrieves memories, reasons with LLM, produces synthesis
  → Returns answer + sources + confidence
  → If high-confidence: insights written back → system gets smarter
  → Observation updated (entity summary cached for future queries)
```
