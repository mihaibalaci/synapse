// Package api defines the HTTP router and all API endpoints.
package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/config"
	"github.com/mihaibalaci/synapse/internal/middleware"
)

// NewRouter creates the main HTTP router with all middleware and routes.
func NewRouter(cfg *config.Config) http.Handler {
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
		r.Post("/api/v1/capture/passive", handleCapturePassive)
		r.Post("/api/v1/capture/active", handleCaptureActive)
		r.Post("/api/v1/capture/event", handleCaptureEvent)
		r.Post("/api/v1/capture/events", handleCaptureEvents)

		// Retrieval endpoints
		r.Post("/api/v1/search", handleSearch)
		r.Post("/api/v1/context", handleGetContext)
		r.Get("/api/v1/chunks/{chunkId}/similar", handleSimilar)

		// Facts endpoints
		r.Get("/api/v1/facts", handleGetFacts)
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
		// TODO: check PG, Redis, S3 connectivity
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ready",
			"checks": map[string]string{
				"database":      "ok",
				"redis":         "ok",
				"objectStorage": "ok",
				"queue":         "ok",
			},
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
	writeJSON(w, http.StatusOK, map[string]any{
		"results": []any{}, "totalCount": 0, "query": "", "strategy": "hybrid",
		"latencyMs": 0, "cached": false, "estimatedTokens": 0, "observations": []any{},
	})
}

func handleGetContext(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"context": []any{}, "totalResults": 0, "returnedResults": 0, "estimatedTokens": 0,
	})
}

func handleSimilar(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"results": []any{}})
}

func handleGetFacts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"facts": []any{}, "total": 0})
}

func handleGetFactHistory(w http.ResponseWriter, r *http.Request) {
	entity := chi.URLParam(r, "entity")
	writeJSON(w, http.StatusOK, map[string]any{"entity": entity, "history": []any{}})
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
	writeJSON(w, http.StatusOK, map[string]any{
		"organization": orgID,
		"timestamp":    time.Now().UTC().Format(time.RFC3339),
		"counts":       map[string]int{"sessions": 0, "chunks": 0, "facts": 0, "clusters": 0, "graphNodes": 0, "searchableChunks": 0, "knowledgeRecords": 0},
		"processing":   map[string]int{"activeSessions": 0, "searchable": 0, "blocked": 0, "failed": 0},
		"queues":       map[string]int{"total": 0},
		"recentActivity": []any{},
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

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
