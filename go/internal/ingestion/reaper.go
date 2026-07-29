package ingestion

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// StaleAfter is how long a session may sit unprocessed before the reaper
// assumes whatever was working on it died and re-enqueues it. It must exceed the
// worst-case processing time so an in-flight session is not picked up twice.
const StaleAfter = 10 * time.Minute

// ReapStranded re-enqueues sessions that were never finished.
//
// A dequeue removes the job from Redis, so if the worker dies mid-job the
// session is left in 'processing'/'pending' with nothing referring to it. The
// raw conversation is durable in object storage, so the work can always be
// redone; this finds those sessions and queues them again. Sessions with no raw
// object are skipped, since there is nothing to reprocess them from.
func (wp *WorkerPool) ReapStranded(ctx context.Context) (int, error) {
	rows, err := wp.db.Query(ctx, `
		SELECT id, organization_id
		FROM sessions
		WHERE searchable_status <> 'searchable'
		  AND status <> 'failed'
		  AND raw_storage_key <> ''
		  AND updated_at < NOW() - $1::interval
		ORDER BY created_at
		LIMIT 500`, fmt.Sprintf("%d seconds", int(StaleAfter.Seconds())))
	if err != nil {
		return 0, fmt.Errorf("query stranded sessions: %w", err)
	}
	defer rows.Close()

	type stranded struct{ id, orgID string }
	var found []stranded

	for rows.Next() {
		var s stranded
		if err := rows.Scan(&s.id, &s.orgID); err != nil {
			return 0, fmt.Errorf("scan stranded session: %w", err)
		}
		found = append(found, s)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate stranded sessions: %w", err)
	}

	requeued := 0
	for _, s := range found {
		job := Job{Type: "session", SessionID: s.id, OrganizationID: s.orgID}
		data, err := json.Marshal(job)
		if err != nil {
			continue
		}
		if err := wp.cache.Enqueue(ctx, "synapse:session", data); err != nil {
			slog.Error("Could not re-enqueue stranded session", "sessionId", s.id, "error", err)
			continue
		}
		// Touch updated_at so the same session is not re-queued on the next pass
		// while this attempt is still running.
		wp.db.Exec(ctx, `UPDATE sessions SET updated_at = NOW() WHERE id = $1`, s.id)
		requeued++
		slog.Info("Re-enqueued stranded session", "sessionId", s.id)
	}

	if requeued > 0 {
		slog.Warn("Recovered stranded sessions", "count", requeued)
	}
	return requeued, nil
}

// StartReaper runs recovery once at startup and then periodically, so a crash
// is repaired without operator intervention.
func (wp *WorkerPool) StartReaper(interval time.Duration) {
	wp.wg.Add(1)
	go func() {
		defer wp.wg.Done()

		// Immediate pass: a restart is exactly when stranded work exists.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		if _, err := wp.ReapStranded(ctx); err != nil {
			slog.Error("Startup recovery pass failed", "error", err)
		}
		cancel()

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-wp.stopCh:
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				if _, err := wp.ReapStranded(ctx); err != nil {
					slog.Error("Recovery pass failed", "error", err)
				}
				cancel()
			}
		}
	}()
}
