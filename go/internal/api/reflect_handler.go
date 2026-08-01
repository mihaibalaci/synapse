package api

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
	"unicode"

	"github.com/google/uuid"
	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/models"
	"github.com/mihaibalaci/synapse/internal/retrieval"
)

// handleReflect performs deep reasoning over stored knowledge using the
// configured LLM. It searches relevant context, reasons about it, and
// optionally writes back new insights as facts.
func handleReflectReal(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	var req struct {
		Query     string `json:"query"`
		WriteBack bool   `json:"writeBack"`
		MaxFacts  int    `json:"maxFacts"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body")
		return
	}
	if req.Query == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "query is required")
		return
	}
	if req.MaxFacts <= 0 {
		req.MaxFacts = 3
	}

	app := appFromRequest(r)
	ctx := r.Context()

	// 1. Search for relevant context
	searchReq := &models.SearchRequest{
		Query:          req.Query,
		TopK:           10,
		MaxTokens:      4000,
		IncludeContent: true,
	}
	engine := newRetrievalEngine(app)
	searchResp, err := engine.Search(ctx, searchReq, claims)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SEARCH_ERROR", err.Error())
		return
	}

	// 2. Get relevant facts
	entities := simpleEntityExtract(req.Query)
	var existingFacts []models.Fact
	if len(entities) > 0 {
		existingFacts, _ = app.Facts.FindByEntities(ctx, entities, claims.OrganizationID, 20)
	}

	// 3. Build LLM prompt with context
	contextText := buildReflectContext(searchResp.Results, existingFacts)
	if contextText == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"reflectId": uuid.NewString(), "query": req.Query,
			"answer":     "No relevant knowledge found to reflect on.",
			"confidence": "none", "sources": []any{}, "insights": []any{},
		})
		return
	}

	// 4. Call LLM for reasoning
	answer, insights, err := callReflectLLM(ctx, req.Query, contextText, req.MaxFacts)
	if err != nil {
		slog.Warn("Reflect LLM call failed", "error", err)
		writeJSON(w, http.StatusOK, map[string]any{
			"reflectId": uuid.NewString(), "query": req.Query,
			"answer":     "LLM reasoning is unavailable. Context was found but could not be synthesized.",
			"confidence": "low", "sources": sourceIDs(searchResp.Results), "insights": []any{},
		})
		return
	}

	// 5. Optionally write back insights as facts
	var writtenFacts []map[string]any
	if req.WriteBack && len(insights) > 0 {
		for _, insight := range insights {
			fact := &models.Fact{
				ID:             uuid.NewString(),
				Content:        insight.Content,
				Type:           insight.Type,
				Entities:       insight.Entities,
				ExtractedFrom:  "reflect",
				AuthorID:       claims.UserID,
				OrganizationID: claims.OrganizationID,
				Scope:          "organization",
				Confidence:     0.8,
				Frameworks:     []string{},
			}
			if err := app.Facts.Create(ctx, fact); err == nil {
				writtenFacts = append(writtenFacts, map[string]any{
					"id": fact.ID, "content": fact.Content, "type": fact.Type, "entities": fact.Entities,
				})
			}
		}
	}
	if writtenFacts == nil {
		writtenFacts = []map[string]any{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"reflectId":  uuid.NewString(),
		"query":      req.Query,
		"answer":     answer,
		"confidence": "high",
		"reasoning":  fmt.Sprintf("Synthesized from %d chunks and %d existing facts", len(searchResp.Results), len(existingFacts)),
		"sources":    sourceIDs(searchResp.Results),
		"insights":   writtenFacts,
	})
}

type reflectInsight struct {
	Content  string   `json:"content"`
	Type     string   `json:"type"`
	Entities []string `json:"entities"`
}

func buildReflectContext(results []models.SearchResult, facts []models.Fact) string {
	var b strings.Builder
	for i, r := range results {
		if i >= 5 {
			break
		}
		fmt.Fprintf(&b, "--- Source %d ---\n%s\n\n", i+1, r.Content)
	}
	if len(facts) > 0 {
		b.WriteString("--- Existing Facts ---\n")
		for _, f := range facts {
			fmt.Fprintf(&b, "- [%s] %s (entities: %s)\n", f.Type, f.Content, strings.Join(f.Entities, ", "))
		}
	}
	return b.String()
}

func sourceIDs(results []models.SearchResult) []string {
	ids := make([]string, 0, len(results))
	for _, r := range results {
		ids = append(ids, r.ID)
	}
	return ids
}

func callReflectLLM(ctx context.Context, query, contextText string, maxInsights int) (string, []reflectInsight, error) {
	provider := os.Getenv("LLM_PROVIDER")
	model := os.Getenv("LLM_MODEL")
	baseURL := os.Getenv("LLM_BASE_URL")
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}

	if provider == "" || provider == "local-none" || provider == "none" {
		return "", nil, fmt.Errorf("no LLM provider configured")
	}

	system := fmt.Sprintf(`You are a technical knowledge synthesizer. Given a question and relevant context from a team's engineering knowledge base, provide:
1. A clear, factual answer based only on the provided context.
2. Up to %d new insights that could be stored as atomic facts (in JSON array format).

Format your response as JSON:
{"answer": "...", "insights": [{"content": "...", "type": "decision|lesson|pattern|constraint", "entities": ["entity1"]}]}

Do not invent information not present in the context.`, maxInsights)

	user := fmt.Sprintf("QUESTION: %s\n\nCONTEXT:\n%s", query, contextText)

	var respText string
	var err error

	switch provider {
	case "ollama":
		if baseURL == "" {
			baseURL = "http://localhost:11434"
		}
		respText, err = doReflectLLM(ctx, baseURL+"/api/chat", map[string]any{
			"model": model, "stream": false,
			"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}},
		}, nil, "ollama")
	case "openai":
		respText, err = doReflectLLM(ctx, "https://api.openai.com/v1/chat/completions", map[string]any{
			"model": model, "max_tokens": 2048,
			"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}},
		}, map[string]string{"Authorization": "Bearer " + apiKey}, "openai")
	case "anthropic":
		respText, err = doReflectLLM(ctx, "https://api.anthropic.com/v1/messages", map[string]any{
			"model": model, "max_tokens": 2048, "system": system,
			"messages": []map[string]string{{"role": "user", "content": user}},
		}, map[string]string{"x-api-key": apiKey, "anthropic-version": "2023-06-01"}, "anthropic")
	default:
		return "", nil, fmt.Errorf("unsupported LLM provider: %s", provider)
	}
	if err != nil {
		return "", nil, err
	}

	// Parse structured response
	var parsed struct {
		Answer   string           `json:"answer"`
		Insights []reflectInsight `json:"insights"`
	}
	if err := json.Unmarshal([]byte(respText), &parsed); err != nil {
		// LLM didn't return valid JSON; use raw text as answer
		return respText, nil, nil
	}
	return parsed.Answer, parsed.Insights, nil
}

func doReflectLLM(ctx context.Context, url string, body any, headers map[string]string, provider string) (string, error) {
	data, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s: %w", provider, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s %d: %s", provider, resp.StatusCode, string(respBody[:min(200, len(respBody))]))
	}

	switch provider {
	case "ollama":
		var r struct{ Message struct{ Content string } }
		json.Unmarshal(respBody, &r)
		return r.Message.Content, nil
	case "openai":
		var r struct {
			Choices []struct{ Message struct{ Content string } }
		}
		json.Unmarshal(respBody, &r)
		if len(r.Choices) > 0 {
			return r.Choices[0].Message.Content, nil
		}
		return "", fmt.Errorf("openai: no choices")
	case "anthropic":
		var r struct{ Content []struct{ Text string } }
		json.Unmarshal(respBody, &r)
		if len(r.Content) > 0 {
			return r.Content[0].Text, nil
		}
		return "", fmt.Errorf("anthropic: no content")
	}
	return "", fmt.Errorf("unknown provider")
}

// newRetrieval creates a retrieval engine for internal use.
func newRetrieval(app *App) *retrieval.Engine {
	return retrieval.NewEngine(app.DB, app.Cache, app.Chunks, app.Facts, app.Embedder)
}

// newRetrievalEngine creates a retrieval engine from the app dependencies.
func newRetrievalEngine(app *App) *retrieval.Engine {
	return newRetrieval(app)
}

// simpleEntityExtract pulls capitalized multi-char words as entity candidates.
func simpleEntityExtract(query string) []string {
	words := strings.Fields(query)
	var entities []string
	for _, w := range words {
		clean := strings.TrimFunc(w, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
		if len(clean) >= 2 && unicode.IsUpper(rune(clean[0])) {
			entities = append(entities, clean)
		}
	}
	return entities
}
