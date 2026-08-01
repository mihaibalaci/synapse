// Package mcp implements the Model Context Protocol server.
//
// MCP uses JSON-RPC 2.0 over stdin/stdout. The server exposes tools
// that AI agents (Claude, Cursor, Kiro, etc.) can call automatically.
//
// Tools:
//   - search_knowledge: Semantic search across org knowledge
//   - get_context: Token-budget-aware context retrieval
//   - get_facts: Query atomic facts by entity/time
//   - get_fact_history: Temporal evolution of an entity
//   - reflect_on_knowledge: Deep reasoning over memories
//   - save_session: Capture AI conversation to knowledge base
//   - save_insight: Store a single atomic fact
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/mihaibalaci/synapse/internal/version"
)

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   *Error `json:"error,omitempty"`
}

type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

type ToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

var tools = []ToolDef{
	{
		Name:        "search_knowledge",
		Description: "Search the engineering knowledge base. Returns relevant chunks from past AI sessions, debugging insights, architecture decisions, and best practices.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":      map[string]string{"type": "string", "description": "Natural language search query"},
				"repository": map[string]string{"type": "string", "description": "Filter by repository"},
				"maxResults": map[string]any{"type": "number", "description": "Max results (1-20)", "default": 5},
			},
			"required": []string{"query"},
		},
	},
	{
		Name:        "get_context",
		Description: "Get relevant context for the current coding task. Token-budget-aware retrieval optimized for AI prompts.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":      map[string]string{"type": "string", "description": "What you need context about"},
				"repository": map[string]string{"type": "string", "description": "Current repository"},
				"maxTokens":  map[string]any{"type": "number", "description": "Token budget", "default": 3000},
			},
			"required": []string{"query"},
		},
	},
	{
		Name:        "get_facts",
		Description: "Query atomic facts from the knowledge base. Facts are concise verified statements like 'Team uses Kafka for event streaming'.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"entities": map[string]any{"type": "array", "items": map[string]string{"type": "string"}, "description": "Entities to search for"},
				"types":    map[string]any{"type": "array", "items": map[string]string{"type": "string"}, "description": "Fact types: decision, lesson, pattern, constraint, opinion"},
				"limit":    map[string]any{"type": "number", "default": 10},
			},
		},
	},
	{
		Name:        "get_fact_history",
		Description: "See how knowledge about an entity evolved over time. Shows temporal chain including superseded facts.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"entity": map[string]string{"type": "string", "description": "Entity to get history for"},
			},
			"required": []string{"entity"},
		},
	},
	{
		Name:        "reflect_on_knowledge",
		Description: "Reflect on a topic by reasoning over organizational memories. Synthesizes a direct answer from multiple facts and decisions.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":       map[string]string{"type": "string", "description": "The question to reflect on"},
				"entityFocus": map[string]string{"type": "string", "description": "Focus on a specific entity"},
				"maxTokens":   map[string]any{"type": "number", "default": 6000},
			},
			"required": []string{"query"},
		},
	},
	{
		Name:        "save_session",
		Description: "Save the current AI conversation to the organizational knowledge base.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"messages":   map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
				"repository": map[string]string{"type": "string"},
				"tags":       map[string]any{"type": "array", "items": map[string]string{"type": "string"}},
			},
			"required": []string{"messages"},
		},
	},
	{
		Name:        "save_insight",
		Description: "Store a single atomic insight/fact to the knowledge base.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"content":  map[string]string{"type": "string", "description": "The fact or insight"},
				"type":     map[string]string{"type": "string", "description": "Type: decision, lesson, pattern, constraint, opinion"},
				"entities": map[string]any{"type": "array", "items": map[string]string{"type": "string"}},
			},
			"required": []string{"content", "type"},
		},
	},
	{
		Name:        "capture_git",
		Description: "Capture a git commit, PR, or code review into the knowledge base. Extracts decisions and patterns from diffs and comments.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"type":       map[string]string{"type": "string", "description": "commit, pr, diff, or review"},
				"repository": map[string]string{"type": "string", "description": "Repository (org/name)"},
				"title":      map[string]string{"type": "string", "description": "Commit message or PR title"},
				"body":       map[string]string{"type": "string", "description": "PR description or commit body"},
				"diff":       map[string]string{"type": "string", "description": "Unified diff content"},
				"branch":     map[string]string{"type": "string", "description": "Branch name"},
				"commitSha":  map[string]string{"type": "string", "description": "Commit SHA"},
			},
			"required": []string{"type", "repository"},
		},
	},
	{
		Name:        "graph_entity",
		Description: "Explore the knowledge graph around an entity. Shows related concepts and how strongly they connect.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"entity": map[string]string{"type": "string", "description": "Entity name to explore"},
			},
			"required": []string{"entity"},
		},
	},
	{
		Name:        "graph_path",
		Description: "Find how two entities are connected through the knowledge graph (up to 4 hops).",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"from": map[string]string{"type": "string", "description": "Starting entity"},
				"to":   map[string]string{"type": "string", "description": "Target entity"},
			},
			"required": []string{"from", "to"},
		},
	},
	{
		Name:        "feedback",
		Description: "Provide feedback on a search result to improve future ranking. Positive (1) boosts, negative (-1) weakens.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"resultId": map[string]string{"type": "string", "description": "The chunk/fact ID to give feedback on"},
				"score":    map[string]any{"type": "number", "description": "1 for good, -1 for bad"},
				"query":    map[string]string{"type": "string", "description": "The original query"},
			},
			"required": []string{"resultId", "score"},
		},
	},
}

