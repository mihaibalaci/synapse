// Package temporal implements temporal fact versioning for Synapse.
//
// Unlike simple supersession (old fact marked as replaced), temporal versioning
// maintains full version chains that track how knowledge evolves over time.
// This enables:
//
//   - Point-in-time queries: "What did we believe about X at time T?"
//   - Evolution tracking: "How has our caching strategy changed?"
//   - Change frequency analysis: "Which decisions are most volatile?"
//   - Temporal graph queries: "What relationships existed between A and B last month?"
//
// Architecture:
//
//	FactVersionChain → [Fact_v1, Fact_v2, Fact_v3, ...]
//	                       ↓          ↓          ↓
//	                   ChangeLog  ChangeLog  (current)
//	                       ↓          ↓
//	                 TemporalEdges (with valid_from/valid_until)
package temporal

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// ─── Domain Types ────────────────────────────────────────────────────────────

// VersionChain represents a series of facts about the same topic over time.
type VersionChain struct {
	ID              string    `json:"id"`
	OrganizationID  string    `json:"organizationId"`
	CanonicalTopic  string    `json:"canonicalTopic"`
	Entities        []string  `json:"entities"`
	CurrentFactID   *string   `json:"currentFactId"`
	VersionIDs      []string  `json:"versionIds"`
	VersionCount    int       `json:"versionCount"`
	FirstObservedAt time.Time `json:"firstObservedAt"`
	LastUpdatedAt   time.Time `json:"lastUpdatedAt"`
	ChangeFrequency float64   `json:"changeFrequency"` // versions per month
}

// TemporalEdge represents a time-bounded relationship between entities.
type TemporalEdge struct {
	ID             string     `json:"id"`
	OrganizationID string     `json:"organizationId"`
	SourceEntity   string     `json:"sourceEntity"`
	TargetEntity   string     `json:"targetEntity"`
	Relation       string     `json:"relation"`
	ValidFrom      time.Time  `json:"validFrom"`
	ValidUntil     *time.Time `json:"validUntil,omitempty"`
	Weight         float64    `json:"weight"`
	Confidence     float64    `json:"confidence"`
	SourceFactID   *string    `json:"sourceFactId,omitempty"`
	SupersededBy   *string    `json:"supersededBy,omitempty"`
}

// ChangeLogEntry records why and how a fact changed.
type ChangeLogEntry struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organizationId"`
	VersionChainID string    `json:"versionChainId"`
	PreviousFactID *string   `json:"previousFactId,omitempty"`
	NewFactID      string    `json:"newFactId"`
	ChangeType     string    `json:"changeType"` // evolution, correction, supersession, retraction
	ChangeReason   string    `json:"changeReason"`
	DetectedBy     string    `json:"detectedBy"` // auto, user, contradiction-detector
	ChangedAt      time.Time `json:"changedAt"`
}

// TimelineEntry represents a single point on an entity's timeline.
type TimelineEntry struct {
	FactID          string     `json:"factId"`
	Content         string     `json:"content"`
	FactType        string     `json:"factType"`
	Confidence      float64    `json:"confidence"`
	ObservedAt      time.Time  `json:"observedAt"`
	ValidFrom       *time.Time `json:"validFrom,omitempty"`
	ValidUntil      *time.Time `json:"validUntil,omitempty"`
	SupersededBy    *string    `json:"supersededBy,omitempty"`
	CanonicalTopic  string     `json:"canonicalTopic,omitempty"`
	VersionCount    int        `json:"versionCount"`
	ChangeFrequency float64    `json:"changeFrequency"`
	TemporalStatus  string     `json:"temporalStatus"` // active, superseded, expired, historical
}

// PointInTimeQuery requests facts as they were at a specific moment.
type PointInTimeQuery struct {
	OrganizationID string    `json:"organizationId"`
	AsOf           time.Time `json:"asOf"`
	Entities       []string  `json:"entities,omitempty"`
	Types          []string  `json:"types,omitempty"`
	Limit          int       `json:"limit"`
}

// EvolutionQuery requests the full history of a topic or entity.
type EvolutionQuery struct {
	OrganizationID string `json:"organizationId"`
	Entity         string `json:"entity,omitempty"`
	Topic          string `json:"topic,omitempty"`
	Limit          int    `json:"limit"`
}

