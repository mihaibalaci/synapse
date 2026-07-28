package ingestion

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	"github.com/mihaibalaci/synapse/internal/models"
	"github.com/mihaibalaci/synapse/internal/storage"
)

// Pipeline implements the session processing stages.
type Pipeline struct {
	db       *storage.DB
	cache    *storage.Cache
	objects  *storage.ObjectStore
	embedder *EmbeddingClient
	facts    *storage.FactRepo
	chunks   *storage.ChunkRepo
}

// NewPipeline creates an ingestion pipeline.
func NewPipeline(db *storage.DB, cache *storage.Cache, objects *storage.ObjectStore) *Pipeline {
	return &Pipeline{
		db:       db,
		cache:    cache,
		objects:  objects,
		embedder: NewEmbeddingClient(),
		facts:    storage.NewFactRepo(db),
		chunks:   storage.NewChunkRepo(db),
	}
}

// ProcessSession handles a complete session: parse → segment → embed → enqueue enrichment.
func (p *Pipeline) ProcessSession(ctx context.Context, sessionID, orgID string) error {
	slog.Info("Processing session", "sessionId", sessionID)

	// 1. Load raw session from S3
	key := fmt.Sprintf("sessions/%s/%s.json", orgID, sessionID)
	data, err := p.objects.Get(ctx, key)
	if err != nil {
		return fmt.Errorf("load raw session: %w", err)
	}

	// 2. Parse messages
	var session struct {
		Messages []models.Message `json:"messages"`
		Metadata json.RawMessage  `json:"metadata"`
	}
	if err := json.Unmarshal(data, &session); err != nil {
		return fmt.Errorf("parse session: %w", err)
	}

	// 3. Segment into chunks
	chunks := p.segment(session.Messages, sessionID, orgID)
	slog.Info("Segmented", "sessionId", sessionID, "chunks", len(chunks))

	// 4. Embed each chunk
	texts := make([]string, len(chunks))
	for i, c := range chunks {
		texts[i] = c.Title + "\n" + c.Summary + "\n" + c.Content
	}
	embeddings, err := p.embedder.EmbedBatch(ctx, texts)
	if err != nil {
		slog.Warn("Embedding failed, continuing without vectors", "error", err)
	}

	// 5. Store chunks in DB
	for i := range chunks {
		if i < len(embeddings) {
			chunks[i].Embedding = embeddings[i]
		}
		if err := p.storeChunk(ctx, &chunks[i]); err != nil {
			slog.Error("Store chunk failed", "chunkId", chunks[i].ID, "error", err)
		}
	}

	// 6. Enqueue enrichment jobs (facts, knowledge, dedup, graph, index)
	for _, chunk := range chunks {
		for _, jobType := range []string{"facts", "knowledge", "dedup", "graph", "index"} {
			job := Job{Type: jobType, ChunkID: chunk.ID, OrganizationID: orgID}
			data, _ := json.Marshal(job)
			p.cache.Enqueue(ctx, "synapse:"+jobType, data)
		}
	}

	// 7. Update session status
	p.db.Exec(ctx, `UPDATE sessions SET searchable_status = 'searchable', updated_at = NOW() WHERE id = $1`, sessionID)

	return nil
}

// ExtractFacts extracts atomic facts from a chunk using heuristic patterns.
func (p *Pipeline) ExtractFacts(ctx context.Context, chunkID, orgID string) error {
	// Load chunk content
	var content, authorID, repository, language string
	var sessionID *string
	err := p.db.QueryRow(ctx, `
		SELECT content, author_id, repository, language, session_id
		FROM chunks WHERE id = $1`, chunkID,
	).Scan(&content, &authorID, &repository, &language, &sessionID)
	if err != nil {
		return err
	}

	// Heuristic fact extraction
	facts := extractFactsHeuristic(content)

	for _, f := range facts {
		fact := &models.Fact{
			ID:             uuid.New().String(),
			Content:        f.content,
			Type:           f.factType,
			Entities:       f.entities,
			ExtractedFrom:  f.source,
			AuthorID:       authorID,
			OrganizationID: orgID,
			Scope:          "organization",
			Confidence:     0.7,
			Repository:     repository,
			Language:       language,
			SourceChunkID:  &chunkID,
			SourceSessionID: sessionID,
		}

		// Embed the fact
		embedding, err := p.embedder.Embed(ctx, fact.Content)
		if err == nil {
			fact.Embedding = embedding
			fact.EmbeddingModel = p.embedder.Model()
		}

		p.facts.Create(ctx, fact)
	}

	slog.Debug("Facts extracted", "chunkId", chunkID, "count", len(facts))
	return nil
}

