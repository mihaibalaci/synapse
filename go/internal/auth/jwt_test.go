package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func makeJWT(secret, sub, org string) string {
	header := base64url(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload := base64url(map[string]any{
		"sub": sub, "organization_id": org,
		"team_ids": []string{}, "roles": []string{"admin"},
		"repository_access": []string{},
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
		"iss": "https://auth.synapse.local", "aud": "synapse",
	})
	sig := signHS256(header+"."+payload, secret)
	return header + "." + payload + "." + sig
}

func base64url(v any) string {
	data, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(data)
}

func signHS256(input, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(input))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func TestMiddleware_NoToken(t *testing.T) {
	handler := Middleware("secret", "https://auth.synapse.local", "synapse")(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
		}),
	)

	req := httptest.NewRequest("GET", "/api/v1/stats", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 401 {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestMiddleware_InvalidToken(t *testing.T) {
	handler := Middleware("secret", "https://auth.synapse.local", "synapse")(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
		}),
	)

	req := httptest.NewRequest("GET", "/api/v1/stats", nil)
	req.Header.Set("Authorization", "Bearer invalid.token.here")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 401 {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestMiddleware_ValidToken(t *testing.T) {
	var capturedClaims *Claims
	handler := Middleware("test-secret", "https://auth.synapse.local", "synapse")(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			capturedClaims = GetClaims(r)
			w.WriteHeader(200)
		}),
	)

	token := makeJWT("test-secret", "dev-1", "org-test")
	req := httptest.NewRequest("GET", "/api/v1/stats", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if capturedClaims == nil {
		t.Fatal("claims should be injected into context")
	}
	if capturedClaims.UserID != "dev-1" {
		t.Errorf("expected user 'dev-1', got %q", capturedClaims.UserID)
	}
	if capturedClaims.OrganizationID != "org-test" {
		t.Errorf("expected org 'org-test', got %q", capturedClaims.OrganizationID)
	}
}

func TestMiddleware_SkipsHealth(t *testing.T) {
	handler := Middleware("secret", "https://auth.synapse.local", "synapse")(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			fmt.Fprint(w, "ok")
		}),
	)

	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Errorf("health should skip auth, got %d", rec.Code)
	}
}

func TestMiddleware_WrongSecret(t *testing.T) {
	handler := Middleware("correct-secret", "https://auth.synapse.local", "synapse")(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
		}),
	)

	token := makeJWT("wrong-secret", "dev-1", "org-test")
	req := httptest.NewRequest("GET", "/api/v1/stats", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 401 {
		t.Errorf("expected 401 for wrong secret, got %d", rec.Code)
	}
}

func TestGetStringSlice(t *testing.T) {
	// Test with []interface{} (what JSON unmarshals to)
	m := map[string]any{"roles": []any{"admin", "dev"}}
	roles := getStringSlice(m, "roles")
	if len(roles) != 2 || roles[0] != "admin" {
		t.Errorf("expected [admin, dev], got %v", roles)
	}

	// Test missing key
	empty := getStringSlice(m, "missing")
	if empty != nil {
		t.Errorf("expected nil for missing key, got %v", empty)
	}
}

// Ensure the unused import doesn't cause issues
var _ = strings.Contains
