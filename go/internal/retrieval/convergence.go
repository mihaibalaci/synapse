// Convergence Detection — detects when multiple engineers converge on the same topic.
//
// When ≥3 unique engineers query the same topic within a sliding window (1 hour),
// a convergence event is triggered:
//   - Topic is marked as "trending"
//   - Future queries get proactive context ("5 others asked about this")
//   - Auto-reflect can synthesize a canonical answer
//   - Notification sent to team (Slack/dashboard)
//
// Implementation: Redis sorted sets with timestamps as scores.
// Topic fingerprinting uses entity extraction + normalized query hashing.

package retrieval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// ─── Configuration ───────────────────────────────────────────────────────────

const (
	// Minimum unique engineers before a convergence is triggered
	ConvergenceThreshold = 3
	// Time window for convergence detection
	ConvergenceWindow = 1 * time.Hour
	// How long a convergence event stays active
	ConvergenceActiveTTL = 4 * time.Hour
	// Redis key prefix
	convergencePrefix = "convergence"
	// Trending topics key
	trendingKey = "trending"
)

// ─── Types ───────────────────────────────────────────────────────────────────

// ConvergenceEvent represents a detected topic convergence.
type ConvergenceEvent struct {
	TopicHash   string    `json:"topicHash"`
	Topic       string    `json:"topic"`
	Engineers   []string  `json:"engineers"`
	Count       int       `json:"count"`
	FirstSeen   time.Time `json:"firstSeen"`
	LastSeen    time.Time `json:"lastSeen"`
	OrgID       string    `json:"organizationId"`
	IsNew       bool      `json:"isNew"` // Just crossed threshold
}

// TrendingTopic is a topic that multiple engineers are asking about.
type TrendingTopic struct {
	Topic       string   `json:"topic"`
	TopicHash   string   `json:"topicHash"`
	Engineers   int      `json:"engineers"`
	Queries     int      `json:"queries"`
	FirstSeen   string   `json:"firstSeen"`
	LastSeen    string   `json:"lastSeen"`
	Context     string   `json:"context,omitempty"` // Auto-generated summary
}

// ─── Convergence Detector ────────────────────────────────────────────────────

// Detector tracks query convergence using Redis sorted sets.
type Detector struct {
	cache *storage.Cache
}

// NewDetector creates a convergence detector.
func NewDetector(cache *storage.Cache) *Detector {
	return &Detector{cache: cache}
}

// RecordQuery records a query from an engineer and checks for convergence.
// Returns a convergence event if the threshold was just crossed or is active.
func (d *Detector) RecordQuery(ctx context.Context, orgID, userID, query string) *ConvergenceEvent {
	topic := normalizeTopic(query)
	topicHash := hashTopic(orgID, topic)

	// Key: convergence:<org>:<topic_hash>:users (sorted set of user IDs by timestamp)
	userKey := fmt.Sprintf("%s:%s:%s:users", convergencePrefix, orgID, topicHash)
	// Key: convergence:<org>:<topic_hash>:queries (count)
	queryKey := fmt.Sprintf("%s:%s:%s:queries", convergencePrefix, orgID, topicHash)

	now := time.Now()
	windowStart := now.Add(-ConvergenceWindow)

	// Add user to sorted set (score = timestamp)
	d.cache.Client.ZAdd(ctx, userKey, redis.Z{Score: float64(now.Unix()), Member: userID})
	// Expire the key after the active TTL
	d.cache.Client.Expire(ctx, userKey, ConvergenceActiveTTL)

	// Increment query count
	d.cache.Client.Incr(ctx, queryKey)
	d.cache.Client.Expire(ctx, queryKey, ConvergenceActiveTTL)

	// Remove entries outside the window
	d.cache.Client.ZRemRangeByScore(ctx, userKey, "0", fmt.Sprintf("%d", windowStart.Unix()))

	// Count unique engineers in the window
	uniqueCount, _ := d.cache.Client.ZCard(ctx, userKey).Result()

	if uniqueCount >= ConvergenceThreshold {
		// Get the list of engineers
		engineers, _ := d.cache.Client.ZRange(ctx, userKey, 0, -1).Result()

		// Get first/last timestamps
		oldest, _ := d.cache.Client.ZRangeWithScores(ctx, userKey, 0, 0).Result()
		var firstSeen time.Time
		if len(oldest) > 0 {
			firstSeen = time.Unix(int64(oldest[0].Score), 0)
		}

		// Check if this is a NEW convergence (just crossed threshold)
		crossedKey := fmt.Sprintf("%s:%s:%s:crossed", convergencePrefix, orgID, topicHash)
		wasAlreadyCrossed, _ := d.cache.Client.Exists(ctx, crossedKey).Result()
		isNew := wasAlreadyCrossed == 0

		if isNew {
			// Mark as crossed
			d.cache.Client.Set(ctx, crossedKey, "1", ConvergenceActiveTTL)

			// Add to trending topics
			d.cache.Client.ZAdd(ctx, fmt.Sprintf("%s:%s", trendingKey, orgID),
				redis.Z{Score: float64(now.Unix()), Member: topicHash + "|" + topic})
			d.cache.Client.Expire(ctx, fmt.Sprintf("%s:%s", trendingKey, orgID), ConvergenceActiveTTL)

			slog.Info("Convergence detected",
				"topic", topic,
				"engineers", uniqueCount,
				"org", orgID,
			)
		}

		return &ConvergenceEvent{
			TopicHash: topicHash,
			Topic:     topic,
			Engineers: engineers,
			Count:     int(uniqueCount),
			FirstSeen: firstSeen,
			LastSeen:  now,
			OrgID:     orgID,
			IsNew:     isNew,
		}
	}

	return nil
}

