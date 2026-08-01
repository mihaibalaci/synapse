package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// AuditEntry represents a single audit log record.
type AuditEntry struct {
	ID             int64           `json:"id"`
	Timestamp      time.Time       `json:"timestamp"`
	ActorID        string          `json:"actorId"`
	OrganizationID string          `json:"organizationId"`
	Action         string          `json:"action"`
	ResourceType   string          `json:"resourceType"`
	ResourceID     string          `json:"resourceId"`
	Details        json.RawMessage `json:"details"`
	IPAddress      string          `json:"ipAddress"`
	UserAgent      string          `json:"userAgent"`
}

// AuditRepo provides audit log operations.
type AuditRepo struct{ db *DB }

func NewAuditRepo(db *DB) *AuditRepo { return &AuditRepo{db: db} }

// Record writes an audit entry. Failures are logged but do not block the caller.
func (r *AuditRepo) Record(ctx context.Context, entry AuditEntry) error {
	details := entry.Details
	if details == nil {
		details = json.RawMessage("{}")
	}
	return r.db.Exec(ctx, `
		INSERT INTO audit_log (user_id, organization_id, action, resource_type, resource_id, metadata, ip_address, user_agent)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		entry.ActorID, entry.OrganizationID, entry.Action,
		entry.ResourceType, entry.ResourceID, details, entry.IPAddress, entry.UserAgent)
}

// Query returns recent audit entries for an organization with optional action filter.
func (r *AuditRepo) Query(ctx context.Context, orgID, action string, limit, offset int) ([]AuditEntry, error) {
	sql := `SELECT id, timestamp, user_id, organization_id, action, resource_type, resource_id, metadata, ip_address, user_agent
		FROM audit_log WHERE organization_id = $1`
	args := []any{orgID}
	if action != "" {
		sql += " AND action = $2"
		args = append(args, action)
	}
	sql += " ORDER BY timestamp DESC"
	if limit > 0 {
		sql += fmt.Sprintf(" LIMIT %d", limit)
	}
	if offset > 0 {
		sql += fmt.Sprintf(" OFFSET %d", offset)
	}

	rows, err := r.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.Timestamp, &e.ActorID, &e.OrganizationID,
			&e.Action, &e.ResourceType, &e.ResourceID, &e.Details, &e.IPAddress, &e.UserAgent); err != nil {
			continue
		}
		entries = append(entries, e)
	}
	return entries, nil
}
