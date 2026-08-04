// Package api defines the HTTP router and all API endpoints.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/config"
	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/middleware"
	"github.com/mihaibalaci/synapse/internal/models"
	"github.com/mihaibalaci/synapse/internal/retrieval"
	"github.com/mihaibalaci/synapse/internal/storage"
	"github.com/mihaibalaci/synapse/internal/version"
)

type appContextKey struct{}

// NewRouter creates the main HTTP router with all middleware and routes.
func NewRouter(cfg *config.Config, app *App) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), appContextKey{}, app)))
		})
	})

	// Global middleware
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(middleware.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))

	// CORS (allow IDE plugins from any origin)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Content-Type", "Authorization", "X-Request-ID"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	// Health checks (no auth required)
	r.Get("/health", handleHealth)
	r.Get("/health/ready", handleHealthReady(app))
	r.Get("/metrics", handlePrometheusMetrics)

	// Browser authentication uses a short-lived access token and a rotating,
	// HttpOnly refresh cookie. Login is independently throttled because it is
	// intentionally outside bearer-token middleware.
	loginAttempts := newLoginLimiter(5, time.Minute)
	r.Post("/api/v1/auth/login", handleAuthLogin(app, loginAttempts))
	r.Post("/api/v1/auth/refresh", handleAuthRefresh(app))
	r.Post("/api/v1/auth/logout", handleAuthLogout(app))
	r.Get("/api/v1/auth/oidc/login", handleOIDCLogin(app))
	r.Get("/api/v1/auth/oidc/callback", handleOIDCCallback(app))
	r.Post("/api/v1/auth/accept-invite", handleAcceptInvite)
	r.Post("/api/v1/auth/password-reset/request", handleRequestPasswordReset)
	r.Post("/api/v1/auth/password-reset/execute", handleExecutePasswordReset)

	// Authenticated routes
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience))

		rateLimiter := middleware.NewRateLimiter(cfg.RateLimitMax, cfg.RateLimitWindow)
		r.Use(rateLimiter.Middleware)

		r.Get("/api/v1/auth/me", handleAuthMe)

		// Capture endpoints
		r.Post("/api/v1/capture/passive", CapturePassiveHandler(app))
		r.Post("/api/v1/capture/active", CaptureActiveHandler(app))
		r.Post("/api/v1/capture/event", handleCaptureEvent)
		r.Post("/api/v1/capture/events", handleCaptureEvents)
		r.Post("/api/v1/capture/git", handleGitCapture)

		// Retrieval endpoints
		r.Post("/api/v1/search", handleSearch)
		r.Post("/api/v1/context", handleGetContext)
		r.Get("/api/v1/chunks/{chunkId}/similar", handleSimilar)

		// Facts endpoints
		r.Get("/api/v1/facts", handleGetFacts)
		r.Post("/api/v1/facts", handleCreateFact)
		r.Get("/api/v1/facts/{entity}/history", handleGetFactHistory)

		// Reflect endpoint (learning loop)
		r.Post("/api/v1/reflect", handleReflectReal)

		// Observations
		r.Get("/api/v1/observations", handleListObservations)
		r.Get("/api/v1/observations/{entity}", handleGetObservation)

		// Feedback
		r.Post("/api/v1/feedback", handleFeedback)
		r.Post("/api/v1/feedback/batch", handleFeedbackBatch)

		// Sessions (legacy)
		r.Post("/api/v1/sessions", handleSessionUpload)
		r.Post("/api/v1/sessions/batch", handleSessionBatch)
		r.Get("/api/v1/sessions/{sessionId}/status", handleSessionStatus)

		// Stats & Admin
		r.Get("/api/v1/stats", handleStats)
		r.Get("/api/v1/stats/learning", handleLearningStats)
		r.Post("/api/v1/stats/learning/trigger", handleLearningTrigger)
		r.Get("/api/v1/stats/trending", handleTrending)
		r.Get("/api/v1/stats/metrics", handleMetrics)

		// Admin routes require an explicit admin role in addition to a valid JWT.
		r.Route("/api/v1/admin", func(r chi.Router) {
			r.Use(auth.RequireRole("admin"))
			r.Get("/users", handleListUsers)
			r.Post("/users", handleCreateUser)
			r.Put("/users/{id}", handleUpdateUser)
			r.Delete("/users/{id}", handleDeleteUser)
			r.Get("/roles", handleListRoles)
			r.Get("/settings/llm", handleGetLLMSettings)
			r.Put("/settings/llm", handlePutLLMSettings)
			r.Post("/settings/llm/test", handleTestLLMSettings)
			r.Get("/settings/llm/models", handleListLLMModels)

			// Memory browser
			r.Get("/chunks", handleBrowseChunks)
			r.Get("/chunks/{id}", handleGetChunk)
			r.Put("/chunks/{id}", handleUpdateChunk)
			r.Delete("/chunks/{id}", handleDeleteChunk)
			r.Get("/facts", handleBrowseFacts)
			r.Delete("/facts/{id}", handleDeleteFact)

			// Graph reasoning
			r.Get("/graph/entity/{entity}", handleGraphEntity)
			r.Get("/graph/path", handleGraphPath)
			r.Get("/graph/important", handleGraphImportant)

			// Invitations
			r.Post("/invite", handleInviteUser)
			r.Post("/reset-password", handleAdminResetPassword)

			// Operations
			r.Get("/queues", handleQueueStatus)
			r.Get("/dead-letters", handleDeadLetterList)
			r.Post("/dead-letters/retry", handleDeadLetterRetry)
			r.Get("/jobs", handleJobHistory)
			r.Get("/backup-status", handleBackupStatus)
			r.Get("/audit", handleAuditLog)
			r.Get("/webhooks", handleListWebhooks)
			r.Post("/webhooks", handleCreateWebhook)
			r.Delete("/webhooks/{id}", handleDeleteWebhook)

			// Organizations & Teams
			r.Get("/organizations", handleListOrganizations)
			r.Post("/organizations", handleCreateOrganization)
			r.Get("/teams", handleListTeams)
			r.Post("/teams", handleCreateTeam)
			r.Delete("/teams/{id}", handleDeleteTeam)
			r.Get("/teams/{id}/members", handleListTeamMembers)
			r.Post("/teams/{id}/members", handleAddTeamMember)
			r.Delete("/teams/{id}/members/{userId}", handleRemoveTeamMember)
		})

		// Self-service API keys (any authenticated user)
		r.Get("/api/v1/keys", handleListAPIKeys)
		r.Post("/api/v1/keys", handleCreateAPIKey)
		r.Delete("/api/v1/keys/{id}", handleRevokeAPIKey)

		// Cross-agent shared context
		r.Put("/api/v1/context/shared", handlePutSharedContext)
		r.Get("/api/v1/context/shared", handleGetSharedContext)

		// Session outcome tracking
		r.Post("/api/v1/sessions/{sessionId}/outcome", handleMarkSessionOutcome)

		// Token cost attribution (admin)
		r.Get("/api/v1/stats/token-costs", handleTokenCosts)
		r.Get("/api/v1/admin/learn", handleLearnFromFailures)
	})

	return r
}

