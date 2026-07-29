package api

import (
	"math"
	"sort"
	"sync"
	"sync/atomic"
)

// metrics is a global in-memory metrics store.
// In production, this would export to Prometheus/OpenTelemetry.
var metrics = &Metrics{}

// Metrics holds operational counters for the system.
type Metrics struct {
	// Cache
	cacheHits      int64
	cacheMisses    int64
	cacheEvictions int64
	cacheSize      int64

	// Retrieval
	totalQueries   int64
	avgLatencyMs   int64
	p95LatencyMs   int64
	concurrent     int64
	peakConcurrent int64

	// Ingestion
	sessionsProcessed   int64
	chunksCreated       int64
	factsExtracted      int64
	segmentations       int64
	embeddingsGenerated int64
	deduplicationsRun   int64
	graphUpdates        int64
	searchIndexed       int64

	// Storage
	pgConns    int64
	pgMaxConns int64
	redisConns int64
	s3Puts     int64
	s3Gets     int64

	// Errors
	totalErrors     int64
	recentErrors    int64
	retrievalErrors int64
	ingestionErrors int64
	storageErrors   int64
}

// SeedFromCounts initializes the cumulative ingestion counters from persisted
// database totals. Runtime counters (cache, latency, concurrency) are in-memory
// by design and stay at zero until traffic arrives, but the ingestion counters
// represent durable work already performed — without seeding they would reset
// to zero on every process restart and the Activity page would look empty even
// though the data is present in PostgreSQL.
func SeedFromCounts(counts map[string]int) {
	atomic.StoreInt64(&metrics.sessionsProcessed, int64(counts["sessions"]))
	atomic.StoreInt64(&metrics.chunksCreated, int64(counts["chunks"]))
	atomic.StoreInt64(&metrics.factsExtracted, int64(counts["facts"]))
	atomic.StoreInt64(&metrics.segmentations, int64(counts["sessions"]))
	atomic.StoreInt64(&metrics.searchIndexed, int64(counts["searchableChunks"]))
	atomic.StoreInt64(&metrics.graphUpdates, int64(counts["graphNodes"]))
}

func (m *Metrics) hitRate() float64 {
	total := m.cacheHits + m.cacheMisses
	if total == 0 {
		return 0
	}
	return float64(m.cacheHits) / float64(total) * 100
}

// ─── Increment helpers (thread-safe) ─────────────────────────────────────────

func RecordCacheHit()  { atomic.AddInt64(&metrics.cacheHits, 1) }
func RecordCacheMiss() { atomic.AddInt64(&metrics.cacheMisses, 1) }

// latencySamples is a bounded ring buffer of recent query latencies in
// microseconds, used to compute a true average and p95 rather than reporting
// only the most recent value.
var (
	latencyMu      sync.Mutex
	latencySamples []int64
	latencyNext    int
)

const latencyWindow = 512

func RecordQuery(latencyMicros int64) {
	atomic.AddInt64(&metrics.totalQueries, 1)

	latencyMu.Lock()
	if len(latencySamples) < latencyWindow {
		latencySamples = append(latencySamples, latencyMicros)
	} else {
		latencySamples[latencyNext] = latencyMicros
		latencyNext = (latencyNext + 1) % latencyWindow
	}
	latencyMu.Unlock()
}

// latencyStats returns the mean and p95 of the recent latency window,
// expressed in milliseconds with two decimals of precision preserved.
func latencyStats() (avgMs, p95Ms float64) {
	latencyMu.Lock()
	sample := make([]int64, len(latencySamples))
	copy(sample, latencySamples)
	latencyMu.Unlock()

	if len(sample) == 0 {
		return 0, 0
	}

	var sum int64
	for _, v := range sample {
		sum += v
	}
	sort.Slice(sample, func(i, j int) bool { return sample[i] < sample[j] })

	idx := int(math.Ceil(0.95*float64(len(sample)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sample) {
		idx = len(sample) - 1
	}

	avgMs = float64(sum) / float64(len(sample)) / 1000
	p95Ms = float64(sample[idx]) / 1000
	return avgMs, p95Ms
}

// SetPoolStats records current connection-pool utilisation, sampled at the
// moment the metrics endpoint is scraped.
func SetPoolStats(pgActive, pgMax, redis int64) {
	atomic.StoreInt64(&metrics.pgConns, pgActive)
	atomic.StoreInt64(&metrics.pgMaxConns, pgMax)
	atomic.StoreInt64(&metrics.redisConns, redis)
}

func RecordConcurrent(n int64) {
	atomic.StoreInt64(&metrics.concurrent, n)
	peak := atomic.LoadInt64(&metrics.peakConcurrent)
	if n > peak {
		atomic.StoreInt64(&metrics.peakConcurrent, n)
	}
}

func RecordSessionProcessed() { atomic.AddInt64(&metrics.sessionsProcessed, 1) }
func RecordChunkCreated()     { atomic.AddInt64(&metrics.chunksCreated, 1) }
func RecordFactExtracted()    { atomic.AddInt64(&metrics.factsExtracted, 1) }
func RecordSegmentation()     { atomic.AddInt64(&metrics.segmentations, 1) }
func RecordEmbedding()        { atomic.AddInt64(&metrics.embeddingsGenerated, 1) }
func RecordDedup()            { atomic.AddInt64(&metrics.deduplicationsRun, 1) }
func RecordGraphUpdate()      { atomic.AddInt64(&metrics.graphUpdates, 1) }
func RecordSearchIndexed()    { atomic.AddInt64(&metrics.searchIndexed, 1) }
func RecordS3Put()            { atomic.AddInt64(&metrics.s3Puts, 1) }
func RecordS3Get()            { atomic.AddInt64(&metrics.s3Gets, 1) }

func RecordError(category string) {
	atomic.AddInt64(&metrics.totalErrors, 1)
	atomic.AddInt64(&metrics.recentErrors, 1)
	switch category {
	case "retrieval":
		atomic.AddInt64(&metrics.retrievalErrors, 1)
	case "ingestion":
		atomic.AddInt64(&metrics.ingestionErrors, 1)
	case "storage":
		atomic.AddInt64(&metrics.storageErrors, 1)
	}
}
