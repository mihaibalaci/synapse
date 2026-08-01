package storage

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"sort"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// RunMigrations applies every pending embedded SQL migration in filename order.
// A PostgreSQL advisory lock serializes concurrent API, worker, and deployment
// jobs. Applied files are checksum-verified so changing migration history fails
// loudly instead of producing servers with different schemas.
func (db *DB) RunMigrations(ctx context.Context) error {
	conn, err := db.Pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('synapse-schema-migrations'))`); err != nil {
		return fmt.Errorf("lock migrations: %w", err)
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext('synapse-schema-migrations'))`)

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version text PRIMARY KEY,
			checksum text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create migration ledger: %w", err)
	}

	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	for _, migration := range migrations {
		var existing string
		err := conn.QueryRow(ctx,
			`SELECT checksum FROM schema_migrations WHERE version = $1`, migration.version,
		).Scan(&existing)
		if err == nil {
			if existing != migration.checksum {
				return fmt.Errorf("migration %s checksum changed: database=%s binary=%s", migration.version, existing, migration.checksum)
			}
			continue
		}
		if !isNoRows(err) {
			return fmt.Errorf("read migration %s state: %w", migration.version, err)
		}

		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", migration.version, err)
		}
		if _, err := tx.Exec(ctx, migration.sql); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", migration.version, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
			migration.version, migration.checksum); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", migration.version, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", migration.version, err)
		}
	}
	return nil
}

// CheckMigrations verifies that every migration embedded in this binary has
// been applied. Runtime processes use this to fail fast with a useful error
// instead of surfacing "relation does not exist" on the first request.
func (db *DB) CheckMigrations(ctx context.Context) error {
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	for _, migration := range migrations {
		var checksum string
		if err := db.QueryRow(ctx,
			`SELECT checksum FROM schema_migrations WHERE version = $1`, migration.version,
		).Scan(&checksum); err != nil {
			return fmt.Errorf("migration %s is not applied; run `synapse migrate`: %w", migration.version, err)
		}
		if checksum != migration.checksum {
			return fmt.Errorf("migration %s checksum mismatch", migration.version)
		}
	}
	return nil
}

type migration struct {
	version  string
	checksum string
	sql      string
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, fmt.Errorf("read embedded migrations: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	out := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		body, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", entry.Name(), err)
		}
		sum := sha256.Sum256(body)
		out = append(out, migration{
			version: entry.Name(), checksum: hex.EncodeToString(sum[:]), sql: string(body),
		})
	}
	return out, nil
}
