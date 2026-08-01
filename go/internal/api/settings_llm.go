package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/mihaibalaci/synapse/internal/auth"
)

// llmSettingsKey is the settings group name for language-model configuration.
const llmSettingsKey = "llm"

// apiKeyMask is returned in place of a stored credential. A client that submits
// this value unchanged is understood to mean "keep the existing key", so the
// real secret never has to travel to the browser and back.
const apiKeyMask = "••••••••"

// LLMSettings is the operator-editable language-model configuration.
//
// This drives synthesis features such as reflect. It is stored in the database
// rather than the environment so it can be changed from the admin UI without a
// redeploy, and so a deployment can point at a different model host without
// rebuilding the binary.
type LLMSettings struct {
	Provider    string  `json:"provider"`    // ollama | openai | anthropic | none
	BaseURL     string  `json:"baseUrl"`     // for self-hosted providers
	Model       string  `json:"model"`       // e.g. qwen2.5-cpu
	APIKey      string  `json:"apiKey"`      // masked on read
	Temperature float64 `json:"temperature"` // 0.0 - 2.0
	MaxTokens   int     `json:"maxTokens"`
	NumThread   int     `json:"numThread"`      // local inference thread count
	TimeoutSecs int     `json:"timeoutSeconds"` // per-request budget
	Enabled     bool    `json:"enabled"`
}

// supportedLLMProviders is the set the backend knows how to talk to.
var supportedLLMProviders = map[string]bool{
	"ollama":    true,
	"openai":    true,
	"anthropic": true,
	"none":      true,
}

// defaultLLMSettings seeds the form before anything has been saved. Values come
// from the environment so an operator sees whatever the process was started
// with rather than a blank form.
func defaultLLMSettings(app *App) LLMSettings {
	provider := app.Config.LLMProvider
	if provider == "" || provider == "local-none" {
		provider = "none"
	}
	return LLMSettings{
		Provider:    provider,
		BaseURL:     envOr("LLM_BASE_URL", "http://localhost:11434"),
		Model:       app.Config.LLMModel,
		Temperature: 0.2, // low: synthesis should stay close to the source material
		MaxTokens:   1024,
		NumThread:   4,
		TimeoutSecs: 120, // CPU inference is slow; a short timeout would always fail
		Enabled:     false,
	}
}

// LoadLLMSettings returns the effective configuration: the saved row if present,
// otherwise the environment-derived defaults.
func LoadLLMSettings(ctx context.Context, app *App) (LLMSettings, error) {
	settings := defaultLLMSettings(app)
	if app.Settings == nil {
		return settings, nil
	}
	if _, err := app.Settings.Get(ctx, llmSettingsKey, &settings); err != nil {
		return settings, err
	}
	return settings, nil
}

// validate normalises the settings and reports why they are unusable, if so.
func (s *LLMSettings) validate() error {
	s.Provider = strings.ToLower(strings.TrimSpace(s.Provider))
	s.BaseURL = strings.TrimRight(strings.TrimSpace(s.BaseURL), "/")
	s.Model = strings.TrimSpace(s.Model)

	if !supportedLLMProviders[s.Provider] {
		return fmt.Errorf("provider must be one of: ollama, openai, anthropic, none")
	}

	// A disabled or absent provider needs no further detail.
	if s.Provider == "none" {
		s.Enabled = false
		return nil
	}
	if s.Model == "" {
		return fmt.Errorf("model is required for provider %q", s.Provider)
	}
	if s.Provider == "ollama" {
		if s.BaseURL == "" {
			return fmt.Errorf("baseUrl is required for ollama")
		}
		if !strings.HasPrefix(s.BaseURL, "http://") && !strings.HasPrefix(s.BaseURL, "https://") {
			return fmt.Errorf("baseUrl must start with http:// or https://")
		}
	}
	if s.Provider == "openai" && s.APIKey == "" {
		return fmt.Errorf("apiKey is required for openai")
	}
	if s.Provider == "anthropic" && s.APIKey == "" {
		return fmt.Errorf("apiKey is required for anthropic")
	}

	if s.Temperature < 0 || s.Temperature > 2 {
		return fmt.Errorf("temperature must be between 0 and 2")
	}
	if s.MaxTokens < 1 || s.MaxTokens > 32000 {
		return fmt.Errorf("maxTokens must be between 1 and 32000")
	}
	if s.NumThread < 0 || s.NumThread > 128 {
		return fmt.Errorf("numThread must be between 0 and 128")
	}
	if s.TimeoutSecs < 1 || s.TimeoutSecs > 900 {
		return fmt.Errorf("timeoutSeconds must be between 1 and 900")
	}
	return nil
}

