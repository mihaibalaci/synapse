package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/mihaibalaci/synapse/internal/auth"
)

// handleGitCapture ingests git diffs, PRs, and commit context as enriched sessions.
// It converts structured git data into messages that the standard pipeline processes.
func handleGitCapture(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	var req struct {
		Type       string `json:"type"` // "commit", "pr", "diff", "review"
		Repository string `json:"repository"`
		Branch     string `json:"branch"`
		CommitSHA  string `json:"commitSha"`
		Author     string `json:"author"`
		Title      string `json:"title"`
		Body       string `json:"body"`
		Diff       string `json:"diff"`
		Files      []struct {
			Path     string `json:"path"`
			Action   string `json:"action"` // added, modified, deleted
			Diff     string `json:"diff"`
			Language string `json:"language"`
		} `json:"files"`
		Comments []struct {
			Author string `json:"author"`
			Body   string `json:"body"`
			Path   string `json:"path"`
			Line   int    `json:"line"`
		} `json:"comments"`
		Labels []string `json:"labels"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 10<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.Repository == "" || req.Type == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "repository and type are required")
		return
	}

	// Convert git data to session messages
	var messages []map[string]string

	// Title/body as the primary conversation
	if req.Title != "" {
		messages = append(messages, map[string]string{
			"role":    "user",
			"content": fmt.Sprintf("[%s] %s: %s", req.Type, req.Repository, req.Title),
		})
	}
	if req.Body != "" {
		messages = append(messages, map[string]string{
			"role":    "assistant",
			"content": req.Body,
		})
	}

	// File changes as context
	for _, file := range req.Files {
		content := fmt.Sprintf("File %s (%s): %s", file.Action, file.Path, file.Language)
		if file.Diff != "" {
			// Truncate large diffs
			diff := file.Diff
			if len(diff) > 2000 {
				diff = diff[:2000] + "\n... (truncated)"
			}
			content += "\n```diff\n" + diff + "\n```"
		}
		messages = append(messages, map[string]string{
			"role": "user", "content": content,
		})
	}

	// Code review comments
	for _, comment := range req.Comments {
		content := fmt.Sprintf("Review by %s", comment.Author)
		if comment.Path != "" {
			content += fmt.Sprintf(" on %s:%d", comment.Path, comment.Line)
		}
		content += ": " + comment.Body
		messages = append(messages, map[string]string{
			"role": "assistant", "content": content,
		})
	}

	// Truncated diff as fallback
	if len(messages) < 2 && req.Diff != "" {
		diff := req.Diff
		if len(diff) > 4000 {
			diff = diff[:4000] + "\n... (truncated)"
		}
		messages = append(messages, map[string]string{
			"role":    "user",
			"content": fmt.Sprintf("Diff for %s on %s:\n%s", req.CommitSHA, req.Branch, diff),
		})
		messages = append(messages, map[string]string{
			"role":    "assistant",
			"content": "Captured git context for " + req.Repository,
		})
	}

	if len(messages) < 2 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Not enough content to capture (need title/body, files, or diff)")
		return
	}

	// Create the session via the standard capture pipeline
	app := appFromRequest(r)
	sessionID := uuid.NewString()

	metadata := map[string]any{
		"source":     "git-capture",
		"type":       req.Type,
		"repository": req.Repository,
		"branch":     req.Branch,
		"commitSha":  req.CommitSHA,
		"author":     req.Author,
		"labels":     req.Labels,
	}
	metaJSON, _ := json.Marshal(metadata)

	// Store raw payload
	rawKey := fmt.Sprintf("git/%s/%s/%s.json", claims.OrganizationID, req.Repository, sessionID)
	rawBody, _ := json.Marshal(req)
	if err := app.Objects.Put(r.Context(), rawKey, rawBody, "application/json"); err != nil {
		writeError(w, http.StatusServiceUnavailable, "STORAGE_ERROR", "Raw storage unavailable")
		return
	}

	// Insert session record
	if err := app.DB.Exec(r.Context(), `
		INSERT INTO sessions (id, client_id, developer_id, organization_id, team_id, status,
			searchable_status, enrichment_status, raw_storage_key, metadata, started_at, ended_at)
		VALUES ($1, $1, $2, $3, '', 'processing', 'pending', 'pending', $4, $5, $6, $6)`,
		sessionID, claims.UserID, claims.OrganizationID, rawKey, string(metaJSON), time.Now()); err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}

	// Enqueue for processing
	sessJSON, _ := json.Marshal(map[string]any{
		"sessionId": sessionID, "messages": messages,
		"source": "git", "repository": req.Repository,
		"language": detectDominantLanguage(req.Files),
	})
	_ = app.Cache.Client.LPush(r.Context(), "synapse:session", string(sessJSON)).Err()

	writeJSON(w, http.StatusAccepted, map[string]any{
		"sessionId": sessionID, "type": req.Type, "repository": req.Repository,
		"filesIngested": len(req.Files), "commentsIngested": len(req.Comments),
	})
}

func detectDominantLanguage(files []struct {
	Path     string `json:"path"`
	Action   string `json:"action"`
	Diff     string `json:"diff"`
	Language string `json:"language"`
}) string {
	counts := make(map[string]int)
	for _, f := range files {
		if f.Language != "" {
			counts[f.Language]++
		}
	}
	best, bestCount := "", 0
	for lang, count := range counts {
		if count > bestCount {
			best, bestCount = lang, count
		}
	}
	return best
}

// Suppress unused import warning
var _ = strings.TrimSpace
