package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mihaibalaci/synapse/internal/auth"
)

// Feature 3: Session outcome tracking + learning.

type failurePattern struct {
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason"`
	Context   string `json:"context"`
}

func handleMarkSessionOutcome(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	sessionID := chi.URLParam(r, "sessionId")

	var req struct {
		Outcome string `json:"outcome"` // success, failure, abandoned
		Reason  string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.Outcome != "success" && req.Outcome != "failure" && req.Outcome != "abandoned" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "outcome must be success, failure, or abandoned")
		return
	}

	err := appFromRequest(r).DB.Exec(r.Context(), `
		UPDATE sessions SET metadata = metadata || jsonb_build_object('outcome', $2::text, 'outcomeReason', $3::text, 'outcomeAt', $4::text)
		WHERE id = $1 AND organization_id = $5`,
		sessionID, req.Outcome, req.Reason, time.Now().UTC().Format(time.RFC3339), claims.OrganizationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"marked": true, "outcome": req.Outcome})
}

func handleLearnFromFailures(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	ctx := r.Context()
	app := appFromRequest(r)

	// Find sessions marked as failures in the last 30 days
	rows, err := app.DB.Query(ctx, `
		SELECT id, metadata->>'outcomeReason' AS reason,
			(SELECT string_agg(content, '; ') FROM chunks WHERE session_id = s.id LIMIT 3) AS context
		FROM sessions s
		WHERE organization_id = $1
			AND metadata->>'outcome' = 'failure'
			AND updated_at > NOW() - interval '30 days'
		ORDER BY updated_at DESC LIMIT 20`, claims.OrganizationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	var failures []failurePattern
	for rows.Next() {
		var f failurePattern
		var reason, context *string
		if err := rows.Scan(&f.SessionID, &reason, &context); err != nil {
			continue
		}
		if reason != nil {
			f.Reason = *reason
		}
		if context != nil {
			f.Context = *context
		}
		failures = append(failures, f)
	}
	if failures == nil {
		failures = []failurePattern{}
	}

	// Generate recommendations based on failure patterns
	recommendations := generateRecommendations(failures)

	writeJSON(w, http.StatusOK, map[string]any{
		"failures":        failures,
		"failureCount":    len(failures),
		"recommendations": recommendations,
	})
}

func generateRecommendations(failures []failurePattern) []string {
	if len(failures) == 0 {
		return []string{"No failures recorded. Mark sessions with POST /api/v1/sessions/{id}/outcome."}
	}

	var recs []string
	// Count reason patterns
	reasons := make(map[string]int)
	for _, f := range failures {
		if f.Reason != "" {
			reasons[f.Reason]++
		}
	}
	for reason, count := range reasons {
		if count >= 2 {
			recs = append(recs, "Recurring failure ("+reason+"): appeared "+string(rune('0'+count))+" times. Consider documenting a workaround as a fact.")
		}
	}
	if len(recs) == 0 {
		recs = append(recs, "Failures are diverse. Review individual session contexts for patterns.")
	}
	return recs
}
