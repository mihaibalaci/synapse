package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// ObjectStore provides S3-compatible object storage access.
// Uses plain HTTP to avoid heavy AWS SDK dependency for basic put/get.
type ObjectStore struct {
	Endpoint  string
	Bucket    string
	Region    string
	AccessKey string
	SecretKey string
}

// NewObjectStore creates a new S3-compatible client.
func NewObjectStore(endpoint, bucket, region, accessKey, secretKey string) *ObjectStore {
	return &ObjectStore{
		Endpoint:  endpoint,
		Bucket:    bucket,
		Region:    region,
		AccessKey: accessKey,
		SecretKey: secretKey,
	}
}

// Healthy checks if the bucket is accessible.
func (s *ObjectStore) Healthy(ctx context.Context) bool {
	url := fmt.Sprintf("%s/%s", s.Endpoint, s.Bucket)
	req, _ := http.NewRequestWithContext(ctx, "HEAD", url, nil)
	req.SetBasicAuth(s.AccessKey, s.SecretKey)

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode < 500
}

// Put stores an object.
func (s *ObjectStore) Put(ctx context.Context, key string, data []byte, contentType string) error {
	url := fmt.Sprintf("%s/%s/%s", s.Endpoint, s.Bucket, key)
	req, err := http.NewRequestWithContext(ctx, "PUT", url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	req.SetBasicAuth(s.AccessKey, s.SecretKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("s3 put: %w", err)
	}
	resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("s3 put failed: %d", resp.StatusCode)
	}

	slog.Debug("S3 object stored", "key", key, "size", len(data))
	return nil
}

// Get retrieves an object.
func (s *ObjectStore) Get(ctx context.Context, key string) ([]byte, error) {
	url := fmt.Sprintf("%s/%s/%s", s.Endpoint, s.Bucket, key)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(s.AccessKey, s.SecretKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("s3 get: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		return nil, fmt.Errorf("s3 not found: %s", key)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("s3 get failed: %d", resp.StatusCode)
	}

	return io.ReadAll(resp.Body)
}

// Exists checks if an object exists.
func (s *ObjectStore) Exists(ctx context.Context, key string) (bool, error) {
	url := fmt.Sprintf("%s/%s/%s", s.Endpoint, s.Bucket, key)
	req, err := http.NewRequestWithContext(ctx, "HEAD", url, nil)
	if err != nil {
		return false, err
	}
	req.SetBasicAuth(s.AccessKey, s.SecretKey)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	resp.Body.Close()

	return resp.StatusCode == 200, nil
}
