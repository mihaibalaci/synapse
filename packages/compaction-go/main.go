// Synapse Compaction Service — High-performance Go binary
//
// Runs as a CronJob or standalone binary for knowledge compaction:
// - Parallel cluster synthesis (N clusters simultaneously)
// - Parallel fact supersession detection
// - Parallel observation refresh
// - Bounded concurrency for LLM calls
//
// Usage:
//   synapse-compaction --org=<org-id> --max-clusters=50 --workers=10
//   synapse-compaction --org=all --workers=20

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mihaibalaci/synapse/compaction/internal/db"
	"github.com/mihaibalaci/synapse/compaction/internal/llm"
	"github.com/mihaibalaci/synapse/compaction/internal/worker"
)

type Config struct {
	Organization string
	MaxClusters  int
	MaxPrune     int
	Workers      int
	ArchiveDays  int
	DatabaseURL  string
	LLMProvider  string
	LLMModel     string
	LLMAPIKey    string
}

type Result struct {
	Organization         string `json:"organization"`
	ClustersSynthesized  int64  `json:"clustersSynthesized"`
	FactsSuperseded      int64  `json:"factsSuperseded"`
	OpinionsReinforced   int64  `json:"opinionsReinforced"`
	ObservationsRefreshed int64 `json:"observationsRefreshed"`
	ChunksArchived       int64  `json:"chunksArchived"`
	TokensSaved          int64  `json:"tokensSaved"`
	LLMCalls             int64  `json:"llmCalls"`
	Errors               int64  `json:"errors"`
	DurationMs           int64  `json:"durationMs"`
}

func main() {
	cfg := parseFlags()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	slog.Info("Synapse Compaction starting",
		"organization", cfg.Organization,
		"workers", cfg.Workers,
		"maxClusters", cfg.MaxClusters,
	)

	// Connect to database
	database, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		slog.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer database.Close()

	// Initialize LLM client
	llmClient := llm.NewClient(cfg.LLMProvider, cfg.LLMModel, cfg.LLMAPIKey)

	// Discover organizations
	orgs, err := discoverOrganizations(cfg, database)
	if err != nil {
		slog.Error("Failed to discover organizations", "error", err)
		os.Exit(1)
	}

	slog.Info("Organizations to compact", "count", len(orgs))

	// Process each organization
	var results []Result
	for _, org := range orgs {
		result := compactOrganization(org, cfg, database, llmClient)
		results = append(results, result)
	}

	// Print summary
	output, _ := json.MarshalIndent(results, "", "  ")
	fmt.Println(string(output))
}

func parseFlags() Config {
	cfg := Config{}
	flag.StringVar(&cfg.Organization, "org", os.Getenv("COMPACTION_ORGANIZATIONS"), "Organization ID or 'all'")
	flag.IntVar(&cfg.MaxClusters, "max-clusters", envInt("COMPACTION_MAX_CLUSTERS", 50), "Max clusters per org")
	flag.IntVar(&cfg.MaxPrune, "max-prune", envInt("COMPACTION_MAX_PRUNE", 500), "Max chunks to archive")
	flag.IntVar(&cfg.Workers, "workers", envInt("COMPACTION_WORKERS", 10), "Parallel workers")
	flag.IntVar(&cfg.ArchiveDays, "archive-days", envInt("COMPACTION_ARCHIVE_DAYS", 90), "Days before archival")
	flag.Parse()

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	cfg.LLMProvider = os.Getenv("LLM_PROVIDER")
	cfg.LLMModel = os.Getenv("LLM_MODEL")
	cfg.LLMAPIKey = os.Getenv("OPENAI_API_KEY")
	if cfg.LLMAPIKey == "" {
		cfg.LLMAPIKey = os.Getenv("ANTHROPIC_API_KEY")
	}

	if cfg.Organization == "" {
		cfg.Organization = "all"
	}
	if cfg.DatabaseURL == "" {
		cfg.DatabaseURL = "postgresql://synapse_app:synapse_secure_password@localhost:5432/synapse"
	}

	return cfg
}

func discoverOrganizations(cfg Config, database *db.DB) ([]string, error) {
	if cfg.Organization != "all" {
		return []string{cfg.Organization}, nil
	}
	return database.ListOrganizations()
}

func compactOrganization(org string, cfg Config, database *db.DB, llmClient *llm.Client) Result {
	start := time.Now()
	result := Result{Organization: org}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	slog.Info("Compacting organization", "org", org)

	// Phase 1: Parallel cluster synthesis
	clusters, err := database.FindTopClusters(org, cfg.MaxClusters)
	if err != nil {
		slog.Error("Failed to find clusters", "org", org, "error", err)
		result.Errors++
	} else {
		synthesized := worker.ParallelSynthesize(ctx, clusters, database, llmClient, cfg.Workers)
		atomic.AddInt64(&result.ClustersSynthesized, int64(synthesized.Count))
		atomic.AddInt64(&result.TokensSaved, int64(synthesized.TokensSaved))
		atomic.AddInt64(&result.LLMCalls, int64(synthesized.LLMCalls))
		atomic.AddInt64(&result.Errors, int64(synthesized.Errors))
	}

	// Phase 2: Parallel fact supersession
	if llmClient.Enabled() {
		superseded := worker.ParallelSupersession(ctx, org, database, llmClient, cfg.Workers)
		atomic.AddInt64(&result.FactsSuperseded, int64(superseded.Count))
		atomic.AddInt64(&result.LLMCalls, int64(superseded.LLMCalls))
	}

	// Phase 3: Parallel opinion reinforcement
	if llmClient.Enabled() {
		reinforced := worker.ParallelReinforcement(ctx, org, database, llmClient, cfg.Workers)
		atomic.AddInt64(&result.OpinionsReinforced, int64(reinforced.Count))
		atomic.AddInt64(&result.LLMCalls, int64(reinforced.LLMCalls))
	}

	// Phase 4: Stale pruning (fast, no LLM)
	archived, err := database.ArchiveStaleChunks(org, cfg.ArchiveDays, cfg.MaxPrune)
	if err != nil {
		slog.Error("Prune failed", "org", org, "error", err)
		result.Errors++
	} else {
		result.ChunksArchived = int64(archived)
	}

	// Phase 5: Parallel observation refresh
	refreshed := worker.ParallelObservationRefresh(ctx, org, database, llmClient, cfg.Workers)
	atomic.AddInt64(&result.ObservationsRefreshed, int64(refreshed.Count))
	atomic.AddInt64(&result.LLMCalls, int64(refreshed.LLMCalls))

	result.DurationMs = time.Since(start).Milliseconds()
	slog.Info("Compaction complete",
		"org", org,
		"clusters", result.ClustersSynthesized,
		"superseded", result.FactsSuperseded,
		"archived", result.ChunksArchived,
		"observations", result.ObservationsRefreshed,
		"duration", result.DurationMs,
	)

	return result
}

func envInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		var i int
		if _, err := fmt.Sscanf(v, "%d", &i); err == nil {
			return i
		}
	}
	return defaultVal
}

// Ensure sync is used (for atomic operations in worker package)
var _ = sync.Mutex{}
