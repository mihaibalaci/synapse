// Package cli implements the Synapse command-line interface.
//
// Commands:
//   synapse search <query>        Search the knowledge base
//   synapse facts [--entity X]    Query atomic facts
//   synapse history <entity>      View temporal evolution
//   synapse reflect <query>       Deep reasoning over memories
//   synapse insight <text>        Store a quick insight
//   synapse status                Check system health
package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
)

var (
	apiURL = envOr("SYNAPSE_API_URL", "http://localhost:3000")
	token  = os.Getenv("SYNAPSE_TOKEN")
)

// Run executes the CLI with the given arguments.
func Run(args []string) {
	if len(args) == 0 {
		printUsage()
		return
	}

	switch args[0] {
	case "search":
		if len(args) < 2 {
			fmt.Println("Usage: synapse search <query>")
			return
		}
		query := strings.Join(args[1:], " ")
		cmdSearch(query)

	case "facts":
		entity := ""
		for i, arg := range args[1:] {
			if arg == "--entity" && i+1 < len(args[1:]) {
				entity = args[i+2]
			}
		}
		cmdFacts(entity)

	case "history":
		if len(args) < 2 {
			fmt.Println("Usage: synapse history <entity>")
			return
		}
		cmdHistory(args[1])

	case "reflect":
		if len(args) < 2 {
			fmt.Println("Usage: synapse reflect <query>")
			return
		}
		query := strings.Join(args[1:], " ")
		cmdReflect(query)

	case "insight":
		if len(args) < 2 {
			fmt.Println("Usage: synapse insight <text> [--type decision|lesson|pattern]")
			return
		}
		text := strings.Join(args[1:], " ")
		cmdInsight(text)

	case "status":
		cmdStatus()

	default:
		fmt.Printf("Unknown command: %s\n", args[0])
		printUsage()
	}
}

func cmdSearch(query string) {
	body := fmt.Sprintf(`{"query":%q,"topK":5,"strategy":"hybrid","includeContent":true}`, query)
	resp := apiPost("/api/v1/search", body)
	if resp == nil {
		return
	}

	results, _ := resp["results"].([]any)
	total, _ := resp["totalCount"].(float64)
	latency, _ := resp["latencyMs"].(float64)

	fmt.Printf("Found %d results (%.0fms)\n\n", int(total), latency)
	for i, r := range results {
		item, _ := r.(map[string]any)
		fmt.Printf("%d. %s (score: %.2f)\n", i+1, item["title"], item["finalScore"])
		fmt.Printf("   %s\n\n", item["summary"])
	}
}

func cmdFacts(entity string) {
	path := "/api/v1/facts?limit=10"
	if entity != "" {
		path += "&entities=" + entity
	}
	resp := apiGet(path)
	if resp == nil {
		return
	}

	facts, _ := resp["facts"].([]any)
	fmt.Printf("Facts: %d\n\n", len(facts))
	for _, f := range facts {
		item, _ := f.(map[string]any)
		fmt.Printf("  [%s] %s (confidence: %.2f)\n", item["type"], item["content"], item["confidence"])
	}
}

func cmdHistory(entity string) {
	resp := apiGet("/api/v1/facts/" + entity + "/history")
	if resp == nil {
		return
	}

	history, _ := resp["history"].([]any)
	fmt.Printf("History for %q: %d entries\n\n", entity, len(history))
	for _, h := range history {
		item, _ := h.(map[string]any)
		status := "current"
		if item["validUntil"] != nil {
			status = "superseded"
		}
		fmt.Printf("  [%s] %s\n", status, item["content"])
	}
}

func cmdReflect(query string) {
	body := fmt.Sprintf(`{"query":%q,"maxTokens":6000,"generateObservation":true,"writeBack":true}`, query)
	resp := apiPost("/api/v1/reflect", body)
	if resp == nil {
		return
	}

	fmt.Printf("Confidence: %s\n\n", resp["confidence"])
	fmt.Println(resp["answer"])
}

func cmdInsight(text string) {
	// Parse --type flag
	factType := "lesson"
	if idx := strings.Index(text, "--type "); idx >= 0 {
		parts := strings.SplitN(text[idx+7:], " ", 2)
		factType = parts[0]
		text = strings.TrimSpace(text[:idx])
	}

	body := fmt.Sprintf(`{"messages":[{"role":"user","content":"Record: %s"},{"role":"assistant","content":"%s"}],"source":"cli"}`,
		strings.ReplaceAll(text, `"`, `\"`), strings.ReplaceAll(text, `"`, `\"`))
	resp := apiPost("/api/v1/capture/passive", body)
	if resp == nil {
		return
	}
	fmt.Printf("Insight saved (%s): %s\n", factType, text)
}

func cmdStatus() {
	resp := apiGet("/health/ready")
	if resp == nil {
		fmt.Println("System: UNREACHABLE")
		return
	}

	status, _ := resp["status"].(string)
	checks, _ := resp["checks"].(map[string]any)

	fmt.Printf("System: %s\n", strings.ToUpper(status))
	fmt.Printf("  URL: %s\n", apiURL)
	for name, val := range checks {
		symbol := "✓"
		if val != "ok" {
			symbol = "✗"
		}
		fmt.Printf("  %s %s: %s\n", symbol, name, val)
	}
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

func apiGet(path string) map[string]any {
	req, _ := http.NewRequest("GET", apiURL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	return doRequest(req)
}

func apiPost(path, body string) map[string]any {
	req, _ := http.NewRequest("POST", apiURL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	return doRequest(req)
}

func doRequest(req *http.Request) map[string]any {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		fmt.Fprintf(os.Stderr, "Error: HTTP %d\n", resp.StatusCode)
		return nil
	}

	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result)
	return result
}

func printUsage() {
	fmt.Println(`Synapse CLI — The memory layer that learns

Usage:
  synapse search <query>          Search the knowledge base
  synapse facts [--entity X]      Query atomic facts
  synapse history <entity>        View temporal evolution
  synapse reflect <query>         Deep reasoning over memories
  synapse insight <text>          Store a quick insight
  synapse status                  Check system health

Environment:
  SYNAPSE_API_URL   API endpoint (default: http://localhost:3000)
  SYNAPSE_TOKEN     Bearer token for authentication`)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
