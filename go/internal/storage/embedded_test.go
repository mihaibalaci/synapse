package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileStore(t *testing.T) {
	dir := t.TempDir()
	fs, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ctx := context.Background()

	// Test Put and Get
	t.Run("PutAndGet", func(t *testing.T) {
		data := []byte("hello world")
		if err := fs.Put(ctx, "test/file.txt", data, "text/plain"); err != nil {
			t.Fatalf("Put: %v", err)
		}
		got, err := fs.Get(ctx, "test/file.txt")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if string(got) != "hello world" {
			t.Errorf("Get = %q, want %q", string(got), "hello world")
		}
	})

	// Test Exists
	t.Run("Exists", func(t *testing.T) {
		exists, err := fs.Exists(ctx, "test/file.txt")
		if err != nil {
			t.Fatalf("Exists: %v", err)
		}
		if !exists {
			t.Error("Exists = false, want true")
		}
		exists, err = fs.Exists(ctx, "nonexistent.txt")
		if err != nil {
			t.Fatalf("Exists: %v", err)
		}
		if exists {
			t.Error("Exists = true for nonexistent file, want false")
		}
	})

	// Test Delete
	t.Run("Delete", func(t *testing.T) {
		_ = fs.Put(ctx, "todelete.txt", []byte("x"), "")
		if err := fs.Delete(ctx, "todelete.txt"); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		exists, _ := fs.Exists(ctx, "todelete.txt")
		if exists {
			t.Error("file still exists after Delete")
		}
	})

	// Test Get nonexistent
	t.Run("GetNotFound", func(t *testing.T) {
		_, err := fs.Get(ctx, "nope.txt")
		if err == nil {
			t.Error("expected error for nonexistent file")
		}
	})

	// Test nested directories
	t.Run("NestedDirs", func(t *testing.T) {
		data := []byte("nested")
		if err := fs.Put(ctx, "a/b/c/deep.txt", data, ""); err != nil {
			t.Fatalf("Put nested: %v", err)
		}
		got, err := fs.Get(ctx, "a/b/c/deep.txt")
		if err != nil {
			t.Fatalf("Get nested: %v", err)
		}
		if string(got) != "nested" {
			t.Errorf("Get nested = %q, want %q", string(got), "nested")
		}
	})

	// Test Healthy
	t.Run("Healthy", func(t *testing.T) {
		if !fs.Healthy(ctx) {
			t.Error("Healthy = false, want true")
		}
	})
}

func TestMemCache(t *testing.T) {
	mc := NewMemCache()
	ctx := context.Background()

	// Test SetCached and GetCached
	t.Run("SetAndGet", func(t *testing.T) {
		if err := mc.SetCached(ctx, "key1", []byte("value1"), 5*time.Minute); err != nil {
			t.Fatalf("SetCached: %v", err)
		}
		got, err := mc.GetCached(ctx, "key1")
		if err != nil {
			t.Fatalf("GetCached: %v", err)
		}
		if string(got) != "value1" {
			t.Errorf("GetCached = %q, want %q", string(got), "value1")
		}
	})

	// Test cache miss
	t.Run("CacheMiss", func(t *testing.T) {
		got, err := mc.GetCached(ctx, "nonexistent")
		if err != nil {
			t.Fatalf("GetCached: %v", err)
		}
		if got != nil {
			t.Errorf("expected nil for cache miss, got %v", got)
		}
	})

	// Test queue operations
	t.Run("Queue", func(t *testing.T) {
		_ = mc.Enqueue(ctx, "testq", []byte("job1"))
		_ = mc.Enqueue(ctx, "testq", []byte("job2"))

		length, _ := mc.QueueLen(ctx, "testq")
		if length != 2 {
			t.Errorf("QueueLen = %d, want 2", length)
		}

		got, _ := mc.Dequeue(ctx, "testq")
		if string(got) != "job1" {
			t.Errorf("Dequeue = %q, want %q", string(got), "job1")
		}

		length, _ = mc.QueueLen(ctx, "testq")
		if length != 1 {
			t.Errorf("QueueLen after dequeue = %d, want 1", length)
		}
	})

	// Test empty queue dequeue
	t.Run("EmptyQueue", func(t *testing.T) {
		got, _ := mc.Dequeue(ctx, "emptyq")
		if got != nil {
			t.Errorf("expected nil from empty queue, got %v", got)
		}
	})

	// Test Healthy
	t.Run("Healthy", func(t *testing.T) {
		if !mc.Healthy(ctx) {
			t.Error("Healthy = false, want true")
		}
	})
}

