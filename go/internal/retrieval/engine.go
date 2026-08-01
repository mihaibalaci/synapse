// Package retrieval implements the 5-signal hybrid search pipeline.
//
// Architecture:
//  1. Query → embed (or cache hit)
//  2. 3-5 parallel DB signals (vector, keyword, entity, temporal, graph)
//  3. RRF fusion → composite ranking → diversity → token budget packing
//  4. Return results
//
// The ranking math runs inline in Go (fast enough for <200 candidates).
// For batch operations (1000+ candidates), we can optionally call the Rust
// native module via subprocess.
package retrieval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/models"
	"github.com/mihaibalaci/synapse/internal/storage"
)

// Embedder turns a query into a vector so the semantic signal can run. It is
// an interface rather than a concrete type to keep this package independent of
// the ingestion package and its provider configuration.
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float64, error)
}

// Engine orchestrates the full retrieval pipeline.
type Engine struct {
	db    *storage.DB
	cache *storage.Cache

	chunks *storage.ChunkRepo
	facts  *storage.FactRepo

	// embedder may be nil, in which case the semantic signal is skipped and
	// retrieval falls back to keyword and entity matching.
	embedder Embedder
}

// NewEngine creates a retrieval engine with the given dependencies. Passing a
// nil embedder disables the semantic signal.
func NewEngine(db *storage.DB, cache *storage.Cache, chunks *storage.ChunkRepo, facts *storage.FactRepo, embedder Embedder) *Engine {
	return &Engine{db: db, cache: cache, chunks: chunks, facts: facts, embedder: embedder}
}

