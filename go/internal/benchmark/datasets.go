package benchmark

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

// GenerateLongMemEvalDataset creates a synthetic LongMemEval-style dataset for
// evaluating long-term memory retrieval. Modeled after the academic LongMemEval
// benchmark categories: single-session, cross-session, and temporal queries.
func GenerateLongMemEvalDataset() *Dataset {
	baseTime := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)

	samples := []Sample{
		// ─── Single-Session Retrieval ────────────────────────────────────
		{
			ID:       "lme-001",
			Query:    "What database did the team decide to use for the event store?",
			Category: "single-session",
			Difficulty: "easy",
			GroundTruth: []string{"mem-001"},
			Context: []Memory{
				{ID: "mem-001", Content: "Decision: We will use PostgreSQL with a JSONB events table as the event store instead of EventStoreDB because the team already has PostgreSQL expertise and we want to minimize operational overhead.", Timestamp: baseTime, Source: "ide-session", Entities: []string{"PostgreSQL", "EventStoreDB", "event-store"}, Type: "decision"},
				{ID: "mem-002", Content: "The API gateway will use rate limiting with a token bucket algorithm at 100 requests per minute per user.", Timestamp: baseTime.Add(10 * time.Minute), Source: "ide-session", Entities: []string{"API-gateway", "rate-limiting"}, Type: "constraint"},
				{ID: "mem-003", Content: "We discussed using Redis for caching but decided it adds unnecessary complexity for our current scale.", Timestamp: baseTime.Add(20 * time.Minute), Source: "ide-session", Entities: []string{"Redis", "caching"}, Type: "decision"},
			},
		},
		{
			ID:       "lme-002",
			Query:    "What pattern should we use for handling retries in the message queue consumer?",
			Category: "single-session",
			Difficulty: "medium",
			GroundTruth: []string{"mem-004"},
			Context: []Memory{
				{ID: "mem-004", Content: "Pattern: Message queue consumers should use exponential backoff with jitter for retries. Start at 1 second, double each attempt, cap at 60 seconds, add random jitter of 0-500ms. After 5 failed attempts, route to dead letter queue.", Timestamp: baseTime.Add(1 * time.Hour), Source: "ide-session", Entities: []string{"message-queue", "retry", "dead-letter-queue"}, Type: "pattern"},
				{ID: "mem-005", Content: "The notification service processes events from RabbitMQ and sends emails, push notifications, and SMS.", Timestamp: baseTime.Add(1*time.Hour + 15*time.Minute), Source: "ide-session", Entities: []string{"notification-service", "RabbitMQ"}, Type: "lesson"},
			},
		},
		{
			ID:       "lme-003",
			Query:    "What are the constraints on the user authentication token format?",
			Category: "single-session",
			Difficulty: "easy",
			GroundTruth: []string{"mem-006"},
			Context: []Memory{
				{ID: "mem-006", Content: "Constraint: Authentication tokens must be JWT with RS256 signing, contain user_id, org_id, and roles claims, expire in 15 minutes, and be refreshable via a separate HttpOnly cookie-based refresh token with 7-day TTL.", Timestamp: baseTime.Add(2 * time.Hour), Source: "ide-session", Entities: []string{"JWT", "authentication", "RS256"}, Type: "constraint"},
				{ID: "mem-007", Content: "We considered using opaque tokens but JWT allows the API gateway to validate tokens without a round-trip to the auth service.", Timestamp: baseTime.Add(2*time.Hour + 5*time.Minute), Source: "ide-session", Entities: []string{"JWT", "API-gateway", "auth-service"}, Type: "lesson"},
			},
		},

		// ─── Cross-Session Retrieval ─────────────────────────────────────
		{
			ID:       "lme-004",
			Query:    "What lessons have we learned about deploying to Kubernetes?",
			Category: "cross-session",
			Difficulty: "medium",
			GroundTruth: []string{"mem-010", "mem-011", "mem-012"},
			Context: []Memory{
				{ID: "mem-010", Content: "Lesson: Always set resource requests AND limits on Kubernetes pods. Without limits, a single runaway pod can OOM-kill the entire node. Without requests, the scheduler places pods suboptimally.", Timestamp: baseTime.Add(24 * time.Hour), Source: "ide-session", Entities: []string{"Kubernetes", "resource-limits", "OOM"}, Type: "lesson"},
				{ID: "mem-011", Content: "Lesson: Use PodDisruptionBudgets for all production services. We lost availability during a node drain because all replicas were on the same node and got evicted simultaneously.", Timestamp: baseTime.Add(48 * time.Hour), Source: "code-review", Entities: []string{"Kubernetes", "PodDisruptionBudget", "availability"}, Type: "lesson"},
				{ID: "mem-012", Content: "Lesson: Kubernetes liveness probes should not check downstream dependencies. If the database is down, restarting the app won't help—use readiness probes for dependency health instead.", Timestamp: baseTime.Add(72 * time.Hour), Source: "ide-session", Entities: []string{"Kubernetes", "liveness-probe", "readiness-probe"}, Type: "lesson"},
				{ID: "mem-013", Content: "We deploy using ArgoCD with automatic sync from the main branch. Rollbacks are done by reverting the git commit.", Timestamp: baseTime.Add(96 * time.Hour), Source: "ide-session", Entities: []string{"ArgoCD", "GitOps", "deployment"}, Type: "pattern"},
			},
		},
		{
			ID:       "lme-005",
			Query:    "What decisions were made about the microservice communication protocol?",
			Category: "cross-session",
			Difficulty: "hard",
			GroundTruth: []string{"mem-020", "mem-021"},
			Context: []Memory{
				{ID: "mem-020", Content: "Decision: Synchronous service-to-service communication will use gRPC with protobuf. REST is only for external-facing APIs. This gives us type safety, code generation, and 3-5x better throughput than JSON/HTTP.", Timestamp: baseTime.Add(5 * 24 * time.Hour), Source: "ide-session", Entities: []string{"gRPC", "protobuf", "microservices"}, Type: "decision"},
				{ID: "mem-021", Content: "Decision: Asynchronous communication uses NATS JetStream for event-driven patterns. We chose NATS over Kafka because our message volume is moderate (<10K/sec) and NATS has simpler operations.", Timestamp: baseTime.Add(7 * 24 * time.Hour), Source: "ide-session", Entities: []string{"NATS", "Kafka", "event-driven", "microservices"}, Type: "decision"},
				{ID: "mem-022", Content: "The payment service handles Stripe webhook callbacks and publishes payment.completed events to NATS.", Timestamp: baseTime.Add(8 * 24 * time.Hour), Source: "ide-session", Entities: []string{"payment-service", "Stripe", "NATS"}, Type: "lesson"},
			},
		},
		{
			ID:       "lme-006",
			Query:    "How do we handle database schema migrations across multiple services?",
			Category: "cross-session",
			Difficulty: "hard",
			GroundTruth: []string{"mem-030", "mem-031"},
			Context: []Memory{
				{ID: "mem-030", Content: "Pattern: Each service owns its database schema. Migrations are embedded in the service binary with checksums and run at startup with advisory locking to prevent concurrent migration attempts.", Timestamp: baseTime.Add(10 * 24 * time.Hour), Source: "ide-session", Entities: []string{"database-migrations", "advisory-lock", "microservices"}, Type: "pattern"},
				{ID: "mem-031", Content: "Constraint: Schema migrations must be forward-only and backward-compatible for at least one release cycle. This means: add columns as nullable, never rename, never drop until the next major version.", Timestamp: baseTime.Add(12 * 24 * time.Hour), Source: "code-review", Entities: []string{"database-migrations", "backward-compatibility"}, Type: "constraint"},
				{ID: "mem-032", Content: "We use golang-migrate for schema management with SQL files versioned in the service repository.", Timestamp: baseTime.Add(13 * 24 * time.Hour), Source: "ide-session", Entities: []string{"golang-migrate", "database-migrations"}, Type: "lesson"},
			},
		},

		// ─── Temporal Queries ─────────────────────────────────────────────
		{
			ID:       "lme-007",
			Query:    "What was our caching strategy before we switched to Redis?",
			Category: "temporal",
			Difficulty: "hard",
			GroundTruth: []string{"mem-040"},
			Context: []Memory{
				{ID: "mem-040", Content: "Decision: We will use in-process LRU caches with a 5-minute TTL for frequently accessed configuration data. Each service instance maintains its own cache, accepting the trade-off of brief inconsistency windows.", Timestamp: baseTime.Add(3 * 24 * time.Hour), Source: "ide-session", Entities: []string{"LRU-cache", "caching"}, Type: "decision"},
				{ID: "mem-041", Content: "Decision: We are adopting Redis as a shared cache layer for session state and frequently accessed user profiles. The in-process LRU is replaced because we need cache consistency across multiple service replicas.", Timestamp: baseTime.Add(30 * 24 * time.Hour), Source: "ide-session", Entities: []string{"Redis", "caching", "session-state"}, Type: "decision"},
			},
		},
		{
			ID:       "lme-008",
			Query:    "What is the latest decision about the CI/CD pipeline?",
			Category: "temporal",
			Difficulty: "medium",
			GroundTruth: []string{"mem-051"},
			Context: []Memory{
				{ID: "mem-050", Content: "Decision: CI/CD will use GitHub Actions with self-hosted runners in our AWS VPC for security compliance.", Timestamp: baseTime.Add(14 * 24 * time.Hour), Source: "ide-session", Entities: []string{"GitHub-Actions", "CI-CD", "AWS"}, Type: "decision"},
				{ID: "mem-051", Content: "Decision: We are migrating from GitHub Actions to Buildkite because self-hosted runners have been unreliable and Buildkite gives better queue management and caching. Target completion: end of Q2.", Timestamp: baseTime.Add(45 * 24 * time.Hour), Source: "ide-session", Entities: []string{"Buildkite", "GitHub-Actions", "CI-CD"}, Type: "decision"},
			},
		},

		// ─── Entity-Specific Queries ─────────────────────────────────────
		{
			ID:       "lme-009",
			Query:    "Everything we know about the payment service architecture",
			Category: "entity-specific",
			Difficulty: "medium",
			GroundTruth: []string{"mem-060", "mem-061", "mem-062"},
			Context: []Memory{
				{ID: "mem-060", Content: "The payment service is a Go microservice that handles Stripe integration, subscription management, and invoice generation. It exposes gRPC endpoints for internal services and receives webhooks from Stripe.", Timestamp: baseTime.Add(20 * 24 * time.Hour), Source: "ide-session", Entities: []string{"payment-service", "Go", "Stripe", "gRPC"}, Type: "lesson"},
				{ID: "mem-061", Content: "Constraint: The payment service must maintain PCI DSS compliance. No raw card numbers are stored—only Stripe customer and payment method IDs. All payment-related logs must be in a separate audit stream.", Timestamp: baseTime.Add(21 * 24 * time.Hour), Source: "code-review", Entities: []string{"payment-service", "PCI-DSS", "Stripe"}, Type: "constraint"},
				{ID: "mem-062", Content: "Pattern: Payment idempotency is achieved via a client-provided idempotency_key stored in a dedupe table with a 24-hour TTL. Stripe's own idempotency keys are passed through for the actual charge.", Timestamp: baseTime.Add(22 * 24 * time.Hour), Source: "ide-session", Entities: []string{"payment-service", "idempotency", "Stripe"}, Type: "pattern"},
				{ID: "mem-063", Content: "The user service manages authentication, profiles, and team membership. It is the source of truth for user identity.", Timestamp: baseTime.Add(23 * 24 * time.Hour), Source: "ide-session", Entities: []string{"user-service", "authentication"}, Type: "lesson"},
			},
		},
		{
			ID:       "lme-010",
			Query:    "What monitoring and observability tools do we use?",
			Category: "entity-specific",
			Difficulty: "easy",
			GroundTruth: []string{"mem-070", "mem-071"},
			Context: []Memory{
				{ID: "mem-070", Content: "Decision: Observability stack is Prometheus + Grafana for metrics, Loki for logs, and Tempo for distributed tracing. All deployed via the kube-prometheus-stack Helm chart.", Timestamp: baseTime.Add(15 * 24 * time.Hour), Source: "ide-session", Entities: []string{"Prometheus", "Grafana", "Loki", "Tempo", "observability"}, Type: "decision"},
				{ID: "mem-071", Content: "Lesson: Every service must expose a /metrics endpoint in OpenMetrics format with at minimum: request_count, request_latency_seconds (histogram), and error_count, all labeled by endpoint and status_code.", Timestamp: baseTime.Add(16 * 24 * time.Hour), Source: "code-review", Entities: []string{"Prometheus", "OpenMetrics", "observability"}, Type: "lesson"},
				{ID: "mem-072", Content: "We considered Datadog but the per-host pricing was prohibitive at our scale. Prometheus + Grafana gives us 90% of the functionality at a fraction of the cost.", Timestamp: baseTime.Add(15*24*time.Hour + 30*time.Minute), Source: "ide-session", Entities: []string{"Datadog", "Prometheus", "Grafana"}, Type: "lesson"},
			},
		},

		// ─── Complex Reasoning Queries ───────────────────────────────────
		{
			ID:       "lme-011",
			Query:    "What are all the constraints that affect how we deploy new services?",
			Category: "reasoning",
			Difficulty: "hard",
			GroundTruth: []string{"mem-080", "mem-081", "mem-082"},
			Context: []Memory{
				{ID: "mem-080", Content: "Constraint: All new services must pass a security review before production deployment. The review checks: dependency vulnerabilities, secret management, authentication enforcement, and data encryption at rest.", Timestamp: baseTime.Add(25 * 24 * time.Hour), Source: "ide-session", Entities: []string{"security-review", "deployment", "compliance"}, Type: "constraint"},
				{ID: "mem-081", Content: "Constraint: Services must achieve 80% code coverage in unit tests and have at least one integration test per API endpoint before they can be deployed to production.", Timestamp: baseTime.Add(26 * 24 * time.Hour), Source: "code-review", Entities: []string{"testing", "deployment", "code-coverage"}, Type: "constraint"},
				{ID: "mem-082", Content: "Constraint: New services require a runbook documenting: health check URLs, common failure modes, rollback procedures, and on-call escalation paths. The runbook is reviewed as part of the production readiness checklist.", Timestamp: baseTime.Add(27 * 24 * time.Hour), Source: "ide-session", Entities: []string{"runbook", "deployment", "on-call"}, Type: "constraint"},
				{ID: "mem-083", Content: "Lesson: We use feature flags via LaunchDarkly for gradual rollouts. New features are always behind a flag for at least one sprint before being fully enabled.", Timestamp: baseTime.Add(28 * 24 * time.Hour), Source: "ide-session", Entities: []string{"LaunchDarkly", "feature-flags", "deployment"}, Type: "lesson"},
			},
		},
		{
			ID:       "lme-012",
			Query:    "What problems have we had with our testing approach and how did we solve them?",
			Category: "reasoning",
			Difficulty: "hard",
			GroundTruth: []string{"mem-090", "mem-091"},
			Context: []Memory{
				{ID: "mem-090", Content: "Lesson: Integration tests that share a database without isolation caused flaky failures. Solution: each test gets its own schema created at test start and dropped at cleanup. This added 2 seconds per test but eliminated all flakiness.", Timestamp: baseTime.Add(35 * 24 * time.Hour), Source: "ide-session", Entities: []string{"integration-tests", "database", "flaky-tests"}, Type: "lesson"},
				{ID: "mem-091", Content: "Lesson: Mocking external services in unit tests was fragile—mocks drifted from real APIs. Solution: contract tests using Pact that verify our mocks match the actual provider behavior. Run weekly against staging.", Timestamp: baseTime.Add(40 * 24 * time.Hour), Source: "code-review", Entities: []string{"mocking", "contract-tests", "Pact"}, Type: "lesson"},
				{ID: "mem-092", Content: "We use testcontainers-go for spinning up PostgreSQL and Redis in integration tests.", Timestamp: baseTime.Add(42 * 24 * time.Hour), Source: "ide-session", Entities: []string{"testcontainers", "integration-tests", "PostgreSQL"}, Type: "lesson"},
			},
		},
	}

	// Assign unique IDs if not set
	for i := range samples {
		if samples[i].ID == "" {
			samples[i].ID = fmt.Sprintf("lme-%03d", i+1)
		}
	}

	return &Dataset{
		Name:        "LongMemEval-Synapse",
		Description: "Synthetic LongMemEval-style benchmark for engineering team memory retrieval. Tests single-session recall, cross-session aggregation, temporal awareness, entity-specific queries, and complex reasoning over stored knowledge.",
		Version:     "1.0.0",
		Samples:     samples,
		Metadata: DatasetMeta{
			TotalSamples: len(samples),
			AvgMemories:  3,
			TokenBudget:  3000,
			SourceURL:    "https://github.com/mihaibalaci/synapse/benchmarks",
		},
	}
}

