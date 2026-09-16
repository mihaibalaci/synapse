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
	"strconv"
	"strings"
	"time"

	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/storage"
)

// Chunk types produced by the three compaction levels. They are ordinary
// searchable chunks; the type records how far the content has been condensed.
const (
	TypeSessionSummary      = "summary"              // one capture batch
	TypeConversationSummary = "conversation_summary" // every batch of one conversation
	TypeTopicSummary        = "topic_summary"        // several conversations on one topic
)

// defaultLLMTimeout bounds one summarization request when nothing is configured.
const defaultLLMTimeout = 120 * time.Second

// Config controls compaction behavior.
//
// The two age settings use a three-way convention so that both a bare Config{}
// literal and an operator asking for immediate compaction get what they expect:
// zero means "unset" and takes the safe default, a positive value is a threshold
// in days, and a negative value is an explicit "no age gate".
type Config struct {
	MinAgeDays   int    // Sessions older than this are eligible (0 = default 14, negative = no gate)
	MaxPerRun    int    // Max sessions to compact per invocation (default 100)
	Workers      int    // Parallel LLM calls (default 4)
	LLMProvider  string // ollama, openai, anthropic
	LLMModel     string
	LLMBaseURL   string
	LLMAPIKey    string
	Organization string // "all" or specific org
	// LLMTimeout bounds a single summarization request. Self-hosted CPU
	// inference is far slower than a hosted API, so this has to be tunable
	// rather than a fixed value that quietly fails every run on small hardware.
	LLMTimeout time.Duration

	// ─── Topic consolidation (level 3) ───────────────────────────────────────
	// TopicEnabled turns the cross-conversation phase on (default true).
	TopicEnabled bool
	// TopicMinAgeDays keeps conversation summaries intact for a while before
	// they are folded into a topic summary, so a run does not immediately
	// discard the per-conversation view it just produced. Zero derives 2x
	// MinAgeDays; negative disables the gate.
	TopicMinAgeDays int
	// TopicSimilarity is the minimum cosine similarity for two summaries to be
	// considered the same topic (default 0.82).
	TopicSimilarity float64
	// TopicMinConversations is how many distinct conversations a topic group
	// must span before it is worth merging (default 2).
	TopicMinConversations int
	// TopicMaxClusters caps topic merges per run (default 50).
	TopicMaxClusters int
}

// Result summarizes a compaction run.
type Result struct {
	ConversationsCompacted int   `json:"conversationsCompacted"`
	SessionsCompacted      int   `json:"sessionsCompacted"`
	TopicsCompacted        int   `json:"topicsCompacted"`
	ChunksArchived         int   `json:"chunksArchived"`
	SummariesCreated       int   `json:"summariesCreated"`
	TokensSaved            int64 `json:"tokensSaved"`
	Errors                 int   `json:"errors"`
	DurationMs             int64 `json:"durationMs"`
}

// Run executes the compaction pipeline in three ordered levels, coarsening one
// step at a time so nothing is summarized out of order:
//
//  1. Conversations. A live conversation is captured as several batches, so its
//     sessions are consolidated into one conversation summary first. Compacting
//     those batches separately would produce several partial summaries of the
//     same discussion.
//  2. Standalone sessions. Only sessions that are not part of a multi-batch
//     conversation are summarized on their own.
//  3. Topics. Conversation and session summaries that cover the same subject
//     across different conversations are merged into one topic summary.
//
// Every level replaces its inputs by inserting a summary and marking the inputs
// archived. Nothing is deleted, and the verbatim capture in object storage is
// never touched, so any level can be rebuilt from source.
func Run(ctx context.Context, db *storage.DB, embedder *ingestion.EmbeddingClient, cfg Config) (*Result, error) {
	cfg = cfg.withDefaults()

	start := time.Now()
	result := &Result{}

	// Level 1: same conversation → one summary.
	if err := compactConversations(ctx, db, embedder, cfg, result); err != nil {
		return nil, err
	}

	// Level 2: sessions that belong to no multi-batch conversation.
	if err := compactSessions(ctx, db, embedder, cfg, result); err != nil {
		return nil, err
	}

	// Level 3: same topic across conversations. Runs last so it operates on the
	// summaries the earlier levels produced.
	if cfg.TopicEnabled {
		if err := compactTopics(ctx, db, embedder, cfg, result); err != nil {
			return nil, err
		}
	}

	result.DurationMs = time.Since(start).Milliseconds()
	return result, nil
}