// ─── Engine ──────────────────────────────────────────────────────────────────

// Engine manages temporal fact versioning operations.
type Engine struct {
	db *storage.DB
}

// NewEngine creates a temporal versioning engine.
func NewEngine(db *storage.DB) *Engine {
	return &Engine{db: db}
}

// RecordFactVersion adds a new fact to its version chain, creating the chain
// if this is the first version. This is called during ingestion when a new fact
// is detected that relates to an existing topic.
func (e *Engine) RecordFactVersion(ctx context.Context, factID, orgID, content string, entities []string) error {
	// Find or create a version chain for this topic
	topic := deriveTopic(content, entities)
	chainID, isNew, err := e.findOrCreateChain(ctx, orgID, topic, entities)
	if err != nil {
		return fmt.Errorf("find/create chain: %w", err)
	}

	if isNew {
		// First version: just link the fact to the new chain
		return e.db.Exec(ctx, `
			UPDATE fact_versions
			SET current_fact_id = $1, version_ids = ARRAY[$1::uuid], version_count = 1
			WHERE id = $2`,
			factID, chainID)
	}

	// Existing chain: this is an evolution of existing knowledge
	// Get the current head of the chain
	var previousFactID *string
	_ = e.db.QueryRow(ctx, `
		SELECT current_fact_id FROM fact_versions WHERE id = $1`, chainID,
	).Scan(&previousFactID)

	// Mark the previous fact as superseded
	if previousFactID != nil {
		_ = e.db.Exec(ctx, `
			UPDATE memory_facts
			SET temporal_superseded_by = $1, temporal_valid_until = NOW(), updated_at = NOW()
			WHERE id = $2`,
			factID, *previousFactID)
	}

	// Update the chain: append new version, update head
	err = e.db.Exec(ctx, `
		UPDATE fact_versions
		SET current_fact_id = $1,
			version_ids = array_append(version_ids, $1::uuid),
			version_count = version_count + 1,
			last_updated_at = NOW(),
			entities = (
				SELECT array_agg(DISTINCT e)
				FROM unnest(entities || $3::text[]) AS e
			),
			change_frequency = CASE
				WHEN first_observed_at = NOW() THEN 0
				ELSE (version_count + 1)::double precision /
					GREATEST(1, EXTRACT(EPOCH FROM NOW() - first_observed_at) / 2592000)
			END
		WHERE id = $2`,
		factID, chainID, entities)
	if err != nil {
		return fmt.Errorf("update chain: %w", err)
	}

	// Link the fact to its chain
	_ = e.db.Exec(ctx, `
		UPDATE memory_facts SET version_chain_id = $1 WHERE id = $2`, chainID, factID)

	// Record the change
	changeType := "evolution"
	if previousFactID != nil {
		changeType = detectChangeType(content)
	}

	return e.db.Exec(ctx, `
		INSERT INTO fact_change_log (id, organization_id, version_chain_id,
			previous_fact_id, new_fact_id, change_type, detected_by, changed_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'auto', NOW())`,
		uuid.New().String(), orgID, chainID, previousFactID, factID, changeType)
}

// RecordTemporalEdge creates or updates a temporal relationship between entities.
func (e *Engine) RecordTemporalEdge(ctx context.Context, orgID, source, target, relation string, factID *string) error {
	// Check if there's an active edge with the same relationship
	var existingID string
	err := e.db.QueryRow(ctx, `
		SELECT id FROM temporal_edges
		WHERE organization_id = $1 AND source_entity = $2 AND target_entity = $3
			AND relation = $4 AND valid_until IS NULL
		LIMIT 1`,
		orgID, source, target, relation,
	).Scan(&existingID)

	newID := uuid.New().String()

	if err == nil && existingID != "" {
		// Edge already exists and is active — update weight
		return e.db.Exec(ctx, `
			UPDATE temporal_edges
			SET weight = weight + 0.1, confidence = LEAST(1.0, confidence + 0.05)
			WHERE id = $1`, existingID)
	}

	// Create new temporal edge
	return e.db.Exec(ctx, `
		INSERT INTO temporal_edges (id, organization_id, source_entity, target_entity,
			relation, valid_from, weight, confidence, source_fact_id)
		VALUES ($1, $2, $3, $4, $5, NOW(), 1.0, 0.7, $6)
		ON CONFLICT (organization_id, source_entity, target_entity, relation, valid_from) DO NOTHING`,
		newID, orgID, source, target, relation, factID)
}

