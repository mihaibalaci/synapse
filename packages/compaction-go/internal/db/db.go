// Package db handles PostgreSQL connections and queries for compaction.
package db

import (
	"database/sql"
	"fmt"

	_ "github.com/lib/pq"
)

type DB struct {
	conn *sql.DB
}

type Cluster struct {
	ID              string
	OrganizationID  string
	CanonicalID     string
	MemberIDs       []string
	Title           string
	MemberCount     int
}

type Fact struct {
	ID             string
	Content        string
	Type           string
	Entities       []string
	Confidence     float64
	CreatedAt      string
	Embedding      []float64
}

func Connect(url string) (*DB, error) {
	conn, err := sql.Open("postgres", url)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	conn.SetMaxOpenConns(20)
	conn.SetMaxIdleConns(5)
	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &DB{conn: conn}, nil
}

func (d *DB) Close() error {
	return d.conn.Close()
}

func (d *DB) ListOrganizations() ([]string, error) {
	rows, err := d.conn.Query(`
		SELECT DISTINCT organization_id FROM sessions
		WHERE searchable_status = 'searchable'
		ORDER BY organization_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orgs []string
	for rows.Next() {
		var org string
		if err := rows.Scan(&org); err != nil {
			return nil, err
		}
		orgs = append(orgs, org)
	}
	return orgs, nil
}

func (d *DB) FindTopClusters(org string, limit int) ([]Cluster, error) {
	rows, err := d.conn.Query(`
		SELECT id, organization_id, canonical_chunk_id, member_chunk_ids, title, member_count
		FROM chunk_clusters
		WHERE organization_id = $1 AND member_count >= 5
		ORDER BY member_count DESC
		LIMIT $2
	`, org, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var clusters []Cluster
	for rows.Next() {
		var c Cluster
		var memberIDs []byte
		if err := rows.Scan(&c.ID, &c.OrganizationID, &c.CanonicalID, &memberIDs, &c.Title, &c.MemberCount); err != nil {
			return nil, err
		}
		// Parse PostgreSQL UUID array
		c.MemberIDs = parseUUIDArray(memberIDs)
		clusters = append(clusters, c)
	}
	return clusters, nil
}

func (d *DB) ArchiveStaleChunks(org string, archiveDays, maxPrune int) (int, error) {
	result, err := d.conn.Exec(`
		UPDATE chunks SET confidence = 'archived', updated_at = NOW()
		WHERE id IN (
			SELECT id FROM chunks
			WHERE organization_id = $1
				AND confidence <> 'archived'
				AND is_canonical = false
				AND usage_count = 0
				AND quality_score < 0.3
				AND created_at < NOW() - ($2 || ' days')::interval
				AND (last_accessed_at IS NULL OR last_accessed_at < NOW() - ($2 || ' days')::interval)
			ORDER BY quality_score ASC
			LIMIT $3
		)
	`, org, archiveDays, maxPrune)
	if err != nil {
		return 0, err
	}
	rows, _ := result.RowsAffected()
	return int(rows), nil
}

func (d *DB) GetRecentFacts(org string, days int) ([]Fact, error) {
	rows, err := d.conn.Query(`
		SELECT id, content, type, entities, confidence, created_at
		FROM memory_facts
		WHERE organization_id = $1
			AND created_at >= NOW() - ($2 || ' days')::interval
			AND temporal_valid_until IS NULL
		ORDER BY created_at DESC
		LIMIT 200
	`, org, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var facts []Fact
	for rows.Next() {
		var f Fact
		var entities []byte
		if err := rows.Scan(&f.ID, &f.Content, &f.Type, &entities, &f.Confidence, &f.CreatedAt); err != nil {
			return nil, err
		}
		f.Entities = parseStringArray(entities)
		facts = append(facts, f)
	}
	return facts, nil
}

func (d *DB) GetOpinions(org string, limit int) ([]Fact, error) {
	rows, err := d.conn.Query(`
		SELECT id, content, type, entities, confidence, created_at
		FROM memory_facts
		WHERE organization_id = $1
			AND type = 'opinion'
			AND temporal_valid_until IS NULL
		ORDER BY confidence DESC
		LIMIT $2
	`, org, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var facts []Fact
	for rows.Next() {
		var f Fact
		var entities []byte
		if err := rows.Scan(&f.ID, &f.Content, &f.Type, &entities, &f.Confidence, &f.CreatedAt); err != nil {
			return nil, err
		}
		f.Entities = parseStringArray(entities)
		facts = append(facts, f)
	}
	return facts, nil
}

func (d *DB) MarkFactSuperseded(oldID, newID string) error {
	_, err := d.conn.Exec(`
		UPDATE memory_facts
		SET temporal_valid_until = NOW(), temporal_superseded_by = $2, updated_at = NOW()
		WHERE id = $1
	`, oldID, newID)
	return err
}

func (d *DB) UpdateOpinionConfidence(factID string, confidence float64) error {
	_, err := d.conn.Exec(`
		UPDATE memory_facts SET confidence = $2, updated_at = NOW() WHERE id = $1
	`, factID, confidence)
	return err
}

func (d *DB) Conn() *sql.DB {
	return d.conn
}

// Helpers
func parseUUIDArray(data []byte) []string {
	s := string(data)
	if len(s) < 3 {
		return nil
	}
	// Strip { and }
	s = s[1 : len(s)-1]
	if s == "" {
		return nil
	}
	var result []string
	for _, item := range splitCSV(s) {
		result = append(result, item)
	}
	return result
}

func parseStringArray(data []byte) []string {
	return parseUUIDArray(data)
}

func splitCSV(s string) []string {
	var result []string
	current := ""
	for _, c := range s {
		if c == ',' {
			result = append(result, current)
			current = ""
		} else {
			current += string(c)
		}
	}
	if current != "" {
		result = append(result, current)
	}
	return result
}
