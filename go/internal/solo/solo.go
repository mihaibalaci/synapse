// Package solo implements the single-user embedded mode for Synapse.
//
// Solo mode runs the full Synapse API on localhost without external dependencies
// (no PostgreSQL, Redis, or S3 required). All data is stored in ~/.synapse/.
//
// Usage:
//
//	synapse solo              — Start solo mode (API + inline worker)
//	synapse solo init        — Initialize the data directory
//	synapse solo status      — Show memory stats
//	synapse solo export      — Export all data as JSON
package solo

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// Mode holds the runtime state for solo mode.
type Mode struct {
	config  *storage.SoloConfig
	store   *storage.SoloStore
	server  *http.Server
}

// Run starts solo mode. This is the entry point from main.go.
func Run(args []string) {
	subcommand := ""
	dataDir := ""
	if len(args) > 0 {
		subcommand = args[0]
	}

	// Parse flags
	for i := 0; i < len(args); i++ {
		if args[i] == "--data-dir" && i+1 < len(args) {
			dataDir = args[i+1]
			i++
		}
	}

	switch subcommand {
	case "init":
		runInit(dataDir)
	case "status":
		runStatus(dataDir)
	case "export":
		runExport(dataDir)
	default:
		runServe(dataDir)
	}
}

func runInit(dataDir string) {
	cfg := storage.LoadSoloConfig(dataDir)
	if err := cfg.Save(); err != nil {
		slog.Error("Failed to initialize solo mode", "error", err)
		os.Exit(1)
	}

	fmt.Printf("Synapse Solo Mode initialized\n")
	fmt.Printf("  Data directory: %s\n", cfg.DataDir)
	fmt.Printf("  Port: %d\n", cfg.Port)
	fmt.Printf("  Embedding: %s\n", cfg.EmbeddingModel)
	fmt.Printf("\nStart with: synapse solo\n")
	fmt.Printf("MCP config: SYNAPSE_API_URL=http://localhost:%d\n", cfg.Port)
}

func runStatus(dataDir string) {
	cfg := storage.LoadSoloConfig(dataDir)

	// Check if data directory exists
	if _, err := os.Stat(cfg.DataDir); os.IsNotExist(err) {
		fmt.Printf("Solo mode not initialized. Run: synapse solo init\n")
		os.Exit(1)
	}

	// Count objects
	objectsDir := filepath.Join(cfg.DataDir, "objects")
	objectCount := 0
	var totalSize int64
	_ = filepath.Walk(objectsDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			objectCount++
			totalSize += info.Size()
		}
		return nil
	})

	fmt.Printf("Synapse Solo Mode Status\n")
	fmt.Printf("========================\n")
	fmt.Printf("Data directory: %s\n", cfg.DataDir)
	fmt.Printf("Objects stored: %d\n", objectCount)
	fmt.Printf("Total size: %s\n", formatBytes(totalSize))
	fmt.Printf("Port: %d\n", cfg.Port)
	fmt.Printf("Embedding: %s @ %s\n", cfg.EmbeddingModel, cfg.EmbeddingURL)
}

func runExport(dataDir string) {
	cfg := storage.LoadSoloConfig(dataDir)
	objectsDir := filepath.Join(cfg.DataDir, "objects")

	type exportData struct {
		ExportedAt string            `json:"exportedAt"`
		DataDir    string            `json:"dataDir"`
		Objects    map[string]string `json:"objects"`
	}

	export := exportData{
		ExportedAt: time.Now().Format(time.RFC3339),
		DataDir:    cfg.DataDir,
		Objects:    make(map[string]string),
	}

	_ = filepath.Walk(objectsDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			rel, _ := filepath.Rel(objectsDir, path)
			data, readErr := os.ReadFile(path)
			if readErr == nil {
				export.Objects[rel] = string(data)
			}
		}
		return nil
	})

	out, _ := json.MarshalIndent(export, "", "  ")
	fmt.Println(string(out))
}

