package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mihaibalaci/synapse/internal/auth"
)

// ─── API Key Management ──────────────────────────────────────────────────────

func handleListAPIKeys(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT id, name, key_prefix, scopes, expires_at, last_used_at, created_at
		FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL
		ORDER BY created_at DESC`, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type keyRow struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		KeyPrefix  string   `json:"keyPrefix"`
		Scopes     []string `json:"scopes"`
		ExpiresAt  *string  `json:"expiresAt"`
		LastUsedAt *string  `json:"lastUsedAt"`
		CreatedAt  string   `json:"createdAt"`
	}
	var keys []keyRow
	for rows.Next() {
		var k keyRow
		var expiresAt, lastUsedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&k.ID, &k.Name, &k.KeyPrefix, &k.Scopes, &expiresAt, &lastUsedAt, &createdAt); err != nil {
			continue
		}
		if expiresAt != nil {
			s := expiresAt.Format(time.RFC3339)
			k.ExpiresAt = &s
		}
		if lastUsedAt != nil {
			s := lastUsedAt.Format(time.RFC3339)
			k.LastUsedAt = &s
		}
		k.CreatedAt = createdAt.Format(time.RFC3339)
		keys = append(keys, k)
	}
	if keys == nil {
		keys = []keyRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys, "count": len(keys)})
}

func handleCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	var req struct {
		Name      string   `json:"name"`
		Scopes    []string `json:"scopes"`
		ExpiresIn int      `json:"expiresInDays"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.Name == "" {
		req.Name = "Unnamed key"
	}
	if len(req.Scopes) == 0 {
		req.Scopes = []string{"read", "write"}
	}

	// Generate a random API key: sk_synapse_<random>
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "CRYPTO_ERROR", "Key generation failed")
		return
	}
	key := "sk_synapse_" + base64.RawURLEncoding.EncodeToString(raw[:])
	prefix := key[:20]
	hash := sha256.Sum256([]byte(key))

	var expiresAt *time.Time
	if req.ExpiresIn > 0 {
		t := time.Now().Add(time.Duration(req.ExpiresIn) * 24 * time.Hour)
		expiresAt = &t
	}

	var id string
	err := appFromRequest(r).DB.QueryRow(r.Context(), `
		INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at)
		VALUES ($1, $2, $3, $4, $5::text[], $6)
		RETURNING id`,
		claims.UserID, req.Name, prefix, hash[:], req.Scopes, expiresAt).Scan(&id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}

	// Return the full key only once; it cannot be retrieved again.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "name": req.Name, "key": key, "prefix": prefix,
		"scopes": req.Scopes, "expiresAt": expiresAt,
		"warning": "Store this key securely. It cannot be displayed again.",
	})
}

func handleRevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	keyID := chi.URLParam(r, "id")
	err := appFromRequest(r).DB.Exec(r.Context(),
		`UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2`, keyID, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true})
}

// ─── Invite Flow ─────────────────────────────────────────────────────────────

func handleInviteUser(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	var req struct {
		Email string   `json:"email"`
		Roles []string `json:"roles"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Valid email is required")
		return
	}
	if len(req.Roles) == 0 {
		req.Roles = []string{"viewer"}
	}

	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "CRYPTO_ERROR", "Token generation failed")
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw[:])
	hash := sha256.Sum256([]byte(token))

	var id string
	err := appFromRequest(r).DB.QueryRow(r.Context(), `
		INSERT INTO user_invitations (email, organization_id, roles, invited_by, token_hash)
		VALUES ($1, $2, $3::text[], $4, $5)
		RETURNING id`,
		email, claims.OrganizationID, req.Roles, claims.UserID, hash[:]).Scan(&id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "email": email, "inviteToken": token,
		"note": "Send this token to the user. It expires in 7 days.",
	})
}

func handleAcceptInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token       string `json:"token"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.Token == "" || len(req.Password) < 12 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "Token and password (12+ chars) required")
		return
	}

	hash := sha256.Sum256([]byte(req.Token))
	ctx := r.Context()
	app := appFromRequest(r)

	var email, orgID string
	var roles []string
	err := app.DB.QueryRow(ctx, `
		SELECT email, organization_id, roles FROM user_invitations
		WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()`,
		hash[:]).Scan(&email, &orgID, &roles)
	if err != nil {
		writeError(w, http.StatusNotFound, "INVALID_INVITE", "Invitation not found or expired")
		return
	}

	// Create user
	var userID string
	err = app.DB.QueryRow(ctx, `
		INSERT INTO auth_users (email, normalized_email, display_name, password_hash, organization_id, roles)
		VALUES ($1, $1, $2, crypt($3, gen_salt('bf', 12)), $4, $5::text[])
		ON CONFLICT (organization_id, normalized_email) DO NOTHING
		RETURNING id`,
		email, strings.TrimSpace(req.DisplayName), req.Password, orgID, roles).Scan(&userID)
	if err != nil || userID == "" {
		writeError(w, http.StatusConflict, "CONFLICT", "User already exists in this organization")
		return
	}

	// Mark invitation accepted
	_ = app.DB.Exec(ctx, `UPDATE user_invitations SET accepted_at = NOW() WHERE token_hash = $1`, hash[:])

	writeJSON(w, http.StatusCreated, map[string]any{"userId": userID, "email": email, "organization": orgID})
}

// ─── Team/Repo Access Enforcement ────────────────────────────────────────────

// EnforceTeamAccess adds team_id and repository filters to a query based on
// the caller's JWT claims. This is used by search and fact endpoints.
func EnforceTeamAccess(claims *auth.Claims) (teamFilter string, repoFilter string) {
	if len(claims.TeamIDs) > 0 {
		// If user has specific team_ids, they can only see content from those teams
		teamFilter = "team_id = ANY('" + strings.Join(claims.TeamIDs, "','") + "')"
	}
	if len(claims.RepositoryAccess) > 0 {
		repoFilter = "repository = ANY('" + strings.Join(claims.RepositoryAccess, "','") + "')"
	}
	return teamFilter, repoFilter
}
