package api

import (
	"net/http"
	"sync/atomic"

	"github.com/mihaibalaci/synapse/internal/auth"
)

// Feature 5: Token cost attribution.
// Tracks LLM token usage per request type and exposes in metrics.

var (
	llmInputTokens     int64
	llmOutputTokens    int64
	llmCallCount       int64
	compactionTokens   int64
	reflectTokens      int64
	contradictionCalls int64
)

// RecordLLMUsage records token usage from an LLM call.
func RecordLLMUsage(callType string, inputTokens, outputTokens int) {
	atomic.AddInt64(&llmInputTokens, int64(inputTokens))
	atomic.AddInt64(&llmOutputTokens, int64(outputTokens))
	atomic.AddInt64(&llmCallCount, 1)
	switch callType {
	case "compaction":
		atomic.AddInt64(&compactionTokens, int64(inputTokens+outputTokens))
	case "reflect":
		atomic.AddInt64(&reflectTokens, int64(inputTokens+outputTokens))
	case "contradiction":
		atomic.AddInt64(&contradictionCalls, 1)
	}
}

// handleTokenCosts returns LLM token usage breakdown for the admin dashboard.
func handleTokenCosts(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	// Estimate costs (approximate, based on common pricing)
	inputCost := float64(atomic.LoadInt64(&llmInputTokens)) * 0.000003   // $3/M input tokens
	outputCost := float64(atomic.LoadInt64(&llmOutputTokens)) * 0.000015 // $15/M output tokens

	writeJSON(w, http.StatusOK, map[string]any{
		"tokens": map[string]any{
			"inputTotal":  atomic.LoadInt64(&llmInputTokens),
			"outputTotal": atomic.LoadInt64(&llmOutputTokens),
			"callCount":   atomic.LoadInt64(&llmCallCount),
		},
		"byType": map[string]any{
			"compaction":    atomic.LoadInt64(&compactionTokens),
			"reflect":       atomic.LoadInt64(&reflectTokens),
			"contradiction": atomic.LoadInt64(&contradictionCalls),
		},
		"estimatedCost": map[string]any{
			"inputUSD":  inputCost,
			"outputUSD": outputCost,
			"totalUSD":  inputCost + outputCost,
			"note":      "Estimates based on typical API pricing. Ollama local inference has zero token cost.",
		},
	})
}
