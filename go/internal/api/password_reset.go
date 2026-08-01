package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/mihaibalaci/synapse/internal/auth"
)

// handleRequestPasswordReset generates a reset token. In production this would
// be emailed; here we return it directly for the admin to communicate.
func handleRequestPasswordReset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email          string `json:"email"`
		OrganizationID string `json:"organizationId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	orgID := strings.TrimSpace(req.OrganizationID)
	if email == "" || orgID == "" {
		// Don't reveal whether user exists
		writeJSON(w, http.StatusOK, map[string]any{"sent": true})
		return
	}

	// Check user exists
	var userID string
	err := appFromRequest(r).DB.QueryRow(r.Context(),
		`SELECT id FROM auth_users WHERE normalized_email = $1 AND organization_id = $2 AND NOT disabled`,
		email, orgID).Scan(&userID)
	if err != nil {
		// Don't reveal whether user exists
		writeJSON(w, http.StatusOK, map[string]any{"sent": true})
		return
	}

	// Generate reset token (valid 1 hour)
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "CRYPTO_ERROR", "Token generation failed")
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw[:])
	hash := sha256.Sum256([]byte(token))
	expiresAt := time.Now().Add(1 * time.Hour)

	// Store in Redis with 1h TTL
	key := "synapse:password_reset:" + base64.RawURLEncoding.EncodeToString(hash[:])
	_ = appFromRequest(r).Cache.Client.Set(r.Context(), key, userID, time.Until(expiresAt)).Err()

	writeJSON(w, http.StatusOK, map[string]any{
		"sent":       true,
		"resetToken": token,
		"expiresAt":  expiresAt.Format(time.RFC3339),
		"note":       "In production, this token would be emailed. Communicate it securely.",
	})
}

// handleExecutePasswordReset validates a reset token and sets the new password.
func handleExecutePasswordReset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token    string `json:"token"`
		Password string `json:"password"`
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
	key := "synapse:password_reset:" + base64.RawURLEncoding.EncodeToString(hash[:])

	ctx := r.Context()
	userID, err := appFromRequest(r).Cache.Client.GetDel(ctx, key).Result()
	if err != nil || userID == "" {
		writeError(w, http.StatusBadRequest, "INVALID_TOKEN", "Reset token is invalid or expired")
		return
	}

	// Update password
	if err := appFromRequest(r).DB.Exec(ctx,
		`UPDATE auth_users SET password_hash = crypt($2, gen_salt('bf', 12)), updated_at = NOW() WHERE id = $1`,
		userID, req.Password); err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}

	// Revoke all sessions
	_ = appFromRequest(r).DB.Exec(ctx, `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1`, userID)

	writeJSON(w, http.StatusOK, map[string]any{"reset": true})
}

// handleAdminResetPassword allows admins to force-reset another user's password.
func handleAdminResetPassword(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	var req struct {
		UserID   string `json:"userId"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.UserID == "" || len(req.Password) < 12 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "userId and password (12+ chars) required")
		return
	}

	ctx := r.Context()
	if err := appFromRequest(r).DB.Exec(ctx,
		`UPDATE auth_users SET password_hash = crypt($2, gen_salt('bf', 12)), updated_at = NOW() WHERE id = $1 AND organization_id = $3`,
		req.UserID, req.Password, claims.OrganizationID); err != nil {
		writeError(w, http.StatusInternalServerError, "STORE_ERROR", err.Error())
		return
	}
	_ = appFromRequest(r).DB.Exec(ctx, `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1`, req.UserID)
	writeJSON(w, http.StatusOK, map[string]any{"reset": true})
}
