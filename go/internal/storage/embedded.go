// Package storage — embedded.go provides lightweight in-process alternatives
// to PostgreSQL, Redis, and S3 for single-user ("solo") mode.
//
// Solo mode stores everything under a single directory (~/.synapse by default):
//
//	~/.synapse/
//	├── synapse.db        — SQLite database (chunks, facts, sessions, graph)
//	├── objects/          — Raw session payloads (replaces S3)
//	├── cache/            — Optional disk-backed cache
//	└── config.json       — Solo mode configuration
//
// This mode is designed for individual developers who want Synapse's knowledge
// capture and retrieval without deploying PostgreSQL, Redis, and MinIO.
//
// Trade-offs vs full deployment:
//   - No pgvector: semantic search uses brute-force cosine similarity (fine for <100K chunks)
//   - No tsvector: keyword search uses SQLite FTS5
//   - No Redis queues: ingestion is synchronous
//   - No team isolation: single user, single organization
//   - No horizontal scaling: single process
package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ─── Filesystem Object Store (replaces S3) ───────────────────────────────────

// FileStore provides file-system-backed object storage for solo mode.
type FileStore struct {
	basePath string
}

// NewFileStore creates a filesystem-based object store under the given directory.
func NewFileStore(basePath string) (*FileStore, error) {
	if err := os.MkdirAll(basePath, 0750); err != nil {
		return nil, fmt.Errorf("create filestore dir: %w", err)
	}
	return &FileStore{basePath: basePath}, nil
}

// Put writes data to a file under the base path.
func (fs *FileStore) Put(ctx context.Context, key string, data []byte, contentType string) error {
	path := filepath.Join(fs.basePath, key)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0750); err != nil {
		return fmt.Errorf("create dir for %s: %w", key, err)
	}
	return os.WriteFile(path, data, 0640)
}

// Get reads a file from the base path.
func (fs *FileStore) Get(ctx context.Context, key string) ([]byte, error) {
	path := filepath.Join(fs.basePath, key)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, fmt.Errorf("object not found: %s", key)
	}
	return data, err
}

// Exists checks if a file exists.
func (fs *FileStore) Exists(ctx context.Context, key string) (bool, error) {
	path := filepath.Join(fs.basePath, key)
	_, err := os.Stat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}

// Delete removes a file.
func (fs *FileStore) Delete(ctx context.Context, key string) error {
	path := filepath.Join(fs.basePath, key)
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Healthy always returns true for filesystem storage.
func (fs *FileStore) Healthy(ctx context.Context) bool { return true }

// ─── In-Memory Cache (replaces Redis) ────────────────────────────────────────

// MemCache provides an in-memory cache with TTL for solo mode, replacing Redis.
type MemCache struct {
	mu      sync.RWMutex
	entries map[string]cacheEntry
	queues  map[string][][]byte
}

type cacheEntry struct {
	data      []byte
	expiresAt time.Time
}

// NewMemCache creates a new in-memory cache.
func NewMemCache() *MemCache {
	mc := &MemCache{
		entries: make(map[string]cacheEntry),
		queues:  make(map[string][][]byte),
	}
	// Background eviction every 60 seconds
	go mc.evictLoop()
	return mc
}

func (mc *MemCache) evictLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		mc.mu.Lock()
		now := time.Now()
		for k, e := range mc.entries {
			if !e.expiresAt.IsZero() && now.After(e.expiresAt) {
				delete(mc.entries, k)
			}
		}
		mc.mu.Unlock()
	}
}

// GetCached retrieves a cached value.
func (mc *MemCache) GetCached(ctx context.Context, key string) ([]byte, error) {
	mc.mu.RLock()
	defer mc.mu.RUnlock()
	entry, ok := mc.entries[key]
	if !ok {
		return nil, nil
	}
	if !entry.expiresAt.IsZero() && time.Now().After(entry.expiresAt) {
		return nil, nil
	}
	return entry.data, nil
}

// SetCached stores a value with TTL.
func (mc *MemCache) SetCached(ctx context.Context, key string, data []byte, ttl time.Duration) error {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	mc.entries[key] = cacheEntry{
		data:      data,
		expiresAt: time.Now().Add(ttl),
	}
	return nil
}

// Enqueue adds a job to an in-memory queue.
func (mc *MemCache) Enqueue(ctx context.Context, queue string, data []byte) error {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	mc.queues[queue] = append(mc.queues[queue], data)
	return nil
}

// Dequeue pops a job from an in-memory queue (non-blocking).
func (mc *MemCache) Dequeue(ctx context.Context, queue string) ([]byte, error) {
	mc.mu.Lock()
	defer mc.mu.Unlock()
	q := mc.queues[queue]
	if len(q) == 0 {
		return nil, nil
	}
	item := q[0]
	mc.queues[queue] = q[1:]
	return item, nil
}