// Search executes the full hybrid retrieval pipeline.
func (e *Engine) Search(ctx context.Context, req *models.SearchRequest, claims *auth.Claims) (*models.SearchResponse, error) {
	start := time.Now()

	// 1. Check cache
	cacheKey := e.buildCacheKey(req, claims)
	// Cache failures degrade to a normal search; malformed cached JSON is
	// deleted so every request does not repeatedly pay the decode failure.
	if cached, err := e.cache.GetCached(ctx, cacheKey); err != nil {
		slog.Warn("Search cache read failed", "error", err)
	} else if cached != nil {
		var resp models.SearchResponse
		if err := json.Unmarshal(cached, &resp); err == nil {
			resp.Cached = true
			resp.LatencyMs = time.Since(start).Milliseconds()
			return &resp, nil
		}
		slog.Warn("Discarding malformed cached search response", "key", cacheKey)
		_ = e.cache.Client.Del(ctx, cacheKey).Err()
	}

	orgID := claims.OrganizationID
	topK := req.TopK
	if topK == 0 {
		topK = 5
	}

	// 2. Run signals in parallel
	type signalResult struct {
		candidates []candidate
		err        error
	}

	var wg sync.WaitGroup
	semanticCh := make(chan signalResult, 1)
	keywordCh := make(chan signalResult, 1)
	entityCh := make(chan signalResult, 1)
	graphCh := make(chan signalResult, 1)

	// Signal 1: Semantic (vector ANN over pgvector).
	wg.Add(1)
	go func() {
		defer wg.Done()

		// Without an embedder there is no query vector, and passing nil would
		// make the similarity NULL for every row. Skip the signal instead of
		// polluting the fusion with meaningless scores.
		if e.embedder == nil {
			semanticCh <- signalResult{}
			return
		}

		queryVec, err := e.embedder.Embed(ctx, req.Query)
		if err != nil {
			slog.Warn("Query embedding failed; semantic signal skipped", "error", err)
			semanticCh <- signalResult{}
			return
		}

		results, err := e.chunks.SearchByVector(ctx, queryVec, orgID, 50)
		candidates := make([]candidate, len(results))
		for i, r := range results {
			candidates[i] = candidate{
				ID: r.ID, Title: r.Title, Summary: r.Summary, Content: r.Content,
				TokenCount: r.TokenCount, QualityScore: r.QualityScore,
				UsageCount: r.UsageCount, Confidence: r.Confidence,
				Repository: r.Repository, CreatedAt: r.CreatedAt,
				Scores: scores{Semantic: r.Similarity},
			}
		}
		semanticCh <- signalResult{candidates: candidates, err: err}
	}()

	// Signal 2: Keyword (BM25)
	wg.Add(1)
	go func() {
		defer wg.Done()
		results, err := e.chunks.SearchByKeyword(ctx, req.Query, orgID, 50)
		candidates := make([]candidate, len(results))
		for i, r := range results {
			candidates[i] = candidate{
				ID: r.ID, Title: r.Title, Summary: r.Summary, Content: r.Content,
				TokenCount: r.TokenCount, QualityScore: r.QualityScore,
				UsageCount: r.UsageCount, Confidence: r.Confidence,
				Repository: r.Repository, CreatedAt: r.CreatedAt,
				Scores: scores{Keyword: r.Similarity},
			}
		}
		keywordCh <- signalResult{candidates: candidates, err: err}
	}()

	// Signal 3: Entity match (facts)
	wg.Add(1)
	go func() {
		defer wg.Done()
		entities := extractQueryEntities(req.Query)
		if len(entities) == 0 {
			entityCh <- signalResult{}
			return
		}
		facts, err := e.facts.FindByEntities(ctx, entities, orgID, 20)
		candidates := make([]candidate, 0, len(facts))
		for _, f := range facts {
			candidates = append(candidates, candidate{
				ID: f.ID, Title: f.Content, Summary: f.Content,
				Scores: scores{EntityMatch: 0.7},
			})
		}
		entityCh <- signalResult{candidates: candidates, err: err}
	}()

	// Signal 4: Graph neighbors — boost chunks whose entities share graph edges
	// with the query entities.
	wg.Add(1)
	go func() {
		defer wg.Done()
		entities := extractQueryEntities(req.Query)
		if len(entities) == 0 {
			graphCh <- signalResult{}
			return
		}
		rows, err := e.db.Query(ctx, `
			SELECT DISTINCT c.id, c.title, c.summary, c.content, c.token_count,
				c.quality_score, c.usage_count, c.confidence, COALESCE(c.repository,''), c.created_at,
				ge.weight / 10.0 AS score
			FROM graph_nodes gn
			JOIN graph_edges ge ON ge.source_id = gn.id OR ge.target_id = gn.id
			JOIN graph_nodes neighbor ON neighbor.id = CASE WHEN ge.source_id = gn.id THEN ge.target_id ELSE ge.source_id END
			JOIN memory_facts mf ON neighbor.name = ANY(mf.entities) AND mf.organization_id = $2
			JOIN chunks c ON c.id = mf.source_chunk_id AND c.confidence <> 'archived' AND c.searchable_status = 'searchable'
			WHERE gn.organization_id = $2 AND gn.name = ANY($1::text[])
			ORDER BY ge.weight DESC
			LIMIT 20`, entities, orgID)
		if err != nil {
			graphCh <- signalResult{err: err}
			return
		}
		defer rows.Close()
		var candidates []candidate
		for rows.Next() {
			var c candidate
			if err := rows.Scan(&c.ID, &c.Title, &c.Summary, &c.Content, &c.TokenCount,
				&c.QualityScore, &c.UsageCount, &c.Confidence, &c.Repository, &c.CreatedAt, &c.Scores.GraphRelevance); err != nil {
				continue
			}
			candidates = append(candidates, c)
		}
		graphCh <- signalResult{candidates: candidates}
	}()

	wg.Wait()

	// 3. Collect results
	sem := <-semanticCh
	kw := <-keywordCh
	ent := <-entityCh
	graph := <-graphCh

	if sem.err != nil {
		slog.Warn("Semantic search failed", "error", sem.err)
	}
	if kw.err != nil {
		slog.Warn("Keyword search failed", "error", kw.err)
	}
	if graph.err != nil {
		slog.Warn("Graph search failed", "error", graph.err)
	}

	// 4. RRF Fusion
	fused := rrfFuse(sem.candidates, kw.candidates, ent.candidates, graph.candidates)

	// 5. Composite ranking
	queryRepo := ""
	if req.Context != nil {
		queryRepo = req.Context.Repository
	}
	ranked := rankCandidates(fused, queryRepo)

	// 6. Apply diversity
	ranked = applyDiversity(ranked)

	// 7. Token budget packing or top-K
	var selected []candidate
	if req.MaxTokens > 0 {
		selected = packByBudget(ranked, req.MaxTokens)
	} else {
		end := topK
		if end > len(ranked) {
			end = len(ranked)
		}
		selected = ranked[:end]
	}

	// 8. Format response
	results := make([]models.SearchResult, len(selected))
	estimatedTokens := 0
	for i, c := range selected {
		content := ""
		if req.IncludeContent {
			content = c.Content
		}
		results[i] = models.SearchResult{
			ID:         c.ID,
			Type:       "chunk",
			Title:      c.Title,
			Summary:    c.Summary,
			Content:    content,
			FinalScore: c.FinalScore,
			Repository: c.Repository,
			CreatedAt:  c.CreatedAt.Format(time.RFC3339),
		}
		estimatedTokens += c.TokenCount
	}

	resp := &models.SearchResponse{
		Results:         results,
		TotalCount:      len(fused),
		Query:           req.Query,
		Strategy:        req.Strategy,
		LatencyMs:       time.Since(start).Milliseconds(),
		Cached:          false,
		EstimatedTokens: estimatedTokens,
		Observations:    []models.Observation{},
	}

	// Cache the response
	if data, err := json.Marshal(resp); err == nil {
		if err := e.cache.SetCached(ctx, cacheKey, data, 5*time.Minute); err != nil {
			slog.Warn("Search cache write failed", "error", err)
		}
	}
	e.cache.IncrementPopular(ctx, orgID, req.Query)

	slog.Info("Search completed",
		"query", truncate(req.Query, 50),
		"results", len(results),
		"latencyMs", resp.LatencyMs,
	)

	return resp, nil
}

