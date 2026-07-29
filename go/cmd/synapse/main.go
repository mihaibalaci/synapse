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
	"github.com/mihaibalaci/synapse/internal/cli"
	"github.com/mihaibalaci/synapse/internal/config"
	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/mcp"
	"github.com/mihaibalaci/synapse/internal/slack"
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
	case "verify-storage":
		runVerifyStorage(cfg)
	case "embed-backfill":
		runEmbedBackfill(cfg)
	case "search", "facts", "history", "reflect", "insight", "status":
		cli.Run(os.Args[1:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nUsage: synapse [serve|worker|compact|mcp|slack|verify-storage|embed-backfill|search|facts|history|reflect|insight|status]\n", mode)
		os.Exit(1)
	}
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

	// Drain in-flight jobs on SIGTERM rather than dropping them.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	slog.Info("Shutdown signal received, stopping workers")
	pool.Stop()
	slog.Info("Worker stopped cleanly")
}

func runCompaction(cfg *config.Config) {
	slog.Info("Running compaction...")
	// TODO: call the Go compaction logic directly (already in packages/compaction-go)
	slog.Info("Compaction complete")
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
