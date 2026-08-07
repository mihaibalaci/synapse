// Synapse — The memory layer that learns
//
// Single binary that runs the full system:
//   synapse serve       — Start the API server
//   synapse worker      — Start background workers
//   synapse compact     — Run compaction job
//   synapse mcp         — Start MCP server (stdin/stdout)
//
// Or run all in one process:
//   synapse             — API + Workers (default)

package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/mihaibalaci/synapse/internal/api"
	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/benchmark"
	"github.com/mihaibalaci/synapse/internal/cli"
	"github.com/mihaibalaci/synapse/internal/compaction"
	"github.com/mihaibalaci/synapse/internal/config"
	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/mcp"
	"github.com/mihaibalaci/synapse/internal/slack"
	"github.com/mihaibalaci/synapse/internal/solo"
	"github.com/mihaibalaci/synapse/internal/storage"
)

func main() {
	cfg := config.Load()

	// JSON structured logging
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: parseLogLevel(cfg.LogLevel),
	}))
	slog.SetDefault(logger)

	// Determine mode
	mode := "serve"
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}

	switch mode {
	case "serve", "":
		runServer(cfg)
	case "worker":
		runWorker(cfg)
	case "compact":
		runCompaction(cfg)
	case "mcp":
		runMCP(cfg)
	case "slack":
		runSlack()
	case "migrate":
		runMigrate(cfg)
	case "auth-bootstrap":
		runAuthBootstrap(cfg)
	case "verify-storage":
		runVerifyStorage(cfg)
	case "embed-backfill":
		runEmbedBackfill(cfg)
	case "detect-contradictions":
		runDetectContradictions(cfg)
	case "s3-gc":
		runS3GC(cfg)
	case "benchmark":
		runBenchmark(cfg)
	case "solo":
		solo.Run(os.Args[2:])
	case "search", "facts", "history", "reflect", "insight", "status":
		cli.Run(os.Args[1:])
	case "wrap":
		cli.WrapAgent(os.Args[2:])
	case "unwrap":
		cli.UnwrapAgent(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nUsage: synapse [serve|worker|migrate|auth-bootstrap|compact|detect-contradictions|mcp|slack|solo|verify-storage|embed-backfill|benchmark|search|facts|history|reflect|insight|status]\n", mode)
		os.Exit(1)
	}
}