// GenerateBEAMDataset creates a BEAM-style (Benchmark for Evaluating Agent Memory)
// dataset focused on large-scale memory retrieval with noise.
func GenerateBEAMDataset() *Dataset {
	baseTime := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)

	// Generate a larger dataset with more noise to test retrieval at scale
	var samples []Sample

	// Generate 50 samples with increasing noise levels
	topics := []struct {
		query       string
		relevant    []string
		noise       int
		category    string
		difficulty  string
	}{
		{"How should errors be propagated in our Go services?", []string{"beam-r-001"}, 20, "recall", "medium"},
		{"What logging library does the team use?", []string{"beam-r-002"}, 15, "recall", "easy"},
		{"Explain the circuit breaker pattern we implemented", []string{"beam-r-003", "beam-r-004"}, 25, "reasoning", "hard"},
		{"What are the team conventions for naming database tables?", []string{"beam-r-005"}, 10, "recall", "easy"},
		{"How did our approach to error handling change over time?", []string{"beam-r-006", "beam-r-007"}, 30, "temporal", "hard"},
	}

	for i, topic := range topics {
		// Build context: relevant memories + noise
		var context []Memory
		relevantMemories := map[string]string{
			"beam-r-001": "Pattern: Go services wrap errors with fmt.Errorf and %w verb for unwrapping. Domain errors implement a custom AppError interface with Code(), Message(), and HTTPStatus() methods. Never log and return—either handle the error or propagate it.",
			"beam-r-002": "Decision: All Go services use slog (structured logging) from the standard library. Log levels: debug for development, info for request lifecycle, warn for recoverable errors, error for unrecoverable failures requiring action.",
			"beam-r-003": "Pattern: Circuit breaker implemented with three states: closed (normal), open (failing, reject immediately), half-open (allow one probe request). Thresholds: open after 5 consecutive failures, half-open after 30 seconds, close after 3 successful probes.",
			"beam-r-004": "Lesson: The circuit breaker for the recommendation service prevented a cascading failure when their API had a 30-second timeout bug. Without it, our thread pool would have been exhausted within 2 minutes.",
			"beam-r-005": "Constraint: Database tables use snake_case, plural nouns (e.g. user_accounts, payment_transactions). Foreign keys follow the pattern: referenced_table_singular_id (e.g. user_account_id). Indexes are named: idx_tablename_columns.",
			"beam-r-006": "Decision (January): Use panic/recover for truly unrecoverable errors and return error values for everything else. Avoid sentinel errors; prefer typed errors.",
			"beam-r-007": "Decision (March): After production incidents caused by unchecked errors, we adopted errcheck linter and made it a CI gate. Also added a custom must() helper for init-time panics only.",
		}

		for id := range relevantMemories {
			found := false
			for _, rel := range topic.relevant {
				if rel == id {
					found = true
					break
				}
			}
			if found {
				context = append(context, Memory{
					ID:        id,
					Content:   relevantMemories[id],
					Timestamp: baseTime.Add(time.Duration(i*24) * time.Hour),
					Source:    "ide-session",
					Type:      "pattern",
				})
			}
		}

		// Add noise memories
		for j := 0; j < topic.noise; j++ {
			noiseID := fmt.Sprintf("beam-noise-%03d-%03d", i, j)
			context = append(context, Memory{
				ID:        noiseID,
				Content:   generateNoiseMemory(j),
				Timestamp: baseTime.Add(time.Duration((i*24)+j) * time.Hour),
				Source:    "ide-session",
				Type:      "lesson",
			})
		}

		samples = append(samples, Sample{
			ID:          fmt.Sprintf("beam-%03d", i+1),
			Query:       topic.query,
			GroundTruth: topic.relevant,
			Context:     context,
			Category:    topic.category,
			Difficulty:  topic.difficulty,
		})
	}

	return &Dataset{
		Name:        "BEAM-Synapse",
		Description: "BEAM-style benchmark testing retrieval quality at scale with noise. Evaluates the system's ability to find relevant memories among many irrelevant ones.",
		Version:     "1.0.0",
		Samples:     samples,
		Metadata: DatasetMeta{
			TotalSamples: len(samples),
			AvgMemories:  20,
			TokenBudget:  5000,
			SourceURL:    "https://github.com/mihaibalaci/synapse/benchmarks",
		},
	}
}

