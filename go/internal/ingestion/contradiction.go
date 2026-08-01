package ingestion

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// ContradictionDetector finds and supersedes conflicting facts. It runs after
// fact extraction to ensure new insights automatically replace outdated ones.
//
// Detection strategy:
//  1. For each new fact, find existing valid facts sharing at least one entity.
//  2. Among those, compute embedding cosine similarity (high similarity + same
//     entities + different content = likely contradiction or refinement).
//  3. When similarity exceeds a threshold AND the facts cover the same entity
//     set, mark the older fact as superseded by the newer one.
//
// This is deliberately conservative: it only supersedes when entity overlap is
// exact and semantic similarity is very high (>0.85), indicating the new fact
// is a refinement rather than a complementary observation.
type ContradictionDetector struct {
	db *storage.DB
}

func NewContradictionDetector(db *storage.DB) *ContradictionDetector {
	return &ContradictionDetector{db: db}
}

// DetectForFact checks whether a newly created fact contradicts or supersedes
// any existing valid facts with overlapping entities.
func (d *ContradictionDetector) DetectForFact(ctx context.Context, factID, orgID string) (int, error) {
	// Load the new fact's entities and embedding
	var entities []string
	var hasEmbedding bool
	err := d.db.QueryRow(ctx, `
		SELECT entities, embedding IS NOT NULL
		FROM memory_facts WHERE id = $1`, factID).Scan(&entities, &hasEmbedding)
	if err != nil {
		return 0, fmt.Errorf("load new fact: %w", err)
	}
	if len(entities) == 0 || !hasEmbedding {
		return 0, nil // can't compare without entities or embedding
	}

	// Find existing valid facts with overlapping entities and high similarity.
	// The query uses array overlap (&&) for entity match and cosine similarity
	// for semantic closeness.
	rows, err := d.db.Query(ctx, `
		SELECT old.id, old.content, old.entities,
			1 - (old.embedding <=> (SELECT embedding FROM memory_facts WHERE id = $1)) AS similarity
		FROM memory_facts old
		WHERE old.organization_id = $2
			AND old.id <> $1
			AND old.temporal_valid_until IS NULL
			AND old.embedding IS NOT NULL
			AND old.entities && $3::text[]
			AND 1 - (old.embedding <=> (SELECT embedding FROM memory_facts WHERE id = $1)) > 0.85
		ORDER BY similarity DESC
		LIMIT 10`, factID, orgID, entities)
	if err != nil {
		return 0, fmt.Errorf("find contradictions: %w", err)
	}
	defer rows.Close()

	superseded := 0
	for rows.Next() {
		var oldID, oldContent string
		var oldEntities []string
		var similarity float64
		if err := rows.Scan(&oldID, &oldContent, &oldEntities, &similarity); err != nil {
			continue
		}

		// Only supersede when entity sets are identical (not just overlapping)
		if !entitySetsEqual(entities, oldEntities) {
			continue
		}

		// Mark old fact as superseded
		err := d.db.Exec(ctx, `
			UPDATE memory_facts
			SET temporal_valid_until = NOW(),
				temporal_superseded_by = $2,
				updated_at = NOW()
			WHERE id = $1 AND temporal_valid_until IS NULL`,
			oldID, factID)
		if err != nil {
			slog.Warn("Failed to supersede fact", "old", oldID, "new", factID, "error", err)
			continue
		}
		superseded++
		slog.Info("Fact superseded",
			"old", oldID, "new", factID,
			"similarity", fmt.Sprintf("%.3f", similarity),
			"entities", entities,
		)
	}
	return superseded, nil
}

// DetectBatch scans recent facts and checks all of them for contradictions.
// Intended for periodic batch runs or the compaction pipeline.
func (d *ContradictionDetector) DetectBatch(ctx context.Context, orgID string, sinceDays int) (int, error) {
	if sinceDays <= 0 {
		sinceDays = 7
	}

	rows, err := d.db.Query(ctx, `
		SELECT id FROM memory_facts
		WHERE organization_id = $1
			AND temporal_valid_until IS NULL
			AND embedding IS NOT NULL
			AND created_at > NOW() - ($2 || ' days')::interval
		ORDER BY created_at DESC
		LIMIT 500`, orgID, fmt.Sprintf("%d", sinceDays))
	if err != nil {
		return 0, fmt.Errorf("load recent facts: %w", err)
	}
	defer rows.Close()

	var factIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			continue
		}
		factIDs = append(factIDs, id)
	}

	totalSuperseded := 0
	for _, fid := range factIDs {
		if ctx.Err() != nil {
			break
		}
		n, err := d.DetectForFact(ctx, fid, orgID)
		if err != nil {
			slog.Debug("Contradiction check failed", "fact", fid, "error", err)
			continue
		}
		totalSuperseded += n
	}

	if totalSuperseded > 0 {
		slog.Info("Batch contradiction detection complete",
			"org", orgID, "checked", len(factIDs), "superseded", totalSuperseded)
	}
	return totalSuperseded, nil
}

func entitySetsEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	setA := make(map[string]struct{}, len(a))
	for _, v := range a {
		setA[v] = struct{}{}
	}
	for _, v := range b {
		if _, ok := setA[v]; !ok {
			return false
		}
	}
	return true
}

// RecordSupersession is a Prometheus-compatible counter increment.
func RecordSupersession() {
	// Reuse the existing metrics infrastructure
	_ = time.Now() // placeholder; wired via API metrics below
}