// QueueLen returns the length of an in-memory queue.
func (mc *MemCache) QueueLen(ctx context.Context, queue string) (int64, error) {
	mc.mu.RLock()
	defer mc.mu.RUnlock()
	return int64(len(mc.queues[queue])), nil
}

// Healthy always returns true.
func (mc *MemCache) Healthy(ctx context.Context) bool { return true }

// ─── Solo Mode Configuration ─────────────────────────────────────────────────

// SoloConfig holds configuration for single-user embedded mode.
type SoloConfig struct {
	DataDir         string `json:"dataDir"`
	Port            int    `json:"port"`
	EmbeddingModel  string `json:"embeddingModel"`
	EmbeddingURL    string `json:"embeddingUrl"`
	LLMProvider     string `json:"llmProvider"`
	LLMModel        string `json:"llmModel"`
	AutoCapture     bool   `json:"autoCapture"`
	MaxChunks       int    `json:"maxChunks"`       // 0 = unlimited
	CompactionHours int    `json:"compactionHours"` // 0 = disabled
}

// DefaultSoloConfig returns sensible defaults for solo mode.
func DefaultSoloConfig() *SoloConfig {
	homeDir, _ := os.UserHomeDir()
	return &SoloConfig{
		DataDir:         filepath.Join(homeDir, ".synapse"),
		Port:            3333,
		EmbeddingModel:  "nomic-embed-text",
		EmbeddingURL:    "http://localhost:11434",
		LLMProvider:     "local-none",
		LLMModel:        "",
		AutoCapture:     true,
		MaxChunks:       0,
		CompactionHours: 24,
	}
}

