package api

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// S3GCResult contains garbage collection statistics.
type S3GCResult struct {
	ObjectsScanned int   `json:"objectsScanned"`
	Orphans        int   `json:"orphans"`
	BytesFreed     int64 `json:"bytesFreed"`
	Errors         int   `json:"errors"`
}

// RunS3GC scans all objects in the raw bucket and deletes those not referenced
// by any session's raw_storage_key. This reclaims space from failed uploads,
// deleted sessions, or interrupted captures.
func RunS3GC(ctx context.Context, app *App, dryRun bool) (*S3GCResult, error) {
	result := &S3GCResult{}
	start := time.Now()

	// List all objects in the bucket
	objects, err := app.Objects.ListAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("list bucket objects: %w", err)
	}
	result.ObjectsScanned = len(objects)

	if len(objects) == 0 {
		return result, nil
	}

	// Get all referenced storage keys from the database
	rows, err := app.DB.Query(ctx, `SELECT DISTINCT raw_storage_key FROM sessions WHERE raw_storage_key <> ''`)
	if err != nil {
		return nil, fmt.Errorf("query referenced keys: %w", err)
	}
	defer rows.Close()

	referenced := make(map[string]bool)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			continue
		}
		referenced[key] = true
	}

	// Find and optionally delete orphans
	for _, obj := range objects {
		if ctx.Err() != nil {
			break
		}
		if referenced[obj.Key] {
			continue
		}
		result.Orphans++
		result.BytesFreed += obj.Size

		if !dryRun {
			if err := app.Objects.Delete(ctx, obj.Key); err != nil {
				slog.Debug("S3 GC delete failed", "key", obj.Key, "error", err)
				result.Errors++
			}
		}
	}

	slog.Info("S3 garbage collection complete",
		"scanned", result.ObjectsScanned,
		"orphans", result.Orphans,
		"bytesFreed", result.BytesFreed,
		"dryRun", dryRun,
		"durationMs", time.Since(start).Milliseconds())
	return result, nil
}
