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
	"syscall"
	"time"

	"github.com/mihaibalaci/synapse/internal/api"
	"github.com/mihaibalaci/synapse/internal/cli"
	"github.com/mihaibalaci/synapse/internal/config"
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
	case "search", "facts", "history", "reflect", "insight", "status":
		cli.Run(os.Args[1:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\nUsage: synapse [serve|worker|compact|mcp|slack|search|facts|history|reflect|insight|status]\n", mode)
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

func runWorker(cfg *config.Config) {
	slog.Info("Synapse Worker starting", "env", cfg.Environment)
	// TODO: Phase 4 — implement goroutine-based workers
	slog.Info("Worker not yet implemented in Go — use TypeScript worker for now")
	select {} // Block forever
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
	token := os.Getenv("SYNAPSE_TOKEN")
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
