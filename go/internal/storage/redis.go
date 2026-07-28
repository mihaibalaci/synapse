package storage

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache wraps a Redis client for caching and lightweight queuing.
type Cache struct {
	Client *redis.Client
}

// ConnectRedis creates a new Redis connection.
func ConnectRedis(ctx context.Context, redisURL string) (*Cache, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}

	opts.PoolSize = 20
	opts.MinIdleConns = 3
	opts.MaxRetries = 3
	opts.DialTimeout = 5 * time.Second
	opts.ReadTimeout = 3 * time.Second
	opts.WriteTimeout = 3 * time.Second

	client := redis.NewClient(opts)

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	slog.Info("Redis connected", "addr", opts.Addr)
	return &Cache{Client: client}, nil
}

// Close shuts down the Redis connection.
func (c *Cache) Close() error {
	return c.Client.Close()
}

// Healthy checks if Redis is reachable.
func (c *Cache) Healthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return c.Client.Ping(ctx).Err() == nil
}

// ─── Search Cache ────────────────────────────────────────────────────────────

// GetCached retrieves a cached search response.
func (c *Cache) GetCached(ctx context.Context, key string) ([]byte, error) {
	val, err := c.Client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	return val, err
}

// SetCached stores a search response with TTL.
func (c *Cache) SetCached(ctx context.Context, key string, data []byte, ttl time.Duration) error {
	return c.Client.Set(ctx, key, data, ttl).Err()
}

// IncrementPopular tracks popular queries for prewarming.
func (c *Cache) IncrementPopular(ctx context.Context, org, query string) {
	key := fmt.Sprintf("popular:%s", org)
	c.Client.ZIncrBy(ctx, key, 1, query)
}

// ─── Rate Limiting (alternative to in-memory) ────────────────────────────────

// RateCheck checks and increments a rate limit counter.
func (c *Cache) RateCheck(ctx context.Context, key string, limit int64, window time.Duration) (bool, error) {
	pipe := c.Client.Pipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, window)
	_, err := pipe.Exec(ctx)
	if err != nil {
		return true, err // Allow on error
	}
	return incr.Val() <= limit, nil
}

// ─── Simple Queue (for lightweight job dispatch) ─────────────────────────────

// Enqueue pushes a job to a Redis list.
func (c *Cache) Enqueue(ctx context.Context, queue string, data []byte) error {
	return c.Client.LPush(ctx, queue, data).Err()
}

// Dequeue pops a job from a Redis list (blocking with timeout).
func (c *Cache) Dequeue(ctx context.Context, queue string, timeout time.Duration) ([]byte, error) {
	result, err := c.Client.BRPop(ctx, timeout, queue).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(result) < 2 {
		return nil, nil
	}
	return []byte(result[1]), nil
}

// QueueLen returns the length of a queue.
func (c *Cache) QueueLen(ctx context.Context, queue string) (int64, error) {
	return c.Client.LLen(ctx, queue).Result()
}