// ─── Server ──────────────────────────────────────────────────────────────────

// Server implements the MCP protocol over stdin/stdout.
type Server struct {
	apiURL string
	token  string
	client *http.Client
	reader *bufio.Reader
	writer io.Writer
}

// Run starts the MCP server, reading from stdin and writing to stdout.
func Run(apiURL, token string) {
	s := &Server{
		apiURL: strings.TrimRight(apiURL, "/"),
		token:  token,
		client: &http.Client{Timeout: 30 * time.Second},
		reader: bufio.NewReader(os.Stdin),
		writer: os.Stdout,
	}

	slog.Info("Synapse MCP server started", "apiURL", apiURL)

	for {
		line, err := s.reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				return
			}
			slog.Error("Read error", "error", err)
			return
		}

		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			s.sendError(nil, -32700, "Parse error")
			continue
		}

		s.handleRequest(&req)
	}
}

func (s *Server) handleRequest(req *Request) {
	switch req.Method {
	case "initialize":
		s.sendResult(req.ID, map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "synapse", "version": version.Version},
		})

	case "tools/list":
		s.sendResult(req.ID, map[string]any{"tools": tools})

	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		json.Unmarshal(req.Params, &params)
		result := s.callTool(params.Name, params.Arguments)
		s.sendResult(req.ID, result)

	case "notifications/initialized":
		// Client acknowledged — no response needed

	default:
		s.sendError(req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

func (s *Server) callTool(name string, args map[string]any) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch name {
	case "search_knowledge":
		return s.toolSearch(ctx, args)
	case "get_context":
		return s.toolContext(ctx, args)
	case "get_facts":
		return s.toolFacts(ctx, args)
	case "get_fact_history":
		return s.toolFactHistory(ctx, args)
	case "reflect_on_knowledge":
		return s.toolReflect(ctx, args)
	case "save_session":
		return s.toolSaveSession(ctx, args)
	case "save_insight":
		return s.toolSaveInsight(ctx, args)
	case "capture_git":
		return s.toolCaptureGit(ctx, args)
	case "graph_entity":
		return s.toolGraphEntity(ctx, args)
	case "graph_path":
		return s.toolGraphPath(ctx, args)
	case "feedback":
		return s.toolFeedback(ctx, args)
	default:
		return errorResult(fmt.Sprintf("Unknown tool: %s", name))
	}
}

// ─── Tool implementations ────────────────────────────────────────────────────

