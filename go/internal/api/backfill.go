package api

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// BackfillResult reports what an embedding backfill run did.
type BackfillResult struct {
	Pending   int // rows found without an embedding
	Embedded  int // rows successfully given a vector
	Failed    int // rows the provider could not embed
	BatchSize int
}

// BackfillEmbeddings generates embeddings for chunks that do not have one.
//
// Chunks are stored whether or not embedding succeeds, so a provider outage or
// a configuration change leaves rows that are keyword-searchable but invisible
// to the semantic signal. This fills those in without re-ingesting anything.
func BackfillEmbeddings(ctx context.Context, app *App, batchSize int) (BackfillResult, error) {
	result := BackfillResult{BatchSize: batchSize}
	if app.Embedder == nil {
		return result, fmt.Errorf("no embedding provider configured")
	}
	if batchSize <= 0 {
		batchSize = 32
	}
	result.BatchSize = batchSize

	if err := app.DB.QueryRow(ctx,
		`SELECT count(*) FROM chunks WHERE embedding IS NULL`).Scan(&result.Pending); err != nil {
		return result, fmt.Errorf("count pending: %w", err)
	}
	if result.Pending == 0 {
		return result, nil
	}

	model := app.Embedder.Model()

	for {
		// Re-query each iteration rather than paging with an offset, since rows
		// stop matching once they are embedded.
		rows, err := app.DB.Query(ctx, `
			SELECT id, content
			FROM chunks
			WHERE embedding IS NULL
			ORDER BY created_at
			LIMIT $1`, batchSize)
		if err != nil {
			return result, fmt.Errorf("select batch: %w", err)
		}

		var (
			ids   []string
			texts []string
		)
		for rows.Next() {
			var id, content string
			if err := rows.Scan(&id, &content); err != nil {
				rows.Close()
				return result, fmt.Errorf("scan chunk: %w", err)
			}
			ids = append(ids, id)
			texts = append(texts, content)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return result, fmt.Errorf("iterate batch: %w", err)
		}
		if len(ids) == 0 {
			break
		}

		vectors, err := app.Embedder.EmbedBatch(ctx, texts)
		if err != nil {
			return result, fmt.Errorf("embed batch of %d: %w", len(texts), err)
		}
		if len(vectors) != len(ids) {
			return result, fmt.Errorf("provider returned %d vectors for %d inputs", len(vectors), len(ids))
		}

		for i, id := range ids {
			if len(vectors[i]) == 0 {
				result.Failed++
				slog.Warn("Provider returned an empty vector", "chunkId", id)
				continue
			}
			if err := app.DB.Exec(ctx, `
				UPDATE chunks
				   SET embedding = $2, embedding_model = $3, updated_at = NOW()
				 WHERE id = $1`,
				id, storage.VectorParam(vectors[i]), model); err != nil {
				result.Failed++
				slog.Warn("Could not store embedding", "chunkId", id, "error", err)
				continue
			}
			result.Embedded++
			RecordEmbedding()
		}

		slog.Info("Backfill progress",
			"embedded", result.Embedded, "failed", result.Failed, "pending", result.Pending)

		// Guard against a provider that always returns empty vectors, which
		// would otherwise loop forever on the same rows.
		if result.Embedded+result.Failed >= result.Pending {
			break
		}
	}

	return result, nil
}
