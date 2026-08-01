package retrieval

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// SignalWeights holds the per-signal importance for ranking. These are learned
// from user feedback (upvotes/downvotes on search results) and stored per
// organization as a system setting.
type SignalWeights struct {
	Semantic float64 `json:"semantic"`
	Keyword  float64 `json:"keyword"`
	Entity   float64 `json:"entity"`
	Graph    float64 `json:"graph"`
	Temporal float64 `json:"temporal"`
	Usage    float64 `json:"usage"`
	Quality  float64 `json:"quality"`
	Repo     float64 `json:"repo"`
}

// DefaultWeights returns the baseline signal weights.
func DefaultWeights() SignalWeights {
	return SignalWeights{
		Semantic: 0.25, Keyword: 0.10, Entity: 0.08, Graph: 0.07,
		Temporal: 0.15, Usage: 0.10, Quality: 0.08, Repo: 0.12,
	}
}

// AdaptiveStrategy learns and applies per-organization signal weights.
type AdaptiveStrategy struct {
	mu       sync.RWMutex
	cache    map[string]SignalWeights
	settings *storage.SettingsRepo
}

// NewAdaptiveStrategy creates an adaptive retrieval strategy backed by settings.
func NewAdaptiveStrategy(settings *storage.SettingsRepo) *AdaptiveStrategy {
	return &AdaptiveStrategy{
		cache:    make(map[string]SignalWeights),
		settings: settings,
	}
}

// GetWeights returns the signal weights for an organization, falling back to defaults.
func (s *AdaptiveStrategy) GetWeights(ctx context.Context, orgID string) SignalWeights {
	s.mu.RLock()
	if w, ok := s.cache[orgID]; ok {
		s.mu.RUnlock()
		return w
	}
	s.mu.RUnlock()

	// Load from settings
	w := DefaultWeights()
	if s.settings != nil {
		var stored SignalWeights
		if found, err := s.settings.Get(ctx, "retrieval_weights_"+orgID, &stored); err == nil && found {
			w = stored
		}
	}

	s.mu.Lock()
	s.cache[orgID] = w
	s.mu.Unlock()
	return w
}

// RecordFeedback adjusts weights based on user feedback. A positive score
// reinforces the signals that contributed to the result; negative weakens them.
func (s *AdaptiveStrategy) RecordFeedback(ctx context.Context, orgID string, resultSignals SignalWeights, positive bool) {
	w := s.GetWeights(ctx, orgID)
	lr := 0.01 // learning rate
	if !positive {
		lr = -lr
	}

	// Nudge weights toward the signals that contributed to this result
	w.Semantic += lr * resultSignals.Semantic
	w.Keyword += lr * resultSignals.Keyword
	w.Entity += lr * resultSignals.Entity
	w.Graph += lr * resultSignals.Graph
	w.Temporal += lr * resultSignals.Temporal
	w.Usage += lr * resultSignals.Usage
	w.Quality += lr * resultSignals.Quality
	w.Repo += lr * resultSignals.Repo

	// Normalize to sum to 1.0
	total := w.Semantic + w.Keyword + w.Entity + w.Graph + w.Temporal + w.Usage + w.Quality + w.Repo
	if total > 0 {
		w.Semantic /= total
		w.Keyword /= total
		w.Entity /= total
		w.Graph /= total
		w.Temporal /= total
		w.Usage /= total
		w.Quality /= total
		w.Repo /= total
	}

	// Clamp minimums (no signal should go below 0.02)
	clamp := func(v *float64) {
		if *v < 0.02 {
			*v = 0.02
		}
	}
	clamp(&w.Semantic)
	clamp(&w.Keyword)
	clamp(&w.Entity)
	clamp(&w.Graph)
	clamp(&w.Temporal)
	clamp(&w.Usage)
	clamp(&w.Quality)
	clamp(&w.Repo)

	s.mu.Lock()
	s.cache[orgID] = w
	s.mu.Unlock()

	// Persist asynchronously
	if s.settings != nil {
		go func() {
			if err := s.settings.Set(context.Background(), "retrieval_weights_"+orgID, w, "system"); err != nil {
				slog.Debug("Failed to persist adaptive weights", "org", orgID, "error", err)
			}
		}()
	}
}

// SerializeWeights returns the current weights as JSON for the API.
func (s *AdaptiveStrategy) SerializeWeights(ctx context.Context, orgID string) json.RawMessage {
	w := s.GetWeights(ctx, orgID)
	data, _ := json.Marshal(w)
	return data
}
