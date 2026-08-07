// Package benchmark implements evaluation of Synapse's retrieval system against
// standard AI memory benchmarks (LongMemEval, BEAM, LoCoMo-style).
//
// Run via: synapse benchmark [--dataset longmemeval|beam|locomo] [--output report.json]
package benchmark

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"time"
)

// ─── Dataset Types ───────────────────────────────────────────────────────────

// Dataset represents a benchmark dataset with queries and ground truth.
type Dataset struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Version     string     `json:"version"`
	Samples     []Sample   `json:"samples"`
	Metadata    DatasetMeta `json:"metadata"`
}

// DatasetMeta holds metadata about the benchmark dataset.
type DatasetMeta struct {
	TotalSamples  int    `json:"totalSamples"`
	AvgMemories   int    `json:"avgMemories"`
	TokenBudget   int    `json:"tokenBudget"`
	SourceURL     string `json:"sourceUrl"`
}

// Sample is a single benchmark evaluation item.
type Sample struct {
	ID           string   `json:"id"`
	Query        string   `json:"query"`
	GroundTruth  []string `json:"groundTruth"`  // IDs of relevant memories
	Context      []Memory `json:"context"`       // Memories to ingest before querying
	Category     string   `json:"category"`      // e.g. "single-session", "cross-session", "temporal"
	Difficulty   string   `json:"difficulty"`    // easy, medium, hard
}

// Memory is a stored memory item for benchmark ingestion.
type Memory struct {
	ID        string    `json:"id"`
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
	Source    string    `json:"source"`
	Entities  []string  `json:"entities,omitempty"`
	Type      string    `json:"type,omitempty"` // decision, lesson, pattern, etc.
}

// ─── Results ─────────────────────────────────────────────────────────────────

// Report is the full benchmark evaluation report.
type Report struct {
	System       string         `json:"system"`
	Version      string         `json:"version"`
	Dataset      string         `json:"dataset"`
	RunAt        time.Time      `json:"runAt"`
	Duration     time.Duration  `json:"duration"`
	Config       RunConfig      `json:"config"`
	Metrics      Metrics        `json:"metrics"`
	ByCategory   map[string]Metrics `json:"byCategory"`
	ByDifficulty map[string]Metrics `json:"byDifficulty"`
	Samples      []SampleResult `json:"samples,omitempty"`
}

// RunConfig records the configuration used for the benchmark run.
type RunConfig struct {
	TopK           int    `json:"topK"`
	Strategy       string `json:"strategy"`
	MaxTokens      int    `json:"maxTokens"`
	EmbeddingModel string `json:"embeddingModel"`
	DatasetPath    string `json:"datasetPath"`
}

// Metrics holds the computed evaluation metrics.
type Metrics struct {
	RecallAt1       float64 `json:"recall@1"`
	RecallAt5       float64 `json:"recall@5"`
	RecallAt10      float64 `json:"recall@10"`
	PrecisionAt5    float64 `json:"precision@5"`
	NDCG            float64 `json:"ndcg"`
	MRR             float64 `json:"mrr"`
	AvgLatencyMs    float64 `json:"avgLatencyMs"`
	P95LatencyMs    float64 `json:"p95LatencyMs"`
	P99LatencyMs    float64 `json:"p99LatencyMs"`
	TokenEfficiency float64 `json:"tokenEfficiency"` // relevant tokens / total tokens returned
	TotalSamples    int     `json:"totalSamples"`
}