// ─── Health Endpoints ────────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "healthy",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"version":   version.Version,
	})
}

func handleHealthReady(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		checks := app.Healthy(r.Context())
		allOK := true
		for _, status := range checks {
			if status != "ok" {
				allOK = false
				break
			}
		}

		status := "ready"
		httpStatus := http.StatusOK
		if !allOK {
			status = "not_ready"
			httpStatus = http.StatusServiceUnavailable
		}

		writeJSON(w, httpStatus, map[string]any{
			"status": status,
			"checks": checks,
		})
	}
}

// ─── Stub Handlers (to be implemented in phases 2-4) ─────────────────────────

func handleCapturePassive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "captured", "mode": "passive"})
}

func handleCaptureActive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "captured", "mode": "active"})
}

func handleCaptureEvent(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusCreated, map[string]any{"captured": true})
}

func handleCaptureEvents(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusCreated, map[string]any{"captured": true, "count": 0})
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "missing claims")
		return
	}

	var req models.SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}
	if req.Query == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "query is required")
		return
	}

	// Track in-flight concurrency for the metrics panel.
	n := atomic.AddInt64(&inFlightSearches, 1)
	RecordConcurrent(n)
	defer func() {
		RecordConcurrent(atomic.AddInt64(&inFlightSearches, -1))
	}()

	start := time.Now()
	engine := retrieval.NewEngine(
		appFromRequest(r).DB, appFromRequest(r).Cache, appFromRequest(r).Chunks, appFromRequest(r).Facts,
		appFromRequest(r).Embedder,
	)

	resp, err := engine.Search(r.Context(), &req, claims)
	if err != nil {
		RecordError("retrieval")
		writeError(w, http.StatusInternalServerError, "SEARCH_ERROR", err.Error())
		return
	}

	RecordQuery(time.Since(start).Microseconds())
	if resp.Cached {
		RecordCacheHit()
	} else {
		RecordCacheMiss()
	}

	writeJSON(w, http.StatusOK, resp)
}

