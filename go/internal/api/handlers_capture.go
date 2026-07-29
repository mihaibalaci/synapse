package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/mihaibalaci/synapse/internal/auth"
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

		// 1. Store raw session in S3
		rawData, _ := json.Marshal(req)
		storageKey := fmt.Sprintf("sessions/%s/%s.json", orgID, sessionID)
		if err := app.Objects.Put(r.Context(), storageKey, rawData, "application/json"); err != nil {
			slog.Warn("S3 store failed, continuing without raw backup", "error", err)
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
		if err := app.Sessions.Create(r.Context(), session); err != nil {
			slog.Error("Session create failed", "error", err)
			// Continue anyway — the capture was accepted
		}
		RecordSessionProcessed()

		// 3. Process inline: segment → store chunks → extract facts
		go func() {
			ctx := context.Background() // Don't use request context in goroutine

			// Segment messages into chunks
			chunks := segmentMessages(req.Messages, sessionID, orgID, devID)
			RecordSegmentation()

			for _, chunk := range chunks {
				// Store chunk in DB
				if err := storeChunk(ctx, app, &chunk); err != nil {
					slog.Error("Chunk store failed", "chunkId", chunk.ID, "error", err)
					RecordError("storage")
					continue
				}
				RecordChunkCreated()

				// Extract facts (heuristic)
				facts := extractFacts(chunk.Content, chunk.ID, sessionID, devID, orgID, req.Repo, req.Language)
				for _, fact := range facts {
					if fact.Entities == nil {
						fact.Entities = []string{}
					}
					if fact.Frameworks == nil {
						fact.Frameworks = []string{}
					}
					if err := app.Facts.Create(ctx, &fact); err != nil {
						slog.Error("Fact store failed", "error", err, "content", fact.Content[:min(50, len(fact.Content))])
						RecordError("storage")
					} else {
						RecordFactExtracted()
					}
				}

				// Mark as searchable
				app.DB.Exec(ctx, `
					INSERT INTO search_index_entries (chunk_id, organization_id, is_searchable, indexed_at)
					VALUES ($1, $2, true, NOW())
					ON CONFLICT (chunk_id) DO UPDATE SET is_searchable = true, indexed_at = NOW()
				`, chunk.ID, orgID)
				RecordSearchIndexed()
			}

			// Update session status
			app.DB.Exec(ctx, `UPDATE sessions SET searchable_status = 'searchable', status = 'indexed', updated_at = NOW() WHERE id = $1`, sessionID)
		}()

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

// ─── Inline Processing Helpers ───────────────────────────────────────────────

type chunkData struct {
	ID        string
	SessionID string
	OrgID     string
	AuthorID  string
	Title     string
	Summary   string
	Content   string
	Tokens    int
}

func segmentMessages(messages []models.Message, sessionID, orgID, authorID string) []chunkData {
	var chunks []chunkData
	var current strings.Builder
	tokenCount := 0

	for _, msg := range messages {
		line := fmt.Sprintf("%s: %s\n", strings.ToUpper(msg.Role), msg.Content)
		lineTokens := len(msg.Content) / 4

		if tokenCount+lineTokens > 1200 && tokenCount > 200 {
			chunks = append(chunks, buildChunk(current.String(), tokenCount, sessionID, orgID, authorID))
			current.Reset()
			tokenCount = 0
		}

		current.WriteString(line)
		tokenCount += lineTokens
	}

	if current.Len() > 0 {
		chunks = append(chunks, buildChunk(current.String(), tokenCount, sessionID, orgID, authorID))
	}

	return chunks
}

func buildChunk(content string, tokens int, sessionID, orgID, authorID string) chunkData {
	lines := strings.SplitN(content, "\n", 2)
	title := strings.TrimPrefix(lines[0], "USER: ")
	if len(title) > 80 {
		title = title[:80]
	}
	summary := content
	if len(summary) > 200 {
		summary = summary[:200]
	}

	return chunkData{
		ID:        uuid.New().String(),
		SessionID: sessionID,
		OrgID:     orgID,
		AuthorID:  authorID,
		Title:     title,
		Summary:   summary,
		Content:   content,
		Tokens:    tokens,
	}
}

func storeChunk(ctx context.Context, app *App, c *chunkData) error {
	return app.DB.Exec(ctx, `
		INSERT INTO chunks (id, session_id, title, summary, content, token_count, type,
			author_id, organization_id, embedding_model, embedding_version,
			searchable_status, confidence, quality_score, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,'discussion',$7,$8,'synapse-local-1536',1,'searchable','high',0.5,NOW(),NOW())
		ON CONFLICT DO NOTHING`,
		c.ID, c.SessionID, c.Title, c.Summary, c.Content, c.Tokens, c.AuthorID, c.OrgID,
	)
}

func extractFacts(content, chunkID, sessionID, authorID, orgID, repo, lang string) []models.Fact {
	var facts []models.Fact
	lines := strings.Split(content, "\n")

	slog.Debug("Extracting facts", "lines", len(lines), "contentLen", len(content))

	for _, line := range lines {
		cleaned := strings.TrimSpace(line)
		if len(cleaned) < 20 || len(cleaned) > 300 {
			continue
		}
		lower := strings.ToLower(cleaned)

		source := "both"
		if strings.HasPrefix(cleaned, "ASSISTANT:") {
			source = "assistant"
			cleaned = strings.TrimPrefix(cleaned, "ASSISTANT: ")
		} else if strings.HasPrefix(cleaned, "USER:") {
			source = "user"
			cleaned = strings.TrimPrefix(cleaned, "USER: ")
		}

		var factType string
		switch {
		case containsAny(lower, "decided", "chose", "going with", "switched to"):
			factType = "decision"
		case containsAny(lower, "root cause", "the issue was", "turned out", "the fix"):
			factType = "lesson"
		case containsAny(lower, "always", "never", "best practice", "should use"):
			factType = "pattern"
		case containsAny(lower, "maximum", "limit", "timeout", "cannot exceed") && containsDigit(lower):
			factType = "constraint"
		case containsAny(lower, "better than", "preferred", "i think", "we believe"):
			factType = "opinion"
		default:
			continue
		}

		cID := chunkID
		sID := sessionID
		facts = append(facts, models.Fact{
			ID:              uuid.New().String(),
			Content:         cleaned[:min(200, len(cleaned))],
			Type:            factType,
			Entities:        extractEntities(cleaned),
			ExtractedFrom:   source,
			AuthorID:        authorID,
			OrganizationID:  orgID,
			Scope:           "organization",
			Confidence:      0.7,
			Repository:      repo,
			Language:        lang,
			SourceChunkID:   &cID,
			SourceSessionID: &sID,
		})
	}

	if len(facts) > 8 {
		facts = facts[:8]
	}
	slog.Debug("Facts found", "count", len(facts))
	return facts
}

func extractEntities(text string) []string {
	terms := []string{"AWS", "S3", "Lambda", "Kafka", "Redis", "PostgreSQL", "Docker", "Kubernetes", "React", "TypeScript", "Terraform", "VPC", "GraphQL", "gRPC"}
	var found []string
	upper := strings.ToUpper(text)
	for _, t := range terms {
		if strings.Contains(upper, strings.ToUpper(t)) {
			found = append(found, t)
		}
	}
	if len(found) > 6 {
		found = found[:6]
	}
	return found
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func containsDigit(s string) bool {
	for _, c := range s {
		if c >= '0' && c <= '9' {
			return true
		}
	}
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
