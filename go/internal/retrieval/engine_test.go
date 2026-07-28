package retrieval

import (
	"testing"
	"time"
)

func TestRRFFuse(t *testing.T) {
	listA := []candidate{
		{ID: "a", Scores: scores{Semantic: 0.9}},
		{ID: "b", Scores: scores{Semantic: 0.8}},
		{ID: "c", Scores: scores{Semantic: 0.7}},
	}
	listB := []candidate{
		{ID: "b", Scores: scores{Keyword: 0.85}},
		{ID: "a", Scores: scores{Keyword: 0.6}},
		{ID: "d", Scores: scores{Keyword: 0.5}},
	}

	result := rrfFuse(listA, listB)

	if len(result) != 4 {
		t.Fatalf("expected 4 fused candidates, got %d", len(result))
	}
	// "a" and "b" appear in both lists — should have highest RRF scores
	if result[0].ID != "a" && result[0].ID != "b" {
		t.Errorf("expected top result to be 'a' or 'b', got %q", result[0].ID)
	}
	if result[0].FinalScore < result[1].FinalScore {
		t.Error("results should be sorted by RRF score descending")
	}
}

func TestRankCandidates(t *testing.T) {
	now := time.Now()
	candidates := []candidate{
		{
			ID: "fresh-high-quality", QualityScore: 0.9, UsageCount: 50,
			Confidence: "high", Repository: "org/service",
			CreatedAt: now.Add(-24 * time.Hour), // 1 day old
			Scores: scores{Semantic: 0.95, Keyword: 0.8},
		},
		{
			ID: "old-low-quality", QualityScore: 0.3, UsageCount: 0,
			Confidence: "low", Repository: "org/other",
			CreatedAt: now.Add(-180 * 24 * time.Hour), // 180 days old
			Scores: scores{Semantic: 0.7, Keyword: 0.3},
		},
	}

	ranked := rankCandidates(candidates, "org/service")

	if ranked[0].ID != "fresh-high-quality" {
		t.Errorf("expected fresh-high-quality first, got %s", ranked[0].ID)
	}
	if ranked[0].FinalScore <= ranked[1].FinalScore {
		t.Error("fresh high-quality should score higher than old low-quality")
	}
	// Confidence "low" applies 0.6 multiplier
	if ranked[1].FinalScore >= 0.5 {
		t.Errorf("low confidence should heavily penalize score, got %f", ranked[1].FinalScore)
	}
}

func TestPackByBudget(t *testing.T) {
	candidates := []candidate{
		{ID: "a", TokenCount: 100},
		{ID: "b", TokenCount: 200},
		{ID: "c", TokenCount: 150},
		{ID: "d", TokenCount: 300},
	}

	// Budget 400: should fit a(100) + b(200) = 300, then c(150) > remaining 100
	result := packByBudget(candidates, 400)
	if len(result) != 2 {
		t.Fatalf("expected 2 packed items, got %d", len(result))
	}
	if result[0].ID != "a" || result[1].ID != "b" {
		t.Error("should pack first two items")
	}

	// Budget 50: too small for first item, but always returns at least 1
	result2 := packByBudget(candidates, 50)
	if len(result2) != 1 {
		t.Fatalf("expected 1 item (minimum guarantee), got %d", len(result2))
	}
}

func TestApplyDiversity(t *testing.T) {
	candidates := []candidate{
		{ID: "1", SessionID: "s1", FinalScore: 0.9},
		{ID: "2", SessionID: "s1", FinalScore: 0.85},
		{ID: "3", SessionID: "s1", FinalScore: 0.8}, // 3rd from same session
		{ID: "4", SessionID: "s2", FinalScore: 0.7},
	}

	result := applyDiversity(candidates)

	// The 3rd result from session s1 should be penalized
	// After diversity, s2 might rank higher than the penalized s1 item
	found3 := false
	for _, c := range result {
		if c.ID == "3" {
			found3 = true
			if c.FinalScore >= 0.8 {
				t.Errorf("3rd session duplicate should be penalized, got %f", c.FinalScore)
			}
		}
	}
	if !found3 {
		t.Error("candidate 3 should still be in results (penalized, not removed)")
	}
}

func TestExtractQueryEntities(t *testing.T) {
	entities := extractQueryEntities("How do we handle Kafka and Redis connection pooling?")
	if len(entities) < 2 {
		t.Fatalf("expected at least 2 entities, got %d: %v", len(entities), entities)
	}

	// Should find Kafka and Redis
	found := map[string]bool{}
	for _, e := range entities {
		found[toLower(e)] = true
	}
	if !found["kafka"] {
		t.Error("should extract 'Kafka'")
	}
	if !found["redis"] {
		t.Error("should extract 'Redis'")
	}
}

func TestExtractQueryEntitiesEmpty(t *testing.T) {
	entities := extractQueryEntities("how do we handle connection pooling?")
	if len(entities) != 0 {
		t.Errorf("expected 0 entities for generic query, got %d: %v", len(entities), entities)
	}
}
