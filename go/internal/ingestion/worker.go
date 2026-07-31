// Package ingestion implements the session processing pipeline.
//
// Architecture: a pool of goroutines processes jobs from Redis queues.
// Each job goes through: parse → segment → embed → extract facts → dedup → index.
package ingestion

import (
	"context"
	"encoding/json"
	"fmt"
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

	// Attempt counts how many times this job has been tried. A dequeue removes
	// the job from Redis, so a failure has to re-enqueue it explicitly or the
	// work is lost.
	Attempt int `json:"attempt,omitempty"`
}

// MaxJobAttempts bounds retries before a job is parked in the dead-letter list.
const MaxJobAttempts = 4

// deadLetterQueue holds jobs that exhausted their retries, so they can be
// inspected and replayed rather than disappearing.
const deadLetterQueue = "synapse:dead"

// target returns the identifier the job operates on, for logging.
func (j Job) target() string {
	if j.SessionID != "" {
		return j.SessionID
	}
	return j.ChunkID
}

// retryDelay backs off exponentially: 2s, 4s, 8s.
func retryDelay(attempt int) time.Duration {
	d := time.Duration(1<<uint(attempt)) * time.Second
	if d > 30*time.Second {
		d = 30 * time.Second
	}
	return d
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

		// One blocking call across every queue, so an idle queue costs nothing.
		// Queues are listed in priority order and BRPOP honours that order.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		data, queue, err := wp.cache.DequeueAny(ctx, 2*time.Second, wp.queues...)
		cancel()

		if err != nil {
			slog.Warn("Dequeue error", "error", err)
			time.Sleep(500 * time.Millisecond) // Back off on errors
			continue
		}
		if data == nil {
			continue // timed out with nothing queued
		}

		var job Job
		if err := json.Unmarshal(data, &job); err != nil {
			slog.Error("Invalid job, discarding", "queue", queue, "error", err)
			continue
		}

		wp.processJob(job)
	}
}

func (wp *WorkerPool) processJob(job Job) {
	start := time.Now()

	// A job may take a while (embedding is a network call), but it must not hang
	// forever holding a worker.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Panic recovery per job: one bad job must not take out the worker, and the
	// job is retried rather than dropped.
	defer func() {
		if r := recover(); r != nil {
			slog.Error("Job panicked", "type", job.Type, "id", job.target(), "panic", r)
			wp.retryOrPark(job, fmt.Errorf("panic: %v", r))
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
		slog.Warn("Unknown job type, discarding", "type", job.Type)
		return
	}

	if err != nil {
		slog.Error("Job failed", "type", job.Type, "id", job.target(),
			"attempt", job.Attempt+1, "error", err,
			"durationMs", time.Since(start).Milliseconds())
		wp.retryOrPark(job, err)
		return
	}

	slog.Info("Job complete", "type", job.Type, "id", job.target(),
		"durationMs", time.Since(start).Milliseconds())
}

// retryOrPark re-enqueues a failed job after a backoff, or moves it to the
// dead-letter list once it has exhausted its attempts.
func (wp *WorkerPool) retryOrPark(job Job, cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	job.Attempt++

	if job.Attempt >= MaxJobAttempts {
		parked := map[string]any{
			"job":      job,
			"error":    cause.Error(),
			"parkedAt": time.Now().UTC().Format(time.RFC3339),
		}
		data, err := json.Marshal(parked)
		if err == nil {
			if err := wp.cache.Enqueue(ctx, deadLetterQueue, data); err != nil {
				slog.Error("Could not park job in dead-letter queue",
					"type", job.Type, "id", job.target(), "error", err)
			}
		}
		slog.Error("Job exhausted retries, parked in dead-letter queue",
			"type", job.Type, "id", job.target(), "attempts", job.Attempt)

		// Reflect the terminal failure on the session so it is not left looking
		// like it is still in flight.
		if job.Type == "session" && job.SessionID != "" {
			wp.db.Exec(ctx, `
				UPDATE sessions SET status = 'failed', updated_at = NOW()
				 WHERE id = $1`, job.SessionID)
		}
		return
	}

	delay := retryDelay(job.Attempt)
	slog.Warn("Re-enqueueing job after backoff",
		"type", job.Type, "id", job.target(), "attempt", job.Attempt, "delay", delay)

	// Sleep before re-enqueueing so a persistently failing job does not spin the
	// queue. This occupies one worker briefly, which is acceptable given the
	// pool size and bounded attempts.
	time.Sleep(delay)

	data, err := json.Marshal(job)
	if err != nil {
		slog.Error("Could not re-encode job", "type", job.Type, "error", err)
		return
	}
	if err := wp.cache.Enqueue(ctx, "synapse:"+job.Type, data); err != nil {
		slog.Error("Could not re-enqueue job",
			"type", job.Type, "id", job.target(), "error", err)
	}
}
