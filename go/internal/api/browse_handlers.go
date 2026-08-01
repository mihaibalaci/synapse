package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mihaibalaci/synapse/internal/auth"
)

// handleBrowseChunks returns paginated chunks with optional text search.
func handleBrowseChunks(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := queryInt(r, "limit", 25)
	offset := queryInt(r, "offset", 0)
	if limit < 1 || limit > 100 {
		limit = 25
	}

	ctx := r.Context()
	db := appFromRequest(r).DB

	type chunkRow struct {
		ID             string  `json:"id"`
		SessionID      string  `json:"sessionId"`
		Title          string  `json:"title"`
		Summary        string  `json:"summary"`
		ContentPreview string  `json:"contentPreview"`
		TokenCount     int     `json:"tokenCount"`
		Type           string  `json:"type"`
		Confidence     string  `json:"confidence"`
		QualityScore   float64 `json:"qualityScore"`
		Repository     string  `json:"repository"`
		CreatedAt      string  `json:"createdAt"`
		UpdatedAt      string  `json:"updatedAt"`
	}

	var chunks []chunkRow

	var scanRows func() error
	if query != "" {
		rows, err := db.Query(ctx, `
			SELECT id, session_id, title, summary, LEFT(content, 300) AS content_preview,
				token_count, type, confidence, quality_score, COALESCE(repository,''),
				created_at, updated_at
			FROM chunks
			WHERE organization_id = $1 AND confidence <> 'archived'
				AND search_vector @@ plainto_tsquery('english', $4)
			ORDER BY ts_rank(search_vector, plainto_tsquery('english', $4)) DESC
			LIMIT $2 OFFSET $3`,
			claims.OrganizationID, limit, offset, query)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
			return
		}
		defer rows.Close()
		scanRows = func() error {
			for rows.Next() {
				var c chunkRow
				var createdAt, updatedAt time.Time
				if err := rows.Scan(&c.ID, &c.SessionID, &c.Title, &c.Summary, &c.ContentPreview,
					&c.TokenCount, &c.Type, &c.Confidence, &c.QualityScore, &c.Repository,
					&createdAt, &updatedAt); err != nil {
					return err
				}
				c.CreatedAt = createdAt.Format(time.RFC3339)
				c.UpdatedAt = updatedAt.Format(time.RFC3339)
				chunks = append(chunks, c)
			}
			return nil
		}
	} else {
		rows, err := db.Query(ctx, `
			SELECT id, session_id, title, summary, LEFT(content, 300) AS content_preview,
				token_count, type, confidence, quality_score, COALESCE(repository,''),
				created_at, updated_at
			FROM chunks
			WHERE organization_id = $1 AND confidence <> 'archived'
			ORDER BY updated_at DESC
			LIMIT $2 OFFSET $3`,
			claims.OrganizationID, limit, offset)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
			return
		}
		defer rows.Close()
		scanRows = func() error {
			for rows.Next() {
				var c chunkRow
				var createdAt, updatedAt time.Time
				if err := rows.Scan(&c.ID, &c.SessionID, &c.Title, &c.Summary, &c.ContentPreview,
					&c.TokenCount, &c.Type, &c.Confidence, &c.QualityScore, &c.Repository,
					&createdAt, &updatedAt); err != nil {
					return err
				}
				c.CreatedAt = createdAt.Format(time.RFC3339)
				c.UpdatedAt = updatedAt.Format(time.RFC3339)
				chunks = append(chunks, c)
			}
			return nil
		}
	}

	if err := scanRows(); err != nil {
		writeError(w, http.StatusInternalServerError, "SCAN_ERROR", err.Error())
		return
	}
	if chunks == nil {
		chunks = []chunkRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"chunks": chunks, "count": len(chunks), "offset": offset, "limit": limit})
}

// handleGetChunk returns the full content of a single chunk.
func handleGetChunk(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	var title, summary, content, chunkType, confidence, repository, authorID string
	var tokenCount int
	var qualityScore float64
	var createdAt, updatedAt time.Time
	err := appFromRequest(r).DB.QueryRow(r.Context(), `
		SELECT title, summary, content, token_count, type, confidence, quality_score,
			COALESCE(repository,''), author_id, created_at, updated_at
		FROM chunks WHERE id = $1 AND organization_id = $2`,
		id, claims.OrganizationID).Scan(
		&title, &summary, &content, &tokenCount, &chunkType, &confidence,
		&qualityScore, &repository, &authorID, &createdAt, &updatedAt)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Chunk not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "title": title, "summary": summary, "content": content,
		"tokenCount": tokenCount, "type": chunkType, "confidence": confidence,
		"qualityScore": qualityScore, "repository": repository, "authorId": authorID,
		"createdAt": createdAt.Format(time.RFC3339), "updatedAt": updatedAt.Format(time.RFC3339),
	})
}

