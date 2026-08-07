package benchmark

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// RunnerConfig holds the configuration for running benchmarks.
type RunnerConfig struct {
	DatasetName string // "longmemeval", "beam", "locomo", or path to file
	DatasetFile string // path to custom dataset JSON
	OutputFile  string // path to write results
	TopK        int
	Strategy    string
	MaxTokens   int
	DatabaseURL string
	RedisURL    string
	S3Endpoint  string
	S3Bucket    string
}

// RunBenchmarkCLI is the entry point for the `synapse benchmark` command.
func RunBenchmarkCLI(cfg RunnerConfig) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	// Load or generate dataset
	dataset, err := resolveDataset(cfg)
	if err != nil {
		slog.Error("Failed to load dataset", "error", err)
		os.Exit(1)
	}

	fmt.Printf("Synapse Benchmark Runner\n")
	fmt.Printf("========================\n")
	fmt.Printf("Dataset: %s (%d samples)\n", dataset.Name, len(dataset.Samples))
	fmt.Printf("Strategy: %s, TopK: %d\n\n", cfg.Strategy, cfg.TopK)

	// Connect to database
	db, err := storage.ConnectWithRetry(ctx, cfg.DatabaseURL, storage.DefaultRetry)
	if err != nil {
		slog.Error("Could not connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Create search and ingest functions bound to the database
	searchFn := createSearchFunc(ctx, db, cfg)
	ingestFn := createIngestFunc(ctx, db, cfg)

	runCfg := RunConfig{
		TopK:           cfg.TopK,
		Strategy:       cfg.Strategy,
		MaxTokens:      cfg.MaxTokens,
		EmbeddingModel: os.Getenv("EMBEDDING_MODEL"),
		DatasetPath:    cfg.DatasetFile,
	}
	if runCfg.TopK == 0 {
		runCfg.TopK = 5
	}
	if runCfg.Strategy == "" {
		runCfg.Strategy = "hybrid"
	}

	evaluator := NewEvaluator(searchFn, ingestFn, runCfg)
	report, err := evaluator.Run(ctx, dataset)
	if err != nil {
		slog.Error("Benchmark failed", "error", err)
		os.Exit(1)
	}

	// Print results
	printReport(report)

	// Save results if output file specified
	if cfg.OutputFile != "" {
		if err := SaveReport(cfg.OutputFile, report); err != nil {
			slog.Error("Failed to save report", "error", err)
			os.Exit(1)
		}
		fmt.Printf("\nResults saved to: %s\n", cfg.OutputFile)
	}
}

func resolveDataset(cfg RunnerConfig) (*Dataset, error) {
	// Custom file takes precedence
	if cfg.DatasetFile != "" {
		return LoadDataset(cfg.DatasetFile)
	}

	// Built-in datasets
	switch cfg.DatasetName {
	case "longmemeval", "":
		return GenerateLongMemEvalDataset(), nil
	case "beam":
		return GenerateBEAMDataset(), nil
	case "locomo":
		return GenerateLoCoMoDataset(), nil
	default:
		// Try as file path
		if _, err := os.Stat(cfg.DatasetName); err == nil {
			return LoadDataset(cfg.DatasetName)
		}
		return nil, fmt.Errorf("unknown dataset: %s (use: longmemeval, beam, locomo, or a file path)", cfg.DatasetName)
	}
}

func createSearchFunc(ctx context.Context, db *storage.DB, cfg RunnerConfig) SearchFunc {
	return func(ctx context.Context, query string, topK int) ([]string, int64, error) {
		start := time.Now()

		// Execute the 4-signal hybrid search directly against the database
		// This uses the same query paths as the production search endpoint.
		rows, err := db.Query(ctx, `
			WITH semantic AS (
				SELECT c.id, 1 - (c.embedding <=> (
					SELECT embedding FROM chunks 
					WHERE content ILIKE '%' || $1 || '%' 
					LIMIT 1
				)) AS score
				FROM chunks c
				WHERE c.embedding IS NOT NULL
				  AND c.confidence <> 'archived'
				  AND c.searchable_status = 'searchable'
				ORDER BY c.embedding <=> (
					SELECT embedding FROM chunks 
					WHERE content ILIKE '%' || $1 || '%' 
					LIMIT 1
				)
				LIMIT $2
			),
			keyword AS (
				SELECT c.id, ts_rank(c.search_vector, plainto_tsquery('english', $1)) AS score
				FROM chunks c
				WHERE c.search_vector @@ plainto_tsquery('english', $1)
				  AND c.confidence <> 'archived'
				  AND c.searchable_status = 'searchable'
				ORDER BY score DESC
				LIMIT $2
			),
			combined AS (
				SELECT id, MAX(score) as score FROM (
					SELECT id, score FROM semantic
					UNION ALL
					SELECT id, score FROM keyword
				) sub
				GROUP BY id
			)
			SELECT id FROM combined ORDER BY score DESC LIMIT $2
		`, query, topK)
		if err != nil {
			// Fallback to simpler keyword-only search
			rows, err = db.Query(ctx, `
				SELECT c.id FROM chunks c
				WHERE c.search_vector @@ plainto_tsquery('english', $1)
				  AND c.confidence <> 'archived'
				  AND c.searchable_status = 'searchable'
				ORDER BY ts_rank(c.search_vector, plainto_tsquery('english', $1)) DESC
				LIMIT $2
			`, query, topK)
			if err != nil {
				return nil, 0, err
			}
		}
		defer rows.Close()

		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				continue
			}
			ids = append(ids, id)
		}

		latency := time.Since(start).Milliseconds()
		return ids, latency, nil
	}
}