func TestVectorIndex(t *testing.T) {
	vi := NewVectorIndex()

	// Add some vectors
	vi.Add("a", []float64{1, 0, 0})
	vi.Add("b", []float64{0, 1, 0})
	vi.Add("c", []float64{0.9, 0.1, 0})
	vi.Add("d", []float64{0, 0, 1})

	// Test Count
	t.Run("Count", func(t *testing.T) {
		if vi.Count() != 4 {
			t.Errorf("Count = %d, want 4", vi.Count())
		}
	})

	// Test Search: query similar to "a" and "c"
	t.Run("SearchSimilar", func(t *testing.T) {
		results := vi.Search([]float64{1, 0, 0}, 2)
		if len(results) != 2 {
			t.Fatalf("Search returned %d results, want 2", len(results))
		}
		if results[0].ID != "a" {
			t.Errorf("top result = %q, want 'a'", results[0].ID)
		}
		if results[0].Similarity < 0.99 {
			t.Errorf("top similarity = %f, want ~1.0", results[0].Similarity)
		}
		if results[1].ID != "c" {
			t.Errorf("second result = %q, want 'c'", results[1].ID)
		}
	})

	// Test Search with empty query
	t.Run("EmptyQuery", func(t *testing.T) {
		results := vi.Search([]float64{}, 5)
		if results != nil {
			t.Errorf("expected nil for empty query, got %v", results)
		}
	})

	// Test Remove
	t.Run("Remove", func(t *testing.T) {
		vi.Remove("d")
		if vi.Count() != 3 {
			t.Errorf("Count after remove = %d, want 3", vi.Count())
		}
	})
}

func TestTextIndex(t *testing.T) {
	ti := NewTextIndex()

	ti.Index("doc1", "PostgreSQL Performance", "PostgreSQL performance tuning involves shared buffers and work mem configuration")
	ti.Index("doc2", "Redis Caching", "Redis provides fast in-memory caching for session state and frequently accessed data")
	ti.Index("doc3", "Database Migrations", "Database migrations should be forward-only and backward-compatible")

	// Test search
	t.Run("SearchPostgreSQL", func(t *testing.T) {
		results := ti.Search("PostgreSQL performance", 5)
		if len(results) == 0 {
			t.Fatal("no results for 'PostgreSQL performance'")
		}
		if results[0].ID != "doc1" {
			t.Errorf("top result = %q, want 'doc1'", results[0].ID)
		}
	})

	t.Run("SearchRedis", func(t *testing.T) {
		results := ti.Search("Redis caching memory", 5)
		if len(results) == 0 {
			t.Fatal("no results for 'Redis caching'")
		}
		if results[0].ID != "doc2" {
			t.Errorf("top result = %q, want 'doc2'", results[0].ID)
		}
	})

	t.Run("SearchNoResults", func(t *testing.T) {
		results := ti.Search("kubernetes helm", 5)
		if len(results) != 0 {
			t.Errorf("expected 0 results for unrelated query, got %d", len(results))
		}
	})

	// Test Remove
	t.Run("Remove", func(t *testing.T) {
		ti.Remove("doc1")
		results := ti.Search("PostgreSQL", 5)
		for _, r := range results {
			if r.ID == "doc1" {
				t.Error("doc1 still found after removal")
			}
		}
	})
}

func TestSoloConfig(t *testing.T) {
	dir := t.TempDir()
	cfg := DefaultSoloConfig()
	cfg.DataDir = dir

	// Test Save and Load
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Verify file exists
	configPath := filepath.Join(dir, "config.json")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		t.Fatal("config.json not created")
	}

	// Load and verify
	loaded := LoadSoloConfig(dir)
	if loaded.Port != 3333 {
		t.Errorf("loaded Port = %d, want 3333", loaded.Port)
	}
	if loaded.EmbeddingModel != "nomic-embed-text" {
		t.Errorf("loaded EmbeddingModel = %q, want 'nomic-embed-text'", loaded.EmbeddingModel)
	}
}

func TestCosineSimilarity(t *testing.T) {
	tests := []struct {
		name string
		a, b []float64
		want float64
	}{
		{"identical", []float64{1, 0, 0}, []float64{1, 0, 0}, 1.0},
		{"orthogonal", []float64{1, 0, 0}, []float64{0, 1, 0}, 0.0},
		{"opposite", []float64{1, 0, 0}, []float64{-1, 0, 0}, -1.0},
		{"empty", []float64{}, []float64{}, 0.0},
		{"different lengths", []float64{1, 0}, []float64{1, 0, 0}, 0.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cosineSimilarity(tt.a, tt.b)
			if abs(got-tt.want) > 0.001 {
				t.Errorf("cosineSimilarity = %f, want %f", got, tt.want)
			}
		})
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
