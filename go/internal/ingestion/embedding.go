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
	"time"
)

// EmbeddingClient handles vector embedding generation from multiple providers.
type EmbeddingClient struct {
	provider   string
	model      string
	dimensions int
	url        string
	apiKey     string
	client     *http.Client
}

// NewEmbeddingClient creates an embedding client from environment config.
func NewEmbeddingClient() *EmbeddingClient {
	return &EmbeddingClient{
		provider:   envOr("EMBEDDING_PROVIDER", "local"),
		model:      envOr("EMBEDDING_MODEL", "synapse-local-1536"),
		dimensions: envIntOr("EMBEDDING_DIMENSIONS", 1536),
		url:        os.Getenv("EMBEDDING_URL"),
		apiKey:     os.Getenv("OPENAI_API_KEY"),
		client:     &http.Client{Timeout: 30 * time.Second},
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

	switch e.provider {
	case "openai":
		return e.callOpenAI(ctx, texts)
	case "ollama":
		return e.callOllama(ctx, texts)
	case "tei":
		return e.callTEI(ctx, texts)
	case "local":
		return e.generateLocal(texts), nil
	default:
		return e.generateLocal(texts), nil
	}
}

func (e *EmbeddingClient) callOpenAI(ctx context.Context, texts []string) ([][]float64, error) {
	body := map[string]any{
		"model":      e.model,
		"input":      texts,
		"dimensions": e.dimensions,
	}
	data, _ := json.Marshal(body)

	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/embeddings", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.apiKey)

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai embed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("openai %d: %s", resp.StatusCode, string(respBody[:min(200, len(respBody))]))
	}

	var result struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	json.Unmarshal(respBody, &result)

	embeddings := make([][]float64, len(result.Data))
	for i, d := range result.Data {
		embeddings[i] = d.Embedding
	}
	return embeddings, nil
}

func (e *EmbeddingClient) callOllama(ctx context.Context, texts []string) ([][]float64, error) {
	var embeddings [][]float64
	for _, text := range texts {
		body := map[string]any{"model": e.model, "prompt": text}
		data, _ := json.Marshal(body)

		req, _ := http.NewRequestWithContext(ctx, "POST", e.url+"/api/embeddings", bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")

		resp, err := e.client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		var result struct {
			Embedding []float64 `json:"embedding"`
		}
		json.NewDecoder(resp.Body).Decode(&result)
		embeddings = append(embeddings, result.Embedding)
	}
	return embeddings, nil
}

func (e *EmbeddingClient) callTEI(ctx context.Context, texts []string) ([][]float64, error) {
	body := map[string]any{"inputs": texts, "truncate": true}
	data, _ := json.Marshal(body)

	req, _ := http.NewRequestWithContext(ctx, "POST", e.url+"/embed", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var embeddings [][]float64
	json.NewDecoder(resp.Body).Decode(&embeddings)
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
