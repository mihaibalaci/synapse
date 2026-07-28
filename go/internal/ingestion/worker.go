// Package ingestion implements the session processing pipeline.
//
// Architecture: a pool of goroutines processes jobs from Redis queues.
// Each job goes through: parse → segment → embed → extract facts → dedup → index.
package ingestion

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// WorkerPool manages a pool of ingestion workers.
type WorkerPool struct {
	db       *storage.DB
	cache    *storage.Cache
	objects  *storage.ObjectStore
	pipeline *Pipeline

	workers    int
	queues     []string
	stopCh     chan struct{}
	wg         sync.WaitGroup
}

// Job represents a queued processing task.
type Job struct {
	Type           string `json:"type"`
	SessionID      string `json:"sessionId,omitempty"`
	ChunkID        string `json:"chunkId,omitempty"`
	OrganizationID string `json:"organizationId"`
	Priority       int    `json:"priority"`
}

// NewWorkerPool creates a worker pool with the given concurrency.
func NewWorkerPool(db *storage.DB, cache *storage.Cache, objects *storage.ObjectStore, workers int) *WorkerPool {
	return &WorkerPool{
		db:      db,
		cache:   cache,
		objects: objects,
		pipeline: NewPipeline(db, cache, objects),
		workers: workers,
		queues: []string{
			"synapse:session",
			"synapse:facts",
			"synapse:knowledge",
			"synapse:dedup",
			"synapse:graph",
			"synapse:index",
		},
		stopCh: make(chan struct{}),
	}
}

// Start launches the worker goroutines.
func (wp *WorkerPool) Start() {
	slog.Info("Starting ingestion workers", "count", wp.workers, "queues", len(wp.queues))

	for i := 0; i < wp.workers; i++ {
		wp.wg.Add(1)
		go wp.run(i)
	}
}

// Stop gracefully shuts down all workers.
func (wp *WorkerPool) Stop() {
	close(wp.stopCh)
	wp.wg.Wait()
	slog.Info("All ingestion workers stopped")
}

func (wp *WorkerPool) run(id int) {
	defer wp.wg.Done()
	defer func() {
		if r := recover(); r != nil {
			slog.Error("Worker panicked, restarting", "id", id, "panic", r)
			// Restart this worker
			wp.wg.Add(1)
			go wp.run(id)
		}
	}()
	slog.Debug("Worker started", "id", id)

	for {
		select {
		case <-wp.stopCh:
			return
		default:
		}

		// Round-robin across queues
		for _, queue := range wp.queues {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			data, err := wp.cache.Dequeue(ctx, queue, 1*time.Second)
			cancel()

			if err != nil {
				slog.Warn("Dequeue error", "queue", queue, "error", err)
				time.Sleep(500 * time.Millisecond) // Back off on errors
				continue
			}
			if data == nil {
				continue
			}

			var job Job
			if err := json.Unmarshal(data, &job); err != nil {
				slog.Error("Invalid job", "queue", queue, "error", err)
				continue
			}

			wp.processJob(job)
		}
	}
}

func (wp *WorkerPool) processJob(job Job) {
	start := time.Now()
	ctx := context.Background()

	// Panic recovery per-job — one bad job doesn't crash the worker
	defer func() {
		if r := recover(); r != nil {
			slog.Error("Job panicked", "type", job.Type, "id", job.SessionID+job.ChunkID, "panic", r)
		}
	}()

	var err error
	switch job.Type {
	case "session":
		err = wp.pipeline.ProcessSession(ctx, job.SessionID, job.OrganizationID)
	case "facts":
		err = wp.pipeline.ExtractFacts(ctx, job.ChunkID, job.OrganizationID)
	case "knowledge":
		err = wp.pipeline.ExtractKnowledge(ctx, job.ChunkID)
	case "dedup":
		err = wp.pipeline.Deduplicate(ctx, job.ChunkID, job.OrganizationID)
	case "graph":
		err = wp.pipeline.IndexGraph(ctx, job.ChunkID)
	case "index":
		err = wp.pipeline.IndexSearch(ctx, job.ChunkID)
	default:
		slog.Warn("Unknown job type", "type", job.Type)
		return
	}

	if err != nil {
		slog.Error("Job failed", "type", job.Type, "id", job.SessionID+job.ChunkID, "error", err, "durationMs", time.Since(start).Milliseconds())
	} else {
		slog.Debug("Job complete", "type", job.Type, "durationMs", time.Since(start).Milliseconds())
	}
}
