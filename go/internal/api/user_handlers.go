package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/mihaibalaci/synapse/internal/auth"
)

func handleListUsers(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT id, email, display_name, organization_id, roles, disabled, last_login_at, created_at
		FROM auth_users
		WHERE organization_id = $1
		ORDER BY created_at DESC`, claims.OrganizationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type userRow struct {
		ID             string   `json:"id"`
		Email          string   `json:"email"`
		DisplayName    string   `json:"displayName"`
		OrganizationID string   `json:"organizationId"`
		Roles          []string `json:"roles"`
		Disabled       bool     `json:"disabled"`
		LastLoginAt    *string  `json:"lastLoginAt"`
		CreatedAt      string   `json:"createdAt"`
	}

	var users []userRow
	for rows.Next() {
		var u userRow
		var lastLogin *string
		var createdAt interface{}
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &u.OrganizationID, &u.Roles, &u.Disabled, &lastLogin, &createdAt); err != nil {
			writeError(w, http.StatusInternalServerError, "SCAN_ERROR", err.Error())
			return
		}
		u.LastLoginAt = lastLogin
		if t, ok := createdAt.(interface{ String() string }); ok {
			u.CreatedAt = t.String()
		}
		users = append(users, u)
	}
	if users == nil {
		users = []userRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users, "total": len(users)})
}

func handleCreateUser(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	var req struct {
		Email       string   `json:"email"`
		Password    string   `json:"password"`
		DisplayName string   `json:"displayName"`
		Roles       []string `json:"roles"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body")
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Valid email is required")
		return
	}
	if len(req.Password) < 12 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Password must be at least 12 characters")
		return
	}
	if len(req.Roles) == 0 {
		req.Roles = []string{"viewer"}
	}
	for _, role := range req.Roles {
		if !validRole(role) {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid role: "+role)
			return
		}
	}

	var id string
	err := appFromRequest(r).DB.QueryRow(r.Context(), `
		INSERT INTO auth_users (email, normalized_email, display_name, password_hash, organization_id, roles)
		VALUES ($1, $1, $2, crypt($3, gen_salt('bf', 12)), $4, $5::text[])
		RETURNING id`,
		email, strings.TrimSpace(req.DisplayName), req.Password, claims.OrganizationID, req.Roles,
	).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
			writeError(w, http.StatusConflict, "CONFLICT", "A user with that email already exists in this organization")
			return
		}
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "created": true})
}

func handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	userID := chi.URLParam(r, "id")

	var req struct {
		DisplayName *string  `json:"displayName"`
		Roles       []string `json:"roles"`
		Disabled    *bool    `json:"disabled"`
		Password    *string  `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body")
		return
	}

	// Prevent last-admin lockout
	if req.Disabled != nil && *req.Disabled || (req.Roles != nil && !contains(req.Roles, "admin")) {
		var adminCount int
		_ = appFromRequest(r).DB.QueryRow(r.Context(), `
			SELECT count(*) FROM auth_users
			WHERE organization_id = $1 AND NOT disabled AND 'admin' = ANY(roles) AND id <> $2`,
			claims.OrganizationID, userID).Scan(&adminCount)
		if adminCount == 0 {
			writeError(w, http.StatusConflict, "LOCKOUT", "Cannot remove the last active admin")
			return
		}
	}

	ctx := r.Context()
	if req.DisplayName != nil {
		if err := appFromRequest(r).DB.Exec(ctx, `UPDATE auth_users SET display_name = $2, updated_at = NOW() WHERE id = $1 AND organization_id = $3`,
			userID, strings.TrimSpace(*req.DisplayName), claims.OrganizationID); err != nil {
			writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
			return
		}
	}
	if req.Roles != nil {
		for _, role := range req.Roles {
			if !validRole(role) {
				writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid role: "+role)
				return
			}
		}
		if err := appFromRequest(r).DB.Exec(ctx, `UPDATE auth_users SET roles = $2::text[], updated_at = NOW() WHERE id = $1 AND organization_id = $3`,
			userID, req.Roles, claims.OrganizationID); err != nil {
			writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
			return
		}
	}
	if req.Disabled != nil {
		if err := appFromRequest(r).DB.Exec(ctx, `UPDATE auth_users SET disabled = $2, updated_at = NOW() WHERE id = $1 AND organization_id = $3`,
			userID, *req.Disabled, claims.OrganizationID); err != nil {
			writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
			return
		}
		// Revoke all sessions when disabling
		if *req.Disabled {
			_ = appFromRequest(r).DB.Exec(ctx, `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1`, userID)
		}
	}
	if req.Password != nil {
		if len(*req.Password) < 12 {
			writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Password must be at least 12 characters")
			return
		}
		if err := appFromRequest(r).DB.Exec(ctx, `UPDATE auth_users SET password_hash = crypt($2, gen_salt('bf', 12)), updated_at = NOW() WHERE id = $1 AND organization_id = $3`,
			userID, *req.Password, claims.OrganizationID); err != nil {
			writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
			return
		}
		// Force re-login after password change
		_ = appFromRequest(r).DB.Exec(ctx, `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1`, userID)
	}

	writeJSON(w, http.StatusOK, map[string]any{"updated": true})
}

func handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	userID := chi.URLParam(r, "id")

	// Prevent self-deletion and last-admin deletion
	if userID == claims.UserID {
		writeError(w, http.StatusConflict, "LOCKOUT", "Cannot delete your own account")
		return
	}
	var adminCount int
	_ = appFromRequest(r).DB.QueryRow(r.Context(), `
		SELECT count(*) FROM auth_users
		WHERE organization_id = $1 AND NOT disabled AND 'admin' = ANY(roles) AND id <> $2`,
		claims.OrganizationID, userID).Scan(&adminCount)
	if adminCount == 0 {
		writeError(w, http.StatusConflict, "LOCKOUT", "Cannot delete the last active admin")
		return
	}

	err := appFromRequest(r).DB.Exec(r.Context(), `DELETE FROM auth_users WHERE id = $1 AND organization_id = $2`, userID, claims.OrganizationID)
	if errors.Is(err, nil) {
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
	} else {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
	}
}

func handleListRoles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"roles": []map[string]string{
			{"id": "admin", "label": "Admin", "description": "Full system access including user management"},
			{"id": "team_lead", "label": "Team Lead", "description": "Team-scoped data access and configuration"},
			{"id": "developer", "label": "Developer", "description": "Capture sessions, search, and manage own data"},
			{"id": "viewer", "label": "Viewer", "description": "Read-only access to search and facts"},
		},
	})
}

func validRole(role string) bool {
	switch role {
	case "admin", "team_lead", "developer", "viewer":
		return true
	}
	return false
}

func contains(slice []string, value string) bool {
	for _, v := range slice {
		if v == value {
			return true
		}
	}
	return false
}