// ExtractKnowledge extracts structured knowledge records (stub).
func (p *Pipeline) ExtractKnowledge(ctx context.Context, chunkID string) error {
	// TODO: LLM-based structured extraction (problem/solution, architecture decisions)
	return nil
}

// Deduplicate checks a chunk against existing chunks for duplicates.
func (p *Pipeline) Deduplicate(ctx context.Context, chunkID, orgID string) error {
	// TODO: Use Rust MinHash for fingerprinting + cosine check
	// For now, skip (dedup happens at query time via RRF)
	return nil
}

// IndexGraph updates the knowledge graph with chunk entities.
func (p *Pipeline) IndexGraph(ctx context.Context, chunkID string) error {
	// TODO: Extract entities from chunk, create graph nodes/edges
	return nil
}

// IndexSearch ensures the chunk appears in the search index.
func (p *Pipeline) IndexSearch(ctx context.Context, chunkID string) error {
	return p.db.Exec(ctx, `
		INSERT INTO search_index_entries (chunk_id, organization_id, is_searchable, indexed_at)
		SELECT id, organization_id, true, NOW() FROM chunks WHERE id = $1
		ON CONFLICT (chunk_id) DO UPDATE SET is_searchable = true, indexed_at = NOW()
	`, chunkID)
}

// ─── Segmentation ────────────────────────────────────────────────────────────

type chunk struct {
	ID             string
	SessionID      string
	OrganizationID string
	Title          string
	Summary        string
	Content        string
	TokenCount     int
	Type           string
	AuthorID       string
	Embedding      []float64
}

func (p *Pipeline) segment(messages []models.Message, sessionID, orgID string) []chunk {
	if len(messages) == 0 {
		return nil
	}

	// Simple segmentation: group consecutive messages into ~800-1200 token chunks
	var chunks []chunk
	var current strings.Builder
	tokenCount := 0
	chunkIndex := 0

	for _, msg := range messages {
		line := fmt.Sprintf("%s: %s\n", strings.ToUpper(msg.Role), msg.Content)
		lineTokens := len(msg.Content) / 4

		if tokenCount+lineTokens > 1200 && tokenCount > 200 {
			// Flush current chunk
			chunks = append(chunks, p.buildChunk(current.String(), tokenCount, sessionID, orgID, chunkIndex))
			current.Reset()
			tokenCount = 0
			chunkIndex++
		}

		current.WriteString(line)
		tokenCount += lineTokens
	}

	// Flush remaining
	if current.Len() > 0 {
		chunks = append(chunks, p.buildChunk(current.String(), tokenCount, sessionID, orgID, chunkIndex))
	}

	return chunks
}

func (p *Pipeline) buildChunk(content string, tokens int, sessionID, orgID string, index int) chunk {
	title := extractTitle(content)
	summary := extractSummary(content)

	return chunk{
		ID:             uuid.New().String(),
		SessionID:      sessionID,
		OrganizationID: orgID,
		Title:          title,
		Summary:        summary,
		Content:        content,
		TokenCount:     tokens,
		Type:           "discussion",
		AuthorID:       "system", // Will be set from session metadata
	}
}

