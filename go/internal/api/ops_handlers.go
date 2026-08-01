package api

import (
	"net/http"

	"github.com/mihaibalaci/synapse/internal/auth"
)

// ─── Queue / Job Visibility ──────────────────────────────────────────────────

// handleQueueStatus returns the current state of all Redis ingestion queues
// including depth, dead-letter count, and recent processing rate.
func handleQueueStatus(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	ctx := r.Context()
	cache := appFromRequest(r).Cache

	queues := []string{"synapse:session", "synapse:embed", "synapse:facts", "synapse:graph", "synapse:search", "synapse:dedup"}
	type queueInfo struct {
		Name      string `json:"name"`
		Depth     int64  `json:"depth"`
		DeadCount int64  `json:"deadCount"`
	}
	var results []queueInfo
	for _, q := range queues {
		depth, _ := cache.Client.LLen(ctx, q).Result()
		dead, _ := cache.Client.LLen(ctx, q+":dead").Result()
		results = append(results, queueInfo{Name: q, Depth: depth, DeadCount: dead})
	}
	writeJSON(w, http.StatusOK, map[string]any{"queues": results})
}

// handleDeadLetterList returns items in the dead-letter queue.
func handleDeadLetterList(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	ctx := r.Context()
	cache := appFromRequest(r).Cache
	limit := queryInt(r, "limit", 20)

	items, _ := cache.Client.LRange(ctx, "synapse:session:dead", 0, int64(limit-1)).Result()
	if items == nil {
		items = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

// handleDeadLetterRetry moves items from the dead-letter queue back to the
// main processing queue.
func handleDeadLetterRetry(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	ctx := r.Context()
	cache := appFromRequest(r).Cache
	limit := queryInt(r, "limit", 10)

	moved := 0
	for i := 0; i < limit; i++ {
		item, err := cache.Client.RPopLPush(ctx, "synapse:session:dead", "synapse:session").Result()
		if err != nil || item == "" {
			break
		}
		moved++
	}
	writeJSON(w, http.StatusOK, map[string]any{"moved": moved})
}

// handleJobHistory returns recent session processing results.
func handleJobHistory(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	limit := queryInt(r, "limit", 50)
	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT id, developer_id, status, searchable_status, enrichment_status,
			total_tokens, created_at, updated_at
		FROM sessions
		WHERE organization_id = $1
		ORDER BY updated_at DESC LIMIT $2`, claims.OrganizationID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	var jobs []map[string]any
	for rows.Next() {
		var id, devID, status, searchStatus, enrichStatus string
		var tokens int
		var createdAt, updatedAt interface{}
		if err := rows.Scan(&id, &devID, &status, &searchStatus, &enrichStatus, &tokens, &createdAt, &updatedAt); err != nil {
			continue
		}
		jobs = append(jobs, map[string]any{
			"sessionId": id, "developerId": devID, "status": status,
			"searchableStatus": searchStatus, "enrichmentStatus": enrichStatus,
			"totalTokens": tokens, "createdAt": createdAt, "updatedAt": updatedAt,
		})
	}
	if jobs == nil {
		jobs = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs, "count": len(jobs)})
}

// handleBackupStatus reports database and S3 storage utilization for operators.
func handleBackupStatus(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	ctx := r.Context()
	app := appFromRequest(r)

	var dbSize string
	_ = app.DB.QueryRow(ctx, `SELECT pg_size_pretty(pg_database_size(current_database()))`).Scan(&dbSize)

	var tableCount int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`).Scan(&tableCount)

	var sessionCount, chunkCount, factCount int
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE organization_id = $1`, claims.OrganizationID).Scan(&sessionCount)
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM chunks WHERE organization_id = $1`, claims.OrganizationID).Scan(&chunkCount)
	_ = app.DB.QueryRow(ctx, `SELECT count(*) FROM memory_facts WHERE organization_id = $1`, claims.OrganizationID).Scan(&factCount)

	writeJSON(w, http.StatusOK, map[string]any{
		"database": map[string]any{"size": dbSize, "tables": tableCount},
		"counts":   map[string]any{"sessions": sessionCount, "chunks": chunkCount, "facts": factCount},
		"backup":   map[string]any{"command": "pg_dump -Fc --no-owner synapse > backup.dump", "note": "Use synapse verify-storage to check S3 consistency"},
	})
}
