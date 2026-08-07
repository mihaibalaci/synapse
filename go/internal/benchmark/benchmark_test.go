package benchmark

import (
	"context"
	"testing"
	"time"
)

func TestComputeMetrics(t *testing.T) {
	results := []SampleResult{
		{
			SampleID:  "s1",
			Retrieved: []string{"a", "b", "c"},
			Relevant:  []string{"a", "c"},
			RecallAt5: 1.0,
			Precision: 0.67,
			NDCG:      0.9,
			LatencyMs: 50,
			Category:  "easy",
		},
		{
			SampleID:  "s2",
			Retrieved: []string{"x", "y", "z"},
			Relevant:  []string{"x"},
			RecallAt5: 1.0,
			Precision: 0.33,
			NDCG:      1.0,
			LatencyMs: 80,
			Category:  "hard",
		},
	}

	metrics := computeMetrics(results)

	if metrics.TotalSamples != 2 {
		t.Errorf("TotalSamples = %d, want 2", metrics.TotalSamples)
	}
	if metrics.RecallAt5 != 1.0 {
		t.Errorf("RecallAt5 = %f, want 1.0", metrics.RecallAt5)
	}
	if metrics.AvgLatencyMs < 60 || metrics.AvgLatencyMs > 70 {
		t.Errorf("AvgLatencyMs = %f, want ~65", metrics.AvgLatencyMs)
	}
	if metrics.NDCG < 0.9 {
		t.Errorf("NDCG = %f, expected >= 0.9", metrics.NDCG)
	}
}

func TestComputeMetricsEmpty(t *testing.T) {
	metrics := computeMetrics(nil)
	if metrics.TotalSamples != 0 {
		t.Errorf("TotalSamples = %d, want 0", metrics.TotalSamples)
	}
	if metrics.RecallAt5 != 0 {
		t.Errorf("RecallAt5 = %f, want 0", metrics.RecallAt5)
	}
}

func TestComputeMetricsByField(t *testing.T) {
	results := []SampleResult{
		{Category: "easy", RecallAt5: 1.0, LatencyMs: 30},
		{Category: "easy", RecallAt5: 0.8, LatencyMs: 40},
		{Category: "hard", RecallAt5: 0.5, LatencyMs: 100},
	}

	byCategory := computeMetricsByField(results, func(r SampleResult) string {
		return r.Category
	})

	if len(byCategory) != 2 {
		t.Fatalf("expected 2 categories, got %d", len(byCategory))
	}
	if byCategory["easy"].TotalSamples != 2 {
		t.Errorf("easy samples = %d, want 2", byCategory["easy"].TotalSamples)
	}
	if byCategory["hard"].TotalSamples != 1 {
		t.Errorf("hard samples = %d, want 1", byCategory["hard"].TotalSamples)
	}
}

func TestPercentile(t *testing.T) {
	sorted := []float64{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}

	p50 := percentile(sorted, 0.5)
	if p50 != 50 {
		t.Errorf("p50 = %f, want 50", p50)
	}

	p95 := percentile(sorted, 0.95)
	if p95 < 90 {
		t.Errorf("p95 = %f, want >= 90", p95)
	}

	pEmpty := percentile(nil, 0.5)
	if pEmpty != 0 {
		t.Errorf("percentile(nil) = %f, want 0", pEmpty)
	}
}

func TestSortFloat64s(t *testing.T) {
	vals := []float64{5, 2, 8, 1, 9, 3}
	sortFloat64s(vals)
	for i := 1; i < len(vals); i++ {
		if vals[i] < vals[i-1] {
			t.Errorf("not sorted at index %d: %f < %f", i, vals[i], vals[i-1])
		}
	}
}

func TestMakeSet(t *testing.T) {
	set := makeSet([]string{"a", "b", "c", "a"})
	if len(set) != 3 {
		t.Errorf("set size = %d, want 3", len(set))
	}
	if !set["a"] || !set["b"] || !set["c"] {
		t.Error("set missing expected values")
	}
}

func TestGenerateLongMemEvalDataset(t *testing.T) {
	ds := GenerateLongMemEvalDataset()
	if ds.Name != "LongMemEval-Synapse" {
		t.Errorf("Name = %q, want 'LongMemEval-Synapse'", ds.Name)
	}
	if len(ds.Samples) != 12 {
		t.Errorf("Samples count = %d, want 12", len(ds.Samples))
	}
	// Each sample should have at least one ground truth
	for _, s := range ds.Samples {
		if len(s.GroundTruth) == 0 {
			t.Errorf("sample %s has no ground truth", s.ID)
		}
		if len(s.Context) == 0 {
			t.Errorf("sample %s has no context memories", s.ID)
		}
		if s.Query == "" {
			t.Errorf("sample %s has empty query", s.ID)
		}
	}
}

func TestGenerateBEAMDataset(t *testing.T) {
	ds := GenerateBEAMDataset()
	if ds.Name != "BEAM-Synapse" {
		t.Errorf("Name = %q, want 'BEAM-Synapse'", ds.Name)
	}
	if len(ds.Samples) != 5 {
		t.Errorf("Samples count = %d, want 5", len(ds.Samples))
	}
	// BEAM samples should have noise (more context than ground truth)
	for _, s := range ds.Samples {
		if len(s.Context) <= len(s.GroundTruth) {
			t.Errorf("sample %s: context (%d) should be larger than ground truth (%d)",
				s.ID, len(s.Context), len(s.GroundTruth))
		}
	}
}

func TestEvaluatorEvaluateSample(t *testing.T) {
	// Create a mock evaluator
	searchFn := func(ctx context.Context, query string, topK int) ([]string, int64, error) {
		// Return perfect results for the test sample
		return []string{"mem-001", "mem-002"}, 42, nil
	}
	ingestFn := func(ctx context.Context, memories []Memory) error {
		return nil
	}

	cfg := RunConfig{TopK: 5, Strategy: "hybrid"}
	eval := NewEvaluator(searchFn, ingestFn, cfg)

	sample := Sample{
		ID:          "test-001",
		Query:       "What database do we use?",
		GroundTruth: []string{"mem-001"},
		Context: []Memory{
			{ID: "mem-001", Content: "We use PostgreSQL", Timestamp: time.Now()},
		},
		Category:   "easy",
		Difficulty: "easy",
	}

	result, err := eval.evaluateSample(context.Background(), sample)
	if err != nil {
		t.Fatalf("evaluateSample: %v", err)
	}
	if result.RecallAt5 != 1.0 {
		t.Errorf("RecallAt5 = %f, want 1.0", result.RecallAt5)
	}
	if result.LatencyMs != 42 {
		t.Errorf("LatencyMs = %d, want 42", result.LatencyMs)
	}
	if result.SampleID != "test-001" {
		t.Errorf("SampleID = %q, want 'test-001'", result.SampleID)
	}
}