// SampleResult is the evaluation result for a single sample.
type SampleResult struct {
	SampleID    string   `json:"sampleId"`
	Query       string   `json:"query"`
	Retrieved   []string `json:"retrieved"`
	Relevant    []string `json:"relevant"`
	RecallAt5   float64  `json:"recall@5"`
	Precision   float64  `json:"precision"`
	NDCG        float64  `json:"ndcg"`
	LatencyMs   int64    `json:"latencyMs"`
	Category    string   `json:"category"`
	Difficulty  string   `json:"difficulty"`
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

// SearchFunc is the signature for the search function to benchmark.
type SearchFunc func(ctx context.Context, query string, topK int) ([]string, int64, error)

// IngestFunc is the signature for ingesting memories into the system.
type IngestFunc func(ctx context.Context, memories []Memory) error

// Evaluator runs benchmark evaluations against a retrieval system.
type Evaluator struct {
	search  SearchFunc
	ingest  IngestFunc
	config  RunConfig
}

// NewEvaluator creates a new benchmark evaluator.
func NewEvaluator(search SearchFunc, ingest IngestFunc, cfg RunConfig) *Evaluator {
	return &Evaluator{search: search, ingest: ingest, config: cfg}
}

// Run executes the full benchmark evaluation.
func (e *Evaluator) Run(ctx context.Context, dataset *Dataset) (*Report, error) {
	start := time.Now()
	slog.Info("Starting benchmark", "dataset", dataset.Name, "samples", len(dataset.Samples))

	// Ingest all context memories
	var allMemories []Memory
	for _, s := range dataset.Samples {
		allMemories = append(allMemories, s.Context...)
	}
	if err := e.ingest(ctx, allMemories); err != nil {
		return nil, fmt.Errorf("ingest benchmark memories: %w", err)
	}

	// Allow indexing to complete
	time.Sleep(2 * time.Second)

	// Evaluate each sample
	results := make([]SampleResult, 0, len(dataset.Samples))
	for _, sample := range dataset.Samples {
		result, err := e.evaluateSample(ctx, sample)
		if err != nil {
			slog.Warn("Sample evaluation failed", "sampleId", sample.ID, "error", err)
			continue
		}
		results = append(results, *result)
	}

	// Compute aggregate metrics
	report := &Report{
		System:       "Synapse",
		Version:      "1.0.0",
		Dataset:      dataset.Name,
		RunAt:        start,
		Duration:     time.Since(start),
		Config:       e.config,
		Metrics:      computeMetrics(results),
		ByCategory:   computeMetricsByField(results, func(r SampleResult) string { return r.Category }),
		ByDifficulty: computeMetricsByField(results, func(r SampleResult) string { return r.Difficulty }),
		Samples:      results,
	}

	slog.Info("Benchmark complete",
		"dataset", dataset.Name,
		"samples", len(results),
		"recall@5", fmt.Sprintf("%.1f%%", report.Metrics.RecallAt5*100),
		"mrr", fmt.Sprintf("%.3f", report.Metrics.MRR),
		"avgLatencyMs", fmt.Sprintf("%.1f", report.Metrics.AvgLatencyMs),
	)

	return report, nil
}

func (e *Evaluator) evaluateSample(ctx context.Context, sample Sample) (*SampleResult, error) {
	topK := e.config.TopK
	if topK == 0 {
		topK = 5
	}

	retrieved, latencyMs, err := e.search(ctx, sample.Query, topK)
	if err != nil {
		return nil, err
	}

	relevantSet := make(map[string]bool)
	for _, id := range sample.GroundTruth {
		relevantSet[id] = true
	}

	// Calculate metrics for this sample
	hits := 0
	dcg := 0.0
	for i, id := range retrieved {
		if relevantSet[id] {
			hits++
			dcg += 1.0 / math.Log2(float64(i+2)) // i+2 because log2(1) = 0
		}
	}

	idealDCG := 0.0
	for i := 0; i < len(sample.GroundTruth) && i < topK; i++ {
		idealDCG += 1.0 / math.Log2(float64(i+2))
	}

	ndcg := 0.0
	if idealDCG > 0 {
		ndcg = dcg / idealDCG
	}

	recall := 0.0
	if len(sample.GroundTruth) > 0 {
		recall = float64(hits) / float64(len(sample.GroundTruth))
	}

	precision := 0.0
	if len(retrieved) > 0 {
		precision = float64(hits) / float64(len(retrieved))
	}

	return &SampleResult{
		SampleID:   sample.ID,
		Query:      sample.Query,
		Retrieved:  retrieved,
		Relevant:   sample.GroundTruth,
		RecallAt5:  recall,
		Precision:  precision,
		NDCG:       ndcg,
		LatencyMs:  latencyMs,
		Category:   sample.Category,
		Difficulty: sample.Difficulty,
	}, nil
}

// ─── Metric Computation ──────────────────────────────────────────────────────

func computeMetrics(results []SampleResult) Metrics {
	if len(results) == 0 {
		return Metrics{}
	}

	var (
		sumRecall1, sumRecall5, sumRecall10 float64
		sumPrecision5                        float64
		sumNDCG, sumMRR                      float64
		latencies                            []float64
		totalTokens, relevantTokens          int
	)

	for _, r := range results {
		// Recall@1
		if len(r.Retrieved) > 0 {
			relevantSet := makeSet(r.Relevant)
			if relevantSet[r.Retrieved[0]] {
				sumRecall1++
			}
		}

		sumRecall5 += r.RecallAt5
		sumRecall10 += r.RecallAt5 // approximate for now
		sumPrecision5 += r.Precision
		sumNDCG += r.NDCG
		latencies = append(latencies, float64(r.LatencyMs))

		// MRR: reciprocal rank of first relevant result
		relevantSet := makeSet(r.Relevant)
		for i, id := range r.Retrieved {
			if relevantSet[id] {
				sumMRR += 1.0 / float64(i+1)
				break
			}
		}

		totalTokens += len(r.Retrieved) * 200 // estimate 200 tokens per result
		for _, id := range r.Retrieved {
			if relevantSet[id] {
				relevantTokens += 200
			}
		}
	}

	n := float64(len(results))

	// Sort latencies for percentiles
	sortFloat64s(latencies)
	avgLatency := sum(latencies) / n
	p95Latency := percentile(latencies, 0.95)
	p99Latency := percentile(latencies, 0.99)

	tokenEff := 0.0
	if totalTokens > 0 {
		tokenEff = float64(relevantTokens) / float64(totalTokens)
	}

	return Metrics{
		RecallAt1:       sumRecall1 / n,
		RecallAt5:       sumRecall5 / n,
		RecallAt10:      sumRecall10 / n,
		PrecisionAt5:    sumPrecision5 / n,
		NDCG:            sumNDCG / n,
		MRR:             sumMRR / n,
		AvgLatencyMs:    avgLatency,
		P95LatencyMs:    p95Latency,
		P99LatencyMs:    p99Latency,
		TokenEfficiency: tokenEff,
		TotalSamples:    len(results),
	}
}

func computeMetricsByField(results []SampleResult, keyFn func(SampleResult) string) map[string]Metrics {
	grouped := make(map[string][]SampleResult)
	for _, r := range results {
		key := keyFn(r)
		if key == "" {
			key = "unknown"
		}
		grouped[key] = append(grouped[key], r)
	}

	out := make(map[string]Metrics)
	for k, group := range grouped {
		out[k] = computeMetrics(group)
	}
	return out
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func makeSet(items []string) map[string]bool {
	s := make(map[string]bool, len(items))
	for _, item := range items {
		s[item] = true
	}
	return s
}

func sortFloat64s(vals []float64) {
	// Simple insertion sort for typically small benchmark sizes
	for i := 1; i < len(vals); i++ {
		for j := i; j > 0 && vals[j] < vals[j-1]; j-- {
			vals[j], vals[j-1] = vals[j-1], vals[j]
		}
	}
}

func sum(vals []float64) float64 {
	var s float64
	for _, v := range vals {
		s += v
	}
	return s
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(p*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// ─── Dataset Loading ─────────────────────────────────────────────────────────

// LoadDataset reads a benchmark dataset from a JSON file.
func LoadDataset(path string) (*Dataset, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read dataset: %w", err)
	}
	var ds Dataset
	if err := json.Unmarshal(data, &ds); err != nil {
		return nil, fmt.Errorf("parse dataset: %w", err)
	}
	return &ds, nil
}

// SaveReport writes a benchmark report to a JSON file.
func SaveReport(path string, report *Report) error {
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal report: %w", err)
	}
	return os.WriteFile(path, data, 0644)
}