// GetTrending returns currently trending topics for an organization.
func (d *Detector) GetTrending(ctx context.Context, orgID string, limit int) []TrendingTopic {
	key := fmt.Sprintf("%s:%s", trendingKey, orgID)

	// Get trending topics sorted by recency
	results, err := d.cache.Client.ZRevRangeWithScores(ctx, key, 0, int64(limit-1)).Result()
	if err != nil || len(results) == 0 {
		return nil
	}

	topics := make([]TrendingTopic, 0, len(results))
	for _, r := range results {
		member := r.Member.(string)
		parts := strings.SplitN(member, "|", 2)
		if len(parts) != 2 {
			continue
		}
		topicHash := parts[0]
		topic := parts[1]

		// Get engineer count
		userKey := fmt.Sprintf("%s:%s:%s:users", convergencePrefix, orgID, topicHash)
		count, _ := d.cache.Client.ZCard(ctx, userKey).Result()

		// Get query count
		queryKey := fmt.Sprintf("%s:%s:%s:queries", convergencePrefix, orgID, topicHash)
		queries, _ := d.cache.Client.Get(ctx, queryKey).Int64()

		lastSeen := time.Unix(int64(r.Score), 0)

		topics = append(topics, TrendingTopic{
			Topic:     topic,
			TopicHash: topicHash,
			Engineers: int(count),
			Queries:   int(queries),
			LastSeen:  lastSeen.Format(time.RFC3339),
		})
	}

	return topics
}

// GetProactiveContext returns context to inject into search results
// when a query matches a trending topic.
func (d *Detector) GetProactiveContext(ctx context.Context, orgID, query string) *string {
	topic := normalizeTopic(query)
	topicHash := hashTopic(orgID, topic)

	// Check if this topic is actively converging
	userKey := fmt.Sprintf("%s:%s:%s:users", convergencePrefix, orgID, topicHash)
	count, _ := d.cache.Client.ZCard(ctx, userKey).Result()

	if count >= ConvergenceThreshold {
		engineers, _ := d.cache.Client.ZRange(ctx, userKey, 0, -1).Result()
		msg := fmt.Sprintf("📡 %d engineers are investigating this topic right now. "+
			"This is a trending question in your organization.", count)
		if len(engineers) > 0 && len(engineers) <= 5 {
			msg += fmt.Sprintf(" (asked by: %s)", strings.Join(engineers, ", "))
		}
		return &msg
	}

	return nil
}

// ─── Topic Fingerprinting ────────────────────────────────────────────────────

// normalizeTopic extracts the core topic from a query.
// Groups similar queries: "Lambda timeout VPC" ≈ "VPC timeout Lambda" ≈ "why Lambda times out in VPC"
func normalizeTopic(query string) string {
	// Step 1: Lowercase and remove noise words
	lower := strings.ToLower(query)
	noise := []string{"how", "do", "we", "i", "the", "is", "a", "an", "to", "in", "for",
		"what", "why", "when", "where", "can", "should", "does", "did", "will",
		"my", "our", "this", "that", "with", "from", "about", "it", "be", "are"}

	words := strings.Fields(lower)
	var meaningful []string
	for _, w := range words {
		// Remove punctuation
		w = strings.TrimFunc(w, func(r rune) bool {
			return r < 'a' || r > 'z'
		})
		if len(w) < 3 {
			continue
		}
		isNoise := false
		for _, n := range noise {
			if w == n {
				isNoise = true
				break
			}
		}
		if !isNoise {
			meaningful = append(meaningful, w)
		}
	}

	// Step 2: Sort alphabetically (order-independent matching)
	sort.Strings(meaningful)

	// Step 3: Take top 5 meaningful words
	if len(meaningful) > 5 {
		meaningful = meaningful[:5]
	}

	return strings.Join(meaningful, " ")
}

// hashTopic creates a stable hash for a normalized topic within an org.
func hashTopic(orgID, topic string) string {
	data := orgID + ":" + topic
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:8])
}