// redacted returns a copy safe to send to a browser.
func (s LLMSettings) redacted() LLMSettings {
	if s.APIKey != "" {
		s.APIKey = apiKeyMask
	}
	return s
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// handleGetLLMSettings returns the current configuration with the credential
// masked, plus the provider list and audit metadata for the UI.
func handleGetLLMSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := LoadLLMSettings(r.Context(), appFromRequest(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SETTINGS_ERROR", err.Error())
		return
	}

	updatedAt, updatedBy, _ := appFromRequest(r).Settings.Meta(r.Context(), llmSettingsKey)

	writeJSON(w, http.StatusOK, map[string]any{
		"settings":  settings.redacted(),
		"providers": []string{"none", "ollama", "openai", "anthropic"},
		"updatedAt": updatedAt,
		"updatedBy": updatedBy,
		"hasApiKey": settings.APIKey != "",
	})
}

// handlePutLLMSettings validates and persists the configuration.
func handlePutLLMSettings(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "missing claims")
		return
	}

	var incoming LLMSettings
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}

	// The browser only ever sees a mask, so an unchanged field means "keep the
	// stored credential" rather than "set the key to the mask characters".
	if incoming.APIKey == apiKeyMask || incoming.APIKey == "" {
		if existing, err := LoadLLMSettings(r.Context(), appFromRequest(r)); err == nil {
			incoming.APIKey = existing.APIKey
		}
	}

	if err := incoming.validate(); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
		return
	}

	if err := appFromRequest(r).Settings.Set(r.Context(), llmSettingsKey, incoming, claims.UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "SETTINGS_ERROR", err.Error())
		return
	}

	slog.Info("LLM settings updated",
		"provider", incoming.Provider, "model", incoming.Model,
		"baseUrl", incoming.BaseURL, "enabled", incoming.Enabled, "by", claims.UserID)

	writeJSON(w, http.StatusOK, map[string]any{
		"saved":    true,
		"settings": incoming.redacted(),
	})
}

// handleTestLLMSettings probes the configured provider with a real completion so
// the operator gets a definite answer instead of a saved form and a guess.
//
// The settings in the request body are used if supplied, letting the UI test
// before saving. An omitted or masked key falls back to the stored one.
func handleTestLLMSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := LoadLLMSettings(r.Context(), appFromRequest(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SETTINGS_ERROR", err.Error())
		return
	}

	// The body is optional. An empty body, or one that names no provider (such
	// as "{}"), tests whatever is already stored rather than being treated as an
	// override with a blank provider.
	var override LLMSettings
	if body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20)); len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &override); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
			return
		}
		if strings.TrimSpace(override.Provider) != "" {
			if override.APIKey == apiKeyMask || override.APIKey == "" {
				override.APIKey = settings.APIKey
			}
			if err := override.validate(); err != nil {
				writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", err.Error())
				return
			}
			settings = override
		}
	}

	if settings.Provider == "none" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      false,
			"message": "No provider configured; synthesis features stay disabled.",
		})
		return
	}

	start := time.Now()
	reply, err := probeLLM(r.Context(), settings)
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":        false,
			"latencyMs": elapsed,
			"message":   err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"latencyMs": elapsed,
		"model":     settings.Model,
		"reply":     reply,
		"message":   fmt.Sprintf("%s responded in %dms", settings.Model, elapsed),
	})
}