// withDefaults fills in the settings a caller left unset.
func (c Config) withDefaults() Config {
	// Zero is "unset", so a Config{} literal still gets the conservative 14-day
	// gate. Negative is the deliberate "compact regardless of age" opt-in, which
	// configuration expresses as 0 and LoadConfigFromEnv translates.
	switch {
	case c.MinAgeDays == 0:
		c.MinAgeDays = 14
	case c.MinAgeDays < 0:
		c.MinAgeDays = 0
	}
	if c.MaxPerRun <= 0 {
		c.MaxPerRun = 100
	}
	if c.LLMTimeout <= 0 {
		c.LLMTimeout = defaultLLMTimeout
	}
	if c.Workers <= 0 {
		c.Workers = 4
	}
	switch {
	case c.TopicMinAgeDays == 0:
		c.TopicMinAgeDays = c.MinAgeDays * 2
	case c.TopicMinAgeDays < 0:
		c.TopicMinAgeDays = 0
	}
	if c.TopicSimilarity <= 0 {
		c.TopicSimilarity = 0.82
	}
	if c.TopicMinConversations <= 0 {
		c.TopicMinConversations = 2
	}
	if c.TopicMaxClusters <= 0 {
		c.TopicMaxClusters = 50
	}
	return c
}

// orgFilter renders the organization scope as a SQL-friendly parameter. "all"
// (or empty) matches every organization. Filtering happens in SQL rather than
// after the row limit, so a busy organization cannot starve the requested one.
func (c Config) orgFilter() string {
	if c.Organization == "" {
		return "all"
	}
	return c.Organization
}

// compactSessions summarizes individual sessions that stand alone: either the
// client sent no conversation id, or the conversation produced a single batch.
// Sessions belonging to a multi-batch conversation are deliberately skipped here
// because level 1 owns them.
func compactSessions(ctx context.Context, db *storage.DB, embedder *ingestion.EmbeddingClient, cfg Config, result *Result) error {
	rows, err := db.Query(ctx, `
		SELECT s.id, s.organization_id
		FROM sessions s
		WHERE s.searchable_status = 'searchable'
		  AND s.updated_at < NOW() - make_interval(days => $1::int)
		  AND ($2 = 'all' OR s.organization_id = $2)
		  AND NOT EXISTS (
		    SELECT 1 FROM chunks c
		    WHERE c.session_id = s.id
		      AND c.type IN ('summary', 'conversation_summary', 'topic_summary')
		  )
		  AND (
		    s.conversation_id = ''
		    OR (SELECT count(*) FROM sessions sib
		        WHERE sib.organization_id = s.organization_id
		          AND sib.conversation_id = s.conversation_id) = 1
		  )
		  AND (SELECT count(*) FROM chunks c2
		       WHERE c2.session_id = s.id AND c2.confidence <> 'archived') >= 3
		ORDER BY s.updated_at ASC
		LIMIT $3`,
		cfg.MinAgeDays, cfg.orgFilter(), cfg.MaxPerRun)
	if err != nil {
		return fmt.Errorf("find session candidates: %w", err)
	}

	type candidate struct{ sessionID, orgID string }
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.sessionID, &c.orgID); err != nil {
			rows.Close()
			return fmt.Errorf("scan session candidate: %w", err)
		}
		candidates = append(candidates, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fmt.Errorf("read session candidates: %w", err)
	}

	slog.Info("Session compaction candidates found", "count", len(candidates))

	// Sequential: the LLM call is the bottleneck, not the database.
	for _, cand := range candidates {
		if ctx.Err() != nil {
			break
		}
		if err := compactSession(ctx, db, embedder, cfg, cand.sessionID, cand.orgID, result); err != nil {
			slog.Warn("Compaction failed for session", "session", cand.sessionID, "error", err)
			result.Errors++
		}
	}
	return nil
}

func compactSession(ctx context.Context, db *storage.DB, embedder *ingestion.EmbeddingClient, cfg Config, sessionID, orgID string, result *Result) error {
	members, err := loadActiveChunks(ctx, db, []string{sessionID})
	if err != nil {
		return err
	}
	if len(members) < 3 {
		return nil // too few to bother
	}

	return summarizeAndArchive(ctx, db, embedder, cfg, summarizeRequest{
		orgID:           orgID,
		attachSessionID: sessionID,
		chunkType:       TypeSessionSummary,
		title:           fmt.Sprintf("Summary: session %s", shortID(sessionID)),
		system:          sessionSummarySystemPrompt,
		members:         members,
		counter:         &result.SessionsCompacted,
	}, result)
}

// callLLM summarizes content with the system prompt for the compaction level
// being run. Each level needs different instructions: a session summary
// describes one batch, a conversation summary has to reconcile a discussion that
// arrived in pieces, and a topic summary has to generalize across conversations.
func callLLM(ctx context.Context, cfg Config, rawSystem, content string) (string, error) {
	// OUTPUT OPTIMIZATION: Apply verbosity steering to reduce output tokens
	system := OptimizedSystemPrompt(rawSystem)

	// EFFORT ROUTING: Compaction is routine — use minimal effort settings
	effort := RouteEffort("compaction")

	switch cfg.LLMProvider {
	case "ollama":
		return callOllama(ctx, cfg, system, content, effort)
	case "openai":
		return callOpenAICompact(ctx, cfg, system, content, effort)
	case "anthropic":
		return callAnthropicCompact(ctx, cfg, system, content, effort)
	default:
		return "", fmt.Errorf("compaction requires a configured LLM provider (ollama/openai/anthropic), got %q", cfg.LLMProvider)
	}
}