// generateNoiseMemory creates plausible but irrelevant memory content.
func generateNoiseMemory(seed int) string {
	noises := []string{
		"The frontend team uses React 18 with TypeScript and Tailwind CSS for all new UI components.",
		"Sprint retrospective: we need to improve PR review turnaround time from 48 hours to 24 hours.",
		"The design system uses a 8px grid with 4px half-steps for fine adjustments.",
		"Marketing requested analytics events for the new onboarding flow: signup_started, email_verified, profile_completed.",
		"The mobile app uses Flutter for cross-platform development with platform-specific plugins for biometrics.",
		"QA found that the search autocomplete breaks on special characters. Filed as JIRA-4521.",
		"DevOps is migrating from Terraform 0.14 to OpenTofu 1.6 for licensing reasons.",
		"The team agreed to adopt conventional commits format for all repositories.",
		"Database backup retention policy: daily for 7 days, weekly for 4 weeks, monthly for 12 months.",
		"Load testing revealed the checkout flow handles 500 concurrent users before response times exceed 2 seconds.",
		"We use Vault for secret management with auto-rotation every 90 days for database credentials.",
		"The API versioning strategy uses URL path prefixes: /v1/, /v2/. No sunset date for v1 until v3 launches.",
		"CDN configuration: CloudFront with 24-hour cache for static assets, 5-minute cache for API responses with vary headers.",
		"The team standup is at 9:30 AM EST, async updates in Slack for remote team members.",
		"Code review standards: at least one approval required, no self-merges, squash merge to main.",
		"The staging environment mirrors production at 1/4 scale with synthetic data refreshed weekly.",
		"Incident response: P1 incidents require war room within 15 minutes, P2 within 1 hour.",
		"We use Renovate for automated dependency updates with auto-merge for patch versions only.",
		"The notification preferences are stored in a separate preferences service with eventual consistency to the user profile.",
		"Performance budget: LCP < 2.5s, FID < 100ms, CLS < 0.1 for all user-facing pages.",
		"The data team uses dbt for SQL transformations and Airflow for orchestration.",
		"Feature flag naming convention: team_feature_description (e.g., payments_stripe_3ds_v2).",
		"API documentation uses OpenAPI 3.1 spec auto-generated from code annotations.",
		"The search service uses Elasticsearch 8 with custom analyzers for multi-language support.",
		"Team onboarding checklist includes: dev environment setup, security training, architecture walkthrough, buddy pairing.",
		"We maintain a tech radar updated quarterly: adopt, trial, assess, hold categories.",
		"The event bus uses at-least-once delivery semantics. Consumers must be idempotent.",
		"Database connection pooling uses PgBouncer in transaction mode with max 100 connections per service.",
		"The deploy pipeline runs: lint → test → build → security scan → deploy staging → smoke test → deploy prod.",
		"Error tracking uses Sentry with custom breadcrumbs for user action replay.",
	}

	return noises[seed%len(noises)]
}

