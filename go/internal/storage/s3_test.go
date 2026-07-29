package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestSignStructure checks the Authorization header shape without needing a
// live endpoint: the algorithm, credential scope, and signed header list must
// match what S3 expects.
func TestSignStructure(t *testing.T) {
	s := NewObjectStore("http://localhost:9000", "synapse-raw", "us-east-1", "AKID", "SECRET")

	payload := []byte(`{"hello":"world"}`)
	req, err := http.NewRequest(http.MethodPut, s.objectURL("sessions/default/abc.json"), nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	s.sign(req, payload)

	auth := req.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 ") {
		t.Errorf("expected SigV4 algorithm prefix, got %q", auth)
	}
	if !strings.Contains(auth, "Credential=AKID/") {
		t.Errorf("expected access key in credential, got %q", auth)
	}
	if !strings.Contains(auth, "/us-east-1/s3/aws4_request") {
		t.Errorf("expected region/service scope, got %q", auth)
	}
	// Signed headers must be sorted and include the mandatory three plus
	// content-type, which was set on the request.
	if !strings.Contains(auth, "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date") {
		t.Errorf("unexpected signed header list: %q", auth)
	}
	if req.Header.Get("X-Amz-Date") == "" {
		t.Error("X-Amz-Date not set")
	}
	// Payload hash must be the SHA-256 of the body, not the empty-body hash.
	if got := req.Header.Get("X-Amz-Content-Sha256"); got == emptyPayloadHash {
		t.Error("payload hash was not computed from the body")
	}
}

// TestSignEmptyPayload verifies the well-known SHA-256 of an empty body is used
// for bodyless requests such as GET and HEAD.
func TestSignEmptyPayload(t *testing.T) {
	s := NewObjectStore("http://localhost:9000", "b", "us-east-1", "AKID", "SECRET")
	req, _ := http.NewRequest(http.MethodGet, s.objectURL("k"), nil)
	s.sign(req, nil)

	if got := req.Header.Get("X-Amz-Content-Sha256"); got != emptyPayloadHash {
		t.Errorf("expected empty payload hash, got %q", got)
	}
	// Without a Content-Type there should be no content-type in SignedHeaders.
	if strings.Contains(req.Header.Get("Authorization"), "content-type") {
		t.Error("content-type should not be signed when absent")
	}
}

func TestObjectURLEscaping(t *testing.T) {
	s := NewObjectStore("http://localhost:9000/", "synapse-raw", "us-east-1", "a", "b")

	cases := map[string]string{
		"sessions/default/abc.json": "http://localhost:9000/synapse-raw/sessions/default/abc.json",
		"/leading/slash.json":       "http://localhost:9000/synapse-raw/leading/slash.json",
		"has space/file.json":       "http://localhost:9000/synapse-raw/has%20space/file.json",
	}
	for key, want := range cases {
		if got := s.objectURL(key); got != want {
			t.Errorf("objectURL(%q) = %q, want %q", key, got, want)
		}
	}
}

// TestObjectStoreIntegration exercises the real round trip against an
// S3-compatible endpoint. Skipped unless S3_ENDPOINT is set, so unit runs stay
// hermetic.
func TestObjectStoreIntegration(t *testing.T) {
	endpoint := os.Getenv("S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_ENDPOINT not set; skipping integration test")
	}

	store := NewObjectStore(
		endpoint,
		envOrDefault("S3_BUCKET", "synapse-raw"),
		envOrDefault("S3_REGION", "us-east-1"),
		envOrDefault("AWS_ACCESS_KEY_ID", "minioadmin"),
		envOrDefault("AWS_SECRET_ACCESS_KEY", "minioadmin"),
	)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := store.EnsureBucket(ctx); err != nil {
		t.Fatalf("EnsureBucket: %v", err)
	}
	if !store.Healthy(ctx) {
		t.Fatal("Healthy() returned false against a live endpoint")
	}

	key := fmt.Sprintf("selftest/%d.json", time.Now().UnixNano())
	original := map[string]any{
		"messages": []map[string]string{
			{"role": "user", "content": "does the raw session actually persist?"},
			{"role": "assistant", "content": "verified by reading it back byte for byte"},
		},
	}
	body, _ := json.Marshal(original)

	if err := store.Put(ctx, key, body, "application/json"); err != nil {
		t.Fatalf("Put: %v", err)
	}

	exists, err := store.Exists(ctx, key)
	if err != nil {
		t.Fatalf("Exists: %v", err)
	}
	if !exists {
		t.Fatal("object reported missing immediately after a successful Put")
	}

	got, err := store.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got) != string(body) {
		t.Errorf("round trip mismatch:\n got: %s\nwant: %s", got, body)
	}

	// A key that was never written must report absent rather than erroring.
	missing, err := store.Exists(ctx, "selftest/definitely-not-here.json")
	if err != nil {
		t.Fatalf("Exists(missing): %v", err)
	}
	if missing {
		t.Error("Exists returned true for a key that was never written")
	}

	if _, err := store.Get(ctx, "selftest/definitely-not-here.json"); err == nil {
		t.Error("Get of a missing key should return an error")
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
