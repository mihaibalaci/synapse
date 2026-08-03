package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mihaibalaci/synapse/internal/auth"
)

// ─── Organizations ───────────────────────────────────────────────────────────

func handleListOrganizations(w http.ResponseWriter, r *http.Request) {
	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT id, name, description, created_at FROM organizations ORDER BY name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type orgRow struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		CreatedAt   string `json:"createdAt"`
	}
	var orgs []orgRow
	for rows.Next() {
		var o orgRow
		var createdAt time.Time
		if err := rows.Scan(&o.ID, &o.Name, &o.Description, &createdAt); err != nil {
			continue
		}
		o.CreatedAt = createdAt.Format(time.RFC3339)
		orgs = append(orgs, o)
	}
	if orgs == nil {
		orgs = []orgRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"organizations": orgs, "count": len(orgs)})
}

func handleCreateOrganization(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	req.ID = strings.ToLower(strings.TrimSpace(req.ID))
	req.Name = strings.TrimSpace(req.Name)
	if req.ID == "" || req.Name == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "id and name are required")
		return
	}

	err := appFromRequest(r).DB.Exec(r.Context(), `
		INSERT INTO organizations (id, name, description) VALUES ($1, $2, $3)`,
		req.ID, req.Name, req.Description)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			writeError(w, http.StatusConflict, "CONFLICT", "Organization already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": req.ID, "created": true})
}

// ─── Teams ───────────────────────────────────────────────────────────────────

func handleListTeams(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT t.id, t.name, t.description, t.created_at,
			(SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
			COALESCE(
				(SELECT string_agg(au.display_name, ', ')
				 FROM team_members tm2
				 JOIN auth_users au ON au.id = tm2.user_id
				 WHERE tm2.team_id = t.id AND tm2.role = 'lead'), ''
			) AS leads
		FROM teams t
		WHERE t.organization_id = $1
		ORDER BY t.name`, claims.OrganizationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type teamRow struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		MemberCount int    `json:"memberCount"`
		Leads       string `json:"leads"`
		CreatedAt   string `json:"createdAt"`
	}
	var teams []teamRow
	for rows.Next() {
		var t teamRow
		var createdAt time.Time
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &createdAt, &t.MemberCount, &t.Leads); err != nil {
			continue
		}
		t.CreatedAt = createdAt.Format(time.RFC3339)
		teams = append(teams, t)
	}
	if teams == nil {
		teams = []teamRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": teams, "count": len(teams)})
}

func handleCreateTeam(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "name is required")
		return
	}

	var id string
	err := appFromRequest(r).DB.QueryRow(r.Context(), `
		INSERT INTO teams (organization_id, name, description) VALUES ($1, $2, $3) RETURNING id`,
		claims.OrganizationID, strings.TrimSpace(req.Name), req.Description).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			writeError(w, http.StatusConflict, "CONFLICT", "Team already exists in this organization")
			return
		}
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "created": true})
}

func handleDeleteTeam(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	teamID := chi.URLParam(r, "id")
	err := appFromRequest(r).DB.Exec(r.Context(), `DELETE FROM teams WHERE id = $1 AND organization_id = $2`, teamID, claims.OrganizationID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// ─── Team Members ────────────────────────────────────────────────────────────

func handleListTeamMembers(w http.ResponseWriter, r *http.Request) {
	teamID := chi.URLParam(r, "id")
	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT au.id, au.email, au.display_name, tm.role, tm.joined_at
		FROM team_members tm
		JOIN auth_users au ON au.id = tm.user_id
		WHERE tm.team_id = $1
		ORDER BY tm.role DESC, au.display_name`, teamID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type memberRow struct {
		ID          string `json:"id"`
		Email       string `json:"email"`
		DisplayName string `json:"displayName"`
		Role        string `json:"role"`
		JoinedAt    string `json:"joinedAt"`
	}
	var members []memberRow
	for rows.Next() {
		var m memberRow
		var joinedAt time.Time
		if err := rows.Scan(&m.ID, &m.Email, &m.DisplayName, &m.Role, &joinedAt); err != nil {
			continue
		}
		m.JoinedAt = joinedAt.Format(time.RFC3339)
		members = append(members, m)
	}
	if members == nil {
		members = []memberRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members, "count": len(members)})
}

func handleAddTeamMember(w http.ResponseWriter, r *http.Request) {
	teamID := chi.URLParam(r, "id")
	var req struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.UserID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "userId is required")
		return
	}
	if req.Role == "" {
		req.Role = "member"
	}
	if req.Role != "member" && req.Role != "lead" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "role must be 'member' or 'lead'")
		return
	}

	err := appFromRequest(r).DB.Exec(r.Context(), `
		INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		teamID, req.UserID, req.Role)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"added": true})
}

func handleRemoveTeamMember(w http.ResponseWriter, r *http.Request) {
	teamID := chi.URLParam(r, "id")
	userID := chi.URLParam(r, "userId")
	err := appFromRequest(r).DB.Exec(r.Context(), `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, teamID, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": true})
}