// inFlightSearches counts concurrently executing search requests.
var inFlightSearches int64

// handleGetContext runs retrieval with a token budget, returning content
// suitable for injecting directly into an AI prompt.
func handleGetContext(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "missing claims")
		return
	}

	var req models.SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}
	if req.Query == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "query is required")
		return
	}
	if req.MaxTokens == 0 {
		req.MaxTokens = 3000
	}
	if req.TopK == 0 {
		req.TopK = 10
	}
	req.IncludeContent = true

	n := atomic.AddInt64(&inFlightSearches, 1)
	RecordConcurrent(n)
	defer func() { RecordConcurrent(atomic.AddInt64(&inFlightSearches, -1)) }()

	start := time.Now()
	engine := retrieval.NewEngine(
		appFromRequest(r).DB, appFromRequest(r).Cache, appFromRequest(r).Chunks, appFromRequest(r).Facts,
		appFromRequest(r).Embedder,
	)

	resp, err := engine.Search(r.Context(), &req, claims)
	if err != nil {
		RecordError("retrieval")
		writeError(w, http.StatusInternalServerError, "CONTEXT_ERROR", err.Error())
		return
	}

	RecordQuery(time.Since(start).Microseconds())
	if resp.Cached {
		RecordCacheHit()
	} else {
		RecordCacheMiss()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"context":         resp.Results,
		"totalResults":    resp.TotalCount,
		"returnedResults": len(resp.Results),
		"estimatedTokens": resp.EstimatedTokens,
		"maxTokens":       req.MaxTokens,
		"latencyMs":       resp.LatencyMs,
		"cached":          resp.Cached,
	})
}

func handleSimilar(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
}

// handleGetFacts returns atomic facts matching the requested entities.
// Query params: entities (comma separated), types (comma separated), limit.
func handleGetFacts(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "missing claims")
		return
	}

	entities := splitCSV(r.URL.Query().Get("entities"))
	limit := queryInt(r, "limit", 10)
	if limit < 1 || limit > 100 {
		limit = 10
	}

	// FindByEntities uses an array-overlap predicate, so an empty entity list
	// would never match. Fall back to the most recent facts in that case.
	var (
		facts []models.Fact
		err   error
	)
	if len(entities) == 0 {
		facts, err = appFromRequest(r).Facts.FindRecent(r.Context(), claims.OrganizationID, limit)
	} else {
		facts, err = appFromRequest(r).Facts.FindByEntities(r.Context(), entities, claims.OrganizationID, limit)
	}
	if err != nil {
		RecordError("storage")
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}

	// Optional filter by fact type.
	if types := splitCSV(r.URL.Query().Get("types")); len(types) > 0 {
		allowed := make(map[string]bool, len(types))
		for _, t := range types {
			allowed[t] = true
		}
		filtered := facts[:0]
		for _, f := range facts {
			if allowed[f.Type] {
				filtered = append(filtered, f)
			}
		}
		facts = filtered
	}

	if facts == nil {
		facts = []models.Fact{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"facts": facts, "total": len(facts)})
}

// handleGetFactHistory returns the temporal chain for an entity, including
// superseded facts, so callers can see how a decision evolved.
func handleGetFactHistory(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "missing claims")
		return
	}

	entity := chi.URLParam(r, "entity")
	if entity == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "entity is required")
		return
	}

	limit := queryInt(r, "limit", 50)
	if limit < 1 || limit > 200 {
		limit = 50
	}

	history, err := appFromRequest(r).Facts.GetHistory(r.Context(), entity, claims.OrganizationID, limit)
	if err != nil {
		RecordError("storage")
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	if history == nil {
		history = []models.Fact{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"entity":  entity,
		"history": history,
		"total":   len(history),
	})
}