// SupersedeEdge marks an existing edge as no longer valid and optionally
// creates a replacement.
func (e *Engine) SupersedeEdge(ctx context.Context, edgeID string, replacementID *string) error {
	err := e.db.Exec(ctx, `
		UPDATE temporal_edges
		SET valid_until = NOW(), superseded_by = $2
		WHERE id = $1`, edgeID, replacementID)
	return err
}

// ─── Temporal Queries ────────────────────────────────────────────────────────

// QueryPointInTime returns facts that were active at a specific point in time.
func (e *Engine) QueryPointInTime(ctx context.Context, q PointInTimeQuery) ([]TimelineEntry, error) {
	if q.Limit == 0 {
		q.Limit = 50
	}

	query := `
		SELECT mf.id, mf.content, mf.type, mf.confidence,
			mf.temporal_observed_at, mf.temporal_valid_from, mf.temporal_valid_until,
			mf.temporal_superseded_by,
			COALESCE(fv.canonical_topic, ''), COALESCE(fv.version_count, 1),
			COALESCE(fv.change_frequency, 0)
		FROM memory_facts mf
		LEFT JOIN fact_versions fv ON fv.id = mf.version_chain_id
		WHERE mf.organization_id = $1
			AND mf.temporal_observed_at <= $2
			AND (mf.temporal_valid_until IS NULL OR mf.temporal_valid_until > $2)
			AND (mf.temporal_superseded_by IS NULL
				OR (SELECT temporal_observed_at FROM memory_facts WHERE id = mf.temporal_superseded_by) > $2)`

	args := []any{q.OrganizationID, q.AsOf}
	n := 3

	if len(q.Entities) > 0 {
		query += fmt.Sprintf(` AND mf.entities && $%d::text[]`, n)
		args = append(args, q.Entities)
		n++
	}
	if len(q.Types) > 0 {
		query += fmt.Sprintf(` AND mf.type = ANY($%d::text[])`, n)
		args = append(args, q.Types)
		n++
	}

	query += fmt.Sprintf(` ORDER BY mf.confidence DESC, mf.temporal_observed_at DESC LIMIT $%d`, n)
	args = append(args, q.Limit)

	rows, err := e.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("point-in-time query: %w", err)
	}
	defer rows.Close()

	var entries []TimelineEntry
	for rows.Next() {
		var entry TimelineEntry
		if err := rows.Scan(
			&entry.FactID, &entry.Content, &entry.FactType, &entry.Confidence,
			&entry.ObservedAt, &entry.ValidFrom, &entry.ValidUntil,
			&entry.SupersededBy,
			&entry.CanonicalTopic, &entry.VersionCount, &entry.ChangeFrequency,
		); err != nil {
			continue
		}
		entry.TemporalStatus = computeTemporalStatus(entry, q.AsOf)
		entries = append(entries, entry)
	}
	return entries, nil
}