// runMigrate applies the schema embedded in this binary. Deployment tooling
// runs this explicitly before starting API or worker processes.
func runMigrate(cfg *config.Config) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	db, err := storage.ConnectWithRetry(ctx, cfg.DatabaseURL, storage.DefaultRetry)
	if err != nil {
		slog.Error("Could not connect for migrations", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.RunMigrations(ctx); err != nil {
		slog.Error("Migration failed", "error", err)
		os.Exit(1)
	}
	slog.Info("Database migrations are current")
}

// runAuthBootstrap creates the first administrator for an organization. The
// password is accepted only through the process environment so it never appears
// in command arguments or logs.
func runAuthBootstrap(cfg *config.Config) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	db, err := storage.ConnectWithRetry(ctx, cfg.DatabaseURL, storage.DefaultRetry)
	if err != nil {
		slog.Error("Could not connect for auth bootstrap", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.CheckMigrations(ctx); err != nil {
		slog.Error("Authentication schema is not current", "error", err)
		os.Exit(1)
	}

	service := auth.NewService(db, cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience, cfg.AuthAccessTTL, cfg.AuthRefreshTTL)
	email := os.Getenv("AUTH_BOOTSTRAP_EMAIL")
	password := os.Getenv("AUTH_BOOTSTRAP_PASSWORD")
	organizationID := os.Getenv("AUTH_BOOTSTRAP_ORGANIZATION_ID")
	if organizationID == "" {
		organizationID = "default"
	}
	created, err := service.BootstrapAdmin(ctx, email, password, os.Getenv("AUTH_BOOTSTRAP_DISPLAY_NAME"), organizationID)
	if err != nil {
		slog.Error("Authentication bootstrap failed", "error", err)
		os.Exit(1)
	}
	if created {
		slog.Info("Initial administrator created", "email", email, "organization_id", organizationID)
	} else {
		slog.Info("Authentication bootstrap skipped because the organization already has users", "organization_id", organizationID)
	}
}

func runS3GC(cfg *config.Config) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	app, err := api.NewApp(ctx, cfg)
	if err != nil {
		slog.Error("Failed to initialize app for S3 GC", "error", err)
		os.Exit(1)
	}
	defer app.Close()

	dryRun := os.Getenv("S3_GC_DRY_RUN") == "true"
	result, err := api.RunS3GC(ctx, app, dryRun)
	if err != nil {
		slog.Error("S3 GC failed", "error", err)
		os.Exit(1)
	}
	fmt.Printf("objects scanned : %d\n", result.ObjectsScanned)
	fmt.Printf("orphans found  : %d\n", result.Orphans)
	fmt.Printf("bytes freed    : %d\n", result.BytesFreed)
	fmt.Printf("errors         : %d\n", result.Errors)
	fmt.Printf("dry run        : %v\n", dryRun)
}

// runDetectContradictions scans recent facts for semantic contradictions and
// marks older conflicting facts as superseded.
func runDetectContradictions(cfg *config.Config) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	db, err := storage.ConnectWithRetry(ctx, cfg.DatabaseURL, storage.DefaultRetry)
	if err != nil {
		slog.Error("Could not connect for contradiction detection", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.CheckMigrations(ctx); err != nil {
		slog.Error("Schema not current", "error", err)
		os.Exit(1)
	}

	detector := ingestion.NewContradictionDetector(db)
	org := os.Getenv("CONTRADICTION_ORGANIZATION")
	if org == "" {
		org = "default"
	}
	days := 7
	if v := os.Getenv("CONTRADICTION_SINCE_DAYS"); v != "" {
		fmt.Sscanf(v, "%d", &days)
	}

	superseded, err := detector.DetectBatch(ctx, org, days)
	if err != nil {
		slog.Error("Contradiction detection failed", "error", err)
		os.Exit(1)
	}
	fmt.Printf("facts superseded: %d\n", superseded)
}

// runVerifyStorage reports whether any session points at a raw object that is
// missing from object storage. Exits non-zero on drift so it can be wired into
// cron or a monitoring check.
func runVerifyStorage(cfg *config.Config) {
	ctx := context.Background()
	app, err := api.NewApp(ctx, cfg)
	if err != nil {
		slog.Error("Failed to initialize app", "error", err)
		os.Exit(1)
	}
	defer app.Close()

	report, err := api.VerifyStorage(ctx, app)
	if err != nil {
		slog.Error("Storage verification failed", "error", err)
		os.Exit(1)
	}

	fmt.Printf("sessions            : %d\n", report.Sessions)
	fmt.Printf("claiming raw object : %d\n", report.Claiming)
	fmt.Printf("  present           : %d\n", report.Present)
	fmt.Printf("  missing           : %d\n", report.Missing)
	fmt.Printf("no raw object       : %d\n", report.Unbacked)

	if report.Drifted() {
		fmt.Fprintf(os.Stderr, "\nDRIFT: %d session(s) reference objects that do not exist.\n", report.Missing)
		for _, k := range report.MissingExample {
			fmt.Fprintf(os.Stderr, "  missing: %s\n", k)
		}
		os.Exit(1)
	}
	fmt.Println("\nOK: every session's raw object is present.")
}

// runEmbedBackfill fills in embeddings for chunks that were stored while the
// embedding provider was unavailable or unconfigured.
func runEmbedBackfill(cfg *config.Config) {
	ctx := context.Background()
	app, err := api.NewApp(ctx, cfg)
	if err != nil {
		slog.Error("Failed to initialize app", "error", err)
		os.Exit(1)
	}
	defer app.Close()

	result, err := api.BackfillEmbeddings(ctx, app, 32)
	if err != nil {
		slog.Error("Backfill failed", "error", err,
			"embedded", result.Embedded, "failed", result.Failed)
		os.Exit(1)
	}

	fmt.Printf("chunks without embedding : %d\n", result.Pending)
	fmt.Printf("embedded                 : %d\n", result.Embedded)
	fmt.Printf("failed                   : %d\n", result.Failed)

	if result.Failed > 0 {
		os.Exit(1)
	}
}

func runServer(cfg *config.Config) {
	if err := cfg.ValidateAPI(); err != nil {
		slog.Error("Invalid API configuration", "error", err)
		os.Exit(1)
	}
	// Initialize app with storage connections
	ctx := context.Background()
	app, err := api.NewApp(ctx, cfg)
	if err != nil {
		slog.Error("Failed to initialize app", "error", err)
		os.Exit(1)
	}
	defer app.Close()

	router := api.NewRouter(cfg, app)

	server := &http.Server{
		Addr:         fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		slog.Info("Synapse API starting", "host", cfg.Host, "port", cfg.Port, "env", cfg.Environment)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-done
	slog.Info("Shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Error("Shutdown error", "error", err)
	}
	slog.Info("Server stopped")
}

// runWorker consumes queued ingestion jobs and recovers stranded sessions.
func runWorker(cfg *config.Config) {
	if err := cfg.ValidateRuntime(); err != nil {
		slog.Error("Invalid worker configuration", "error", err)
		os.Exit(1)
	}
	slog.Info("Synapse Worker starting", "env", cfg.Environment)

	ctx := context.Background()
	app, err := api.NewApp(ctx, cfg)
	if err != nil {
		slog.Error("Failed to initialize app", "error", err)
		os.Exit(1)
	}
	defer app.Close()

	workers := cfg.WorkerConcurrency
	if workers <= 0 {
		workers = 4
	}

	pool := ingestion.NewWorkerPool(app.DB, app.Cache, app.Objects, workers)

	// Recovery runs immediately and then on a timer, so a crash mid-job is
	// repaired without operator intervention.
	pool.StartReaper(5 * time.Minute)
	pool.Start()

	// Automatic compaction runs on a configurable interval (default: every 6 hours).
	// It summarizes old sessions in the background without blocking ingestion.
	compactInterval := time.Duration(envIntMain("COMPACTION_INTERVAL_HOURS", 6)) * time.Hour
	compactCtx, compactCancel := context.WithCancel(context.Background())
	go func() {
		if compactInterval <= 0 {
			return
		}
		embedder := ingestion.NewEmbeddingClient()
		compCfg := compaction.LoadConfigFromEnv()
		// Run once shortly after startup (2 min delay) then on interval.
		timer := time.NewTimer(2 * time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-compactCtx.Done():
				return
			case <-timer.C:
				slog.Info("Automatic compaction starting")
				result, err := compaction.Run(compactCtx, app.DB, embedder, compCfg)
				if err != nil {
					slog.Warn("Automatic compaction failed", "error", err)
				} else if result.SessionsCompacted > 0 {
					slog.Info("Automatic compaction complete",
						"sessions", result.SessionsCompacted,
						"tokensSaved", result.TokensSaved,
						"errors", result.Errors)
				}
				timer.Reset(compactInterval)
			}
		}
	}()

	// Drain in-flight jobs on SIGTERM rather than dropping them.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	slog.Info("Shutdown signal received, stopping workers")
	compactCancel()
	pool.Stop()
	slog.Info("Worker stopped cleanly")
}

func runCompaction(cfg *config.Config) {
	slog.Info("Running compaction...")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()

	db, err := storage.ConnectWithRetry(ctx, cfg.DatabaseURL, storage.DefaultRetry)
	if err != nil {
		slog.Error("Could not connect for compaction", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := db.CheckMigrations(ctx); err != nil {
		slog.Error("Schema not current", "error", err)
		os.Exit(1)
	}

	embedder := ingestion.NewEmbeddingClient()
	compCfg := compaction.LoadConfigFromEnv()

	result, err := compaction.Run(ctx, db, embedder, compCfg)
	if err != nil {
		slog.Error("Compaction failed", "error", err)
		os.Exit(1)
	}

	slog.Info("Compaction complete",
		"sessionsCompacted", result.SessionsCompacted,
		"chunksArchived", result.ChunksArchived,
		"summariesCreated", result.SummariesCreated,
		"tokensSaved", result.TokensSaved,
		"errors", result.Errors,
		"durationMs", result.DurationMs,
	)
	if result.Errors > 0 {
		os.Exit(1)
	}
}

func runMCP(cfg *config.Config) {
	apiURL := os.Getenv("SYNAPSE_API_URL")
	if apiURL == "" {
		apiURL = fmt.Sprintf("http://localhost:%d", cfg.Port)
	}

	// Prefer SYNAPSE_TOKEN_FILE so the credential can live in a mode-0600 file
	// instead of being inlined into an IDE's MCP config, which is often
	// world-readable and easy to commit by accident.
	token := os.Getenv("SYNAPSE_TOKEN")
	if token == "" {
		if path := os.Getenv("SYNAPSE_TOKEN_FILE"); path != "" {
			data, err := os.ReadFile(path)
			if err != nil {
				slog.Error("Could not read SYNAPSE_TOKEN_FILE", "path", path, "error", err)
				os.Exit(1)
			}
			token = strings.TrimSpace(string(data))
		}
	}
	if token == "" {
		slog.Warn("No SYNAPSE_TOKEN or SYNAPSE_TOKEN_FILE set; API calls will be unauthenticated")
	}

	mcp.Run(apiURL, token)
}

func runSlack() {
	bot := slack.NewBot()
	bot.Run()
}

func runBenchmark(cfg *config.Config) {
	bcfg := benchmark.RunnerConfig{
		DatabaseURL: cfg.DatabaseURL,
		RedisURL:    cfg.RedisURL,
		S3Endpoint:  cfg.S3Endpoint,
		S3Bucket:    cfg.S3Bucket,
		TopK:        5,
		Strategy:    "hybrid",
	}

	// Parse benchmark-specific flags from os.Args
	for i := 2; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--dataset":
			if i+1 < len(os.Args) {
				bcfg.DatasetName = os.Args[i+1]
				i++
			}
		case "--dataset-file":
			if i+1 < len(os.Args) {
				bcfg.DatasetFile = os.Args[i+1]
				i++
			}
		case "--output":
			if i+1 < len(os.Args) {
				bcfg.OutputFile = os.Args[i+1]
				i++
			}
		case "--top-k":
			if i+1 < len(os.Args) {
				fmt.Sscanf(os.Args[i+1], "%d", &bcfg.TopK)
				i++
			}
		case "--strategy":
			if i+1 < len(os.Args) {
				bcfg.Strategy = os.Args[i+1]
				i++
			}
		case "--max-tokens":
			if i+1 < len(os.Args) {
				fmt.Sscanf(os.Args[i+1], "%d", &bcfg.MaxTokens)
				i++
			}
		}
	}

	benchmark.RunBenchmarkCLI(bcfg)
}

func parseLogLevel(level string) slog.Level {
	switch level {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func envIntMain(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		var i int
		if _, err := fmt.Sscanf(v, "%d", &i); err == nil && i > 0 {
			return i
		}
	}
	return fallback
}
