package storage

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mihaibalaci/synapse/internal/models"
)

// ─── Session Repository ──────────────────────────────────────────────────────

type SessionRepo struct{ db *DB }

func NewSessionRepo(db *DB) *SessionRepo { return &SessionRepo{db: db} }

func (r *SessionRepo) Create(ctx context.Context, s *models.Session) error {
	return r.db.Exec(ctx, `
		INSERT INTO sessions (id, client_id, developer_id, organization_id, team_id,
			status, searchable_status, enrichment_status, raw_storage_key,
			total_tokens, message_count, metadata, started_at, ended_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		ON CONFLICT DO NOTHING`,
		s.ID, s.ClientID, s.DeveloperID, s.OrganizationID, s.TeamID,
		s.Status, s.SearchableStatus, s.EnrichmentStatus, s.RawStorageKey,
		s.TotalTokens, s.MessageCount, s.Metadata, s.StartedAt, s.EndedAt,
	)
}

func (r *SessionRepo) GetByID(ctx context.Context, id string) (*models.Session, error) {
	var s models.Session
	err := r.db.QueryRow(ctx, `
		SELECT id, developer_id, organization_id, status, searchable_status,
			enrichment_status, total_tokens, message_count, created_at, updated_at
		FROM sessions WHERE id = $1`, id,
	).Scan(&s.ID, &s.DeveloperID, &s.OrganizationID, &s.Status, &s.SearchableStatus,
		&s.EnrichmentStatus, &s.TotalTokens, &s.MessageCount, &s.CreatedAt, &s.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return &s, err
}

func (r *SessionRepo) ListRecent(ctx context.Context, orgID string, limit int) ([]models.Session, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, developer_id, organization_id, searchable_status,
			enrichment_status, total_tokens, created_at, updated_at
		FROM sessions WHERE organization_id = $1
		ORDER BY updated_at DESC LIMIT $2`, orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []models.Session
	for rows.Next() {
		var s models.Session
		rows.Scan(&s.ID, &s.DeveloperID, &s.OrganizationID, &s.SearchableStatus,
			&s.EnrichmentStatus, &s.TotalTokens, &s.CreatedAt, &s.UpdatedAt)
		sessions = append(sessions, s)
	}
	return sessions, nil
}

// ─── Chunk Repository ────────────────────────────────────────────────────────

type ChunkRepo struct{ db *DB }

func NewChunkRepo(db *DB) *ChunkRepo { return &ChunkRepo{db: db} }

func (r *ChunkRepo) SearchByVector(ctx context.Context, embedding []float64, orgID string, limit int) ([]models.ChunkResult, error) {
	// pgvector ANN search
	rows, err := r.db.Query(ctx, `
		SELECT id, title, summary, content, token_count, type, repository, language,
			quality_score, usage_count, confidence, created_at,
			1 - (embedding <=> $1::vector) AS similarity
		FROM chunks
		WHERE organization_id = $2
			AND embedding IS NOT NULL
			AND searchable_status = 'searchable'
		ORDER BY embedding <=> $1::vector
		LIMIT $3`,
		vectorToString(embedding), orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []models.ChunkResult
	for rows.Next() {
		var c models.ChunkResult
		rows.Scan(&c.ID, &c.Title, &c.Summary, &c.Content, &c.TokenCount, &c.Type,
			&c.Repository, &c.Language, &c.QualityScore, &c.UsageCount, &c.Confidence,
			&c.CreatedAt, &c.Similarity)
		results = append(results, c)
	}
	return results, nil
}

func (r *ChunkRepo) SearchByKeyword(ctx context.Context, query, orgID string, limit int) ([]models.ChunkResult, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, title, summary, content, token_count, type, repository, language,
			quality_score, usage_count, confidence, created_at,
			ts_rank(search_vector, plainto_tsquery('english', $1)) AS similarity
		FROM chunks
		WHERE organization_id = $2
			AND searchable_status = 'searchable'
			AND search_vector @@ plainto_tsquery('english', $1)
		ORDER BY similarity DESC
		LIMIT $3`, query, orgID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []models.ChunkResult
	for rows.Next() {
		var c models.ChunkResult
		rows.Scan(&c.ID, &c.Title, &c.Summary, &c.Content, &c.TokenCount, &c.Type,
			&c.Repository, &c.Language, &c.QualityScore, &c.UsageCount, &c.Confidence,
			&c.CreatedAt, &c.Similarity)
		results = append(results, c)
	}
	return results, nil
}

func (r *ChunkRepo) Count(ctx context.Context, orgID string) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM chunks WHERE organization_id = $1`, orgID).Scan(&count)
	return count, err
}

// ─── Fact Repository ─────────────────────────────────────────────────────────

type FactRepo struct{ db *DB }

func NewFactRepo(db *DB) *FactRepo { return &FactRepo{db: db} }

func (r *FactRepo) Create(ctx context.Context, f *models.Fact) error {
	if f.ID == "" {
		f.ID = uuid.New().String()
	}
	return r.db.Exec(ctx, `
		INSERT INTO memory_facts (id, content, type, entities, temporal_observed_at,
			temporal_valid_from, source_chunk_id, source_session_id, extracted_from,
			author_id, organization_id, scope, confidence, embedding, embedding_model,
			repository, language, frameworks, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())
		ON CONFLICT DO NOTHING`,
		f.ID, f.Content, f.Type, f.Entities, time.Now(),
		f.ValidFrom, f.SourceChunkID, f.SourceSessionID, f.ExtractedFrom,
		f.AuthorID, f.OrganizationID, f.Scope, f.Confidence,
		vectorToString(f.Embedding), f.EmbeddingModel,
		f.Repository, f.Language, f.Frameworks,
	)
}

func (r *FactRepo) FindByEntities(ctx context.Context, entities []string, orgID string, limit int) ([]models.Fact, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, content, type, entities, confidence, usage_count, repository, created_at
		FROM memory_facts
		WHERE organization_id = $1
			AND entities && $2::text[]
			AND temporal_valid_until IS NULL
		ORDER BY confidence DESC, created_at DESC
		LIMIT $3`, orgID, entities, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var facts []models.Fact
	for rows.Next() {
		var f models.Fact
		rows.Scan(&f.ID, &f.Content, &f.Type, &f.Entities, &f.Confidence,
			&f.UsageCount, &f.Repository, &f.CreatedAt)
		facts = append(facts, f)
	}
	return facts, nil
}