func (s *Server) toolSearch(ctx context.Context, args map[string]any) map[string]any {
	query := argString(args, "query")
	if query == "" {
		return errorResult("query is required")
	}

	body := map[string]any{
		"query":          query,
		"topK":           argInt(args, "maxResults", 5),
		"includeContent": true,
	}
	if repo := argString(args, "repository"); repo != "" {
		body["context"] = map[string]any{"repository": repo}
	}

	var resp struct {
		Results []struct {
			Title      string  `json:"title"`
			Summary    string  `json:"summary"`
			Content    string  `json:"content"`
			FinalScore float64 `json:"finalScore"`
			Repository string  `json:"repository"`
			CreatedAt  string  `json:"createdAt"`
		} `json:"results"`
		TotalCount      int   `json:"totalCount"`
		EstimatedTokens int   `json:"estimatedTokens"`
		LatencyMs       int64 `json:"latencyMs"`
		Cached          bool  `json:"cached"`
	}
	if err := s.apiCall(ctx, http.MethodPost, "/api/v1/search", body, &resp); err != nil {
		return errorResult(fmt.Sprintf("Search failed: %v", err))
	}

	if len(resp.Results) == 0 {
		return textResult(fmt.Sprintf("No prior knowledge found for %q.", query))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Found %d relevant memories for %q (%dms%s):\n\n",
		resp.TotalCount, query, resp.LatencyMs, cachedSuffix(resp.Cached))
	for i, r := range resp.Results {
		fmt.Fprintf(&b, "%d. %s\n", i+1, firstNonEmpty(r.Title, "(untitled)"))
		if r.Repository != "" {
			fmt.Fprintf(&b, "   repo: %s\n", r.Repository)
		}
		if r.Summary != "" {
			fmt.Fprintf(&b, "   %s\n", truncate(r.Summary, 300))
		}
		if r.Content != "" {
			fmt.Fprintf(&b, "   %s\n", truncate(r.Content, 600))
		}
		fmt.Fprintf(&b, "   relevance: %.3f | %s\n\n", r.FinalScore, r.CreatedAt)
	}
	return textResult(b.String())
}

func (s *Server) toolContext(ctx context.Context, args map[string]any) map[string]any {
	query := argString(args, "query")
	if query == "" {
		return errorResult("query is required")
	}

	body := map[string]any{
		"query":     query,
		"maxTokens": argInt(args, "maxTokens", 3000),
	}
	if repo := argString(args, "repository"); repo != "" {
		body["context"] = map[string]any{"repository": repo}
	}

	var resp struct {
		Context []struct {
			Title      string `json:"title"`
			Summary    string `json:"summary"`
			Content    string `json:"content"`
			Repository string `json:"repository"`
			CreatedAt  string `json:"createdAt"`
		} `json:"context"`
		ReturnedResults int  `json:"returnedResults"`
		EstimatedTokens int  `json:"estimatedTokens"`
		MaxTokens       int  `json:"maxTokens"`
		Cached          bool `json:"cached"`
	}
	if err := s.apiCall(ctx, http.MethodPost, "/api/v1/context", body, &resp); err != nil {
		return errorResult(fmt.Sprintf("Context retrieval failed: %v", err))
	}

	if len(resp.Context) == 0 {
		return textResult(fmt.Sprintf("No organizational context available for %q.", query))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Organizational context for %q (%d items, ~%d/%d tokens%s):\n\n",
		query, resp.ReturnedResults, resp.EstimatedTokens, resp.MaxTokens, cachedSuffix(resp.Cached))
	for i, c := range resp.Context {
		fmt.Fprintf(&b, "--- %d. %s", i+1, firstNonEmpty(c.Title, "(untitled)"))
		if c.Repository != "" {
			fmt.Fprintf(&b, " [%s]", c.Repository)
		}
		fmt.Fprintf(&b, " ---\n%s\n\n", firstNonEmpty(c.Content, c.Summary))
	}
	return textResult(b.String())
}

