package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestSearchByKeywordScansNullRepository is a regression test for a silent data
// bug: chunks.repository is nullable, and because the row scan error was
// discarded, a NULL there aborted the scan partway and left every field after
// it (quality_score, usage_count, confidence, created_at, similarity) at its
// zero value. Ranking then ran on all-zero scores and results carried
// 0001-01-01 timestamps.
//
// Requires a live database; skipped otherwise.
func TestSearchByKeywordScansNullRepository(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping database test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	db, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer db.Close()

	orgID := "test-org-" + uuid.New().String()[:8]
	sessionID := uuid.New().String()
	chunkID := uuid.New().String()
	marker := "zqxjkvbn" + uuid.New().String()[:8] // unlikely to collide

	// A session row is required by the chunks foreign key.
	if err := db.Exec(ctx, `
		INSERT INTO sessions (id, client_id, developer_id, organization_id, status,
			searchable_status, enrichment_status, raw_storage_key, total_tokens,
			message_count, metadata, started_at, ended_at, created_at, updated_at)
		VALUES ($1,$1,'test-dev',$2,'indexed','searchable','pending','',10,2,'{}',NOW(),NOW(),NOW(),NOW())`,
		sessionID, orgID); err != nil {
		t.Fatalf("insert session: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		db.Exec(cleanupCtx, `DELETE FROM chunks WHERE id = $1`, chunkID)
		db.Exec(cleanupCtx, `DELETE FROM sessions WHERE id = $1`, sessionID)
	})

	// Deliberately leave repository NULL, which is what the capture path used to
	// write for every single chunk.
	if err := db.Exec(ctx, `
		INSERT INTO chunks (id, session_id, title, summary, content, token_count, type,
			repository, language, author_id, organization_id, embedding_model,
			embedding_version, searchable_status, confidence, quality_score,
			usage_count, created_at, updated_at)
		VALUES ($1,$2,'null repo title','summary',$3,42,'discussion',
			NULL,'en','test-dev',$4,'synapse-local-1536',1,'searchable','high',0.75,
			7,NOW(),NOW())`,
		chunkID, sessionID, "the "+marker+" token makes this row findable", orgID); err != nil {
		t.Fatalf("insert chunk: %v", err)
	}

	repo := NewChunkRepo(db)
	results, err := repo.SearchByKeyword(ctx, marker, orgID, 10)
	if err != nil {
		t.Fatalf("SearchByKeyword returned an error: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 result, got %d", len(results))
	}

	got := results[0]
	if got.Repository != "" {
		t.Errorf("Repository = %q, want empty string for a NULL column", got.Repository)
	}
	// These are the fields that used to be silently zeroed.
	if got.QualityScore == 0 {
		t.Error("QualityScore is zero; the row scan aborted before reaching it")
	}
	if got.UsageCount == 0 {
		t.Error("UsageCount is zero; the row scan aborted before reaching it")
	}
	if got.Confidence == "" {
		t.Error("Confidence is empty; the row scan aborted before reaching it")
	}
	if got.CreatedAt.IsZero() {
		t.Error("CreatedAt is the zero time; the row scan aborted before reaching it")
	}
	if got.CreatedAt.Year() < 2000 {
		t.Errorf("CreatedAt = %v, which is not a real timestamp", got.CreatedAt)
	}
	if got.TokenCount != 42 {
		t.Errorf("TokenCount = %d, want 42", got.TokenCount)
	}
}
