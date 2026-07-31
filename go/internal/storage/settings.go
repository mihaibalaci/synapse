package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// SettingsRepo persists operator-editable runtime configuration.
//
// Values are stored as jsonb keyed by a group name, so adding a new settings
// group does not require a migration. Environment variables remain the
// bootstrap defaults; a row here overrides them.
type SettingsRepo struct{ db *DB }

func NewSettingsRepo(db *DB) *SettingsRepo { return &SettingsRepo{db: db} }

// Get unmarshals the stored value for a key into out. It reports false when no
// value has been saved, leaving out untouched so the caller can fall back to
// its defaults.
func (r *SettingsRepo) Get(ctx context.Context, key string, out any) (bool, error) {
	var raw []byte
	err := r.db.QueryRow(ctx,
		`SELECT value FROM system_settings WHERE key = $1`, key).Scan(&raw)
	if err != nil {
		if isNoRows(err) {
			return false, nil
		}
		return false, fmt.Errorf("load setting %q: %w", key, err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, fmt.Errorf("decode setting %q: %w", key, err)
	}
	return true, nil
}

// Set writes a settings group, recording who changed it.
func (r *SettingsRepo) Set(ctx context.Context, key string, value any, updatedBy string) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode setting %q: %w", key, err)
	}
	return r.db.Exec(ctx, `
		INSERT INTO system_settings (key, value, updated_at, updated_by)
		VALUES ($1, $2, NOW(), $3)
		ON CONFLICT (key) DO UPDATE
		   SET value = EXCLUDED.value,
		       updated_at = NOW(),
		       updated_by = EXCLUDED.updated_by`,
		key, raw, updatedBy)
}

// Meta returns when a settings group was last changed and by whom.
func (r *SettingsRepo) Meta(ctx context.Context, key string) (updatedAt string, updatedBy string, err error) {
	err = r.db.QueryRow(ctx, `
		SELECT to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), updated_by
		FROM system_settings WHERE key = $1`, key).Scan(&updatedAt, &updatedBy)
	if err != nil {
		if isNoRows(err) {
			return "", "", nil
		}
		return "", "", err
	}
	return updatedAt, updatedBy, nil
}
