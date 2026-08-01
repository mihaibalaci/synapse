package api

import (
	"fmt"
	"net/http"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/mihaibalaci/synapse/internal/version"
)

// handlePrometheusMetrics exports application and Go runtime metrics in
// OpenMetrics/Prometheus exposition format. No external library is required
// because the text format is simple and stable.
func handlePrometheusMetrics(w http.ResponseWriter, r *http.Request) {
	app := appFromRequest(r)

	// Sample live pool stats at scrape time.
	if app.DB != nil {
		stat := app.DB.Pool.Stat()
		SetPoolStats(int64(stat.AcquiredConns()), int64(stat.MaxConns()), int64(stat.IdleConns()))
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")

	// ─── Application metrics ─────────────────────────────────────────────
	fmt.Fprintf(w, "# HELP synapse_info Build information.\n")
	fmt.Fprintf(w, "# TYPE synapse_info gauge\n")
	fmt.Fprintf(w, "synapse_info{version=%q} 1\n\n", version.Version)

	// Cache
	fmt.Fprintf(w, "# HELP synapse_cache_hits_total Total cache hits.\n")
	fmt.Fprintf(w, "# TYPE synapse_cache_hits_total counter\n")
	fmt.Fprintf(w, "synapse_cache_hits_total %d\n\n", atomic.LoadInt64(&metrics.cacheHits))

	fmt.Fprintf(w, "# HELP synapse_cache_misses_total Total cache misses.\n")
	fmt.Fprintf(w, "# TYPE synapse_cache_misses_total counter\n")
	fmt.Fprintf(w, "synapse_cache_misses_total %d\n\n", atomic.LoadInt64(&metrics.cacheMisses))

	// Retrieval
	fmt.Fprintf(w, "# HELP synapse_queries_total Total search queries.\n")
	fmt.Fprintf(w, "# TYPE synapse_queries_total counter\n")
	fmt.Fprintf(w, "synapse_queries_total %d\n\n", atomic.LoadInt64(&metrics.totalQueries))

	fmt.Fprintf(w, "# HELP synapse_query_concurrent Current concurrent search requests.\n")
	fmt.Fprintf(w, "# TYPE synapse_query_concurrent gauge\n")
	fmt.Fprintf(w, "synapse_query_concurrent %d\n\n", atomic.LoadInt64(&metrics.concurrent))

	fmt.Fprintf(w, "# HELP synapse_query_peak_concurrent Peak concurrent search requests.\n")
	fmt.Fprintf(w, "# TYPE synapse_query_peak_concurrent gauge\n")
	fmt.Fprintf(w, "synapse_query_peak_concurrent %d\n\n", atomic.LoadInt64(&metrics.peakConcurrent))

	// Ingestion
	fmt.Fprintf(w, "# HELP synapse_sessions_processed_total Total sessions ingested.\n")
	fmt.Fprintf(w, "# TYPE synapse_sessions_processed_total counter\n")
	fmt.Fprintf(w, "synapse_sessions_processed_total %d\n\n", atomic.LoadInt64(&metrics.sessionsProcessed))

	fmt.Fprintf(w, "# HELP synapse_chunks_created_total Total chunks created.\n")
	fmt.Fprintf(w, "# TYPE synapse_chunks_created_total counter\n")
	fmt.Fprintf(w, "synapse_chunks_created_total %d\n\n", atomic.LoadInt64(&metrics.chunksCreated))

	fmt.Fprintf(w, "# HELP synapse_facts_extracted_total Total facts extracted.\n")
	fmt.Fprintf(w, "# TYPE synapse_facts_extracted_total counter\n")
	fmt.Fprintf(w, "synapse_facts_extracted_total %d\n\n", atomic.LoadInt64(&metrics.factsExtracted))

	fmt.Fprintf(w, "# HELP synapse_embeddings_generated_total Total embeddings generated.\n")
	fmt.Fprintf(w, "# TYPE synapse_embeddings_generated_total counter\n")
	fmt.Fprintf(w, "synapse_embeddings_generated_total %d\n\n", atomic.LoadInt64(&metrics.embeddingsGenerated))

	fmt.Fprintf(w, "# HELP synapse_graph_updates_total Total graph updates.\n")
	fmt.Fprintf(w, "# TYPE synapse_graph_updates_total counter\n")
	fmt.Fprintf(w, "synapse_graph_updates_total %d\n\n", atomic.LoadInt64(&metrics.graphUpdates))

	// Storage connections
	fmt.Fprintf(w, "# HELP synapse_pg_active_conns Current active PostgreSQL connections.\n")
	fmt.Fprintf(w, "# TYPE synapse_pg_active_conns gauge\n")
	fmt.Fprintf(w, "synapse_pg_active_conns %d\n\n", atomic.LoadInt64(&metrics.pgConns))

	fmt.Fprintf(w, "# HELP synapse_pg_max_conns Maximum PostgreSQL connections.\n")
	fmt.Fprintf(w, "# TYPE synapse_pg_max_conns gauge\n")
	fmt.Fprintf(w, "synapse_pg_max_conns %d\n\n", atomic.LoadInt64(&metrics.pgMaxConns))

	fmt.Fprintf(w, "# HELP synapse_redis_conns Current Redis connections.\n")
	fmt.Fprintf(w, "# TYPE synapse_redis_conns gauge\n")
	fmt.Fprintf(w, "synapse_redis_conns %d\n\n", atomic.LoadInt64(&metrics.redisConns))

	// Errors
	fmt.Fprintf(w, "# HELP synapse_errors_total Total errors by source.\n")
	fmt.Fprintf(w, "# TYPE synapse_errors_total counter\n")
	fmt.Fprintf(w, "synapse_errors_total{source=\"retrieval\"} %d\n", atomic.LoadInt64(&metrics.retrievalErrors))
	fmt.Fprintf(w, "synapse_errors_total{source=\"ingestion\"} %d\n", atomic.LoadInt64(&metrics.ingestionErrors))
	fmt.Fprintf(w, "synapse_errors_total{source=\"storage\"} %d\n\n", atomic.LoadInt64(&metrics.storageErrors))

	// S3
	fmt.Fprintf(w, "# HELP synapse_s3_puts_total Total S3 PUT operations.\n")
	fmt.Fprintf(w, "# TYPE synapse_s3_puts_total counter\n")
	fmt.Fprintf(w, "synapse_s3_puts_total %d\n\n", atomic.LoadInt64(&metrics.s3Puts))

	fmt.Fprintf(w, "# HELP synapse_s3_gets_total Total S3 GET operations.\n")
	fmt.Fprintf(w, "# TYPE synapse_s3_gets_total counter\n")
	fmt.Fprintf(w, "synapse_s3_gets_total %d\n\n", atomic.LoadInt64(&metrics.s3Gets))

	// ─── Go runtime metrics ──────────────────────────────────────────────
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	fmt.Fprintf(w, "# HELP go_goroutines Number of goroutines.\n")
	fmt.Fprintf(w, "# TYPE go_goroutines gauge\n")
	fmt.Fprintf(w, "go_goroutines %d\n\n", runtime.NumGoroutine())

	fmt.Fprintf(w, "# HELP go_memstats_alloc_bytes Current bytes allocated.\n")
	fmt.Fprintf(w, "# TYPE go_memstats_alloc_bytes gauge\n")
	fmt.Fprintf(w, "go_memstats_alloc_bytes %d\n\n", mem.Alloc)

	fmt.Fprintf(w, "# HELP go_memstats_sys_bytes Total bytes obtained from OS.\n")
	fmt.Fprintf(w, "# TYPE go_memstats_sys_bytes gauge\n")
	fmt.Fprintf(w, "go_memstats_sys_bytes %d\n\n", mem.Sys)

	fmt.Fprintf(w, "# HELP go_memstats_heap_inuse_bytes Heap bytes in use.\n")
	fmt.Fprintf(w, "# TYPE go_memstats_heap_inuse_bytes gauge\n")
	fmt.Fprintf(w, "go_memstats_heap_inuse_bytes %d\n\n", mem.HeapInuse)

	fmt.Fprintf(w, "# HELP go_gc_duration_seconds_total Total GC pause time.\n")
	fmt.Fprintf(w, "# TYPE go_gc_duration_seconds_total counter\n")
	fmt.Fprintf(w, "go_gc_duration_seconds_total %.6f\n\n", float64(mem.PauseTotalNs)/1e9)

	fmt.Fprintf(w, "# HELP go_gc_completed_total Total GC cycles completed.\n")
	fmt.Fprintf(w, "# TYPE go_gc_completed_total counter\n")
	fmt.Fprintf(w, "go_gc_completed_total %d\n\n", mem.NumGC)

	fmt.Fprintf(w, "# HELP process_start_time_seconds Unix timestamp of process start.\n")
	fmt.Fprintf(w, "# TYPE process_start_time_seconds gauge\n")
	fmt.Fprintf(w, "process_start_time_seconds %d\n", processStart.Unix())
}

var processStart = time.Now()
