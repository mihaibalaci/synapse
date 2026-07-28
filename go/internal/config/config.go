// Package config loads environment configuration for Synapse.
package config

import (
	"os"
	"strconv"
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
	JWTSecret  string
	JWTIssuer  string
	JWTAudience string

	// Embedding
	EmbeddingProvider   string
	EmbeddingModel      string
	EmbeddingDimensions int

	// LLM
	LLMProvider string
	LLMModel    string
	OpenAIKey   string
	AnthropicKey string

	// Rate Limiting
	RateLimitMax    int
	RateLimitWindow int // seconds
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

		JWTSecret:   env("AUTH_JWT_SECRET", ""),
		JWTIssuer:   env("AUTH_ISSUER", "https://auth.synapse.local"),
		JWTAudience: env("AUTH_AUDIENCE", "synapse"),

		EmbeddingProvider:   env("EMBEDDING_PROVIDER", "local"),
		EmbeddingModel:      env("EMBEDDING_MODEL", "synapse-local-1536"),
		EmbeddingDimensions: envInt("EMBEDDING_DIMENSIONS", 1536),

		LLMProvider:  env("LLM_PROVIDER", "local-none"),
		LLMModel:     env("LLM_MODEL", ""),
		OpenAIKey:    env("OPENAI_API_KEY", ""),
		AnthropicKey: env("ANTHROPIC_API_KEY", ""),

		RateLimitMax:    envInt("RATE_LIMIT_MAX", 100),
		RateLimitWindow: envInt("RATE_LIMIT_WINDOW_MS", 60000) / 1000,
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
