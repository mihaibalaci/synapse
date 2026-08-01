// Package config loads environment configuration for Synapse.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port        int
	Host        string
	Environment string
	LogLevel    string

	// Database
	DatabaseURL string

	// Redis
	RedisURL string

	// Object Storage
	S3Bucket   string
	S3Region   string
	S3Endpoint string

	// Auth
	JWTSecret        string
	JWTIssuer        string
	JWTAudience      string
	AuthAccessTTL    time.Duration
	AuthRefreshTTL   time.Duration
	AuthCookieSecure bool

	// Embedding
	EmbeddingProvider   string
	EmbeddingModel      string
	EmbeddingDimensions int

	// LLM
	LLMProvider  string
	LLMModel     string
	OpenAIKey    string
	AnthropicKey string

	// Rate Limiting
	RateLimitMax    int
	RateLimitWindow int // seconds
	// Ingestion
	WorkerConcurrency int
}

func Load() *Config {
	return &Config{
		Port:        envInt("PORT", 3000),
		Host:        env("HOST", "0.0.0.0"),
		Environment: env("NODE_ENV", "production"),
		LogLevel:    env("LOG_LEVEL", "info"),

		DatabaseURL: env("DATABASE_URL", "postgresql://synapse_app:synapse_secure_password@localhost:5432/synapse"),
		RedisURL:    env("REDIS_URL", "redis://localhost:6379"),

		S3Bucket:   env("S3_BUCKET", "synapse-raw"),
		S3Region:   env("S3_REGION", "us-east-1"),
		S3Endpoint: env("S3_ENDPOINT", "http://localhost:9000"),

		JWTSecret:        env("AUTH_JWT_SECRET", ""),
		JWTIssuer:        env("AUTH_ISSUER", "https://auth.synapse.local"),
		JWTAudience:      env("AUTH_AUDIENCE", "synapse"),
		AuthAccessTTL:    time.Duration(envInt("AUTH_ACCESS_TTL_MINUTES", 15)) * time.Minute,
		AuthRefreshTTL:   time.Duration(envInt("AUTH_REFRESH_TTL_DAYS", 7)) * 24 * time.Hour,
		AuthCookieSecure: envBool("AUTH_COOKIE_SECURE", true),

		EmbeddingProvider:   env("EMBEDDING_PROVIDER", "local"),
		EmbeddingModel:      env("EMBEDDING_MODEL", "nomic-embed-text"),
		EmbeddingDimensions: envInt("EMBEDDING_DIMENSIONS", 768),

		LLMProvider:  env("LLM_PROVIDER", "local-none"),
		LLMModel:     env("LLM_MODEL", ""),
		OpenAIKey:    env("OPENAI_API_KEY", ""),
		AnthropicKey: env("ANTHROPIC_API_KEY", ""),

		RateLimitMax:    envInt("RATE_LIMIT_MAX", 100),
		RateLimitWindow: envInt("RATE_LIMIT_WINDOW_MS", 60000) / 1000,

		WorkerConcurrency: envInt("WORKER_CONCURRENCY", 4),
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

// ValidateRuntime checks invariants shared by API and worker processes.
func (c *Config) ValidateRuntime() error {
	if c.DatabaseURL == "" || c.RedisURL == "" || c.S3Endpoint == "" || c.S3Bucket == "" {
		return fmt.Errorf("DATABASE_URL, REDIS_URL, S3_ENDPOINT, and S3_BUCKET are required")
	}
	if c.EmbeddingDimensions != 768 {
		return fmt.Errorf("EMBEDDING_DIMENSIONS must be 768 to match the tracked pgvector schema (got %d)", c.EmbeddingDimensions)
	}
	return nil
}

// ValidateAPI adds authentication checks required by the HTTP server.
func (c *Config) ValidateAPI() error {
	if err := c.ValidateRuntime(); err != nil {
		return err
	}
	if len(c.JWTSecret) < 32 {
		return fmt.Errorf("AUTH_JWT_SECRET must contain at least 32 characters")
	}
	if c.JWTIssuer == "" || c.JWTAudience == "" {
		return fmt.Errorf("AUTH_ISSUER and AUTH_AUDIENCE are required")
	}
	if c.AuthAccessTTL < time.Minute || c.AuthAccessTTL > time.Hour {
		return fmt.Errorf("AUTH_ACCESS_TTL_MINUTES must be between 1 and 60")
	}
	if c.AuthRefreshTTL < 24*time.Hour || c.AuthRefreshTTL > 90*24*time.Hour {
		return fmt.Errorf("AUTH_REFRESH_TTL_DAYS must be between 1 and 90")
	}
	return nil
}