func (r *FactRepo) GetHistory(ctx context.Context, entity, orgID string, limit int) ([]models.Fact, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, content, type, entities, confidence,
			temporal_valid_from, temporal_valid_until, temporal_superseded_by, created_at
		FROM memory_facts
		WHERE organization_id = $1 AND $2 = ANY(entities)
		ORDER BY temporal_valid_from ASC NULLS FIRST
		LIMIT $3`, orgID, entity, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var facts []models.Fact
	for rows.Next() {
		var f models.Fact
		rows.Scan(&f.ID, &f.Content, &f.Type, &f.Entities, &f.Confidence,
			&f.ValidFrom, &f.ValidUntil, &f.SupersededBy, &f.CreatedAt)
		facts = append(facts, f)
	}
	return facts, nil
}

func (r *FactRepo) Count(ctx context.Context, orgID string) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM memory_facts WHERE organization_id = $1`, orgID).Scan(&count)
	return count, err
}

func (r *FactRepo) IncrementUsage(ctx context.Context, factID string) error {
	return r.db.Exec(ctx, `
		UPDATE memory_facts SET usage_count = usage_count + 1, last_accessed_at = NOW(), updated_at = NOW()
		WHERE id = $1`, factID)
}

// ─── Stats ───────────────────────────────────────────────────────────────────

type StatsRepo struct{ db *DB }

func NewStatsRepo(db *DB) *StatsRepo { return &StatsRepo{db: db} }

func (r *StatsRepo) GetCounts(ctx context.Context, orgID string) (map[string]int, error) {
	var sessions, chunks, searchable, facts, clusters, knowledge, graphNodes int
	err := r.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM sessions WHERE organization_id = $1),
			(SELECT count(*) FROM chunks WHERE organization_id = $1),
			(SELECT count(*) FROM search_index_entries WHERE organization_id = $1 AND is_searchable),
			(SELECT count(*) FROM memory_facts WHERE organization_id = $1),
			(SELECT count(*) FROM chunk_clusters WHERE organization_id = $1),
			(SELECT count(*) FROM knowledge_records WHERE organization_id = $1),
			(SELECT count(*) FROM graph_nodes WHERE organization_id = $1)
	`, orgID).Scan(&sessions, &chunks, &searchable, &facts, &clusters, &knowledge, &graphNodes)
	if err != nil {
		return nil, err
	}
	return map[string]int{
		"sessions":         sessions,
		"chunks":           chunks,
		"searchableChunks": searchable,
		"facts":            facts,
		"clusters":         clusters,
		"knowledgeRecords": knowledge,
		"graphNodes":       graphNodes,
	}, nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func vectorToString(v []float64) *string {
	if len(v) == 0 {
		return nil
	}
	s := "["
	for i, val := range v {
		if i > 0 {
			s += ","
		}
		s += fmt.Sprintf("%f", val)
	}
	s += "]"
	return &s
}
