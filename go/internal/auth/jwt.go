// Package auth provides JWT authentication middleware.
package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const ClaimsKey contextKey = "claims"

// Claims represents the JWT claims extracted from a token.
type Claims struct {
	UserID           string   `json:"sub"`
	OrganizationID   string   `json:"organization_id"`
	TeamIDs          []string `json:"team_ids"`
	Roles            []string `json:"roles"`
	RepositoryAccess []string `json:"repository_access"`
}

// Middleware returns an HTTP middleware that validates JWT tokens.
func Middleware(secret string, issuer string, audience string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip health endpoints
			if r.URL.Path == "/health" || r.URL.Path == "/health/ready" {
				next.ServeHTTP(w, r)
				return
			}

			// Extract Bearer token
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, `{"error":"AUTH_ERROR","message":"No Authorization was found in request.headers"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				http.Error(w, `{"error":"AUTH_ERROR","message":"Invalid authorization format"}`, http.StatusUnauthorized)
				return
			}

			tokenString := parts[1]

			// Parse and validate
			token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
				if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
					return nil, fmt.Errorf("unexpected signing method %q", t.Method.Alg())
				}
				return []byte(secret), nil
			},
				jwt.WithIssuer(issuer),
				jwt.WithAudience(audience),
				jwt.WithExpirationRequired(),
				jwt.WithValidMethods([]string{"HS256"}),
			)

			if err != nil || !token.Valid {
				http.Error(w, `{"error":"AUTH_ERROR","message":"Invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			// Extract claims
			mapClaims, ok := token.Claims.(jwt.MapClaims)
			if !ok {
				http.Error(w, `{"error":"AUTH_ERROR","message":"Invalid token claims"}`, http.StatusUnauthorized)
				return
			}

			claims := Claims{
				UserID:           getString(mapClaims, "sub"),
				OrganizationID:   getString(mapClaims, "organization_id"),
				TeamIDs:          getStringSlice(mapClaims, "team_ids"),
				Roles:            getStringSlice(mapClaims, "roles"),
				RepositoryAccess: getStringSlice(mapClaims, "repository_access"),
			}
			if claims.UserID == "" || claims.OrganizationID == "" {
				http.Error(w, `{"error":"AUTH_ERROR","message":"Token requires sub and organization_id claims"}`, http.StatusUnauthorized)
				return
			}

			// Inject into context
			ctx := context.WithValue(r.Context(), ClaimsKey, &claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetClaims extracts the claims from the request context.
func GetClaims(r *http.Request) *Claims {
	claims, _ := r.Context().Value(ClaimsKey).(*Claims)
	return claims
}

func getString(m jwt.MapClaims, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func getStringSlice(m jwt.MapClaims, key string) []string {
	val, ok := m[key]
	if !ok {
		return nil
	}
	switch v := val.(type) {
	case []interface{}:
		result := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				result = append(result, s)
			}
		}
		return result
	case []string:
		return v
	default:
		return nil
	}
}

// RequireRole rejects authenticated callers that do not have the required
// role. It is intended for nested route groups after Middleware has populated
// the request claims.
func RequireRole(required string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := GetClaims(r)
			if claims == nil {
				http.Error(w, `{"error":"AUTH_ERROR","message":"Missing authentication claims"}`, http.StatusUnauthorized)
				return
			}
			for _, role := range claims.Roles {
				if role == required {
					next.ServeHTTP(w, r)
					return
				}
			}
			http.Error(w, `{"error":"FORBIDDEN","message":"Required role is missing"}`, http.StatusForbidden)
		})
	}
}