func (s *Server) toolFacts(ctx context.Context, args map[string]any) map[string]any {
	params := url.Values{}
	if entities := argStringSlice(args, "entities"); len(entities) > 0 {
		params.Set("entities", strings.Join(entities, ","))
	}
	if types := argStringSlice(args, "types"); len(types) > 0 {
		params.Set("types", strings.Join(types, ","))
	}
	params.Set("limit", strconv.Itoa(argInt(args, "limit", 10)))

	var resp struct {
		Facts []factView `json:"facts"`
		Total int        `json:"total"`
	}
	if err := s.apiCall(ctx, http.MethodGet, "/api/v1/facts?"+params.Encode(), nil, &resp); err != nil {
		return errorResult(fmt.Sprintf("Fact query failed: %v", err))
	}

	if len(resp.Facts) == 0 {
		return textResult("No facts recorded yet for that query.")
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%d known facts:\n\n", resp.Total)
	for _, f := range resp.Facts {
		fmt.Fprintf(&b, "- [%s] %s\n", f.Type, f.Content)
		if len(f.Entities) > 0 {
			fmt.Fprintf(&b, "  entities: %s\n", strings.Join(f.Entities, ", "))
		}
		fmt.Fprintf(&b, "  confidence: %.2f | used %d times\n", f.Confidence, f.UsageCount)
	}
	return textResult(b.String())
}

func (s *Server) toolFactHistory(ctx context.Context, args map[string]any) map[string]any {
	entity := argString(args, "entity")
	if entity == "" {
		return errorResult("entity is required")
	}

	var resp struct {
		Entity  string     `json:"entity"`
		History []factView `json:"history"`
		Total   int        `json:"total"`
	}
	path := "/api/v1/facts/" + url.PathEscape(entity) + "/history"
	if err := s.apiCall(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return errorResult(fmt.Sprintf("History query failed: %v", err))
	}

	if len(resp.History) == 0 {
		return textResult(fmt.Sprintf("No recorded history for %q.", entity))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "How knowledge about %q evolved (%d entries, oldest first):\n\n", entity, resp.Total)
	for i, f := range resp.History {
		state := "current"
		if f.ValidUntil != nil {
			state = "superseded"
		}
		fmt.Fprintf(&b, "%d. [%s | %s] %s\n", i+1, f.Type, state, f.Content)
		if f.ValidFrom != nil {
			fmt.Fprintf(&b, "   from: %s\n", *f.ValidFrom)
		}
		if f.ValidUntil != nil {
			fmt.Fprintf(&b, "   until: %s\n", *f.ValidUntil)
		}
	}
	return textResult(b.String())
}

// toolReflect uses the LLM-powered reflect endpoint to synthesize answers.
func (s *Server) toolReflect(ctx context.Context, args map[string]any) map[string]any {
	query := argString(args, "query")
	if query == "" {
		return errorResult("query is required")
	}

	body := map[string]any{"query": query, "writeBack": false, "maxFacts": 3}

	var resp struct {
		Answer     string   `json:"answer"`
		Confidence string   `json:"confidence"`
		Reasoning  string   `json:"reasoning"`
		Sources    []string `json:"sources"`
		Insights   []struct {
			Content string `json:"content"`
			Type    string `json:"type"`
		} `json:"insights"`
	}
	if err := s.apiCall(ctx, http.MethodPost, "/api/v1/reflect", body, &resp); err != nil {
		return errorResult(fmt.Sprintf("Reflect failed: %v", err))
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\nConfidence: %s\n", resp.Answer, resp.Confidence)
	if resp.Reasoning != "" {
		fmt.Fprintf(&b, "Reasoning: %s\n", resp.Reasoning)
	}
	if len(resp.Sources) > 0 {
		fmt.Fprintf(&b, "Sources: %d chunks referenced\n", len(resp.Sources))
	}
	return textResult(b.String())
}

func (s *Server) toolSaveSession(ctx context.Context, args map[string]any) map[string]any {
	rawMessages, ok := args["messages"].([]any)
	if !ok || len(rawMessages) < 2 {
		return errorResult("messages must be an array of at least 2 {role, content} objects")
	}

	messages := make([]map[string]string, 0, len(rawMessages))
	for _, rm := range rawMessages {
		m, ok := rm.(map[string]any)
		if !ok {
			continue
		}
		role := argString(m, "role")
		content := argString(m, "content")
		if role == "" || content == "" {
			continue
		}
		messages = append(messages, map[string]string{"role": role, "content": content})
	}
	if len(messages) < 2 {
		return errorResult("at least 2 messages with non-empty role and content are required")
	}

	body := map[string]any{
		"messages":   messages,
		"source":     "mcp",
		"repository": argString(args, "repository"),
	}
	if tags := argStringSlice(args, "tags"); len(tags) > 0 {
		body["tags"] = tags
	}

	var resp struct {
		SessionID string `json:"sessionId"`
		Status    string `json:"status"`
		Message   string `json:"message"`
	}
	if err := s.apiCall(ctx, http.MethodPost, "/api/v1/capture/active", body, &resp); err != nil {
		return errorResult(fmt.Sprintf("Save failed: %v", err))
	}

	return textResult(fmt.Sprintf(
		"Session saved to the knowledge base (%d messages).\nsessionId: %s\nstatus: %s",
		len(messages), resp.SessionID, firstNonEmpty(resp.Status, "captured")))
}

func (s *Server) toolSaveInsight(ctx context.Context, args map[string]any) map[string]any {
	content := argString(args, "content")
	factType := argString(args, "type")
	if content == "" || factType == "" {
		return errorResult("content and type are required")
	}

	body := map[string]any{
		"content":  content,
		"type":     factType,
		"entities": argStringSlice(args, "entities"),
	}
	if repo := argString(args, "repository"); repo != "" {
		body["repository"] = repo
	}

	var resp struct {
		Saved bool     `json:"saved"`
		Fact  factView `json:"fact"`
	}
	if err := s.apiCall(ctx, http.MethodPost, "/api/v1/facts", body, &resp); err != nil {
		return errorResult(fmt.Sprintf("Save failed: %v", err))
	}

	return textResult(fmt.Sprintf("Insight saved as a %q fact.\nid: %s\ncontent: %s",
		factType, resp.Fact.ID, content))
}

func (s *Server) toolCaptureGit(ctx context.Context, args map[string]any) map[string]any {
	gitType := argString(args, "type")
	repo := argString(args, "repository")
	if gitType == "" || repo == "" {
		return errorResult("type and repository are required")
	}

	body := map[string]any{
		"type":       gitType,
		"repository": repo,
		"title":      argString(args, "title"),
		"body":       argString(args, "body"),
		"diff":       argString(args, "diff"),
		"branch":     argString(args, "branch"),
		"commitSha":  argString(args, "commitSha"),
	}

	var resp struct {
		SessionID string `json:"sessionId"`
		Type      string `json:"type"`
	}
	if err := s.apiCall(ctx, http.MethodPost, "/api/v1/capture/git", body, &resp); err != nil {
		return errorResult(fmt.Sprintf("Git capture failed: %v", err))
	}
	return textResult(fmt.Sprintf("Git %s captured.\nsessionId: %s\nrepository: %s", gitType, resp.SessionID, repo))
}

func (s *Server) toolGraphEntity(ctx context.Context, args map[string]any) map[string]any {
	entity := argString(args, "entity")
	if entity == "" {
		return errorResult("entity is required")
	}

	var resp struct {
		Entity string `json:"entity"`
		Edges  []struct {
			Neighbor string  `json:"neighbor"`
			Relation string  `json:"relation"`
			Weight   float64 `json:"weight"`
		} `json:"edges"`
		Count int `json:"count"`
	}
	path := "/api/v1/admin/graph/entity/" + url.PathEscape(entity)
	if err := s.apiCall(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return errorResult(fmt.Sprintf("Graph query failed: %v", err))
	}
	if resp.Count == 0 {
		return textResult(fmt.Sprintf("Entity %q has no connections in the knowledge graph.", entity))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Knowledge graph for %q (%d connections):\n\n", entity, resp.Count)
	for _, e := range resp.Edges {
		fmt.Fprintf(&b, "  → %s (%s, weight: %.0f)\n", e.Neighbor, e.Relation, e.Weight)
	}
	return textResult(b.String())
}

func (s *Server) toolGraphPath(ctx context.Context, args map[string]any) map[string]any {
	from := argString(args, "from")
	to := argString(args, "to")
	if from == "" || to == "" {
		return errorResult("from and to are required")
	}

	var resp struct {
		Paths [][]string `json:"paths"`
		Count int        `json:"count"`
	}
	path := "/api/v1/admin/graph/path?from=" + url.QueryEscape(from) + "&to=" + url.QueryEscape(to)
	if err := s.apiCall(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return errorResult(fmt.Sprintf("Path query failed: %v", err))
	}
	if resp.Count == 0 {
		return textResult(fmt.Sprintf("No path found between %q and %q (within 4 hops).", from, to))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Paths from %q to %q:\n", from, to)
	for i, p := range resp.Paths {
		fmt.Fprintf(&b, "  %d. %s\n", i+1, strings.Join(p, " → "))
	}
	return textResult(b.String())
}

func (s *Server) toolFeedback(ctx context.Context, args map[string]any) map[string]any {
	resultID := argString(args, "resultId")
	score := argInt(args, "score", 0)
	if resultID == "" {
		return errorResult("resultId is required")
	}
	body := map[string]any{"resultId": resultID, "score": score, "query": argString(args, "query")}
	var resp struct {
		Received bool `json:"received"`
	}
	if err := s.apiCall(ctx, http.MethodPost, "/api/v1/feedback", body, &resp); err != nil {
		return errorResult(fmt.Sprintf("Feedback failed: %v", err))
	}
	direction := "positive"
	if score < 0 {
		direction = "negative"
	}
	return textResult(fmt.Sprintf("Feedback recorded (%s) for result %s.", direction, resultID))
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

// factView mirrors the API's fact JSON for the fields the tools render.
type factView struct {
	ID         string   `json:"id"`
	Content    string   `json:"content"`
	Type       string   `json:"type"`
	Entities   []string `json:"entities"`
	Confidence float64  `json:"confidence"`
	UsageCount int      `json:"usageCount"`
	ValidFrom  *string  `json:"validFrom,omitempty"`
	ValidUntil *string  `json:"validUntil,omitempty"`
}

// apiCall performs an authenticated request against the Synapse API and decodes
// the JSON response into out, which may be nil.
func (s *Server) apiCall(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, s.apiURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("request to %s: %w", s.apiURL+path, err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return fmt.Errorf("API returned %d: %s", resp.StatusCode, truncate(string(payload), 300))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

// ─── Result and argument helpers ─────────────────────────────────────────────

func textResult(text string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
	}
}

func errorResult(text string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": true,
	}
}

func argString(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// argInt reads a numeric argument. JSON numbers decode as float64, but the
// other plausible shapes are accepted so a client sending an int or a string
// still works.
func argInt(args map[string]any, key string, fallback int) int {
	switch v := args[key].(type) {
	case float64:
		if v > 0 {
			return int(v)
		}
	case int:
		if v > 0 {
			return v
		}
	case string:
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func argStringSlice(args map[string]any, key string) []string {
	raw, ok := args[key].([]any)
	if !ok {
		if single := argString(args, key); single != "" {
			return []string{single}
		}
		return []string{}
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func cachedSuffix(cached bool) string {
	if cached {
		return ", cached"
	}
	return ""
}

func (s *Server) sendResult(id any, result any) {
	resp := Response{JSONRPC: "2.0", ID: id, Result: result}
	data, _ := json.Marshal(resp)
	fmt.Fprintf(s.writer, "%s\n", data)
}

func (s *Server) sendError(id any, code int, message string) {
	resp := Response{JSONRPC: "2.0", ID: id, Error: &Error{Code: code, Message: message}}
	data, _ := json.Marshal(resp)
	fmt.Fprintf(s.writer, "%s\n", data)
}
