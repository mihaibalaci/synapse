// Package compaction implements memory condensation. Old session chunks are
// summarized into a single canonical chunk per session, reducing storage and
// retrieval noise while preserving searchability.
package compaction

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/storage"
)

// Config controls compaction behavior.
type Config struct {
	MinAgeDays   int    // Sessions older than this are eligible (default 14)
	MaxPerRun    int    // Max sessions to compact per invocation (default 100)
	Workers      int    // Parallel LLM calls (default 4)
	LLMProvider  string // ollama, openai, anthropic
	LLMModel     string
	LLMBaseURL   string
	LLMAPIKey    string
	Organization string // "all" or specific org
}

// Result summarizes a compaction run.
type Result struct {
	SessionsCompacted int   `json:"sessionsCompacted"`
	ChunksArchived    int   `json:"chunksArchived"`
	SummariesCreated  int   `json:"summariesCreated"`
	TokensSaved       int64 `json:"tokensSaved"`
	Errors            int   `json:"errors"`
	DurationMs        int64 `json:"durationMs"`
}

// Run executes the compaction pipeline.
func Run(ctx context.Context, db *storage.DB, embedder *ingestion.EmbeddingClient, cfg Config) (*Result, error) {
	if cfg.MinAgeDays <= 0 {
		cfg.MinAgeDays = 14
	}
	if cfg.MaxPerRun <= 0 {
		cfg.MaxPerRun = 100
	}
	if cfg.Workers <= 0 {
		cfg.Workers = 4
	}

	start := time.Now()
	result := &Result{}

	// Find eligible sessions: old, searchable, and not yet compacted.
	rows, err := db.Query(ctx, `
		SELECT s.id, s.organization_id
		FROM sessions s
		WHERE s.searchable_status = 'searchable'
		  AND s.updated_at < NOW() - ($1 || ' days')::interval
		  AND NOT EXISTS (
		    SELECT 1 FROM chunks c
		    WHERE c.session_id = s.id AND c.type = 'summary'
		  )
		  AND (SELECT count(*) FROM chunks c2 WHERE c2.session_id = s.id AND c2.confidence <> 'archived') >= 3
		ORDER BY s.updated_at ASC
		LIMIT $2`,
		fmt.Sprintf("%d", cfg.MinAgeDays), cfg.MaxPerRun)
	if err != nil {
		return nil, fmt.Errorf("find compaction candidates: %w", err)
	}
	defer rows.Close()

	type candidate struct {
		sessionID string
		orgID     string
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.sessionID, &c.orgID); err != nil {
			return nil, fmt.Errorf("scan candidate: %w", err)
		}
		if cfg.Organization != "" && cfg.Organization != "all" && c.orgID != cfg.Organization {
			continue
		}
		candidates = append(candidates, c)
	}

	slog.Info("Compaction candidates found", "count", len(candidates))

	// Process each session sequentially for now (LLM is the bottleneck, not I/O)
	for _, cand := range candidates {
		if ctx.Err() != nil {
			break
		}
		err := compactSession(ctx, db, embedder, cfg, cand.sessionID, cand.orgID, result)
		if err != nil {
			slog.Warn("Compaction failed for session", "session", cand.sessionID, "error", err)
			result.Errors++
		}
	}

	result.DurationMs = time.Since(start).Milliseconds()
	return result, nil
}

func compactSession(ctx context.Context, db *storage.DB, embedder *ingestion.EmbeddingClient, cfg Config, sessionID, orgID string, result *Result) error {
	// Load all active chunks for this session
	rows, err := db.Query(ctx, `
		SELECT id, title, content, token_count, author_id
		FROM chunks
		WHERE session_id = $1
		  AND confidence <> 'archived'
		ORDER BY created_at ASC`, sessionID)
	if err != nil {
		return fmt.Errorf("load chunks: %w", err)
	}
	defer rows.Close()

	type chunk struct {
		id         string
		title      string
		content    string
		tokenCount int
		authorID   string
	}
	var chunks []chunk
	var totalTokens int64
	for rows.Next() {
		var c chunk
		if err := rows.Scan(&c.id, &c.title, &c.content, &c.tokenCount, &c.authorID); err != nil {
			return fmt.Errorf("scan chunk: %w", err)
		}
		chunks = append(chunks, c)
		totalTokens += int64(c.tokenCount)
	}
	if len(chunks) < 3 {
		return nil // too few to bother
	}

	// Build the LLM prompt from chunk contents
	var contentBuilder strings.Builder
	for i, c := range chunks {
		fmt.Fprintf(&contentBuilder, "--- Chunk %d: %s ---\n%s\n\n", i+1, c.title, c.content)
		if contentBuilder.Len() > 12000 {
			break // keep prompt bounded
		}
	}

	summary, err := callLLM(ctx, cfg, contentBuilder.String())
	if err != nil {
		return fmt.Errorf("LLM summarize: %w", err)
	}
	if strings.TrimSpace(summary) == "" {
		return fmt.Errorf("LLM returned empty summary")
	}

	// Generate embedding for the summary
	embedding, err := embedder.Embed(ctx, summary)
	if err != nil {
		return fmt.Errorf("embed summary: %w", err)
	}

	// Transaction: insert summary chunk + archive originals
	summaryID := uuid.NewString()
	poolTx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin compact tx: %w", err)
	}
	defer poolTx.Rollback(ctx)

	// Insert summary chunk
	_, err = poolTx.Exec(ctx, `
		INSERT INTO chunks (id, session_id, title, summary, content, token_count, type,
			author_id, organization_id, embedding, embedding_model, searchable_status,
			confidence, quality_score)
		VALUES ($1, $2, $3, $4, $5, $6, 'summary', $7, $8, $9::vector, $10, 'searchable', 'high', 0.9)`,
		summaryID, sessionID,
		fmt.Sprintf("Summary: session %s", sessionID[:8]),
		summary,
		summary,
		estimateTokens(summary),
		chunks[0].authorID,
		orgID,
		storage.VectorParam(embedding),
		embedder.Model(),
	)
	if err != nil {
		return fmt.Errorf("insert summary: %w", err)
	}

	// Archive original chunks
	chunkIDs := make([]string, len(chunks))
	for i, c := range chunks {
		chunkIDs[i] = c.id
	}
	_, err = poolTx.Exec(ctx, `
		UPDATE chunks SET confidence = 'archived', updated_at = NOW()
		WHERE id = ANY($1::uuid[])`, chunkIDs)
	if err != nil {
		return fmt.Errorf("archive chunks: %w", err)
	}

	if err := poolTx.Commit(ctx); err != nil {
		return fmt.Errorf("commit compaction: %w", err)
	}

	result.SessionsCompacted++
	result.ChunksArchived += len(chunks)
	result.SummariesCreated++
	result.TokensSaved += totalTokens - int64(estimateTokens(summary))
	return nil
}

