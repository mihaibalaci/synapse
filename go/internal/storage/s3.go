package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// ObjectStore provides S3-compatible object storage access.
//
// Requests are signed with AWS Signature Version 4, which every S3-compatible
// service (AWS S3, MinIO, Ceph) requires. Signing is implemented directly here
// rather than pulling in the AWS SDK, since only put/get/head/list are needed
// and SigV4 for a single service is a well-specified ~80 lines.
//
// Endpoint addressing is path style (endpoint/bucket/key), which is what MinIO
// and other self-hosted gateways expect.
type ObjectStore struct {
	Endpoint  string
	Bucket    string
	Region    string
	AccessKey string
	SecretKey string

	client *http.Client
}

// unsignedPayload is used when the body is streamed rather than buffered.
const emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// NewObjectStore creates a new S3-compatible client.
func NewObjectStore(endpoint, bucket, region, accessKey, secretKey string) *ObjectStore {
	if region == "" {
		region = "us-east-1"
	}
	return &ObjectStore{
		Endpoint:  strings.TrimRight(endpoint, "/"),
		Bucket:    bucket,
		Region:    region,
		AccessKey: accessKey,
		SecretKey: secretKey,
		client:    &http.Client{Timeout: 30 * time.Second},
	}
}

// ─── Signature Version 4 ─────────────────────────────────────────────────────

// sign attaches SigV4 authentication headers to req for the given payload.
// The payload must be the exact bytes that will be sent as the body.
func (s *ObjectStore) sign(req *http.Request, payload []byte) {
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	payloadHash := emptyPayloadHash
	if len(payload) > 0 {
		sum := sha256.Sum256(payload)
		payloadHash = hex.EncodeToString(sum[:])
	}

	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if req.Host == "" {
		req.Host = req.URL.Host
	}

	// 1. Canonical headers. host, x-amz-content-sha256 and x-amz-date are always
	// signed; content-type is included when present because S3 verifies it.
	signed := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	values := map[string]string{
		"host":                 req.URL.Host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date":           amzDate,
	}
	if ct := req.Header.Get("Content-Type"); ct != "" {
		signed = append(signed, "content-type")
		values["content-type"] = ct
	}
	sort.Strings(signed)

	var canonicalHeaders strings.Builder
	for _, h := range signed {
		canonicalHeaders.WriteString(h)
		canonicalHeaders.WriteString(":")
		canonicalHeaders.WriteString(strings.TrimSpace(values[h]))
		canonicalHeaders.WriteString("\n")
	}
	signedHeaders := strings.Join(signed, ";")

	// 2. Canonical request. EscapedPath keeps the slashes between key segments
	// while encoding anything else, which is what S3 expects.
	canonicalRequest := strings.Join([]string{
		req.Method,
		req.URL.EscapedPath(),
		req.URL.RawQuery,
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")

	// 3. String to sign.
	scope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, s.Region)
	crSum := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hex.EncodeToString(crSum[:]),
	}, "\n")

	// 4. Derive the signing key and sign.
	kDate := hmacSHA256([]byte("AWS4"+s.SecretKey), dateStamp)
	kRegion := hmacSHA256(kDate, s.Region)
	kService := hmacSHA256(kRegion, "s3")
	kSigning := hmacSHA256(kService, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(kSigning, stringToSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		s.AccessKey, scope, signedHeaders, signature,
	))
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// objectURL builds a path-style URL, encoding the key so that characters like
// spaces or '+' survive intact.
func (s *ObjectStore) objectURL(key string) string {
	escaped := strings.Join(splitAndEscape(key), "/")
	return fmt.Sprintf("%s/%s/%s", s.Endpoint, url.PathEscape(s.Bucket), escaped)
}

func splitAndEscape(key string) []string {
	parts := strings.Split(strings.TrimPrefix(key, "/"), "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return parts
}

// do signs and executes a request, returning the response body for 2xx replies
// and a descriptive error otherwise.
func (s *ObjectStore) do(req *http.Request, payload []byte, op string) ([]byte, int, error) {
	s.sign(req, payload)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("s3 %s: %w", op, err)
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode >= 400 {
		// S3 returns XML error documents; include them so failures are
		// diagnosable instead of a bare status code.
		return nil, resp.StatusCode, fmt.Errorf("s3 %s failed: HTTP %d: %s",
			op, resp.StatusCode, strings.TrimSpace(truncateForLog(string(body))))
	}
	if readErr != nil {
		return nil, resp.StatusCode, fmt.Errorf("s3 %s: read body: %w", op, readErr)
	}
	return body, resp.StatusCode, nil
}

func truncateForLog(s string) string {
	if len(s) <= 400 {
		return s
	}
	return s[:400] + "…"
}

// ─── Operations ──────────────────────────────────────────────────────────────

// Healthy checks that the bucket is reachable and credentials are accepted.
func (s *ObjectStore) Healthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	u := fmt.Sprintf("%s/%s", s.Endpoint, url.PathEscape(s.Bucket))
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
	if err != nil {
		return false
	}
	_, status, err := s.do(req, nil, "head bucket")
	return err == nil && status < 400
}

// EnsureBucket creates the bucket if it does not already exist. Safe to call
// repeatedly; an existing bucket is treated as success.
func (s *ObjectStore) EnsureBucket(ctx context.Context) error {
	u := fmt.Sprintf("%s/%s", s.Endpoint, url.PathEscape(s.Bucket))

	head, err := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
	if err != nil {
		return err
	}
	if _, status, err := s.do(head, nil, "head bucket"); err == nil && status < 400 {
		return nil
	}

	put, err := http.NewRequestWithContext(ctx, http.MethodPut, u, nil)
	if err != nil {
		return err
	}
	if _, status, err := s.do(put, nil, "create bucket"); err != nil {
		// 409 means someone else created it first, which is fine.
		if status == http.StatusConflict {
			return nil
		}
		return err
	}
	slog.Info("Created object storage bucket", "bucket", s.Bucket)
	return nil
}

// Put stores an object.
func (s *ObjectStore) Put(ctx context.Context, key string, data []byte, contentType string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, s.objectURL(key), bytes.NewReader(data))
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.ContentLength = int64(len(data))

	if _, _, err := s.do(req, data, "put "+key); err != nil {
		return err
	}
	slog.Debug("Object stored", "key", key, "size", len(data))
	return nil
}

// Get retrieves an object.
func (s *ObjectStore) Get(ctx context.Context, key string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.objectURL(key), nil)
	if err != nil {
		return nil, err
	}
	body, status, err := s.do(req, nil, "get "+key)
	if status == http.StatusNotFound {
		return nil, fmt.Errorf("s3 not found: %s", key)
	}
	if err != nil {
		return nil, err
	}
	return body, nil
}

// Exists reports whether an object is present.
func (s *ObjectStore) Exists(ctx context.Context, key string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, s.objectURL(key), nil)
	if err != nil {
		return false, err
	}
	_, status, err := s.do(req, nil, "head "+key)
	if status == http.StatusNotFound {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return status == http.StatusOK, nil
}