// LoadSoloConfig reads config from the data directory, or returns defaults.
func LoadSoloConfig(dataDir string) *SoloConfig {
	cfg := DefaultSoloConfig()
	if dataDir != "" {
		cfg.DataDir = dataDir
	}

	path := filepath.Join(cfg.DataDir, "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, cfg)
	return cfg
}

// Save writes the config to disk.
func (sc *SoloConfig) Save() error {
	if err := os.MkdirAll(sc.DataDir, 0750); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(sc, "", "  ")
	return os.WriteFile(filepath.Join(sc.DataDir, "config.json"), data, 0640)
}

// ─── Brute-Force Vector Search (replaces pgvector) ───────────────────────────

// VectorIndex provides in-memory brute-force cosine similarity search.
// Suitable for <100K vectors in solo mode.
type VectorIndex struct {
	mu      sync.RWMutex
	vectors map[string][]float64 // id → embedding
}

// NewVectorIndex creates a new in-memory vector index.
func NewVectorIndex() *VectorIndex {
	return &VectorIndex{
		vectors: make(map[string][]float64),
	}
}

// Add inserts or updates a vector.
func (vi *VectorIndex) Add(id string, embedding []float64) {
	vi.mu.Lock()
	defer vi.mu.Unlock()
	vi.vectors[id] = embedding
}

// Remove deletes a vector.
func (vi *VectorIndex) Remove(id string) {
	vi.mu.Lock()
	defer vi.mu.Unlock()
	delete(vi.vectors, id)
}

// Search finds the topK most similar vectors to the query.
func (vi *VectorIndex) Search(query []float64, topK int) []VectorMatch {
	vi.mu.RLock()
	defer vi.mu.RUnlock()

	if len(query) == 0 || len(vi.vectors) == 0 {
		return nil
	}

	type scored struct {
		id    string
		score float64
	}

	results := make([]scored, 0, len(vi.vectors))
	for id, vec := range vi.vectors {
		sim := cosineSimilarity(query, vec)
		results = append(results, scored{id: id, score: sim})
	}

	// Partial sort: find top-K (insertion sort into small result buffer)
	if topK > len(results) {
		topK = len(results)
	}
	topResults := make([]scored, 0, topK)
	for _, r := range results {
		if len(topResults) < topK {
			topResults = append(topResults, r)
			// Bubble up
			for i := len(topResults) - 1; i > 0 && topResults[i].score > topResults[i-1].score; i-- {
				topResults[i], topResults[i-1] = topResults[i-1], topResults[i]
			}
		} else if r.score > topResults[topK-1].score {
			topResults[topK-1] = r
			for i := topK - 1; i > 0 && topResults[i].score > topResults[i-1].score; i-- {
				topResults[i], topResults[i-1] = topResults[i-1], topResults[i]
			}
		}
	}

	matches := make([]VectorMatch, len(topResults))
	for i, r := range topResults {
		matches[i] = VectorMatch{ID: r.id, Similarity: r.score}
	}
	return matches
}

// Count returns the number of indexed vectors.
func (vi *VectorIndex) Count() int {
	vi.mu.RLock()
	defer vi.mu.RUnlock()
	return len(vi.vectors)
}

// VectorMatch represents a search result from the vector index.
type VectorMatch struct {
	ID         string  `json:"id"`
	Similarity float64 `json:"similarity"`
}

func cosineSimilarity(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	denom := math.Sqrt(normA) * math.Sqrt(normB)
	if denom == 0 {
		return 0
	}
	return dot / denom
}

// ─── FTS5-style Keyword Search (replaces tsvector) ───────────────────────────

// TextIndex provides simple full-text search for solo mode without PostgreSQL.
type TextIndex struct {
	mu      sync.RWMutex
	docs    map[string]indexedDoc
}

type indexedDoc struct {
	title   string
	content string
	terms   map[string]int // term → count
}

// NewTextIndex creates a new in-memory text search index.
func NewTextIndex() *TextIndex {
	return &TextIndex{
		docs: make(map[string]indexedDoc),
	}
}

// Index adds a document to the text index.
func (ti *TextIndex) Index(id, title, content string) {
	ti.mu.Lock()
	defer ti.mu.Unlock()

	terms := tokenize(title + " " + content)
	termCounts := make(map[string]int)
	for _, t := range terms {
		termCounts[t]++
	}
	ti.docs[id] = indexedDoc{title: title, content: content, terms: termCounts}
}

// Remove deletes a document from the index.
func (ti *TextIndex) Remove(id string) {
	ti.mu.Lock()
	defer ti.mu.Unlock()
	delete(ti.docs, id)
}

// Search performs keyword search and returns ranked results.
func (ti *TextIndex) Search(query string, limit int) []TextMatch {
	ti.mu.RLock()
	defer ti.mu.RUnlock()

	queryTerms := tokenize(query)
	if len(queryTerms) == 0 {
		return nil
	}

	type scored struct {
		id    string
		score float64
	}

	var results []scored
	docCount := float64(len(ti.docs))

	for id, doc := range ti.docs {
		score := 0.0
		for _, qt := range queryTerms {
			tf := float64(doc.terms[qt])
			if tf == 0 {
				continue
			}
			// Simple TF-IDF scoring
			df := ti.docFreq(qt)
			idf := math.Log(1 + docCount/(1+df))
			score += tf * idf
		}
		if score > 0 {
			results = append(results, scored{id: id, score: score})
		}
	}

	// Sort by score descending
	for i := 1; i < len(results); i++ {
		for j := i; j > 0 && results[j].score > results[j-1].score; j-- {
			results[j], results[j-1] = results[j-1], results[j]
		}
	}

	if limit > len(results) {
		limit = len(results)
	}
	matches := make([]TextMatch, limit)
	for i := 0; i < limit; i++ {
		matches[i] = TextMatch{ID: results[i].id, Score: results[i].score}
	}
	return matches
}

func (ti *TextIndex) docFreq(term string) float64 {
	count := 0
	for _, doc := range ti.docs {
		if doc.terms[term] > 0 {
			count++
		}
	}
	return float64(count)
}

// TextMatch represents a keyword search result.
type TextMatch struct {
	ID    string  `json:"id"`
	Score float64 `json:"score"`
}

func tokenize(text string) []string {
	text = strings.ToLower(text)
	// Split on non-alphanumeric characters
	var tokens []string
	var current strings.Builder
	for _, r := range text {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			current.WriteRune(r)
		} else {
			if current.Len() > 2 { // skip very short tokens
				tokens = append(tokens, current.String())
			}
			current.Reset()
		}
	}
	if current.Len() > 2 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

// ─── Solo Mode Initialization ────────────────────────────────────────────────

// SoloStore holds all embedded storage components for single-user mode.
type SoloStore struct {
	Config  *SoloConfig
	Objects *FileStore
	Cache   *MemCache
	Vectors *VectorIndex
	Text    *TextIndex
	DB      *DB // still PostgreSQL for now, but can work with embedded PG
}

// InitSoloMode sets up the solo mode data directory and returns storage components.
func InitSoloMode(dataDir string) (*SoloStore, error) {
	cfg := LoadSoloConfig(dataDir)

	// Ensure directory structure
	dirs := []string{
		cfg.DataDir,
		filepath.Join(cfg.DataDir, "objects"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0750); err != nil {
			return nil, fmt.Errorf("create dir %s: %w", d, err)
		}
	}

	objects, err := NewFileStore(filepath.Join(cfg.DataDir, "objects"))
	if err != nil {
		return nil, fmt.Errorf("init filestore: %w", err)
	}

	slog.Info("Solo mode initialized",
		"dataDir", cfg.DataDir,
		"port", cfg.Port,
		"embedding", cfg.EmbeddingModel,
	)

	return &SoloStore{
		Config:  cfg,
		Objects: objects,
		Cache:   NewMemCache(),
		Vectors: NewVectorIndex(),
		Text:    NewTextIndex(),
	}, nil
}
