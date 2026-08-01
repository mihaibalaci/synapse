package api

import (
	"context"
	"log/slog"
	"os"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/config"
	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/storage"
)

// App holds the application dependencies injected into route handlers.
type App struct {
	Config  *config.Config
	DB      *storage.DB
	Cache   *storage.Cache
	Objects *storage.ObjectStore

	Sessions *storage.SessionRepo
	Chunks   *storage.ChunkRepo
	Facts    *storage.FactRepo
	Stats    *storage.StatsRepo
	Settings *storage.SettingsRepo
	Auth     *auth.Service
	OIDC     *auth.OIDCProvider

	// Embedder generates vectors for chunk content and search queries.
	Embedder *ingestion.EmbeddingClient
}

// NewApp initializes all storage connections and repositories.
func NewApp(ctx context.Context, cfg *config.Config) (*App, error) {
	db, err := storage.ConnectWithRetry(ctx, cfg.DatabaseURL, storage.DefaultRetry)
	if err != nil {
		return nil, err
	}
	if err := db.CheckMigrations(ctx); err != nil {
		db.Close()
		return nil, err
	}

	cache, err := storage.ConnectRedisWithRetry(ctx, cfg.RedisURL, storage.DefaultRetry)
	if err != nil {
		db.Close()
		return nil, err
	}

	objects := storage.NewObjectStore(
		cfg.S3Endpoint, cfg.S3Bucket, cfg.S3Region,
		envOr("AWS_ACCESS_KEY_ID", "minioadmin"),
		envOr("AWS_SECRET_ACCESS_KEY", "minioadmin"),
	)

	app := &App{
		Config:   cfg,
		DB:       db,
		Cache:    cache,
		Objects:  objects,
		Sessions: storage.NewSessionRepo(db),
		Chunks:   storage.NewChunkRepo(db),
		Facts:    storage.NewFactRepo(db),
		Stats:    storage.NewStatsRepo(db),
		Settings: storage.NewSettingsRepo(db),
		Auth:     auth.NewService(db, cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience, cfg.AuthAccessTTL, cfg.AuthRefreshTTL),
		Embedder: ingestion.NewEmbeddingClient(),
	}

	// Initialize optional OIDC provider
	oidcCfg := auth.OIDCConfig{
		Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClientID,
		ClientSecret: cfg.OIDCClientSecret, RedirectURI: cfg.OIDCRedirectURI,
	}
	if oidcCfg.Enabled() {
		oidc, err := auth.NewOIDCProvider(oidcCfg, app.Auth, db)
		if err != nil {
			slog.Warn("OIDC provider initialization failed; OIDC login disabled", "error", err)
		} else {
			app.OIDC = oidc
		}
	}

	slog.Info("Embedding provider configured",
		"provider", cfg.EmbeddingProvider,
		"model", cfg.EmbeddingModel,
		"dimensions", cfg.EmbeddingDimensions)

	// Publish object-store I/O counters to Redis so the API and the workers,
	// which are separate processes, contribute to a single total.
	objects.AttachMetrics(cache)

	// Make sure the raw-session bucket exists. Captures are rejected when the
	// raw write fails, so a missing bucket would take down ingestion entirely.
	if err := objects.EnsureBucket(ctx); err != nil {
		slog.Warn("Could not verify object storage bucket", "bucket", cfg.S3Bucket, "error", err)
	}

	// Seed cumulative ingestion metrics from the database so the Activity page
	// reflects real historical work instead of zeros after a restart.
	if counts, err := app.Stats.GetCounts(ctx, "default"); err == nil {
		SeedFromCounts(counts)
	}

	return app, nil
}

// Close shuts down all connections.
func (a *App) Close() {
	if a.DB != nil {
		a.DB.Close()
	}
	if a.Cache != nil {
		a.Cache.Close()
	}
}

// Healthy returns true if all dependencies are reachable.
func (a *App) Healthy(ctx context.Context) map[string]string {
	checks := map[string]string{}

	if a.DB.Healthy(ctx) {
		checks["database"] = "ok"
	} else {
		checks["database"] = "unavailable"
	}

	if a.Cache.Healthy(ctx) {
		checks["redis"] = "ok"
	} else {
		checks["redis"] = "unavailable"
	}

	if a.Objects.Healthy(ctx) {
		checks["objectStorage"] = "ok"
	} else {
		checks["objectStorage"] = "unavailable"
	}

	checks["queue"] = "ok"
	return checks
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