// GenerateLoCoMoDataset creates a LoCoMo-style (Long Context Memory) dataset.
func GenerateLoCoMoDataset() *Dataset {
	baseTime := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)

	samples := []Sample{
		{
			ID:          "locomo-001",
			Query:       "What was discussed in the architecture review last month?",
			Category:    "long-context",
			Difficulty:  "hard",
			GroundTruth: []string{uuid.New().String()},
			Context:     generateLongConversation(baseTime, 50),
		},
		{
			ID:          "locomo-002",
			Query:       "What did Alex suggest about the caching layer?",
			Category:    "attribution",
			Difficulty:  "medium",
			GroundTruth: []string{uuid.New().String()},
			Context:     generateLongConversation(baseTime.Add(24*time.Hour), 30),
		},
		{
			ID:          "locomo-003",
			Query:       "Summarize all the performance optimization decisions",
			Category:    "aggregation",
			Difficulty:  "hard",
			GroundTruth: []string{uuid.New().String()},
			Context:     generateLongConversation(baseTime.Add(48*time.Hour), 40),
		},
	}

	return &Dataset{
		Name:        "LoCoMo-Synapse",
		Description: "LoCoMo-style benchmark for long-context memory retrieval over extended conversation histories.",
		Version:     "1.0.0",
		Samples:     samples,
		Metadata: DatasetMeta{
			TotalSamples: len(samples),
			AvgMemories:  40,
			TokenBudget:  8000,
			SourceURL:    "https://github.com/mihaibalaci/synapse/benchmarks",
		},
	}
}

func generateLongConversation(start time.Time, count int) []Memory {
	memories := make([]Memory, count)
	for i := range memories {
		memories[i] = Memory{
			ID:        uuid.New().String(),
			Content:   generateNoiseMemory(i),
			Timestamp: start.Add(time.Duration(i*15) * time.Minute),
			Source:    "ide-session",
		}
	}
	return memories
}