// QueryEvolution returns the full version history of a topic or entity.
func (e *Engine) QueryEvolution(ctx context.Context, q EvolutionQuery) ([]TimelineEntry, error) {
	if q.Limit == 0 {
		q.Limit = 50
	}

	var query string
	var args []any

	if q.Topic != "" {
		// Query by topic (version chain)
		query = `
			SELECT mf.id, mf.content, mf.type, mf.confidence,
				mf.temporal_observed_at, mf.temporal_valid_from, mf.temporal_valid_until,
				mf.temporal_superseded_by,
				fv.canonical_topic, fv.version_count, fv.change_frequency
			FROM fact_versions fv
			JOIN memory_facts mf ON mf.id = ANY(fv.version_ids)
			WHERE fv.organization_id = $1 AND fv.canonical_topic = $2
			ORDER BY mf.temporal_observed_at ASC
			LIMIT $3`
		args = []any{q.OrganizationID, q.Topic, q.Limit}
	} else if q.Entity != "" {
		// Query by entity
		query = `
			SELECT mf.id, mf.content, mf.type, mf.confidence,
				mf.temporal_observed_at, mf.temporal_valid_from, mf.temporal_valid_until,
				mf.temporal_superseded_by,
				COALESCE(fv.canonical_topic, ''), COALESCE(fv.version_count, 1),
				COALESCE(fv.change_frequency, 0)
			FROM memory_facts mf
			LEFT JOIN fact_versions fv ON fv.id = mf.version_chain_id
			WHERE mf.organization_id = $1 AND $2 = ANY(mf.entities)
			ORDER BY mf.temporal_observed_at ASC
			LIMIT $3`
		args = []any{q.OrganizationID, q.Entity, q.Limit}
	} else {
		return nil, fmt.Errorf("either topic or entity is required")
	}

	rows, err := e.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("evolution query: %w", err)
	}
	defer rows.Close()

	var entries []TimelineEntry
	for rows.Next() {
		var entry TimelineEntry
		if err := rows.Scan(
			&entry.FactID, &entry.Content, &entry.FactType, &entry.Confidence,
			&entry.ObservedAt, &entry.ValidFrom, &entry.ValidUntil,
			&entry.SupersededBy,
			&entry.CanonicalTopic, &entry.VersionCount, &entry.ChangeFrequency,
		); err != nil {
			continue
		}
		entry.TemporalStatus = computeTemporalStatus(entry, time.Now())
		entries = append(entries, entry)
	}
	return entries, nil
}

