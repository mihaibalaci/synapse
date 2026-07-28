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
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
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
				"query":     map[string]string{"type": "string", "description": "What you need context about"},
				"repository": map[string]string{"type": "string", "description": "Current repository"},
				"maxTokens": map[string]any{"type": "number", "description": "Token budget", "default": 3000},
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
}

// ─── Server ──────────────────────────────────────────────────────────────────

// Server implements the MCP protocol over stdin/stdout.
type Server struct {
	apiURL string
	token  string
	reader *bufio.Reader
	writer io.Writer
}

// Run starts the MCP server, reading from stdin and writing to stdout.
func Run(apiURL, token string) {
	s := &Server{
		apiURL: apiURL,
		token:  token,
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
			"serverInfo":      map[string]any{"name": "synapse", "version": "0.2.0"},
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
	// In production, these would call the API. For now, return stubs.
	ctx := context.Background()
	_ = ctx

	switch name {
	case "search_knowledge":
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": fmt.Sprintf("Searching for: %v", args["query"])},
			},
		}
	case "get_context":
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "No context found yet. The system is ready to capture knowledge."},
			},
		}
	case "get_facts":
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "No facts found matching the query."},
			},
		}
	case "get_fact_history":
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": fmt.Sprintf("No history for entity: %v", args["entity"])},
			},
		}
	case "reflect_on_knowledge":
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "Reflect: not enough memories to synthesize an answer yet."},
			},
		}
	case "save_session":
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "Session saved to knowledge base."},
			},
		}
	case "save_insight":
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": fmt.Sprintf("Insight saved: %v", args["content"])},
			},
		}
	default:
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": fmt.Sprintf("Unknown tool: %s", name)},
			},
			"isError": true,
		}
	}
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
