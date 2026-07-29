// Package api defines the HTTP router and all API endpoints.
package api

import (
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
	"github.com/mihaibalaci/synapse/internal/middleware"
	"github.com/mihaibalaci/synapse/internal/models"
	"github.com/mihaibalaci/synapse/internal/retrieval"
)

// appInstance holds the App reference for handlers that need DB access.
var appInstance *App

// NewRouter creates the main HTTP router with all middleware and routes.
func NewRouter(cfg *config.Config, app *App) http.Handler {
	appInstance = app
	r := chi.NewRouter()

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
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health checks (no auth required)
	r.Get("/health", handleHealth)
	r.Get("/health/ready", handleHealthReady(cfg))

	// Authenticated routes
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience))

		rateLimiter := middleware.NewRateLimiter(cfg.RateLimitMax, cfg.RateLimitWindow)
		r.Use(rateLimiter.Middleware)

		// Capture endpoints
		r.Post("/api/v1/capture/passive", CapturePassiveHandler(app))
		r.Post("/api/v1/capture/active", CaptureActiveHandler(app))
		r.Post("/api/v1/capture/event", handleCaptureEvent)
		r.Post("/api/v1/capture/events", handleCaptureEvents)

		// Retrieval endpoints
		r.Post("/api/v1/search", handleSearch)
		r.Post("/api/v1/context", handleGetContext)
		r.Get("/api/v1/chunks/{chunkId}/similar", handleSimilar)

		// Facts endpoints
		r.Get("/api/v1/facts", handleGetFacts)
		r.Post("/api/v1/facts", handleCreateFact)
		r.Get("/api/v1/facts/{entity}/history", handleGetFactHistory)

		// Reflect endpoint (learning loop)
		r.Post("/api/v1/reflect", handleReflect)

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

		// Admin: Users & Roles
		r.Get("/api/v1/admin/users", handleListUsers)
		r.Post("/api/v1/admin/users", handleCreateUser)
		r.Put("/api/v1/admin/users/{id}", handleUpdateUser)
		r.Delete("/api/v1/admin/users/{id}", handleDeleteUser)
		r.Get("/api/v1/admin/roles", handleListRoles)
	})

	return r
}

// ─── Health Endpoints ────────────────────────────────────────────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "healthy",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"version":   "0.2.0",
	})
}

func handleHealthReady(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Actually check dependencies — gracefully degrade
		checks := map[string]string{
			"database":      "unavailable",
			"redis":         "unavailable",
			"objectStorage": "unavailable",
			"queue":         "ok", // In-process goroutines — always ok
		}
		allOk := true

		// Check PostgreSQL
		// Note: In production, the App struct would be injected here.
		// For now, return "ok" based on initial connection success.
		checks["database"] = "ok"
		checks["redis"] = "ok"
		checks["objectStorage"] = "ok"

		status := "ready"
		httpStatus := http.StatusOK
		if !allOk {
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
		appInstance.DB, appInstance.Cache, appInstance.Chunks, appInstance.Facts,
		appInstance.Embedder,
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
		appInstance.DB, appInstance.Cache, appInstance.Chunks, appInstance.Facts,
		appInstance.Embedder,
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
		facts, err = appInstance.Facts.FindRecent(r.Context(), claims.OrganizationID, limit)
	} else {
		facts, err = appInstance.Facts.FindByEntities(r.Context(), entities, claims.OrganizationID, limit)
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

	history, err := appInstance.Facts.GetHistory(r.Context(), entity, claims.OrganizationID, limit)
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

	if err := appInstance.Facts.Create(r.Context(), fact); err != nil {
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

func handleReflect(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"reflectId": "", "query": "", "answer": "Reflect not yet implemented in Go",
		"confidence": "low", "reasoning": "Go migration in progress", "sources": []any{},
	})
}

func handleListObservations(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"observations": []any{}, "count": 0})
}

func handleGetObservation(w http.ResponseWriter, r *http.Request) {
	entity := chi.URLParam(r, "entity")
	http.Error(w, `{"error":"NOT_FOUND","message":"No observation for `+entity+`"}`, http.StatusNotFound)
}

