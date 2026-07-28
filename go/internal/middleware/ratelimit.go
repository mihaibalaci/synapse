// Package middleware provides HTTP middleware for rate limiting and logging.
package middleware

import (
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/mihaibalaci/synapse/internal/auth"
)

// RateLimiter implements per-user rate limiting using token buckets.
type RateLimiter struct {
	limiters map[string]*rate.Limiter
	mu       sync.RWMutex
	rate     rate.Limit
	burst    int
}

// NewRateLimiter creates a rate limiter with the given requests per second and burst.
func NewRateLimiter(maxRequests int, windowSeconds int) *RateLimiter {
	rps := rate.Limit(float64(maxRequests) / float64(windowSeconds))
	return &RateLimiter{
		limiters: make(map[string]*rate.Limiter),
		rate:     rps,
		burst:    maxRequests / 2, // Allow burst up to half the window
	}
}

func (rl *RateLimiter) getLimiter(key string) *rate.Limiter {
	rl.mu.RLock()
	limiter, exists := rl.limiters[key]
	rl.mu.RUnlock()

	if exists {
		return limiter
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()

	// Double check
	if limiter, exists = rl.limiters[key]; exists {
		return limiter
	}

	limiter = rate.NewLimiter(rl.rate, rl.burst)
	rl.limiters[key] = limiter
	return limiter
}

// Middleware returns an HTTP middleware that rate-limits by user ID.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Determine the rate limit key (user ID or IP)
		key := r.RemoteAddr
		if claims := auth.GetClaims(r); claims != nil {
			key = claims.UserID
		}

		limiter := rl.getLimiter(key)
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
	// Simple: just reset the map periodically
	rl.mu.Lock()
	rl.limiters = make(map[string]*rate.Limiter)
	rl.mu.Unlock()
}
