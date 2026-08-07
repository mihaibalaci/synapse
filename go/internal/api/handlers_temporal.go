package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/temporal"
)

// ─── Temporal API Handlers ───────────────────────────────────────────────────

// HandleTemporalPointInTime queries facts as they were at a specific time.
// POST /api/v1/temporal/point-in-time
//
//	{
//	  "asOf": "2026-03-15T10:00:00Z",
//	  "entities": ["PostgreSQL", "caching"],
//	  "types": ["decision"],
//	  "limit": 20
//	}
func HandleTemporalPointInTime(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.GetClaims(r)
		if claims == nil {
			http.Error(w, `{"error":"AUTH_ERROR"}`, http.StatusUnauthorized)
			return
		}

		var req struct {
			AsOf     time.Time `json:"asOf"`
			Entities []string  `json:"entities"`
			Types    []string  `json:"types"`
			Limit    int       `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"VALIDATION_ERROR","message":"Invalid JSON"}`, http.StatusBadRequest)
			return
		}
		if req.AsOf.IsZero() {
			http.Error(w, `{"error":"VALIDATION_ERROR","message":"asOf timestamp required"}`, http.StatusBadRequest)
			return
		}

		engine := temporal.NewEngine(app.DB)
		entries, err := engine.QueryPointInTime(r.Context(), temporal.PointInTimeQuery{
			OrganizationID: claims.OrganizationID,
			AsOf:           req.AsOf,
			Entities:       req.Entities,
			Types:          req.Types,
			Limit:          req.Limit,
		})
		if err != nil {
			http.Error(w, `{"error":"QUERY_ERROR","message":"`+err.Error()+`"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"asOf":    req.AsOf,
			"results": entries,
			"count":   len(entries),
		})
	}
}

// HandleTemporalEvolution returns the full version history of a topic or entity.
// GET /api/v1/temporal/evolution?entity=PostgreSQL&limit=50
// GET /api/v1/temporal/evolution?topic=PostgreSQL:caching&limit=50
func HandleTemporalEvolution(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.GetClaims(r)
		if claims == nil {
			http.Error(w, `{"error":"AUTH_ERROR"}`, http.StatusUnauthorized)
			return
		}

		entity := r.URL.Query().Get("entity")
		topic := r.URL.Query().Get("topic")
		if entity == "" && topic == "" {
			http.Error(w, `{"error":"VALIDATION_ERROR","message":"entity or topic parameter required"}`, http.StatusBadRequest)
			return
		}

		limit := 50
		if l := r.URL.Query().Get("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
				limit = parsed
			}
		}

		engine := temporal.NewEngine(app.DB)
		entries, err := engine.QueryEvolution(r.Context(), temporal.EvolutionQuery{
			OrganizationID: claims.OrganizationID,
			Entity:         entity,
			Topic:          topic,
			Limit:          limit,
		})
		if err != nil {
			http.Error(w, `{"error":"QUERY_ERROR","message":"`+err.Error()+`"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"entity":  entity,
			"topic":   topic,
			"results": entries,
			"count":   len(entries),
		})
	}
}

// HandleTemporalEdges returns time-bounded relationships for an entity.
// GET /api/v1/temporal/edges?entity=Redis&asOf=2026-06-01T00:00:00Z
func HandleTemporalEdges(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.GetClaims(r)
		if claims == nil {
			http.Error(w, `{"error":"AUTH_ERROR"}`, http.StatusUnauthorized)
			return
		}

		entity := r.URL.Query().Get("entity")
		if entity == "" {
			http.Error(w, `{"error":"VALIDATION_ERROR","message":"entity parameter required"}`, http.StatusBadRequest)
			return
		}

		asOf := time.Now()
		if t := r.URL.Query().Get("asOf"); t != "" {
			if parsed, err := time.Parse(time.RFC3339, t); err == nil {
				asOf = parsed
			}
		}

		limit := 50
		if l := r.URL.Query().Get("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
				limit = parsed
			}
		}

		engine := temporal.NewEngine(app.DB)
		edges, err := engine.QueryTemporalEdges(r.Context(), claims.OrganizationID, entity, asOf, limit)
		if err != nil {
			http.Error(w, `{"error":"QUERY_ERROR","message":"`+err.Error()+`"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"entity":  entity,
			"asOf":    asOf,
			"edges":   edges,
			"count":   len(edges),
		})
	}
}

// HandleTemporalVolatile returns the most frequently changing topics.
// GET /api/v1/temporal/volatile?limit=20
func HandleTemporalVolatile(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.GetClaims(r)
		if claims == nil {
			http.Error(w, `{"error":"AUTH_ERROR"}`, http.StatusUnauthorized)
			return
		}

		limit := 20
		if l := r.URL.Query().Get("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
				limit = parsed
			}
		}

		engine := temporal.NewEngine(app.DB)
		chains, err := engine.GetVolatileTopics(r.Context(), claims.OrganizationID, limit)
		if err != nil {
			http.Error(w, `{"error":"QUERY_ERROR","message":"`+err.Error()+`"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"topics": chains,
			"count":  len(chains),
		})
	}
}

// HandleTemporalChangeLog returns the change history for a version chain.
// GET /api/v1/temporal/changelog?chainId=<uuid>&limit=50
func HandleTemporalChangeLog(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.GetClaims(r)
		if claims == nil {
			http.Error(w, `{"error":"AUTH_ERROR"}`, http.StatusUnauthorized)
			return
		}

		chainID := r.URL.Query().Get("chainId")
		if chainID == "" {
			http.Error(w, `{"error":"VALIDATION_ERROR","message":"chainId parameter required"}`, http.StatusBadRequest)
			return
		}

		limit := 50
		if l := r.URL.Query().Get("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
				limit = parsed
			}
		}

		engine := temporal.NewEngine(app.DB)
		entries, err := engine.GetChangeLog(r.Context(), chainID, limit)
		if err != nil {
			http.Error(w, `{"error":"QUERY_ERROR","message":"`+err.Error()+`"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"chainId":   chainID,
			"changes":   entries,
			"count":     len(entries),
		})
	}
}
