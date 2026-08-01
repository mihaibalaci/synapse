package ingestion

import (
	"context"
	"fmt"
	"log/slog"
	"math"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// ConfidenceCalibrator adjusts fact and chunk confidence based on age, usage,
// and feedback signals. Run periodically (e.g. daily) to keep scores meaningful.
type ConfidenceCalibrator struct {
	db *storage.DB
}

func NewConfidenceCalibrator(db *storage.DB) *ConfidenceCalibrator {
	return &ConfidenceCalibrator{db: db}
}

// CalibrateResult holds the outcome of a calibration run.
type CalibrateResult struct {
	FactsUpdated  int `json:"factsUpdated"`
	ChunksUpdated int `json:"chunksUpdated"`
}

// Run applies time-decay and usage-based confidence adjustments:
// - Facts without recent access decay toward 0.3 over 90 days
// - Chunks with high usage get a quality boost (capped at 0.95)
// - Chunks with zero usage for 60+ days decay quality toward 0.2
func (c *ConfidenceCalibrator) Run(ctx context.Context, orgID string) (*CalibrateResult, error) {
	result := &CalibrateResult{}

	// Fact confidence decay: facts not accessed in the last 30 days lose confidence
	// Formula: new_confidence = max(0.3, confidence * exp(-age_days / 90))
	tag, err := c.db.Pool.Exec(ctx, `
		UPDATE memory_facts
		SET confidence = GREATEST(0.3, confidence * exp(-EXTRACT(epoch FROM NOW() - COALESCE(last_accessed_at, created_at)) / 86400.0 / 90.0)),
			updated_at = NOW()
		WHERE organization_id = $1
			AND temporal_valid_until IS NULL
			AND (last_accessed_at IS NULL OR last_accessed_at < NOW() - interval '30 days')
			AND confidence > 0.35`, orgID)
	if err != nil {
		return result, fmt.Errorf("fact decay: %w", err)
	}
	result.FactsUpdated = int(tag.RowsAffected())

	// Chunk quality boost for high-usage content
	tag2, err := c.db.Pool.Exec(ctx, `
		UPDATE chunks
		SET quality_score = LEAST(0.95, quality_score + 0.02 * (usage_count::float / 50.0)),
			updated_at = NOW()
		WHERE organization_id = $1
			AND confidence <> 'archived'
			AND usage_count > 10
			AND quality_score < 0.9`, orgID)
	if err != nil {
		return result, fmt.Errorf("chunk boost: %w", err)
	}

	// Chunk quality decay for unused content
	tag3, err := c.db.Pool.Exec(ctx, `
		UPDATE chunks
		SET quality_score = GREATEST(0.2, quality_score - 0.05),
			updated_at = NOW()
		WHERE organization_id = $1
			AND confidence <> 'archived'
			AND usage_count = 0
			AND (last_accessed_at IS NULL OR last_accessed_at < NOW() - interval '60 days')
			AND quality_score > 0.25`, orgID)
	if err != nil {
		return result, fmt.Errorf("chunk decay: %w", err)
	}

	result.ChunksUpdated = int(tag2.RowsAffected()) + int(tag3.RowsAffected())

	if result.FactsUpdated > 0 || result.ChunksUpdated > 0 {
		slog.Info("Confidence calibration complete",
			"org", orgID,
			"factsUpdated", result.FactsUpdated,
			"chunksUpdated", result.ChunksUpdated)
	}
	return result, nil
}

// RecordPositiveFeedback boosts the fact/chunk that received a positive signal.
func RecordPositiveFeedback(ctx context.Context, db *storage.DB, resultID string) {
	// Try chunk first, then fact
	_ = db.Exec(ctx, `
		UPDATE chunks SET usage_count = usage_count + 1, last_accessed_at = NOW(), updated_at = NOW()
		WHERE id = $1`, resultID)
	_ = db.Exec(ctx, `
		UPDATE memory_facts SET usage_count = usage_count + 1, last_accessed_at = NOW(),
			confidence = LEAST(1.0, confidence + 0.02), updated_at = NOW()
		WHERE id = $1`, resultID)
}

// RecordNegativeFeedback weakens the fact/chunk that received a negative signal.
func RecordNegativeFeedback(ctx context.Context, db *storage.DB, resultID string) {
	_ = db.Exec(ctx, `
		UPDATE chunks SET quality_score = GREATEST(0.1, quality_score - 0.03), updated_at = NOW()
		WHERE id = $1`, resultID)
	_ = db.Exec(ctx, `
		UPDATE memory_facts SET confidence = GREATEST(0.1, confidence - 0.03), updated_at = NOW()
		WHERE id = $1`, resultID)
}

// Ensure math is used
var _ = math.Exp
