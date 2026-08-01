package ingestion

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"runtime"
	"time"
)

// EmbeddingClient handles vector embedding generation from multiple providers.
type EmbeddingClient struct {
	provider   string
	model      string
	dimensions int
	url        string
	apiKey     string
	numThread  int
	client     *http.Client
}

// NewEmbeddingClient creates an embedding client from environment config.
func NewEmbeddingClient() *EmbeddingClient {
	// runtime.NumCPU reflects the cgroup-visible CPU count, which is what local
	// inference should be sized to. EMBEDDING_NUM_THREADS overrides it.
	threads := envIntOr("EMBEDDING_NUM_THREADS", runtime.NumCPU())

	return &EmbeddingClient{
		provider:   envOr("EMBEDDING_PROVIDER", "local"),
		model:      envOr("EMBEDDING_MODEL", "nomic-embed-text"),
		dimensions: envIntOr("EMBEDDING_DIMENSIONS", 768),
		url:        envOr("EMBEDDING_URL", "http://localhost:11434"),
		apiKey:     os.Getenv("OPENAI_API_KEY"),
		numThread:  threads,
		client:     &http.Client{Timeout: 60 * time.Second},
	}
}

// Model returns the configured model name.
func (e *EmbeddingClient) Model() string { return e.model }

// Embed generates an embedding for a single text.
func (e *EmbeddingClient) Embed(ctx context.Context, text string) ([]float64, error) {
	results, err := e.EmbedBatch(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("no embedding returned")
	}
	return results[0], nil
}

// EmbedBatch generates embeddings for multiple texts.
func (e *EmbeddingClient) EmbedBatch(ctx context.Context, texts []string) ([][]float64, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	// Truncate long texts
	for i := range texts {
		if len(texts[i]) > 8000 {
			texts[i] = texts[i][:8000]
		}
	}

	var (
		embeddings [][]float64
		err        error
	)
	switch e.provider {
	case "openai":
		embeddings, err = e.callOpenAI(ctx, texts)
	case "ollama":
		embeddings, err = e.callOllama(ctx, texts)
	case "tei":
		embeddings, err = e.callTEI(ctx, texts)
	case "local":
		embeddings = e.generateLocal(texts)
	default:
		return nil, fmt.Errorf("unsupported embedding provider %q", e.provider)
	}
	if err != nil {
		return nil, err
	}
	if len(embeddings) != len(texts) {
		return nil, fmt.Errorf("embedding provider returned %d vectors for %d inputs", len(embeddings), len(texts))
	}
	for i, vector := range embeddings {
		if len(vector) != e.dimensions {
			return nil, fmt.Errorf("embedding %d has %d dimensions; expected %d", i, len(vector), e.dimensions)
		}
		for _, value := range vector {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return nil, fmt.Errorf("embedding %d contains a non-finite value", i)
			}
		}
	}
	return embeddings, nil
}

func (e *EmbeddingClient) callOpenAI(ctx context.Context, texts []string) ([][]float64, error) {
	if e.apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY is required for the openai embedding provider")
	}
	body := map[string]any{
		"model":      e.model,
		"input":      texts,
		"dimensions": e.dimensions,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode openai request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/embeddings", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create openai request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.apiKey)

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai embed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("openai read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openai %d: %s", resp.StatusCode, string(respBody[:min(200, len(respBody))]))
	}

	var result struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("openai decode: %w", err)
	}

	embeddings := make([][]float64, len(result.Data))
	for i, d := range result.Data {
		embeddings[i] = d.Embedding
	}
	return embeddings, nil
}

// callOllama embeds a batch via Ollama's /api/embed endpoint.
//
// Two details matter for latency. First, /api/embed accepts an array and
// returns all vectors in one round trip, unlike the older /api/embeddings which
// takes a single prompt. Second, num_thread must be set explicitly: inside a
// container llama.cpp reads the host's CPU count, so on a 4-core LXC guest it
// defaults to 16 threads and thrashes. Measured on the test box, a short embed
// went from ~8s at the default to ~57ms with num_thread matching the real core
// count.
func (e *EmbeddingClient) callOllama(ctx context.Context, texts []string) ([][]float64, error) {
	body := map[string]any{
		"model":   e.model,
		"input":   texts,
		"options": map[string]any{"num_thread": e.numThread},
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode ollama request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url+"/api/embed", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama embed: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("ollama read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama %d: %s", resp.StatusCode,
			string(payload[:min(300, len(payload))]))
	}

	var result struct {
		Embeddings [][]float64 `json:"embeddings"`
	}
	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, fmt.Errorf("ollama decode: %w", err)
	}
	if len(result.Embeddings) != len(texts) {
		return nil, fmt.Errorf("ollama returned %d embeddings for %d inputs",
			len(result.Embeddings), len(texts))
	}
	return result.Embeddings, nil
}

func (e *EmbeddingClient) callTEI(ctx context.Context, texts []string) ([][]float64, error) {
	body := map[string]any{"inputs": texts, "truncate": true}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode tei request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url+"/embed", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create tei request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tei embed: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("tei read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tei %d: %s", resp.StatusCode, string(payload[:min(300, len(payload))]))
	}

	var embeddings [][]float64
	if err := json.Unmarshal(payload, &embeddings); err != nil {
		return nil, fmt.Errorf("tei decode: %w", err)
	}
	return embeddings, nil
}

// generateLocal produces deterministic pseudo-embeddings (dev/test only).
func (e *EmbeddingClient) generateLocal(texts []string) [][]float64 {
	embeddings := make([][]float64, len(texts))
	for i, text := range texts {
		emb := make([]float64, e.dimensions)
		for j, b := range []byte(text) {
			emb[j%e.dimensions] += float64(b) / 1000.0
		}
		// L2 normalize
		norm := 0.0
		for _, v := range emb {
			norm += v * v
		}
		norm = math.Sqrt(norm)
		if norm > 0 {
			for j := range emb {
				emb[j] /= norm
			}
		}
		embeddings[i] = emb
	}
	return embeddings
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		var i int
		fmt.Sscanf(v, "%d", &i)
		if i > 0 {
			return i
		}
	}
	return fallback
}

// init logs the embedding provider at startup.
func init() {
	provider := envOr("EMBEDDING_PROVIDER", "local")
	slog.Debug("Embedding client initialized", "provider", provider)
}