func (p *Pipeline) storeChunk(ctx context.Context, c *chunk) error {
	var embStr *string
	if len(c.Embedding) > 0 {
		s := "["
		for i, v := range c.Embedding {
			if i > 0 {
				s += ","
			}
			s += fmt.Sprintf("%f", v)
		}
		s += "]"
		embStr = &s
	}

	return p.db.Exec(ctx, `
		INSERT INTO chunks (id, session_id, title, summary, content, token_count, type,
			author_id, organization_id, embedding, embedding_model, embedding_version,
			searchable_status, confidence, quality_score, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11,1,'searchable','high',0.5,NOW(),NOW())
		ON CONFLICT DO NOTHING`,
		c.ID, c.SessionID, c.Title, c.Summary, c.Content, c.TokenCount, c.Type,
		c.AuthorID, c.OrganizationID, embStr, "synapse-local-1536",
	)
}

// ─── Fact Extraction (Heuristic) ─────────────────────────────────────────────

type rawFact struct {
	content  string
	factType string
	entities []string
	source   string
}

func extractFactsHeuristic(content string) []rawFact {
	var facts []rawFact
	lines := strings.Split(content, "\n")

	for _, line := range lines {
		cleaned := strings.TrimSpace(line)
		if len(cleaned) < 20 || len(cleaned) > 300 {
			continue
		}
		lower := strings.ToLower(cleaned)

		source := "both"
		if strings.HasPrefix(cleaned, "ASSISTANT:") {
			source = "assistant"
			cleaned = strings.TrimPrefix(cleaned, "ASSISTANT: ")
		} else if strings.HasPrefix(cleaned, "USER:") {
			source = "user"
			cleaned = strings.TrimPrefix(cleaned, "USER: ")
		}

		var factType string
		switch {
		case containsAny(lower, "decided", "chose", "going with", "switched to", "migrated to"):
			factType = "decision"
		case containsAny(lower, "root cause", "the issue was", "turned out", "the fix is", "problem was"):
			factType = "lesson"
		case containsAny(lower, "always", "never", "best practice", "recommend", "should use", "avoid"):
			factType = "pattern"
		case containsAny(lower, "maximum", "limit", "timeout", "must be", "cannot exceed") && containsDigit(lower):
			factType = "constraint"
		case containsAny(lower, "better than", "preferred over", "i think", "we believe"):
			factType = "opinion"
		default:
			continue
		}

		entities := extractEntities(cleaned)
		facts = append(facts, rawFact{
			content:  cleaned[:min(200, len(cleaned))],
			factType: factType,
			entities: entities,
			source:   source,
		})
	}

	if len(facts) > 8 {
		facts = facts[:8]
	}
	return facts
}

func extractEntities(text string) []string {
	techTerms := []string{
		"AWS", "S3", "EC2", "Lambda", "DynamoDB", "Kafka", "Redis", "PostgreSQL",
		"MongoDB", "Docker", "Kubernetes", "React", "TypeScript", "Python", "Go",
		"Rust", "GraphQL", "Terraform", "CloudFront", "VPC", "ECS", "SQS",
	}
	var found []string
	upper := strings.ToUpper(text)
	for _, term := range techTerms {
		if strings.Contains(upper, strings.ToUpper(term)) {
			found = append(found, term)
		}
	}
	if len(found) > 6 {
		found = found[:6]
	}
	return found
}

func extractTitle(content string) string {
	lines := strings.SplitN(content, "\n", 3)
	if len(lines) > 0 {
		title := strings.TrimPrefix(lines[0], "USER: ")
		title = strings.TrimPrefix(title, "ASSISTANT: ")
		if len(title) > 80 {
			title = title[:80] + "..."
		}
		return title
	}
	return "Untitled chunk"
}

func extractSummary(content string) string {
	if len(content) > 200 {
		return content[:200] + "..."
	}
	return content
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func containsAny(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func containsDigit(s string) bool {
	for _, c := range s {
		if c >= '0' && c <= '9' {
			return true
		}
	}
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
