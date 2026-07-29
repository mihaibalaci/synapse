package api

import (
	"context"
	"fmt"
	"log/slog"
)

// StorageReport summarises consistency between the session rows in Postgres and
// the raw objects they point at in object storage.
type StorageReport struct {
	Sessions       int      // total session rows
	Claiming       int      // rows advertising a raw object
	Present        int      // objects that were found
	Missing        int      // objects that are gone
	Unbacked       int      // rows explicitly marked as having no raw object
	MissingExample []string // a sample of missing keys, for diagnosis
}

// Drifted reports whether any session points at an object that does not exist.
func (r StorageReport) Drifted() bool { return r.Missing > 0 }

// VerifyStorage cross-checks every session's raw_storage_key against the object
// store.
//
// Raw objects are the only durable copy of a verbatim conversation, and a failed
// write used to be swallowed, which left thousands of rows pointing at objects
// that were never created. Nothing surfaced that drift: the dashboard counted
// the sessions as healthy and searches kept working off the derived chunks. This
// makes the invariant checkable instead of invisible.
func VerifyStorage(ctx context.Context, app *App) (StorageReport, error) {
	var report StorageReport

	rows, err := app.DB.Query(ctx, `
		SELECT id, raw_storage_key
		FROM sessions
		ORDER BY created_at DESC`)
	if err != nil {
		return report, fmt.Errorf("query sessions: %w", err)
	}
	defer rows.Close()

	type entry struct{ id, key string }
	var toCheck []entry

	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.id, &e.key); err != nil {
			return report, fmt.Errorf("scan session: %w", err)
		}
		report.Sessions++
		if e.key == "" {
			report.Unbacked++
			continue
		}
		report.Claiming++
		toCheck = append(toCheck, e)
	}
	if err := rows.Err(); err != nil {
		return report, fmt.Errorf("iterate sessions: %w", err)
	}

	for _, e := range toCheck {
		exists, err := app.Objects.Exists(ctx, e.key)
		if err != nil {
			// Treat a probe failure as missing but say so, since an unreachable
			// store should not be reported as clean.
			slog.Warn("Could not probe object", "sessionId", e.id, "key", e.key, "error", err)
		}
		if exists {
			report.Present++
			continue
		}
		report.Missing++
		if len(report.MissingExample) < 10 {
			report.MissingExample = append(report.MissingExample, e.key)
		}
	}

	return report, nil
}