// handleListLLMModels asks a self-hosted provider what it has available, so the
// operator can pick from a list instead of typing a model name exactly.
func handleListLLMModels(w http.ResponseWriter, r *http.Request) {
	settings, err := LoadLLMSettings(r.Context(), appFromRequest(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SETTINGS_ERROR", err.Error())
		return
	}

	// Allow probing a host that has not been saved yet.
	if raw := strings.TrimSpace(r.URL.Query().Get("baseUrl")); raw != "" {
		settings.BaseURL = strings.TrimRight(raw, "/")
	}
	if p := strings.TrimSpace(r.URL.Query().Get("provider")); p != "" {
		settings.Provider = strings.ToLower(p)
	}

	if settings.Provider != "ollama" {
		writeJSON(w, http.StatusOK, map[string]any{
			"models":  []string{},
			"message": "Model discovery is only available for ollama; enter the model name manually.",
		})
		return
	}

	models, err := listOllamaModels(r.Context(), settings.BaseURL)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"models":  []string{},
			"message": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

// ─── Provider probes ─────────────────────────────────────────────────────────

// probeLLM sends a trivial completion and returns the reply.
func probeLLM(ctx context.Context, s LLMSettings) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(s.TimeoutSecs)*time.Second)
	defer cancel()

	switch s.Provider {
	case "ollama":
		return probeOllama(ctx, s)
	case "openai":
		return probeOpenAICompatible(ctx, s, "https://api.openai.com/v1/chat/completions")
	case "anthropic":
		return probeAnthropic(ctx, s)
	default:
		return "", fmt.Errorf("provider %q cannot be tested", s.Provider)
	}
}

const probePrompt = "Reply with the single word: ready"

func probeOllama(ctx context.Context, s LLMSettings) (string, error) {
	// num_thread is sent explicitly because llama.cpp reads the host CPU count
	// inside a container and oversubscribes, which is the difference between a
	// sub-second reply and a timeout.
	body := map[string]any{
		"model":  s.Model,
		"prompt": probePrompt,
		"stream": false,
		"options": map[string]any{
			"temperature": s.Temperature,
			"num_predict": 16,
			"num_thread":  s.NumThread,
		},
	}

	var out struct {
		Response string `json:"response"`
		Error    string `json:"error"`
	}
	if err := postJSON(ctx, s.BaseURL+"/api/generate", nil, body, &out); err != nil {
		return "", err
	}
	if out.Error != "" {
		return "", fmt.Errorf("ollama: %s", out.Error)
	}
	return strings.TrimSpace(out.Response), nil
}

func probeOpenAICompatible(ctx context.Context, s LLMSettings, url string) (string, error) {
	if s.BaseURL != "" && strings.HasPrefix(s.BaseURL, "http") {
		url = s.BaseURL + "/v1/chat/completions"
	}
	body := map[string]any{
		"model":       s.Model,
		"messages":    []map[string]string{{"role": "user", "content": probePrompt}},
		"max_tokens":  16,
		"temperature": s.Temperature,
	}
	headers := map[string]string{"Authorization": "Bearer " + s.APIKey}

	var out struct {
		Choices []struct {
			Message struct{ Content string } `json:"message"`
		} `json:"choices"`
	}
	if err := postJSON(ctx, url, headers, body, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("provider returned no choices")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func probeAnthropic(ctx context.Context, s LLMSettings) (string, error) {
	body := map[string]any{
		"model":      s.Model,
		"max_tokens": 16,
		"messages":   []map[string]string{{"role": "user", "content": probePrompt}},
	}
	headers := map[string]string{
		"x-api-key":         s.APIKey,
		"anthropic-version": "2023-06-01",
	}

	var out struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := postJSON(ctx, "https://api.anthropic.com/v1/messages", headers, body, &out); err != nil {
		return "", err
	}
	if len(out.Content) == 0 {
		return "", fmt.Errorf("provider returned no content")
	}
	return strings.TrimSpace(out.Content[0].Text), nil
}

func listOllamaModels(ctx context.Context, baseURL string) ([]string, error) {
	if baseURL == "" {
		return nil, fmt.Errorf("baseUrl is required to list models")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/tags", nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", baseURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned HTTP %d", baseURL, resp.StatusCode)
	}

	var out struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("could not parse model list: %w", err)
	}

	names := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		names = append(names, m.Name)
	}
	return names, nil
}

// postJSON performs a JSON POST and decodes a 2xx response into out, surfacing
// the response body on failure so the UI can show why a probe was rejected.
func postJSON(ctx context.Context, url string, headers map[string]string, body, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return fmt.Errorf("request to %s failed: %w", url, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("could not read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	return json.Unmarshal(raw, out)
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
