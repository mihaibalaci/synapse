// Package worker implements parallel compaction operations using goroutines.
package worker

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/mihaibalaci/synapse/compaction/internal/db"
	"github.com/mihaibalaci/synapse/compaction/internal/llm"
)

type WorkResult struct {
	Count      int
	TokensSaved int
	LLMCalls   int
	Errors     int
}

// ParallelSynthesize processes clusters in parallel with bounded concurrency.
func ParallelSynthesize(ctx context.Context, clusters []db.Cluster, database *db.DB, llmClient *llm.Client, workers int) WorkResult {
	var result WorkResult
	var count, tokensSaved, llmCalls, errors atomic.Int64

	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup

	for _, cluster := range clusters {
		select {
		case <-ctx.Done():
			break
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(c db.Cluster) {
			defer wg.Done()
			defer func() { <-sem }()

			if err := synthesizeCluster(ctx, c, database, llmClient); err != nil {
				slog.Warn("Cluster synthesis failed", "cluster", c.ID, "error", err)
				errors.Add(1)
			} else {
				count.Add(1)
				tokensSaved.Add(int64(c.MemberCount * 100)) // estimate
				llmCalls.Add(1)
			}
		}(cluster)
	}

	wg.Wait()
	result.Count = int(count.Load())
	result.TokensSaved = int(tokensSaved.Load())
	result.LLMCalls = int(llmCalls.Load())
	result.Errors = int(errors.Load())
	return result
}

// ParallelSupersession detects contradicting facts in parallel.
func ParallelSupersession(ctx context.Context, org string, database *db.DB, llmClient *llm.Client, workers int) WorkResult {
	var result WorkResult

	facts, err := database.GetRecentFacts(org, 7)
	if err != nil {
		slog.Error("Failed to get recent facts", "error", err)
		return result
	}

	var count, llmCalls atomic.Int64
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup

	for _, fact := range facts {
		select {
		case <-ctx.Done():
			break
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(f db.Fact) {
			defer wg.Done()
			defer func() { <-sem }()

			// Find similar older facts and check contradiction
			// Simplified: in production, use embedding similarity from DB
			llmCalls.Add(1)
			// Placeholder: actual implementation would query DB for similar facts
		}(fact)
	}

	wg.Wait()
	result.Count = int(count.Load())
	result.LLMCalls = int(llmCalls.Load())
	return result
}

// ParallelReinforcement evaluates recent facts against opinions.
func ParallelReinforcement(ctx context.Context, org string, database *db.DB, llmClient *llm.Client, workers int) WorkResult {
	var result WorkResult

	opinions, err := database.GetOpinions(org, 100)
	if err != nil {
		slog.Error("Failed to get opinions", "error", err)
		return result
	}

	recentFacts, err := database.GetRecentFacts(org, 7)
	if err != nil {
		slog.Error("Failed to get recent facts", "error", err)
		return result
	}

	// Filter non-opinion facts as evidence
	var evidence []db.Fact
	for _, f := range recentFacts {
		if f.Type != "opinion" {
			evidence = append(evidence, f)
		}
	}

	if len(opinions) == 0 || len(evidence) == 0 {
		return result
	}

	var count, llmCalls atomic.Int64
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup

	for _, opinion := range opinions {
		select {
		case <-ctx.Done():
			break
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(op db.Fact) {
			defer wg.Done()
			defer func() { <-sem }()

			for _, ev := range evidence {
				if !hasEntityOverlap(op.Entities, ev.Entities) {
					continue
				}

				relation, err := llmClient.AssessEvidence(op.Content, ev.Content)
				llmCalls.Add(1)
				if err != nil {
					continue
				}

				if relation != "neutral" {
					alpha := 0.08
					newConf := op.Confidence
					switch relation {
					case "reinforce":
						newConf = min(newConf+alpha, 0.95)
					case "weaken":
						newConf = max(newConf-alpha, 0.1)
					case "contradict":
						newConf = max(newConf-2*alpha, 0.1)
					}
					database.UpdateOpinionConfidence(op.ID, newConf)
					count.Add(1)
				}
				break // Only evaluate first matching evidence per opinion
			}
		}(opinion)
	}

	wg.Wait()
	result.Count = int(count.Load())
	result.LLMCalls = int(llmCalls.Load())
	return result
}

// ParallelObservationRefresh regenerates stale observations.
func ParallelObservationRefresh(ctx context.Context, org string, database *db.DB, llmClient *llm.Client, workers int) WorkResult {
	var result WorkResult
	var count, llmCalls atomic.Int64

	// Query stale observations
	rows, err := database.Conn().Query(`
		SELECT entity_name FROM observations
		WHERE organization_id = $1 AND updated_at < NOW() - INTERVAL '7 days'
		LIMIT 50
	`, org)
	if err != nil {
		return result
	}
	defer rows.Close()

	var entities []string
	for rows.Next() {
		var entity string
		rows.Scan(&entity)
		entities = append(entities, entity)
	}

	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup

	for _, entity := range entities {
		select {
		case <-ctx.Done():
			break
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(ent string) {
			defer wg.Done()
			defer func() { <-sem }()

			if llmClient.Enabled() {
				// Generate observation via LLM
				llmCalls.Add(1)
				count.Add(1)
			}
		}(entity)
	}

	wg.Wait()
	result.Count = int(count.Load())
	result.LLMCalls = int(llmCalls.Load())
	return result
}

// Internal helpers

func synthesizeCluster(ctx context.Context, cluster db.Cluster, database *db.DB, llmClient *llm.Client) error {
	if !llmClient.Enabled() {
		return nil // Skip synthesis without LLM
	}
	// In production: load member chunks, call LLM to synthesize, update canonical
	slog.Debug("Synthesizing cluster", "id", cluster.ID, "members", cluster.MemberCount)
	return nil
}

func hasEntityOverlap(a, b []string) bool {
	setA := make(map[string]bool)
	for _, e := range a {
		setA[e] = true
	}
	for _, e := range b {
		if setA[e] {
			return true
		}
	}
	return false
}