func callOllama(ctx context.Context, cfg Config, system, user string, effort EffortLevel) (string, error) {
	baseURL := cfg.LLMBaseURL
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	body := map[string]any{
		"model":  cfg.LLMModel,
		"stream": false,
		// Effort routing has to be expressed as Ollama options. Without
		// num_predict the model generates until it decides to stop, which on a
		// self-hosted CPU deployment runs far past any sensible request timeout.
		"options": map[string]any{
			"num_predict": MaxTokensForEffort(effort),
			"temperature": TemperatureForEffort(effort),
		},
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	}
	return doLLMRequest(ctx, baseURL+"/api/chat", body, nil, "ollama", cfg.LLMTimeout)
}

func callOpenAICompact(ctx context.Context, cfg Config, system, user string, effort EffortLevel) (string, error) {
	body := map[string]any{
		"model":       cfg.LLMModel,
		"max_tokens":  MaxTokensForEffort(effort),
		"temperature": TemperatureForEffort(effort),
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	}
	headers := map[string]string{"Authorization": "Bearer " + cfg.LLMAPIKey}
	return doLLMRequest(ctx, "https://api.openai.com/v1/chat/completions", body, headers, "openai", cfg.LLMTimeout)
}

func callAnthropicCompact(ctx context.Context, cfg Config, system, user string, effort EffortLevel) (string, error) {
	body := map[string]any{
		"model":       cfg.LLMModel,
		"max_tokens":  MaxTokensForEffort(effort),
		"temperature": TemperatureForEffort(effort),
		"system":      system,
		"messages":    []map[string]string{{"role": "user", "content": user}},
	}
	headers := map[string]string{
		"x-api-key":         cfg.LLMAPIKey,
		"anthropic-version": "2023-06-01",
	}
	return doLLMRequest(ctx, "https://api.anthropic.com/v1/messages", body, headers, "anthropic", cfg.LLMTimeout)
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
	return doLLMRequest(ctx, "https://api.openai.com/v1/chat/completions", body, headers, "openai", cfg.LLMTimeout)
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
	return doLLMRequest(ctx, "https://api.anthropic.com/v1/messages", body, headers, "anthropic", cfg.LLMTimeout)
}

func doLLMRequest(ctx context.Context, url string, body any, headers map[string]string, provider string, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = defaultLLMTimeout
	}
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

	client := &http.Client{Timeout: timeout}
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
		MinAgeDays:   envAgeDays("COMPACTION_MIN_AGE_DAYS", 14),
		MaxPerRun:    envInt("COMPACTION_MAX_PER_RUN", 100),
		Workers:      envInt("COMPACTION_WORKERS", 4),
		LLMProvider:  os.Getenv("LLM_PROVIDER"),
		LLMModel:     os.Getenv("LLM_MODEL"),
		LLMBaseURL:   os.Getenv("LLM_BASE_URL"),
		LLMAPIKey:    coalesce(os.Getenv("OPENAI_API_KEY"), os.Getenv("ANTHROPIC_API_KEY")),
		Organization: coalesce(os.Getenv("COMPACTION_ORGANIZATIONS"), "all"),
		LLMTimeout: time.Duration(envInt("COMPACTION_LLM_TIMEOUT_SECONDS",
			int(defaultLLMTimeout/time.Second))) * time.Second,

		TopicEnabled:          envBool("COMPACTION_TOPIC_ENABLED", true),
		TopicMinAgeDays:       envAgeDays("COMPACTION_TOPIC_MIN_AGE_DAYS", 0), // unset → 2x MinAgeDays
		TopicSimilarity:       envFloat("COMPACTION_TOPIC_SIMILARITY", 0.82),
		TopicMinConversations: envInt("COMPACTION_TOPIC_MIN_CONVERSATIONS", 2),
		TopicMaxClusters:      envInt("COMPACTION_MAX_CLUSTERS", 50),
	}
}

// envAgeDays reads an age-in-days threshold. An explicit 0 means "no age gate"
// and is carried as -1, because the struct reserves 0 for "unset" so that a
// Config{} literal cannot accidentally compact everything ever captured.
func envAgeDays(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	i, err := strconv.Atoi(v)
	if err != nil || i < 0 {
		return fallback
	}
	if i == 0 {
		return -1
	}
	return i
}

// envBool reads a boolean setting. Unlike envInt it must distinguish "unset"
// from "explicitly false", so an unparseable value falls back rather than
// silently enabling a phase the operator tried to turn off.
func envBool(key string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envFloat(key string, fallback float64) float64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f <= 0 || f > 1 {
		return fallback
	}
	return f
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