// handleCreateFact stores a single atomic insight supplied by a developer or
// an AI agent via the MCP save_insight tool.
func handleCreateFact(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "missing claims")
		return
	}

	var req struct {
		Content    string   `json:"content"`
		Type       string   `json:"type"`
		Entities   []string `json:"entities"`
		Repository string   `json:"repository"`
		Confidence float64  `json:"confidence"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}
	if req.Content == "" || req.Type == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "content and type are required")
		return
	}
	if !validFactTypes[req.Type] {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR",
			"type must be one of: decision, lesson, pattern, constraint, opinion")
		return
	}
	if req.Confidence <= 0 || req.Confidence > 1 {
		req.Confidence = 0.9 // human/agent-asserted insights start high
	}
	if req.Entities == nil {
		req.Entities = []string{}
	}

	now := time.Now()
	fact := &models.Fact{
		Content:        req.Content,
		Type:           req.Type,
		Entities:       req.Entities,
		Confidence:     req.Confidence,
		ValidFrom:      &now,
		ExtractedFrom:  "explicit",
		AuthorID:       claims.UserID,
		OrganizationID: claims.OrganizationID,
		Scope:          "organization",
		Repository:     req.Repository,
		// memory_facts.frameworks is NOT NULL, so send an empty array
		// rather than a nil slice.
		Frameworks: []string{},
	}

	if err := appFromRequest(r).Facts.Create(r.Context(), fact); err != nil {
		RecordError("storage")
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	RecordFactExtracted()

	writeJSON(w, http.StatusCreated, map[string]any{"saved": true, "fact": fact})
}

var validFactTypes = map[string]bool{
	"decision": true, "lesson": true, "pattern": true,
	"constraint": true, "opinion": true,
}

func handleListObservations(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"observations": []any{}, "count": 0})
}

func handleGetObservation(w http.ResponseWriter, r *http.Request) {
	entity := chi.URLParam(r, "entity")
	http.Error(w, `{"error":"NOT_FOUND","message":"No observation for `+entity+`"}`, http.StatusNotFound)
}

func handleFeedback(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	var req struct {
		ResultID string `json:"resultId"`
		Score    int    `json:"score"`
		Query    string `json:"query"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusCreated, map[string]any{"received": true})
		return
	}

	app := appFromRequest(r)
	ctx := r.Context()

	// Update confidence/quality based on feedback
	if req.Score > 0 {
		ingestion.RecordPositiveFeedback(ctx, app.DB, req.ResultID)
	} else if req.Score < 0 {
		ingestion.RecordNegativeFeedback(ctx, app.DB, req.ResultID)
	}

	writeJSON(w, http.StatusCreated, map[string]any{"received": true, "applied": true})
}

func handleFeedbackBatch(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusCreated, map[string]any{"received": true, "count": 0})
}

func handleSessionUpload(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "uploaded"})
}

func handleSessionBatch(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "uploaded", "count": 0})
}

func handleSessionStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "sessionId")
	writeJSON(w, http.StatusOK, map[string]any{"sessionId": id, "status": "searchable"})
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	orgID := ""
	if claims != nil {
		orgID = claims.OrganizationID
	}

	// Query real counts from database
	ctx := r.Context()
	var sessions, chunks, facts, searchIdx, clusters, knowledge, graphNodes int

	row := appFromRequest(r).DB.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM sessions WHERE organization_id = $1),
		(SELECT count(*) FROM chunks WHERE organization_id = $1),
		(SELECT count(*) FROM memory_facts WHERE organization_id = $1),
		(SELECT count(*) FROM search_index_entries WHERE organization_id = $1 AND is_searchable),
		(SELECT count(*) FROM chunk_clusters WHERE organization_id = $1),
		(SELECT count(*) FROM knowledge_records WHERE organization_id = $1),
		(SELECT count(*) FROM graph_nodes WHERE organization_id = $1)
	`, orgID)
	row.Scan(&sessions, &chunks, &facts, &searchIdx, &clusters, &knowledge, &graphNodes)

	// Recent activity
	rows, _ := appFromRequest(r).DB.Query(ctx, `
		SELECT id, developer_id, organization_id, searchable_status, enrichment_status,
			total_tokens, created_at, updated_at
		FROM sessions WHERE organization_id = $1
		ORDER BY updated_at DESC LIMIT 20`, orgID)
	var activity []map[string]any
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var id, devID, org, searchStatus, enrichStatus string
			var tokens int
			var createdAt, updatedAt time.Time
			rows.Scan(&id, &devID, &org, &searchStatus, &enrichStatus, &tokens, &createdAt, &updatedAt)
			activity = append(activity, map[string]any{
				"id": id, "developerId": devID, "organizationId": org,
				"searchableStatus": searchStatus, "enrichmentStatus": enrichStatus,
				"totalTokens": tokens, "createdAt": createdAt.Format(time.RFC3339),
				"updatedAt": updatedAt.Format(time.RFC3339),
			})
		}
	}
	if activity == nil {
		activity = []map[string]any{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"organization": orgID,
		"timestamp":    time.Now().UTC().Format(time.RFC3339),
		"counts": map[string]int{
			"sessions": sessions, "chunks": chunks, "facts": facts,
			"searchableChunks": searchIdx, "clusters": clusters,
			"knowledgeRecords": knowledge, "graphNodes": graphNodes,
		},
		"processing":     map[string]int{"activeSessions": 0, "searchable": sessions, "blocked": 0, "failed": 0},
		"queues":         map[string]int{"total": 0},
		"recentActivity": activity,
	})
}

func handleLearningStats(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	orgID := ""
	if claims != nil {
		orgID = claims.OrganizationID
	}
	ctx := r.Context()
	app := appFromRequest(r)

	// Query real learning metrics from the database
	var factsTotal, facts7d, factsSuperseded, chunksCompacted int
	var avgConfidence float64

	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM memory_facts WHERE organization_id = $1`, orgID).Scan(&factsTotal)
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM memory_facts WHERE organization_id = $1 AND created_at > NOW() - interval '7 days'`, orgID).Scan(&facts7d)
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM memory_facts WHERE organization_id = $1 AND temporal_valid_until IS NOT NULL`, orgID).Scan(&factsSuperseded)
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM chunks WHERE organization_id = $1 AND type = 'summary'`, orgID).Scan(&chunksCompacted)
	_ = app.DB.QueryRow(ctx, `SELECT COALESCE(AVG(confidence), 0) FROM memory_facts WHERE organization_id = $1 AND temporal_valid_until IS NULL`, orgID).Scan(&avgConfidence)

	isLearning := facts7d > 0
	coverage := 0.0
	if factsTotal > 0 {
		coverage = float64(factsTotal-factsSuperseded) / float64(factsTotal)
	}

	now := time.Now()
	weekAgo := now.AddDate(0, 0, -7)

	writeJSON(w, http.StatusOK, map[string]any{
		"metrics": map[string]any{
			"period": map[string]string{
				"from": weekAgo.Format(time.RFC3339),
				"to":   now.Format(time.RFC3339),
			},
			"inline": map[string]int{
				"factsExtracted":     facts7d,
				"opinionsReinforced": factsSuperseded,
			},
			"reflect": map[string]int{
				"reflectCalls":        0,
				"insightsWrittenBack": chunksCompacted,
			},
			"health": map[string]any{
				"isLearning":          isLearning,
				"confidenceTrend":     avgConfidence,
				"observationCoverage": coverage,
			},
		},
		"health": map[string]any{"healthy": true, "reasons": []string{}},
		"config": map[string]any{"inlineReinforcementEnabled": true, "reflectWriteBackEnabled": true},
	})
}

func handleLearningTrigger(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"triggered": true,
		"result":    map[string]int{"opinionsReinforced": 0, "observationsRefreshed": 0, "observationsDiscovered": 0},
	})
}

func handleTrending(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	orgID := ""
	if claims != nil {
		orgID = claims.OrganizationID
	}
	ctx := r.Context()
	app := appFromRequest(r)

	// Trending = entities that appear most frequently in recent facts (last 7 days)
	rows, err := app.DB.Query(ctx, `
		SELECT entity, count(*) AS mentions, MAX(created_at) AS last_seen
		FROM (
			SELECT unnest(entities) AS entity, created_at
			FROM memory_facts
			WHERE organization_id = $1
				AND temporal_valid_until IS NULL
				AND created_at > NOW() - interval '7 days'
		) sub
		GROUP BY entity
		HAVING count(*) >= 2
		ORDER BY mentions DESC
		LIMIT 20`, orgID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"trending": []any{}, "count": 0})
		return
	}
	defer rows.Close()

	type trend struct {
		Entity   string `json:"entity"`
		Mentions int    `json:"mentions"`
		LastSeen string `json:"lastSeen"`
	}
	var trending []trend
	for rows.Next() {
		var t trend
		var lastSeen time.Time
		if err := rows.Scan(&t.Entity, &t.Mentions, &lastSeen); err != nil {
			continue
		}
		t.LastSeen = lastSeen.Format(time.RFC3339)
		trending = append(trending, t)
	}
	if trending == nil {
		trending = []trend{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"trending": trending, "count": len(trending)})
}

func handleMetrics(w http.ResponseWriter, r *http.Request) {
	// Sample live pool utilisation at scrape time.
	if appFromRequest(r) != nil && appFromRequest(r).DB != nil {
		stat := appFromRequest(r).DB.Pool.Stat()
		SetPoolStats(
			int64(stat.AcquiredConns()),
			int64(stat.MaxConns()),
			int64(stat.IdleConns()),
		)
	}

	avgMs, p95Ms := latencyStats()

	// Cache and object-store figures are sampled from the systems themselves at
	// scrape time, so they reflect reality rather than in-process guesses and
	// survive a restart of this process.
	app := appFromRequest(r)
	var cacheStats storage.CacheStats
	if app.Cache != nil {
		cacheStats = app.Cache.Stats(r.Context())
	}
	var objectStats storage.ObjectStoreStats
	if app.Objects != nil {
		objectStats = app.Objects.Stats(r.Context())
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"cache": map[string]any{
			"hits":        metricValue(&metrics.cacheHits),
			"misses":      metricValue(&metrics.cacheMisses),
			"hitRate":     metrics.hitRate(),
			"evictions":   cacheStats.Evicted,
			"expired":     cacheStats.Expired,
			"size":        cacheStats.Entries,
			"queueDepth":  cacheStats.Queues,
			"memoryBytes": cacheStats.MemoryBytes,
		},
		"objectStorage": map[string]any{
			"puts":      objectStats.Puts,
			"gets":      objectStats.Gets,
			"bytesPut":  objectStats.BytesPut,
			"bytesRead": objectStats.BytesRead,
			"putErrors": objectStats.PutErrors,
			"getErrors": objectStats.GetErrors,
		},
		"retrieval": map[string]any{
			"totalQueries":   metricValue(&metrics.totalQueries),
			"avgLatencyMs":   avgMs,
			"p95LatencyMs":   p95Ms,
			"concurrentNow":  metricValue(&metrics.concurrent),
			"peakConcurrent": metricValue(&metrics.peakConcurrent),
		},
		"ingestion": map[string]any{
			"sessionsProcessed":   metricValue(&metrics.sessionsProcessed),
			"chunksCreated":       metricValue(&metrics.chunksCreated),
			"factsExtracted":      metricValue(&metrics.factsExtracted),
			"segmentations":       metricValue(&metrics.segmentations),
			"embeddingsGenerated": metricValue(&metrics.embeddingsGenerated),
			"deduplicationsRun":   metricValue(&metrics.deduplicationsRun),
			"graphUpdates":        metricValue(&metrics.graphUpdates),
			"searchIndexed":       metricValue(&metrics.searchIndexed),
		},
		"storage": map[string]any{
			"pgActiveConns": metricValue(&metrics.pgConns),
			"pgMaxConns":    metricValue(&metrics.pgMaxConns),
			"redisConns":    metricValue(&metrics.redisConns),
			"s3Puts":        metricValue(&metrics.s3Puts),
			"s3Gets":        metricValue(&metrics.s3Gets),
		},
		"errors": map[string]any{
			"total":     metricValue(&metrics.totalErrors),
			"last5min":  metricValue(&metrics.recentErrors),
			"retrieval": metricValue(&metrics.retrievalErrors),
			"ingestion": metricValue(&metrics.ingestionErrors),
			"storage":   metricValue(&metrics.storageErrors),
		},
	})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func appFromRequest(r *http.Request) *App {
	app, _ := r.Context().Value(appContextKey{}).(*App)
	if app == nil {
		panic("api app dependency missing from request context")
	}
	return app
}

// splitCSV parses a comma-separated query parameter, trimming blanks.
func splitCSV(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// queryInt reads an integer query parameter, falling back on absence or a
// malformed value.
func queryInt(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

// writeError emits a JSON error body matching the shape used by the auth
// middleware, so clients can parse failures uniformly.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": code, "message": message})
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
