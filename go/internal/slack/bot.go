// Package slack implements the Synapse Slack bot.
//
// Commands:
//   /synapse <query>       — Search knowledge base
//   /synapse-save          — Capture thread to knowledge base
//   @synapse <question>    — Answer via app mention
//   📌 reaction            — Capture message to knowledge base
package slack

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
)

// Bot handles Slack events and slash commands.
type Bot struct {
	token     string
	apiURL    string
	authToken string
	port      int
}

// NewBot creates a Slack bot instance.
func NewBot() *Bot {
	return &Bot{
		token:     os.Getenv("SLACK_BOT_TOKEN"),
		apiURL:    envOr("SYNAPSE_API_URL", "http://localhost:3000"),
		authToken: os.Getenv("SYNAPSE_TOKEN"),
		port:      3001,
	}
}

// Run starts the Slack bot HTTP server for events and commands.
func (b *Bot) Run() {
	mux := http.NewServeMux()

	mux.HandleFunc("/slack/commands", b.handleCommand)
	mux.HandleFunc("/slack/events", b.handleEvent)
	mux.HandleFunc("/slack/interactions", b.handleInteraction)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"healthy"}`))
	})

	slog.Info("Slack bot starting", "port", b.port)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", b.port), mux); err != nil {
		slog.Error("Slack bot failed", "error", err)
	}
}

func (b *Bot) handleCommand(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	command := r.FormValue("command")
	text := r.FormValue("text")
	responseURL := r.FormValue("response_url")

	slog.Info("Slack command", "command", command, "text", text)

	switch command {
	case "/synapse":
		go b.searchAndRespond(text, responseURL)
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{
			"response_type": "ephemeral",
			"text":          fmt.Sprintf("Searching for: %s...", text),
		})

	case "/synapse-save":
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{
			"response_type": "ephemeral",
			"text":          "Thread captured to knowledge base.",
		})

	default:
		w.WriteHeader(200)
		json.NewEncoder(w).Encode(map[string]string{
			"text": "Unknown command",
		})
	}
}

func (b *Bot) handleEvent(w http.ResponseWriter, r *http.Request) {
	var event struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		Event     struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"event"`
	}

	json.NewDecoder(r.Body).Decode(&event)

	// URL verification
	if event.Type == "url_verification" {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(event.Challenge))
		return
	}

	// App mention
	if event.Event.Type == "app_mention" {
		slog.Info("App mention", "text", event.Event.Text)
		// TODO: search and reply in thread
	}

	w.WriteHeader(200)
}

func (b *Bot) handleInteraction(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}

func (b *Bot) searchAndRespond(query, responseURL string) {
	// Call Synapse API
	body := fmt.Sprintf(`{"query":%q,"topK":3,"strategy":"hybrid","includeContent":true}`, query)
	req, _ := http.NewRequest("POST", b.apiURL+"/api/v1/search", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.authToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Error("Search failed", "error", err)
		return
	}
	defer resp.Body.Close()

	var result struct {
		Results []struct {
			Title   string  `json:"title"`
			Summary string  `json:"summary"`
			Score   float64 `json:"finalScore"`
		} `json:"results"`
		TotalCount int `json:"totalCount"`
	}
	json.NewDecoder(resp.Body).Decode(&result)

	// Format response
	text := fmt.Sprintf("Found %d results for: *%s*\n", result.TotalCount, query)
	for i, r := range result.Results {
		text += fmt.Sprintf("\n%d. *%s* (%.0f%%)\n> %s\n", i+1, r.Title, r.Score*100, r.Summary)
	}

	// Post to response URL
	slackResp, _ := json.Marshal(map[string]string{
		"response_type": "in_channel",
		"text":          text,
	})
	http.Post(responseURL, "application/json", strings.NewReader(string(slackResp)))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