// QueryTemporalEdges returns relationships active at a point in time.
func (e *Engine) QueryTemporalEdges(ctx context.Context, orgID, entity string, asOf time.Time, limit int) ([]TemporalEdge, error) {
	if limit == 0 {
		limit = 50
	}

	rows, err := e.db.Query(ctx, `
		SELECT id, organization_id, source_entity, target_entity, relation,
			valid_from, valid_until, weight, confidence, source_fact_id, superseded_by
		FROM temporal_edges
		WHERE organization_id = $1
			AND (source_entity = $2 OR target_entity = $2)
			AND valid_from <= $3
			AND (valid_until IS NULL OR valid_until > $3)
		ORDER BY weight DESC
		LIMIT $4`, orgID, entity, asOf, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var edges []TemporalEdge
	for rows.Next() {
		var edge TemporalEdge
		if err := rows.Scan(
			&edge.ID, &edge.OrganizationID, &edge.SourceEntity, &edge.TargetEntity,
			&edge.Relation, &edge.ValidFrom, &edge.ValidUntil,
			&edge.Weight, &edge.Confidence, &edge.SourceFactID, &edge.SupersededBy,
		); err != nil {
			continue
		}
		edges = append(edges, edge)
	}
	return edges, nil
}

// GetVolatileTopics returns the most frequently changing version chains.
func (e *Engine) GetVolatileTopics(ctx context.Context, orgID string, limit int) ([]VersionChain, error) {
	if limit == 0 {
		limit = 20
	}

	rows, err := e.db.Query(ctx, `
		SELECT id, organization_id, canonical_topic, entities, current_fact_id,
			version_count, first_observed_at, last_updated_at, change_frequency
		FROM fact_versions
		WHERE organization_id = $1 AND version_count > 1
		ORDER BY change_frequency DESC
		LIMIT $2`, orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var chains []VersionChain
	for rows.Next() {
		var c VersionChain
		if err := rows.Scan(
			&c.ID, &c.OrganizationID, &c.CanonicalTopic, &c.Entities,
			&c.CurrentFactID, &c.VersionCount,
			&c.FirstObservedAt, &c.LastUpdatedAt, &c.ChangeFrequency,
		); err != nil {
			continue
		}
		chains = append(chains, c)
	}
	return chains, nil
}

// GetChangeLog returns the change history for a version chain.
func (e *Engine) GetChangeLog(ctx context.Context, chainID string, limit int) ([]ChangeLogEntry, error) {
	if limit == 0 {
		limit = 50
	}

	rows, err := e.db.Query(ctx, `
		SELECT id, organization_id, version_chain_id, previous_fact_id,
			new_fact_id, change_type, change_reason, detected_by, changed_at
		FROM fact_change_log
		WHERE version_chain_id = $1
		ORDER BY changed_at DESC
		LIMIT $2`, chainID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []ChangeLogEntry
	for rows.Next() {
		var e ChangeLogEntry
		if err := rows.Scan(
			&e.ID, &e.OrganizationID, &e.VersionChainID, &e.PreviousFactID,
			&e.NewFactID, &e.ChangeType, &e.ChangeReason, &e.DetectedBy, &e.ChangedAt,
		); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

func (e *Engine) findOrCreateChain(ctx context.Context, orgID, topic string, entities []string) (string, bool, error) {
	// Try to find existing chain
	var chainID string
	err := e.db.QueryRow(ctx, `
		SELECT id FROM fact_versions
		WHERE organization_id = $1 AND canonical_topic = $2`,
		orgID, topic,
	).Scan(&chainID)

	if err == nil {
		return chainID, false, nil
	}

	// Also try matching by entity overlap with high similarity
	err = e.db.QueryRow(ctx, `
		SELECT id FROM fact_versions
		WHERE organization_id = $1
			AND entities && $2::text[]
			AND array_length(
				(SELECT array_agg(e) FROM unnest(entities) e WHERE e = ANY($2::text[])), 1
			) >= 2
		ORDER BY last_updated_at DESC
		LIMIT 1`,
		orgID, entities,
	).Scan(&chainID)

	if err == nil {
		return chainID, false, nil
	}

	// Create new chain
	chainID = uuid.New().String()
	createErr := e.db.Exec(ctx, `
		INSERT INTO fact_versions (id, organization_id, canonical_topic, entities, first_observed_at, last_updated_at)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
		ON CONFLICT (organization_id, canonical_topic) DO UPDATE SET last_updated_at = NOW()
		RETURNING id`,
		chainID, orgID, topic, entities)
	if createErr != nil {
		// Race condition: another goroutine created it first
		_ = e.db.QueryRow(ctx, `
			SELECT id FROM fact_versions WHERE organization_id = $1 AND canonical_topic = $2`,
			orgID, topic).Scan(&chainID)
		return chainID, false, nil
	}

	return chainID, true, nil
}

// deriveTopic generates a canonical topic string from fact content and entities.
// This groups related facts into the same version chain.
func deriveTopic(content string, entities []string) string {
	// Use the primary entities as the topic key
	if len(entities) >= 2 {
		return fmt.Sprintf("%s:%s", entities[0], entities[1])
	}
	if len(entities) == 1 {
		return entities[0]
	}
	// Fallback: use first 50 chars of content normalized
	topic := content
	if len(topic) > 50 {
		topic = topic[:50]
	}
	return topic
}

// detectChangeType determines how a fact changed based on content analysis.
func detectChangeType(content string) string {
	lower := content
	// Look for signals of different change types
	corrections := []string{"correction:", "fix:", "actually", "was wrong", "corrected"}
	retractions := []string{"no longer", "deprecated", "removed", "stopped using", "abandoned"}

	for _, sig := range corrections {
		if containsInsensitive(lower, sig) {
			return "correction"
		}
	}
	for _, sig := range retractions {
		if containsInsensitive(lower, sig) {
			return "retraction"
		}
	}
	return "evolution"
}

func containsInsensitive(s, substr string) bool {
	// Simple case-insensitive contains
	sl := len(s)
	subl := len(substr)
	if subl > sl {
		return false
	}
	for i := 0; i <= sl-subl; i++ {
		match := true
		for j := 0; j < subl; j++ {
			sc := s[i+j]
			sc2 := substr[j]
			if sc >= 'A' && sc <= 'Z' {
				sc += 32
			}
			if sc2 >= 'A' && sc2 <= 'Z' {
				sc2 += 32
			}
			if sc != sc2 {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func computeTemporalStatus(entry TimelineEntry, asOf time.Time) string {
	if entry.SupersededBy != nil {
		return "superseded"
	}
	if entry.ValidUntil != nil && entry.ValidUntil.Before(asOf) {
		return "expired"
	}
	if entry.ValidFrom != nil && entry.ValidFrom.After(asOf) {
		return "future"
	}
	return "active"
}

// RefreshTimeline refreshes the entity_timeline materialized view.
func (e *Engine) RefreshTimeline(ctx context.Context) error {
	slog.Debug("Refreshing entity timeline materialized view")
	return e.db.Exec(ctx, `REFRESH MATERIALIZED VIEW CONCURRENTLY entity_timeline`)
}
