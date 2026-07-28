// Package llm provides a simple LLM client for compaction tasks.
package llm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	provider string
	model    string
	apiKey   string
	client   *http.Client
}

type Response struct {
	Text        string
	InputTokens int
	OutputTokens int
}

func NewClient(provider, model, apiKey string) *Client {
	return &Client{
		provider: provider,
		model:    model,
		apiKey:   apiKey,
		client:   &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) Enabled() bool {
	return c.provider != "" && c.provider != "local-none" && c.apiKey != ""
}

func (c *Client) Generate(system, user string) (*Response, error) {
	if !c.Enabled() {
		return nil, fmt.Errorf("LLM disabled")
	}

	switch c.provider {
	case "openai":
		return c.callOpenAI(system, user)
	case "claude":
		return c.callClaude(system, user)
	default:
		return nil, fmt.Errorf("unsupported provider: %s", c.provider)
	}
}

func (c *Client) callOpenAI(system, user string) (*Response, error) {
	body := map[string]any{
		"model":      c.model,
		"max_tokens": 1024,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	}
	data, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("OpenAI %d: %s", resp.StatusCode, string(respBody[:min(200, len(respBody))]))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	json.Unmarshal(respBody, &result)

	text := ""
	if len(result.Choices) > 0 {
		text = result.Choices[0].Message.Content
	}
	return &Response{Text: text, InputTokens: result.Usage.PromptTokens, OutputTokens: result.Usage.CompletionTokens}, nil
}

func (c *Client) callClaude(system, user string) (*Response, error) {
	body := map[string]any{
		"model":      c.model,
		"max_tokens": 1024,
		"system":     system,
		"messages":   []map[string]string{{"role": "user", "content": user}},
	}
	data, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Claude %d: %s", resp.StatusCode, string(respBody[:min(200, len(respBody))]))
	}

	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	json.Unmarshal(respBody, &result)

	text := ""
	if len(result.Content) > 0 {
		text = result.Content[0].Text
	}
	return &Response{Text: text, InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens}, nil
}

// CheckContradiction asks the LLM if two facts contradict each other.
func (c *Client) CheckContradiction(factA, factB string) (bool, error) {
	system := `You detect whether two technical facts contradict each other.
Respond with exactly one word: CONTRADICTS or COMPATIBLE`
	user := fmt.Sprintf("Fact A: \"%s\"\nFact B: \"%s\"", factA, factB)

	resp, err := c.Generate(system, user)
	if err != nil {
		return false, err
	}
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(resp.Text)), "CONTRADICT"), nil
}

// AssessEvidence determines the relationship between an opinion and new evidence.
func (c *Client) AssessEvidence(opinion, evidence string) (string, error) {
	system := `You evaluate whether evidence supports, weakens, contradicts, or is neutral to an opinion.
Respond with exactly one word: REINFORCE, WEAKEN, CONTRADICT, or NEUTRAL`
	user := fmt.Sprintf("OPINION: \"%s\"\nEVIDENCE: \"%s\"", opinion, evidence)

	resp, err := c.Generate(system, user)
	if err != nil {
		return "neutral", err
	}

	text := strings.ToUpper(strings.TrimSpace(resp.Text))
	switch {
	case strings.HasPrefix(text, "REINFORCE"):
		return "reinforce", nil
	case strings.HasPrefix(text, "WEAKEN"):
		return "weaken", nil
	case strings.HasPrefix(text, "CONTRADICT"):
		return "contradict", nil
	default:
		return "neutral", nil
	}
}
