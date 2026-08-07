package ingestion

import (
	"context"
	"log/slog"

	"github.com/mihaibalaci/synapse/internal/storage"
	"github.com/mihaibalaci/synapse/internal/temporal"
)

// TemporalIndexer integrates temporal versioning into the ingestion pipeline.
// After fact extraction, it records each fact in its version chain and creates
// temporal edges between entities mentioned in the same fact.
type TemporalIndexer struct {
	engine *temporal.Engine
}

// NewTemporalIndexer creates a temporal indexer.
func NewTemporalIndexer(db *storage.DB) *TemporalIndexer {
	return &TemporalIndexer{
		engine: temporal.NewEngine(db),
	}
}

// IndexFact records a newly extracted fact in the temporal versioning system.
// This should be called after the fact is persisted to memory_facts.
func (ti *TemporalIndexer) IndexFact(ctx context.Context, factID, orgID, content string, entities []string) {
	if len(entities) == 0 {
		return
	}

	// Record in version chain (handles chain creation and supersession)
	if err := ti.engine.RecordFactVersion(ctx, factID, orgID, content, entities); err != nil {
		slog.Debug("Temporal version recording failed",
			"factId", factID, "error", err)
		// Non-fatal: temporal versioning is an enhancement
	}

	// Create temporal edges between co-occurring entities
	if len(entities) >= 2 {
		for i := 0; i < len(entities)-1; i++ {
			for j := i + 1; j < len(entities); j++ {
				_ = ti.engine.RecordTemporalEdge(ctx,
					orgID, entities[i], entities[j], "co-occurs", &factID)
			}
		}
	}
}

// IndexFactRelationships extracts and records typed relationships from fact content.
func (ti *TemporalIndexer) IndexFactRelationships(ctx context.Context, factID, orgID, content, factType string, entities []string) {
	if len(entities) < 2 {
		return
	}

	// Derive relationship type from fact type
	relation := factTypeToRelation(factType)

	// The first entity is typically the subject, others are related
	subject := entities[0]
	for _, obj := range entities[1:] {
		_ = ti.engine.RecordTemporalEdge(ctx, orgID, subject, obj, relation, &factID)
	}
}

func factTypeToRelation(factType string) string {
	switch factType {
	case "decision":
		return "decided-for"
	case "lesson":
		return "learned-about"
	case "pattern":
		return "implements"
	case "constraint":
		return "constrains"
	case "opinion":
		return "opines-on"
	default:
		return "relates-to"
	}
}