func createIngestFunc(ctx context.Context, db *storage.DB, cfg RunnerConfig) IngestFunc {
	return func(ctx context.Context, memories []Memory) error {
		for _, mem := range memories {
			// Insert directly as chunks for benchmark evaluation
			entities := mem.Entities
			if entities == nil {
				entities = []string{}
			}
			entitiesJSON, _ := json.Marshal(entities)

			err := db.Exec(ctx, `
				INSERT INTO chunks (id, session_id, title, summary, content, token_count, 
					type, repository, language, frameworks, author_id, organization_id, 
					searchable_status, confidence, quality_score)
				VALUES ($1, 
					(SELECT id FROM sessions LIMIT 1),
					$2, $3, $4, $5, $6, '', '', '{}', 'benchmark', 'benchmark',
					'searchable', 'high', 0.8)
				ON CONFLICT (id) DO NOTHING`,
				mem.ID,
				summarizeContent(mem.Content),
				mem.Content,
				mem.Content,
				estimateTokens(mem.Content),
				mem.Type,
			)
			if err != nil {
				// Try creating a session first if none exists
				_ = db.Exec(ctx, `
					INSERT INTO sessions (id, client_id, developer_id, organization_id, 
						raw_storage_key, status, searchable_status)
					VALUES (gen_random_uuid(), 'benchmark', 'benchmark', 'benchmark', 
						'benchmark/placeholder', 'indexed', 'searchable')
					ON CONFLICT DO NOTHING`)

				// Retry the chunk insert
				err = db.Exec(ctx, `
					INSERT INTO chunks (id, session_id, title, summary, content, token_count, 
						type, repository, language, frameworks, author_id, organization_id, 
						searchable_status, confidence, quality_score)
					VALUES ($1, 
						(SELECT id FROM sessions WHERE organization_id = 'benchmark' LIMIT 1),
						$2, $3, $4, $5, $6, '', '', '{}', 'benchmark', 'benchmark',
						'searchable', 'high', 0.8)
					ON CONFLICT (id) DO NOTHING`,
					mem.ID,
					summarizeContent(mem.Content),
					mem.Content,
					mem.Content,
					estimateTokens(mem.Content),
					mem.Type,
				)
				if err != nil {
					return fmt.Errorf("insert benchmark chunk %s: %w", mem.ID, err)
				}
			}

			// Also insert as facts for entity-based retrieval
			if len(entities) > 0 {
				_ = db.Exec(ctx, `
					INSERT INTO memory_facts (id, content, type, entities, author_id, 
						organization_id, source_chunk_id, extracted_from, confidence, frameworks)
					VALUES (gen_random_uuid(), $1, COALESCE(NULLIF($2, ''), 'lesson'), $3::text[], 
						'benchmark', 'benchmark', $4, 'benchmark', 0.8, '{}')
					ON CONFLICT DO NOTHING`,
					mem.Content, mem.Type, entitiesJSON, mem.ID,
				)
			}
		}
		return nil
	}
}

func summarizeContent(content string) string {
	if len(content) <= 80 {
		return content
	}
	return content[:77] + "..."
}

func estimateTokens(content string) int {
	// Rough estimate: 1 token per 4 characters
	return len(content) / 4
}

func printReport(report *Report) {
	fmt.Printf("\n─── Results ────────────────────────────────────────────\n")
	fmt.Printf("Dataset:     %s\n", report.Dataset)
	fmt.Printf("Samples:     %d\n", report.Metrics.TotalSamples)
	fmt.Printf("Duration:    %s\n\n", report.Duration.Round(time.Millisecond))

	fmt.Printf("Recall@1:         %.1f%%\n", report.Metrics.RecallAt1*100)
	fmt.Printf("Recall@5:         %.1f%%\n", report.Metrics.RecallAt5*100)
	fmt.Printf("Precision@5:      %.1f%%\n", report.Metrics.PrecisionAt5*100)
	fmt.Printf("NDCG:             %.3f\n", report.Metrics.NDCG)
	fmt.Printf("MRR:              %.3f\n", report.Metrics.MRR)
	fmt.Printf("Avg Latency:      %.1fms\n", report.Metrics.AvgLatencyMs)
	fmt.Printf("P95 Latency:      %.1fms\n", report.Metrics.P95LatencyMs)
	fmt.Printf("Token Efficiency: %.1f%%\n", report.Metrics.TokenEfficiency*100)

	if len(report.ByCategory) > 0 {
		fmt.Printf("\n─── By Category ────────────────────────────────────────\n")
		for cat, m := range report.ByCategory {
			fmt.Printf("  %-16s  R@5=%.1f%%  MRR=%.3f  Latency=%.0fms\n",
				cat, m.RecallAt5*100, m.MRR, m.AvgLatencyMs)
		}
	}

	if len(report.ByDifficulty) > 0 {
		fmt.Printf("\n─── By Difficulty ──────────────────────────────────────\n")
		for diff, m := range report.ByDifficulty {
			fmt.Printf("  %-8s  R@5=%.1f%%  MRR=%.3f  NDCG=%.3f\n",
				diff, m.RecallAt5*100, m.MRR, m.NDCG)
		}
	}

	fmt.Printf("\n────────────────────────────────────────────────────────\n")
}
