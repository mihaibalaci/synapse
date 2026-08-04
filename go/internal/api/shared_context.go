package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"github.com/mihaibalaci/synapse/internal/auth"
)

// Feature 4: Cross-agent shared context API.
// Any agent (Claude, Cursor, Codex, MCP) can push context and any other can pull it.
// Deduplication by content hash prevents the same insight from being stored twice.

func handlePutSharedContext(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	var req struct {
		Key     string `json:"key"`
		Content string `json:"content"`
		Agent   string `json:"agent"`
		TTL     int    `json:"ttlMinutes"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON")
		return
	}
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_ERROR", "content is required")
		return
	}
	if req.Key == "" {
		// Auto-generate key from content hash
		hash := sha256.Sum256([]byte(req.Content))
		req.Key = hex.EncodeToString(hash[:8])
	}
	if req.TTL <= 0 {
		req.TTL = 60 // default 1 hour
	}
	if req.Agent == "" {
		req.Agent = "unknown"
	}

	// Dedup: check if same content hash already exists
	contentHash := sha256.Sum256([]byte(req.Content))
	hashHex := hex.EncodeToString(contentHash[:])
	dedupKey := "synapse:shared:" + claims.OrganizationID + ":hash:" + hashHex

	cache := appFromRequest(r).Cache
	ctx := r.Context()

	// Check dedup
	if exists, _ := cache.Client.Exists(ctx, dedupKey).Result(); exists > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"stored": false, "reason": "duplicate", "key": req.Key})
		return
	}

	// Store context
	storeKey := "synapse:shared:" + claims.OrganizationID + ":" + req.Key
	ttl := time.Duration(req.TTL) * time.Minute

	value, _ := json.Marshal(map[string]any{
		"content": req.Content, "agent": req.Agent,
		"userId": claims.UserID, "storedAt": time.Now().UTC().Format(time.RFC3339),
	})
	cache.Client.Set(ctx, storeKey, string(value), ttl)
	cache.Client.Set(ctx, dedupKey, "1", ttl)

	// Also store in a set for listing
	cache.Client.SAdd(ctx, "synapse:shared:"+claims.OrganizationID+":keys", req.Key)
	cache.Client.Expire(ctx, "synapse:shared:"+claims.OrganizationID+":keys", ttl)

	writeJSON(w, http.StatusCreated, map[string]any{"stored": true, "key": req.Key, "ttlMinutes": req.TTL})
}

func handleGetSharedContext(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}

	key := r.URL.Query().Get("key")
	cache := appFromRequest(r).Cache
	ctx := r.Context()

	if key != "" {
		// Get specific key
		storeKey := "synapse:shared:" + claims.OrganizationID + ":" + key
		val, err := cache.Client.Get(ctx, storeKey).Result()
		if err != nil {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Shared context not found or expired")
			return
		}
		var entry map[string]any
		json.Unmarshal([]byte(val), &entry)
		entry["key"] = key
		writeJSON(w, http.StatusOK, entry)
		return
	}

	// List all keys
	keysKey := "synapse:shared:" + claims.OrganizationID + ":keys"
	keys, _ := cache.Client.SMembers(ctx, keysKey).Result()

	var entries []map[string]any
	for _, k := range keys {
		storeKey := "synapse:shared:" + claims.OrganizationID + ":" + k
		val, err := cache.Client.Get(ctx, storeKey).Result()
		if err != nil {
			continue
		}
		var entry map[string]any
		json.Unmarshal([]byte(val), &entry)
		entry["key"] = k
		entries = append(entries, entry)
	}
	if entries == nil {
		entries = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"contexts": entries, "count": len(entries)})
}
