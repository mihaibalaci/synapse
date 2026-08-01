// Package middleware provides HTTP middleware for rate limiting and logging.
package middleware

import (
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/mihaibalaci/synapse/internal/auth"
)

// RateTier defines rate limits for different user roles.
type RateTier struct {
	RequestsPerMinute int
	BurstSize         int
}

// DefaultTiers returns the built-in rate limit tiers by role.
func DefaultTiers() map[string]RateTier {
	return map[string]RateTier{
		"admin":     {RequestsPerMinute: 300, BurstSize: 50},
		"team_lead": {RequestsPerMinute: 200, BurstSize: 30},
		"developer": {RequestsPerMinute: 100, BurstSize: 20},
		"viewer":    {RequestsPerMinute: 50, BurstSize: 10},
		"default":   {RequestsPerMinute: 60, BurstSize: 10},
	}
}

// RateLimiter implements per-user rate limiting with role-based tiers.
type RateLimiter struct {
	limiters map[string]*rate.Limiter
	mu       sync.RWMutex
	tiers    map[string]RateTier
	// Fallback for users without a recognized role
	defaultRate  rate.Limit
	defaultBurst int
}

// NewRateLimiter creates a rate limiter with the given base requests and window.
// Role-based tiers override the base for authenticated users.
func NewRateLimiter(maxRequests int, windowSeconds int) *RateLimiter {
	tiers := DefaultTiers()
	rps := rate.Limit(float64(maxRequests) / float64(windowSeconds))
	return &RateLimiter{
		limiters:     make(map[string]*rate.Limiter),
		tiers:        tiers,
		defaultRate:  rps,
		defaultBurst: maxRequests / 2,
	}
}

func (rl *RateLimiter) getLimiter(key string, claims *auth.Claims) *rate.Limiter {
	rl.mu.RLock()
	limiter, exists := rl.limiters[key]
	rl.mu.RUnlock()

	if exists {
		return limiter
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()

	if limiter, exists = rl.limiters[key]; exists {
		return limiter
	}

	// Determine tier from role
	r := rl.defaultRate
	burst := rl.defaultBurst
	if claims != nil && len(claims.Roles) > 0 {
		// Use the highest-privilege role's tier
		for _, role := range claims.Roles {
			if tier, ok := rl.tiers[role]; ok {
				tierRate := rate.Limit(float64(tier.RequestsPerMinute) / 60.0)
				if tierRate > r {
					r = tierRate
					burst = tier.BurstSize
				}
			}
		}
	}

	limiter = rate.NewLimiter(r, burst)
	rl.limiters[key] = limiter
	return limiter
}

// Middleware returns an HTTP middleware that rate-limits by user ID with role tiers.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.RemoteAddr
		claims := auth.GetClaims(r)
		if claims != nil {
			key = claims.UserID
		}

		limiter := rl.getLimiter(key, claims)
		if !limiter.Allow() {
			w.Header().Set("Retry-After", "60")
			http.Error(w, `{"error":"RATE_LIMITED","message":"Too many requests"}`, http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// Cleanup removes stale limiters (call periodically).
func (rl *RateLimiter) Cleanup(maxAge time.Duration) {
	rl.mu.Lock()
	rl.limiters = make(map[string]*rate.Limiter)
	rl.mu.Unlock()
}
