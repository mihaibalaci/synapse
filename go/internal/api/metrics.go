package api

import "sync/atomic"

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

func RecordQuery(latencyMs int64) {
	atomic.AddInt64(&metrics.totalQueries, 1)
	atomic.StoreInt64(&metrics.avgLatencyMs, latencyMs)
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