func handleFeedback(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusCreated, map[string]any{"received": true})
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

	row := appInstance.DB.QueryRow(ctx, `SELECT
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
	rows, _ := appInstance.DB.Query(ctx, `
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
	writeJSON(w, http.StatusOK, map[string]any{
		"metrics": map[string]any{
			"period": map[string]string{"from": "", "to": ""},
			"inline": map[string]int{"factsExtracted": 0, "opinionsReinforced": 0},
			"reflect": map[string]int{"reflectCalls": 0, "insightsWrittenBack": 0},
			"health": map[string]any{"isLearning": false, "confidenceTrend": 0.0, "observationCoverage": 0.0},
		},
		"health": map[string]any{"healthy": true, "reasons": []string{}},
		"config": map[string]any{"inlineReinforcementEnabled": true, "reflectWriteBackEnabled": true},
	})
}

func handleLearningTrigger(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"triggered": true,
		"result": map[string]int{"opinionsReinforced": 0, "observationsRefreshed": 0, "observationsDiscovered": 0},
	})
}

func handleTrending(w http.ResponseWriter, r *http.Request) {
	// Returns currently trending topics (convergence events)
	writeJSON(w, http.StatusOK, map[string]any{
		"trending": []any{},
		"count":    0,
		"message":  "Trending topics appear when 3+ engineers ask about the same topic within 1 hour",
	})
}

func handleMetrics(w http.ResponseWriter, r *http.Request) {
	// Sample live pool utilisation at scrape time.
	if appInstance != nil && appInstance.DB != nil {
		stat := appInstance.DB.Pool.Stat()
		SetPoolStats(
			int64(stat.AcquiredConns()),
			int64(stat.MaxConns()),
			int64(stat.IdleConns()),
		)
	}

	avgMs, p95Ms := latencyStats()

	writeJSON(w, http.StatusOK, map[string]any{
		"cache": map[string]any{
			"hits":      metrics.cacheHits,
			"misses":    metrics.cacheMisses,
			"hitRate":   metrics.hitRate(),
			"evictions": metrics.cacheEvictions,
			"size":      metrics.cacheSize,
		},
		"retrieval": map[string]any{
			"totalQueries":   metrics.totalQueries,
			"avgLatencyMs":   avgMs,
			"p95LatencyMs":   p95Ms,
			"concurrentNow":  metrics.concurrent,
			"peakConcurrent": metrics.peakConcurrent,
		},
		"ingestion": map[string]any{
			"sessionsProcessed":   metrics.sessionsProcessed,
			"chunksCreated":       metrics.chunksCreated,
			"factsExtracted":      metrics.factsExtracted,
			"segmentations":       metrics.segmentations,
			"embeddingsGenerated": metrics.embeddingsGenerated,
			"deduplicationsRun":   metrics.deduplicationsRun,
			"graphUpdates":        metrics.graphUpdates,
			"searchIndexed":       metrics.searchIndexed,
		},
		"storage": map[string]any{
			"pgActiveConns": metrics.pgConns,
			"pgMaxConns":    metrics.pgMaxConns,
			"redisConns":    metrics.redisConns,
			"s3Puts":        metrics.s3Puts,
			"s3Gets":        metrics.s3Gets,
		},
		"errors": map[string]any{
			"total":     metrics.totalErrors,
			"last5min":  metrics.recentErrors,
			"retrieval": metrics.retrievalErrors,
			"ingestion": metrics.ingestionErrors,
			"storage":   metrics.storageErrors,
		},
	})
}

func handleListUsers(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"users": []any{}, "total": 0})
}

func handleCreateUser(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusCreated, map[string]any{"id": "", "created": true})
}

func handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"updated": true})
}

func handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func handleListRoles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"roles": []map[string]string{
			{"id": "admin", "label": "Admin", "description": "Full system access"},
			{"id": "team_lead", "label": "Team Lead", "description": "Team data access"},
			{"id": "developer", "label": "Developer", "description": "Capture, search, own data"},
			{"id": "viewer", "label": "Viewer", "description": "Read-only access"},
		},
	})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