func runServe(dataDir string) {
	store, err := storage.InitSoloMode(dataDir)
	if err != nil {
		slog.Error("Failed to start solo mode", "error", err)
		os.Exit(1)
	}

	cfg := store.Config
	mux := http.NewServeMux()

	// Health endpoints
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok","mode":"solo"}`))
	})

	// Solo-specific status endpoint
	mux.HandleFunc("GET /api/v1/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"mode":     "solo",
			"vectors":  store.Vectors.Count(),
			"dataDir":  cfg.DataDir,
			"upSince":  time.Now().Format(time.RFC3339),
		})
	})

	// Capture endpoint (simplified for solo)
	mux.HandleFunc("POST /api/v1/capture/passive", soloCapture(store))
	mux.HandleFunc("POST /api/v1/capture/active", soloCapture(store))

	// Search endpoint (simplified for solo)
	mux.HandleFunc("POST /api/v1/search", soloSearch(store))
	mux.HandleFunc("POST /api/v1/context", soloSearch(store))

	server := &http.Server{
		Addr:         fmt.Sprintf("127.0.0.1:%d", cfg.Port),
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		slog.Info("Synapse Solo Mode starting",
			"addr", server.Addr,
			"dataDir", cfg.DataDir,
		)
		fmt.Printf("\n  Synapse Solo Mode\n")
		fmt.Printf("  API: http://localhost:%d\n", cfg.Port)
		fmt.Printf("  Data: %s\n", cfg.DataDir)
		fmt.Printf("  MCP: SYNAPSE_API_URL=http://localhost:%d\n\n", cfg.Port)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			slog.Error("Server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-done
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(ctx)
	slog.Info("Solo mode stopped")
}

// ─── Handlers ────────────────────────────────────────────────────────────────

func soloCapture(store *storage.SoloStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
			Source     string `json:"source"`
			Repository string `json:"repository"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
			return
		}
		if len(req.Messages) == 0 {
			http.Error(w, `{"error":"no messages"}`, http.StatusBadRequest)
			return
		}

		// Store raw session
		sessionID := fmt.Sprintf("solo-%d", time.Now().UnixNano())
		data, _ := json.Marshal(req)
		key := fmt.Sprintf("sessions/%s.json", sessionID)
		if err := store.Objects.Put(r.Context(), key, data, "application/json"); err != nil {
			http.Error(w, `{"error":"storage failed"}`, http.StatusInternalServerError)
			return
		}

		// Inline processing: segment and index
		for i, msg := range req.Messages {
			if msg.Content == "" {
				continue
			}
			chunkID := fmt.Sprintf("%s-chunk-%d", sessionID, i)
			title := truncate(msg.Content, 80)

			// Index for text search
			store.Text.Index(chunkID, title, msg.Content)

			// TODO: embed and add to vector index when embedder is available
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{
			"sessionId": sessionID,
			"status":    "captured",
			"chunks":    len(req.Messages),
		})
	}
}

func soloSearch(store *storage.SoloStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Query   string `json:"query"`
			TopK    int    `json:"topK"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
			return
		}
		if req.Query == "" {
			http.Error(w, `{"error":"query required"}`, http.StatusBadRequest)
			return
		}
		if req.TopK == 0 {
			req.TopK = 5
		}

		start := time.Now()

		// Run text search
		textResults := store.Text.Search(req.Query, req.TopK*2)

		// TODO: Run vector search when embedder available
		// vectorResults := store.Vectors.Search(queryEmbedding, req.TopK*2)

		// Build response from text results
		type result struct {
			ID       string  `json:"id"`
			Title    string  `json:"title"`
			Score    float64 `json:"finalScore"`
		}

		results := make([]result, 0, req.TopK)
		for i, tr := range textResults {
			if i >= req.TopK {
				break
			}
			results = append(results, result{
				ID:    tr.ID,
				Title: tr.ID,
				Score: tr.Score,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"results":    results,
			"totalCount": len(results),
			"query":      req.Query,
			"strategy":   "solo-hybrid",
			"latencyMs":  time.Since(start).Milliseconds(),
			"cached":     false,
		})
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

func formatBytes(b int64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(b)/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(b)/(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(b)/(1<<10))
	default:
		return fmt.Sprintf("%d B", b)
	}
}
