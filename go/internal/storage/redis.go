package storage

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
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

// CacheStats describes the state of the search-response cache as Redis sees it.
//
// Entry count and eviction figures come from the server rather than in-process
// counters, so they survive a restart and reflect what is actually resident.
type CacheStats struct {
	Entries     int64 `json:"entries"`     // live search: keys
	Queues      int64 `json:"queues"`      // pending job entries across queues
	Evicted     int64 `json:"evicted"`     // keys dropped under memory pressure
	Expired     int64 `json:"expired"`     // keys removed by TTL
	MemoryBytes int64 `json:"memoryBytes"` // resident dataset size
}

// Stats samples cache state. SCAN is used rather than KEYS so a large keyspace
// does not block the server.
func (c *Cache) Stats(ctx context.Context) CacheStats {
	var stats CacheStats

	var cursor uint64
	for {
		keys, next, err := c.Client.Scan(ctx, cursor, "search:*", 500).Result()
		if err != nil {
			break
		}
		stats.Entries += int64(len(keys))
		cursor = next
		if cursor == 0 {
			break
		}
	}

	for _, q := range []string{
		"synapse:session", "synapse:facts", "synapse:knowledge",
		"synapse:dedup", "synapse:graph", "synapse:index",
	} {
		if n, err := c.Client.LLen(ctx, q).Result(); err == nil {
			stats.Queues += n
		}
	}

	if info, err := c.Client.Info(ctx, "stats", "memory").Result(); err == nil {
		stats.Evicted = parseRedisInfoInt(info, "evicted_keys:")
		stats.Expired = parseRedisInfoInt(info, "expired_keys:")
		stats.MemoryBytes = parseRedisInfoInt(info, "used_memory:")
	}

	return stats
}

// parseRedisInfoInt pulls a single numeric field out of an INFO reply.
func parseRedisInfoInt(info, field string) int64 {
	idx := strings.Index(info, field)
	if idx < 0 {
		return 0
	}
	rest := info[idx+len(field):]
	if end := strings.IndexAny(rest, "\r\n"); end >= 0 {
		rest = rest[:end]
	}
	v, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
	if err != nil {
		return 0
	}
	return v
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
	data, _, err := c.DequeueAny(ctx, timeout, queue)
	return data, err
}

// DequeueAny blocks on several queues at once and returns the first job to
// arrive, along with the queue it came from.
//
// BRPOP takes multiple keys and returns as soon as any of them has an element,
// checking them in the order given. Polling each queue in turn with its own
// blocking call instead would spend the full timeout on every empty queue: with
// six queues and a one second timeout, a worker would waste five seconds per
// cycle whenever only one queue had work.
func (c *Cache) DequeueAny(ctx context.Context, timeout time.Duration, queues ...string) ([]byte, string, error) {
	if len(queues) == 0 {
		return nil, "", nil
	}

	result, err := c.Client.BRPop(ctx, timeout, queues...).Result()
	if err == redis.Nil {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	// BRPOP replies with [key, value].
	if len(result) < 2 {
		return nil, "", nil
	}
	return []byte(result[1]), result[0], nil
}

// QueueLen returns the length of a queue.
func (c *Cache) QueueLen(ctx context.Context, queue string) (int64, error) {
	return c.Client.LLen(ctx, queue).Result()
}
