package storage

import (
	"context"
	"log/slog"
	"time"
)

// RetryConfig defines retry behavior for connection establishment.
type RetryConfig struct {
	MaxAttempts int
	InitialWait time.Duration
	MaxWait     time.Duration
}

// DefaultRetry provides sensible defaults for production.
var DefaultRetry = RetryConfig{
	MaxAttempts: 5,
	InitialWait: 1 * time.Second,
	MaxWait:     30 * time.Second,
}

// ConnectWithRetry attempts to connect to PostgreSQL with exponential backoff.
func ConnectWithRetry(ctx context.Context, databaseURL string, retry RetryConfig) (*DB, error) {
	var lastErr error
	wait := retry.InitialWait

	for attempt := 1; attempt <= retry.MaxAttempts; attempt++ {
		db, err := Connect(ctx, databaseURL)
		if err == nil {
			if attempt > 1 {
				slog.Info("PostgreSQL connected after retry", "attempts", attempt)
			}
			return db, nil
		}

		lastErr = err
		slog.Warn("PostgreSQL connection failed, retrying",
			"attempt", attempt,
			"maxAttempts", retry.MaxAttempts,
			"nextWait", wait,
			"error", err,
		)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}

		wait = min(wait*2, retry.MaxWait)
	}

	return nil, lastErr
}

// ConnectRedisWithRetry attempts to connect to Redis with exponential backoff.
func ConnectRedisWithRetry(ctx context.Context, redisURL string, retry RetryConfig) (*Cache, error) {
	var lastErr error
	wait := retry.InitialWait

	for attempt := 1; attempt <= retry.MaxAttempts; attempt++ {
		cache, err := ConnectRedis(ctx, redisURL)
		if err == nil {
			if attempt > 1 {
				slog.Info("Redis connected after retry", "attempts", attempt)
			}
			return cache, nil
		}

		lastErr = err
		slog.Warn("Redis connection failed, retrying",
			"attempt", attempt,
			"maxAttempts", retry.MaxAttempts,
			"nextWait", wait,
			"error", err,
		)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}

		wait = min(wait*2, retry.MaxWait)
	}

	return nil, lastErr
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
