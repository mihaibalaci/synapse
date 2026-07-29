package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/models"
)

// CapturePassiveHandler processes passive session captures end-to-end.
func CapturePassiveHandler(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.GetClaims(r)
		if claims == nil {
			http.Error(w, `{"error":"AUTH_ERROR"}`, http.StatusUnauthorized)
			return
		}

		// Parse request
		var req struct {
			Messages []models.Message `json:"messages"`
			Source   string           `json:"source"`
			Repo     string           `json:"repository"`
			Language string           `json:"language"`
			DevID    string           `json:"developerId"`
			OrgID    string           `json:"organizationId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"VALIDATION_ERROR","message":"Invalid JSON"}`, http.StatusBadRequest)
			return
		}

		if len(req.Messages) < 2 {
			http.Error(w, `{"error":"VALIDATION_ERROR","message":"At least 2 messages required"}`, http.StatusBadRequest)
			return
		}

		orgID := claims.OrganizationID
		devID := claims.UserID
		if req.DevID != "" {
			devID = req.DevID
		}

		sessionID := uuid.New().String()

		// Compute total tokens
		totalTokens := 0
		for _, m := range req.Messages {
			totalTokens += len(m.Content) / 4
		}

		// 1. Store the raw session in object storage.
		//
		// This is the only durable copy of the verbatim conversation: chunks are
		// lossy (title and summary are truncated, facts are capped) and cannot be
		// re-derived from Postgres. Accepting the capture while the raw write
		// failed would silently discard the source material and leave
		// sessions.raw_storage_key pointing at an object that does not exist, so
		// this fails the request instead.
		rawData, err := json.Marshal(req)
		if err != nil {
			http.Error(w, `{"error":"INTERNAL_ERROR","message":"Could not serialize session"}`, http.StatusInternalServerError)
			return
		}

		storageKey := fmt.Sprintf("sessions/%s/%s.json", orgID, sessionID)
		if err := app.Objects.Put(r.Context(), storageKey, rawData, "application/json"); err != nil {
			slog.Error("Raw session store failed, rejecting capture",
				"sessionId", sessionID, "key", storageKey, "error", err)
			RecordError("storage")
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":   "STORAGE_ERROR",
				"message": "Could not persist the raw session; capture rejected so it can be retried",
			})
			return
		}
		RecordS3Put()

		// 2. Create session record in DB
		session := &models.Session{
			ID:               sessionID,
			ClientID:         sessionID,
			DeveloperID:      devID,
			OrganizationID:   orgID,
			Status:           "processing",
			SearchableStatus: "pending",
			EnrichmentStatus: "pending",
			RawStorageKey:    storageKey,
			TotalTokens:      totalTokens,
			MessageCount:     len(req.Messages),
			Metadata:         map[string]any{"source": req.Source, "repository": req.Repo, "language": req.Language},
			StartedAt:        time.Now(),
			EndedAt:          time.Now(),
		}
		// The session row must exist before the job is queued, otherwise the
		// worker would dequeue a job referring to nothing.
		if err := app.Sessions.Create(r.Context(), session); err != nil {
			slog.Error("Session create failed", "sessionId", sessionID, "error", err)
			RecordError("storage")
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"error":   "STORAGE_ERROR",
				"message": "Could not record the session; capture rejected so it can be retried",
			})
			return
		}
		RecordSessionProcessed()

		// 3. Queue the processing work.
		//
		// This used to run in a bare goroutine, which meant a restart mid-flight
		// stranded the session in 'processing' forever with nothing to resume it.
		// Queueing makes the work durable: the raw conversation is already in
		// object storage, so the worker can retry from scratch, and the reaper
		// re-queues anything left unfinished.
		job := ingestion.Job{
			Type:           "session",
			SessionID:      sessionID,
			OrganizationID: orgID,
		}
		payload, err := json.Marshal(job)
		if err == nil {
			err = app.Cache.Enqueue(r.Context(), "synapse:session", payload)
		}
		if err != nil {
			// The session and its raw object are both persisted, so the reaper
			// will pick this up. Report success but say it is queued.
			slog.Error("Could not enqueue session job; leaving it for recovery",
				"sessionId", sessionID, "error", err)
			RecordError("storage")
		}

		// Return immediately (async processing)
		writeJSON(w, http.StatusAccepted, map[string]any{
			"sessionId": sessionID,
			"status":    "captured",
			"mode":      "passive",
			"message":   "Session captured and processing",
		})
	}
}

// CaptureActiveHandler handles explicit saves (same as passive but higher priority).
func CaptureActiveHandler(app *App) http.HandlerFunc {
	return CapturePassiveHandler(app) // Same logic, can add tier2 promotion later
}
