package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mihaibalaci/synapse/internal/auth"
)

// WebhookEvent types
const (
	EventSessionCaptured = "session.captured"
	EventFactCreated     = "fact.created"
	EventFactSuperseded  = "fact.superseded"
	EventChunkArchived   = "chunk.archived"
	EventUserCreated     = "user.created"
	EventUserDisabled    = "user.disabled"
)

// WebhookSubscription represents a registered webhook endpoint.
type WebhookSubscription struct {
	ID             string   `json:"id"`
	URL            string   `json:"url"`
	Events         []string `json:"events"`
	Secret         string   `json:"secret,omitempty"`
	OrganizationID string   `json:"organizationId"`
	Active         bool     `json:"active"`
	CreatedAt      string   `json:"createdAt"`
}

// WebhookRegistry manages webhook subscriptions (stored in system_settings for simplicity).
type WebhookRegistry struct {
	mu    sync.RWMutex
	hooks []WebhookSubscription
}

var webhookRegistry = &WebhookRegistry{}

// Emit sends an event to all registered webhooks matching the event type.
func EmitWebhook(ctx context.Context, orgID, eventType string, payload any) {
	webhookRegistry.mu.RLock()
	defer webhookRegistry.mu.RUnlock()

	for _, hook := range webhookRegistry.hooks {
		if !hook.Active || hook.OrganizationID != orgID {
			continue
		}
		matched := false
		for _, evt := range hook.Events {
			if evt == eventType || evt == "*" {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}

		go deliverWebhook(hook, eventType, payload)
	}
}

func deliverWebhook(hook WebhookSubscription, eventType string, payload any) {
	body, _ := json.Marshal(map[string]any{
		"event":     eventType,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"data":      payload,
	})

	req, err := http.NewRequest(http.MethodPost, hook.URL, bytes.NewReader(body))
	if err != nil {
		slog.Debug("Webhook delivery failed", "url", hook.URL, "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Synapse-Event", eventType)
	if hook.Secret != "" {
		req.Header.Set("X-Synapse-Secret", hook.Secret)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		slog.Debug("Webhook delivery failed", "url", hook.URL, "error", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		slog.Debug("Webhook returned error", "url", hook.URL, "status", resp.StatusCode)
	}
}

// ─── Webhook API Handlers ────────────────────────────────────────────────────

func handleListWebhooks(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	webhookRegistry.mu.RLock()
	defer webhookRegistry.mu.RUnlock()

	var result []WebhookSubscription
	for _, h := range webhookRegistry.hooks {
		if h.OrganizationID == claims.OrganizationID {
			safe := h
			safe.Secret = "" // Don't expose secrets
			result = append(result, safe)
		}
	}
	if result == nil {
		result = []WebhookSubscription{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"webhooks": result, "count": len(result)})
}

func handleCreateWebhook(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	var req struct {
		URL    string   `json:"url"`
		Events []string `json:"events"`
		Secret string   `json:"secret"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.URL == "" || len(req.Events) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "url and events are required")
		return
	}

	hook := WebhookSubscription{
		ID:             fmt.Sprintf("wh_%d", time.Now().UnixNano()),
		URL:            req.URL,
		Events:         req.Events,
		Secret:         req.Secret,
		OrganizationID: claims.OrganizationID,
		Active:         true,
		CreatedAt:      time.Now().Format(time.RFC3339),
	}

	webhookRegistry.mu.Lock()
	webhookRegistry.hooks = append(webhookRegistry.hooks, hook)
	webhookRegistry.mu.Unlock()

	// Persist to settings
	go persistWebhooks(appFromRequest(r))

	safe := hook
	safe.Secret = ""
	writeJSON(w, http.StatusCreated, map[string]any{"webhook": safe})
}

func handleDeleteWebhook(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	hookID := chi.URLParam(r, "id")

	webhookRegistry.mu.Lock()
	var filtered []WebhookSubscription
	found := false
	for _, h := range webhookRegistry.hooks {
		if h.ID == hookID && h.OrganizationID == claims.OrganizationID {
			found = true
			continue
		}
		filtered = append(filtered, h)
	}
	webhookRegistry.hooks = filtered
	webhookRegistry.mu.Unlock()

	if !found {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Webhook not found")
		return
	}

	go persistWebhooks(appFromRequest(r))
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func persistWebhooks(app *App) {
	webhookRegistry.mu.RLock()
	defer webhookRegistry.mu.RUnlock()
	if app.Settings != nil {
		_ = app.Settings.Set(context.Background(), "webhooks", webhookRegistry.hooks, "system")
	}
}

// LoadWebhooks loads persisted webhooks from settings on startup.
func LoadWebhooks(app *App) {
	if app.Settings == nil {
		return
	}
	var hooks []WebhookSubscription
	if found, err := app.Settings.Get(context.Background(), "webhooks", &hooks); err == nil && found {
		webhookRegistry.mu.Lock()
		webhookRegistry.hooks = hooks
		webhookRegistry.mu.Unlock()
	}
}
