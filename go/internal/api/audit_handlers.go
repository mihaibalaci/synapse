package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/storage"
)

// Audit records an event asynchronously. Failures are logged but never block the request.
func Audit(app *App, r *http.Request, action, resourceType, resourceID string, details any) {
	claims := auth.GetClaims(r)
	actorID, actorEmail, orgID := "", "", ""
	if claims != nil {
		actorID = claims.UserID
		orgID = claims.OrganizationID
	}

	var detailsJSON json.RawMessage
	if details != nil {
		detailsJSON, _ = json.Marshal(details)
	}

	entry := storage.AuditEntry{
		ActorID: actorID, ActorEmail: actorEmail, OrganizationID: orgID,
		Action: action, ResourceType: resourceType, ResourceID: resourceID,
		Details: detailsJSON, IPAddress: requestIP(r), UserAgent: r.UserAgent(),
	}

	go func() {
		if err := app.Audit.Record(r.Context(), entry); err != nil {
			slog.Debug("Audit log write failed", "action", action, "error", err)
		}
	}()
}

// handleAuditLog returns paginated audit entries for the admin panel.
func handleAuditLog(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	action := r.URL.Query().Get("action")
	limit := queryInt(r, "limit", 50)
	offset := queryInt(r, "offset", 0)

	entries, err := appFromRequest(r).Audit.Query(r.Context(), claims.OrganizationID, action, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	if entries == nil {
		entries = []storage.AuditEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "count": len(entries)})
}
