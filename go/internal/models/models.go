// Package models defines the core data types for Synapse.
package models

import "time"

// ─── Session ─────────────────────────────────────────────────────────────────

type Session struct {
	ID               string    `json:"id"`
	ClientID         string    `json:"clientId"`
	DeveloperID      string    `json:"developerId"`
	OrganizationID   string    `json:"organizationId"`
	TeamID           string    `json:"teamId,omitempty"`
	Status           string    `json:"status"`
	SearchableStatus string    `json:"searchableStatus"`
	EnrichmentStatus string    `json:"enrichmentStatus"`
	RawStorageKey    string    `json:"rawStorageKey"`
	TotalTokens      int       `json:"totalTokens"`
	MessageCount     int       `json:"messageCount"`
	Metadata         any       `json:"metadata"`
	StartedAt        time.Time `json:"startedAt"`
	EndedAt          time.Time `json:"endedAt"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// ─── Chunk ───────────────────────────────────────────────────────────────────

type ChunkResult struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Summary      string    `json:"summary"`
	Content      string    `json:"content,omitempty"`
	TokenCount   int       `json:"tokenCount"`
	Type         string    `json:"type"`
	Repository   string    `json:"repository,omitempty"`
	Language     string    `json:"language,omitempty"`
	QualityScore float64   `json:"qualityScore"`
	UsageCount   int       `json:"usageCount"`
	Confidence   string    `json:"confidence"`
	Similarity   float64   `json:"similarity"`
	CreatedAt    time.Time `json:"createdAt"`
}

// ─── Fact ────────────────────────────────────────────────────────────────────

type Fact struct {
	ID              string    `json:"id"`
	Content         string    `json:"content"`
	Type            string    `json:"type"`
	Entities        []string  `json:"entities"`
	Confidence      float64   `json:"confidence"`
	UsageCount      int       `json:"usageCount"`
	ValidFrom       *time.Time `json:"validFrom,omitempty"`
	ValidUntil      *time.Time `json:"validUntil,omitempty"`
	SupersededBy    *string   `json:"supersededBy,omitempty"`
	SourceChunkID   *string   `json:"sourceChunkId,omitempty"`
	SourceSessionID *string   `json:"sourceSessionId,omitempty"`
	ExtractedFrom   string    `json:"extractedFrom"`
	AuthorID        string    `json:"authorId"`
	OrganizationID  string    `json:"organizationId"`
	Scope           string    `json:"scope"`
	Embedding       []float64 `json:"-"`
	EmbeddingModel  string    `json:"-"`
	Repository      string    `json:"repository,omitempty"`
	Language        string    `json:"language,omitempty"`
	Frameworks      []string  `json:"frameworks,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
}

// ─── Search ──────────────────────────────────────────────────────────────────

type SearchRequest struct {
	Query      string            `json:"query"`
	Context    *SearchContext    `json:"context,omitempty"`
	Filters    *SearchFilters    `json:"filters,omitempty"`
	TopK       int               `json:"topK"`
	Offset     int               `json:"offset"`
	MaxTokens  int               `json:"maxTokens,omitempty"`
	Strategy   string            `json:"strategy"`
	IncludeContent bool          `json:"includeContent"`
}

type SearchContext struct {
	Repository string   `json:"repository,omitempty"`
	FilePath   string   `json:"filePath,omitempty"`
	Language   string   `json:"language,omitempty"`
	Frameworks []string `json:"frameworks,omitempty"`
}

type SearchFilters struct {
	Repositories []string `json:"repositories,omitempty"`
	Languages    []string `json:"languages,omitempty"`
	Types        []string `json:"types,omitempty"`
	Teams        []string `json:"teams,omitempty"`
}

type SearchResult struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"`
	Title      string  `json:"title"`
	Summary    string  `json:"summary"`
	Content    string  `json:"content,omitempty"`
	FinalScore float64 `json:"finalScore"`
	Repository string  `json:"repository,omitempty"`
	Language   string  `json:"language,omitempty"`
	CreatedAt  string  `json:"createdAt"`
}

type SearchResponse struct {
	Results         []SearchResult `json:"results"`
	TotalCount      int            `json:"totalCount"`
	Query           string         `json:"query"`
	Strategy        string         `json:"strategy"`
	LatencyMs       int64          `json:"latencyMs"`
	Cached          bool           `json:"cached"`
	EstimatedTokens int            `json:"estimatedTokens"`
	Observations    []Observation  `json:"observations"`
}

// ─── Observation ─────────────────────────────────────────────────────────────

type Observation struct {
	ID              string `json:"id"`
	EntityName      string `json:"entityName"`
	Summary         string `json:"summary"`
	SourceFactCount int    `json:"sourceFactCount"`
	UpdatedAt       string `json:"updatedAt"`
}

// ─── Capture ─────────────────────────────────────────────────────────────────

type CaptureRequest struct {
	Messages []Message `json:"messages"`
	Source   string    `json:"source"`
	Repository string `json:"repository,omitempty"`
	Branch   string    `json:"branch,omitempty"`
	Language string    `json:"language,omitempty"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ─── Feedback ────────────────────────────────────────────────────────────────

type FeedbackEvent struct {
	SearchID  string `json:"searchId"`
	ResultID  string `json:"resultId"`
	Action    string `json:"action"`
	Comment   string `json:"comment,omitempty"`
}