// handleUpdateChunk allows editing title, summary, and confidence.
func handleUpdateChunk(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	var req struct {
		Title      *string `json:"title"`
		Summary    *string `json:"summary"`
		Confidence *string `json:"confidence"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}

	ctx := r.Context()
	if req.Title != nil {
		_ = appFromRequest(r).DB.Exec(ctx, `UPDATE chunks SET title = $2, updated_at = NOW() WHERE id = $1 AND organization_id = $3`, id, *req.Title, claims.OrganizationID)
	}
	if req.Summary != nil {
		_ = appFromRequest(r).DB.Exec(ctx, `UPDATE chunks SET summary = $2, updated_at = NOW() WHERE id = $1 AND organization_id = $3`, id, *req.Summary, claims.OrganizationID)
	}
	if req.Confidence != nil {
		_ = appFromRequest(r).DB.Exec(ctx, `UPDATE chunks SET confidence = $2, updated_at = NOW() WHERE id = $1 AND organization_id = $3`, id, *req.Confidence, claims.OrganizationID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": true})
}

// handleDeleteChunk archives a chunk (soft delete).
func handleDeleteChunk(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	id := chi.URLParam(r, "id")
	err := appFromRequest(r).DB.Exec(r.Context(), `UPDATE chunks SET confidence = 'archived', updated_at = NOW() WHERE id = $1 AND organization_id = $2`, id, claims.OrganizationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"archived": true})
}

// handleBrowseFacts returns paginated facts with optional entity/type filter.
func handleBrowseFacts(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	factType := strings.TrimSpace(r.URL.Query().Get("type"))
	limit := queryInt(r, "limit", 25)
	offset := queryInt(r, "offset", 0)
	if limit < 1 || limit > 100 {
		limit = 25
	}

	sqlBase := `SELECT id, content, type, entities, confidence, author_id, created_at, updated_at
		FROM memory_facts WHERE organization_id = $1 AND temporal_valid_until IS NULL`
	args := []any{claims.OrganizationID}
	argN := 2

	if query != "" {
		sqlBase += ` AND content ILIKE '%' || $` + itoa(argN) + ` || '%'`
		args = append(args, query)
		argN++
	}
	if factType != "" {
		sqlBase += ` AND type = $` + itoa(argN)
		args = append(args, factType)
		argN++
	}
	sqlBase += ` ORDER BY created_at DESC LIMIT $` + itoa(argN) + ` OFFSET $` + itoa(argN+1)
	args = append(args, limit, offset)

	rows, err := appFromRequest(r).DB.Query(r.Context(), sqlBase, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type factRow struct {
		ID         string   `json:"id"`
		Content    string   `json:"content"`
		Type       string   `json:"type"`
		Entities   []string `json:"entities"`
		Confidence float64  `json:"confidence"`
		AuthorID   string   `json:"authorId"`
		CreatedAt  string   `json:"createdAt"`
		UpdatedAt  string   `json:"updatedAt"`
	}

	var facts []factRow
	for rows.Next() {
		var f factRow
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&f.ID, &f.Content, &f.Type, &f.Entities, &f.Confidence, &f.AuthorID, &createdAt, &updatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "SCAN_ERROR", err.Error())
			return
		}
		f.CreatedAt = createdAt.Format(time.RFC3339)
		f.UpdatedAt = updatedAt.Format(time.RFC3339)
		facts = append(facts, f)
	}
	if facts == nil {
		facts = []factRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"facts": facts, "count": len(facts), "offset": offset, "limit": limit})
}

// handleDeleteFact supersedes a fact (soft delete via temporal).
func handleDeleteFact(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	id := chi.URLParam(r, "id")
	err := appFromRequest(r).DB.Exec(r.Context(), `UPDATE memory_facts SET temporal_valid_until = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2`, id, claims.OrganizationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"superseded": true})
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}
