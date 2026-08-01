package api

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mihaibalaci/synapse/internal/auth"
)

const refreshCookieName = "synapse_refresh"

func handleAuthLogin(app *App, limiter *loginLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clientIP := requestIP(r)
		if !limiter.Allow(clientIP) {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "Too many login attempts")
			return
		}

		var request struct {
			Email          string `json:"email"`
			Password       string `json:"password"`
			OrganizationID string `json:"organizationId"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		if err := decoder.Decode(&request); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid login request")
			return
		}

		tokens, err := app.Auth.Login(r.Context(), request.Email, request.Password, request.OrganizationID, auth.ClientMetadata{
			UserAgent: r.UserAgent(), IPAddress: clientIP,
		})
		if err != nil {
			if errors.Is(err, auth.ErrInvalidCredentials) || errors.Is(err, auth.ErrUserDisabled) {
				writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Invalid email, password, or organization")
				return
			}
			writeError(w, http.StatusInternalServerError, "AUTH_ERROR", "Authentication is temporarily unavailable")
			return
		}

		setRefreshCookie(w, app, tokens.RefreshToken)
		writeAuthResponse(w, tokens)
	}
}

func handleAuthRefresh(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(refreshCookieName)
		if err != nil || cookie.Value == "" {
			clearRefreshCookie(w, app)
			writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "No active session")
			return
		}

		tokens, err := app.Auth.Refresh(r.Context(), cookie.Value, auth.ClientMetadata{
			UserAgent: r.UserAgent(), IPAddress: requestIP(r),
		})
		if err != nil {
			clearRefreshCookie(w, app)
			writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Session expired or revoked")
			return
		}
		setRefreshCookie(w, app, tokens.RefreshToken)
		writeAuthResponse(w, tokens)
	}
}

func handleAuthLogout(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cookie, err := r.Cookie(refreshCookieName); err == nil {
			_ = app.Auth.Logout(r.Context(), cookie.Value)
		}
		clearRefreshCookie(w, app)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleAuthMe(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing authentication claims")
		return
	}
	user, err := appFromRequest(r).Auth.UserByID(r.Context(), claims.UserID)
	if err != nil || user.OrganizationID != claims.OrganizationID {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "User is unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func writeAuthResponse(w http.ResponseWriter, tokens *auth.SessionTokens) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"accessToken": tokens.AccessToken,
		"tokenType":   "Bearer",
		"expiresIn":   tokens.ExpiresIn,
		"user":        tokens.User,
	})
}

func setRefreshCookie(w http.ResponseWriter, app *App, value string) {
	ttl := app.Auth.RefreshTTL()
	http.SetCookie(w, &http.Cookie{
		Name: refreshCookieName, Value: value, Path: "/api/v1/auth",
		HttpOnly: true, Secure: app.Config.AuthCookieSecure,
		SameSite: http.SameSiteStrictMode, MaxAge: int(ttl.Seconds()),
		Expires: time.Now().Add(ttl),
	})
}

func clearRefreshCookie(w http.ResponseWriter, app *App) {
	http.SetCookie(w, &http.Cookie{
		Name: refreshCookieName, Value: "", Path: "/api/v1/auth",
		HttpOnly: true, Secure: app.Config.AuthCookieSecure,
		SameSite: http.SameSiteStrictMode, MaxAge: -1,
		Expires: time.Unix(1, 0),
	})
}

func requestIP(r *http.Request) string {
	value := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(value); err == nil {
		return host
	}
	return value
}

type loginWindow struct {
	started time.Time
	count   int
}

type loginLimiter struct {
	mu      sync.Mutex
	entries map[string]loginWindow
	limit   int
	window  time.Duration
}

func newLoginLimiter(limit int, window time.Duration) *loginLimiter {
	return &loginLimiter{entries: make(map[string]loginWindow), limit: limit, window: window}
}

func (l *loginLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	entry := l.entries[key]
	if entry.started.IsZero() || now.Sub(entry.started) >= l.window {
		l.entries[key] = loginWindow{started: now, count: 1}
		return true
	}
	if entry.count >= l.limit {
		return false
	}
	entry.count++
	l.entries[key] = entry
	return true
}

// ─── OIDC Handlers ───────────────────────────────────────────────────────────

func handleOIDCLogin(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if app.OIDC == nil {
			writeError(w, http.StatusNotFound, "OIDC_DISABLED", "OIDC is not configured")
			return
		}
		// Use a simple state parameter (in production, use a signed/stored nonce)
		state := "synapse-oidc"
		http.Redirect(w, r, app.OIDC.AuthorizeURL(state), http.StatusFound)
	}
}

func handleOIDCCallback(app *App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if app.OIDC == nil {
			writeError(w, http.StatusNotFound, "OIDC_DISABLED", "OIDC is not configured")
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Missing authorization code")
			return
		}

		tokens, err := app.OIDC.Exchange(r.Context(), code, "default", auth.ClientMetadata{
			UserAgent: r.UserAgent(), IPAddress: requestIP(r),
		})
		if err != nil {
			writeError(w, http.StatusUnauthorized, "OIDC_ERROR", "OIDC authentication failed")
			return
		}

		setRefreshCookie(w, app, tokens.RefreshToken)
		// Redirect to the dashboard; the Flutter app will read the access token from a subsequent refresh call
		http.Redirect(w, r, "/?oidc=success", http.StatusFound)
	}
}