func callLLM(ctx context.Context, cfg Config, content string) (string, error) {
	system := `You are a technical knowledge summarizer. Given a set of conversation chunks from a software engineering session, produce a concise summary that preserves:
- Key decisions and their reasoning
- Technical patterns and constraints discovered
- Action items and open questions
Keep the summary factual and under 500 words. Do not invent information not present in the chunks.`

	switch cfg.LLMProvider {
	case "ollama":
		return callOllama(ctx, cfg, system, content)
	case "openai":
		return callOpenAI(ctx, cfg, system, content)
	case "anthropic":
		return callAnthropic(ctx, cfg, system, content)
	default:
		return "", fmt.Errorf("compaction requires a configured LLM provider (ollama/openai/anthropic), got %q", cfg.LLMProvider)
	}
}

func callOllama(ctx context.Context, cfg Config, system, user string) (string, error) {
	baseURL := cfg.LLMBaseURL
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	body := map[string]any{
		"model":  cfg.LLMModel,
		"stream": false,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	}
	return doLLMRequest(ctx, baseURL+"/api/chat", body, nil, "ollama")
}

func callOpenAI(ctx context.Context, cfg Config, system, user string) (string, error) {
	body := map[string]any{
		"model":      cfg.LLMModel,
		"max_tokens": 1024,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	}
	headers := map[string]string{"Authorization": "Bearer " + cfg.LLMAPIKey}
	return doLLMRequest(ctx, "https://api.openai.com/v1/chat/completions", body, headers, "openai")
}

func callAnthropic(ctx context.Context, cfg Config, system, user string) (string, error) {
	body := map[string]any{
		"model":      cfg.LLMModel,
		"max_tokens": 1024,
		"system":     system,
		"messages":   []map[string]string{{"role": "user", "content": user}},
	}
	headers := map[string]string{
		"x-api-key":         cfg.LLMAPIKey,
		"anthropic-version": "2023-06-01",
	}
	return doLLMRequest(ctx, "https://api.anthropic.com/v1/messages", body, headers, "anthropic")
}

func doLLMRequest(ctx context.Context, url string, body any, headers map[string]string, provider string) (string, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("encode %s request: %w", provider, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("create %s request: %w", provider, err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s request: %w", provider, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("%s read response: %w", provider, err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s %d: %s", provider, resp.StatusCode, string(respBody[:min(300, len(respBody))]))
	}

	return extractText(respBody, provider)
}

func extractText(body []byte, provider string) (string, error) {
	switch provider {
	case "ollama":
		var r struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(body, &r); err != nil {
			return "", fmt.Errorf("decode ollama: %w", err)
		}
		return r.Message.Content, nil
	case "openai":
		var r struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &r); err != nil {
			return "", fmt.Errorf("decode openai: %w", err)
		}
		if len(r.Choices) == 0 {
			return "", fmt.Errorf("openai returned no choices")
		}
		return r.Choices[0].Message.Content, nil
	case "anthropic":
		var r struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(body, &r); err != nil {
			return "", fmt.Errorf("decode anthropic: %w", err)
		}
		if len(r.Content) == 0 {
			return "", fmt.Errorf("anthropic returned no content")
		}
		return r.Content[0].Text, nil
	default:
		return "", fmt.Errorf("unknown provider %q", provider)
	}
}

func estimateTokens(text string) int {
	// Rough approximation: 1 token ≈ 4 characters for English text
	return len(text) / 4
}

// LoadConfigFromEnv reads compaction settings from environment variables.
func LoadConfigFromEnv() Config {
	return Config{
		MinAgeDays:   envInt("COMPACTION_MIN_AGE_DAYS", 14),
		MaxPerRun:    envInt("COMPACTION_MAX_PER_RUN", 100),
		Workers:      envInt("COMPACTION_WORKERS", 4),
		LLMProvider:  os.Getenv("LLM_PROVIDER"),
		LLMModel:     os.Getenv("LLM_MODEL"),
		LLMBaseURL:   os.Getenv("LLM_BASE_URL"),
		LLMAPIKey:    coalesce(os.Getenv("OPENAI_API_KEY"), os.Getenv("ANTHROPIC_API_KEY")),
		Organization: coalesce(os.Getenv("COMPACTION_ORGANIZATIONS"), "all"),
	}
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	var i int
	if _, err := fmt.Sscanf(v, "%d", &i); err == nil && i > 0 {
		return i
	}
	return fallback
}

func coalesce(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