// ─── Internal Types ──────────────────────────────────────────────────────────

type scores struct {
	Semantic       float64
	Keyword        float64
	EntityMatch    float64
	Temporal       float64
	GraphRelevance float64
}

type candidate struct {
	ID           string
	Title        string
	Summary      string
	Content      string
	TokenCount   int
	QualityScore float64
	UsageCount   int
	Confidence   string
	Repository   string
	SessionID    string
	CreatedAt    time.Time
	Scores       scores
	FinalScore   float64
}

// ─── RRF Fusion ──────────────────────────────────────────────────────────────

func rrfFuse(lists ...[]candidate) []candidate {
	const k = 60.0
	scoreMap := make(map[string]*candidate)
	rrfScores := make(map[string]float64)

	for _, list := range lists {
		for rank, c := range list {
			rrfScores[c.ID] += 1.0 / (k + float64(rank) + 1.0)
			if _, exists := scoreMap[c.ID]; !exists {
				copy := c
				scoreMap[c.ID] = &copy
			} else {
				// Merge scores
				existing := scoreMap[c.ID]
				existing.Scores.Semantic = math.Max(existing.Scores.Semantic, c.Scores.Semantic)
				existing.Scores.Keyword = math.Max(existing.Scores.Keyword, c.Scores.Keyword)
				existing.Scores.EntityMatch = math.Max(existing.Scores.EntityMatch, c.Scores.EntityMatch)
			}
		}
	}

	result := make([]candidate, 0, len(scoreMap))
	for id, c := range scoreMap {
		c.FinalScore = rrfScores[id]
		result = append(result, *c)
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].FinalScore > result[j].FinalScore
	})
	return result
}

// ─── Composite Ranking ───────────────────────────────────────────────────────

func rankCandidates(candidates []candidate, queryRepo string) []candidate {
	now := time.Now()

	for i := range candidates {
		c := &candidates[i]
		s := c.Scores

		// Signal weights (sum to ~1.0 before confidence multiplier)
		semantic := s.Semantic * 0.25
		keyword := s.Keyword * 0.10
		entity := s.EntityMatch * 0.08
		graph := s.GraphRelevance * 0.07

		// Temporal decay: 30-day half-life for recent relevance, floor at 0.1
		ageDays := now.Sub(c.CreatedAt).Hours() / 24.0
		temporalDecay := math.Max(math.Exp(-0.693*ageDays/30.0), 0.1)
		freshness := temporalDecay * 0.15

		// Repository match boost
		repoMatch := 0.0
		if queryRepo != "" && c.Repository == queryRepo {
			repoMatch = 0.12
		}

		// Usage with decay: high usage is good but old unused content decays
		usageRaw := math.Min(float64(c.UsageCount)/50.0, 1.0)
		usageDecayed := usageRaw * temporalDecay
		usage := usageDecayed * 0.10

		// Quality score
		quality := c.QualityScore * 0.08

		// Importance score: combines multiple signals into a compound relevance
		importance := (semantic + keyword + entity + graph + freshness + repoMatch + usage + quality)

		// Confidence multiplier
		confMult := 1.0
		switch c.Confidence {
		case "low":
			confMult = 0.6
		case "archived":
			confMult = 0.2
		case "high":
			confMult = 1.1
		}

		c.FinalScore = importance * confMult
		c.Scores.Temporal = temporalDecay
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].FinalScore > candidates[j].FinalScore
	})
	return candidates
}

// ─── Diversity ───────────────────────────────────────────────────────────────

func applyDiversity(candidates []candidate) []candidate {
	sessionCounts := make(map[string]int)
	for i := range candidates {
		sid := candidates[i].SessionID
		if sid == "" {
			continue
		}
		count := sessionCounts[sid]
		if count >= 2 {
			candidates[i].FinalScore *= 0.5
		}
		sessionCounts[sid] = count + 1
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].FinalScore > candidates[j].FinalScore
	})
	return candidates
}

// ─── Token Budget Packing ────────────────────────────────────────────────────

func packByBudget(candidates []candidate, maxTokens int) []candidate {
	var result []candidate
	remaining := maxTokens

	for _, c := range candidates {
		tokens := c.TokenCount
		if tokens == 0 {
			tokens = len(c.Content) / 4
		}
		if tokens > remaining {
			if len(result) == 0 {
				result = append(result, c)
			}
			break
		}
		remaining -= tokens
		result = append(result, c)
	}
	return result
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (e *Engine) buildCacheKey(req *models.SearchRequest, claims *auth.Claims) string {
	// Include every request field that can alter the response plus the complete
	// authorization context. Omitting maxTokens/includeContent previously let a
	// summary-only response satisfy a later full-content request.
	data, _ := json.Marshal(map[string]any{
		"request": req,
		"auth": map[string]any{
			"organizationId":   claims.OrganizationID,
			"userId":           claims.UserID,
			"teamIds":          claims.TeamIDs,
			"roles":            claims.Roles,
			"repositoryAccess": claims.RepositoryAccess,
		},
	})
	hash := sha256.Sum256(data)
	return "search:" + hex.EncodeToString(hash[:16])
}

func extractQueryEntities(query string) []string {
	// Simple heuristic: extract capitalized tech terms
	// In production, use the Rust batchEntityOverlap for precision
	var entities []string
	words := splitWords(query)
	techTerms := map[string]bool{
		"aws": true, "s3": true, "lambda": true, "kafka": true, "redis": true,
		"postgres": true, "docker": true, "kubernetes": true, "react": true,
		"typescript": true, "python": true, "go": true, "rust": true, "graphql": true,
		"terraform": true, "dynamodb": true, "ec2": true, "ecs": true, "vpc": true,
	}
	for _, w := range words {
		lower := toLower(w)
		if techTerms[lower] {
			entities = append(entities, w)
		}
	}
	return entities
}

func splitWords(s string) []string {
	var words []string
	current := ""
	for _, c := range s {
		if c == ' ' || c == '\t' || c == '\n' {
			if current != "" {
				words = append(words, current)
				current = ""
			}
		} else {
			current += string(c)
		}
	}
	if current != "" {
		words = append(words, current)
	}
	return words
}

func toLower(s string) string {
	result := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		result[i] = c
	}
	return string(result)
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
