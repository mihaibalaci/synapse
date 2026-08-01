package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/mihaibalaci/synapse/internal/storage"
)

// OIDCConfig holds optional OIDC provider settings. When ClientID is empty,
// OIDC is disabled and all authentication goes through local credentials.
type OIDCConfig struct {
	Issuer       string // e.g. https://accounts.google.com
	ClientID     string
	ClientSecret string
	RedirectURI  string // e.g. http://localhost:8080/api/v1/auth/oidc/callback
	Scopes       string // space-separated, defaults to "openid email profile"
}

func (c OIDCConfig) Enabled() bool { return c.ClientID != "" && c.Issuer != "" }

// OIDCProvider handles the authorization code exchange and user provisioning.
type OIDCProvider struct {
	cfg      OIDCConfig
	auth     *Service
	db       *storage.DB
	client   *http.Client
	authURL  string
	tokenURL string
	userURL  string
}

// NewOIDCProvider discovers endpoints from the issuer's well-known configuration.
func NewOIDCProvider(cfg OIDCConfig, authService *Service, db *storage.DB) (*OIDCProvider, error) {
	if !cfg.Enabled() {
		return nil, nil
	}
	if cfg.Scopes == "" {
		cfg.Scopes = "openid email profile"
	}

	client := &http.Client{Timeout: 10 * time.Second}

	// Discover OIDC endpoints
	discoveryURL := strings.TrimRight(cfg.Issuer, "/") + "/.well-known/openid-configuration"
	resp, err := client.Get(discoveryURL)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("oidc discovery read: %w", err)
	}

	var discovery struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		UserinfoEndpoint      string `json:"userinfo_endpoint"`
	}
	if err := json.Unmarshal(body, &discovery); err != nil {
		return nil, fmt.Errorf("oidc discovery decode: %w", err)
	}
	if discovery.AuthorizationEndpoint == "" || discovery.TokenEndpoint == "" {
		return nil, fmt.Errorf("oidc discovery missing required endpoints")
	}

	return &OIDCProvider{
		cfg: cfg, auth: authService, db: db, client: client,
		authURL: discovery.AuthorizationEndpoint, tokenURL: discovery.TokenEndpoint,
		userURL: discovery.UserinfoEndpoint,
	}, nil
}

// AuthorizeURL returns the URL to redirect the browser to for login.
func (p *OIDCProvider) AuthorizeURL(state string) string {
	params := url.Values{
		"response_type": {"code"},
		"client_id":     {p.cfg.ClientID},
		"redirect_uri":  {p.cfg.RedirectURI},
		"scope":         {p.cfg.Scopes},
		"state":         {state},
	}
	return p.authURL + "?" + params.Encode()
}

// Exchange trades an authorization code for user info and creates/provisions the user.
func (p *OIDCProvider) Exchange(ctx context.Context, code, organizationID string, meta ClientMetadata) (*SessionTokens, error) {
	// Exchange code for tokens
	data := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {p.cfg.RedirectURI},
		"client_id":     {p.cfg.ClientID},
		"client_secret": {p.cfg.ClientSecret},
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.tokenURL, strings.NewReader(data.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oidc token exchange: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidc token %d: %s", resp.StatusCode, string(body[:min(200, len(body))]))
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("oidc token decode: %w", err)
	}

	// Get user info
	userReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.userURL, nil)
	userReq.Header.Set("Authorization", "Bearer "+tokenResp.AccessToken)
	userResp, err := p.client.Do(userReq)
	if err != nil {
		return nil, fmt.Errorf("oidc userinfo: %w", err)
	}
	defer userResp.Body.Close()
	userBody, _ := io.ReadAll(io.LimitReader(userResp.Body, 1<<20))

	var userInfo struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := json.Unmarshal(userBody, &userInfo); err != nil {
		return nil, fmt.Errorf("oidc userinfo decode: %w", err)
	}
	if userInfo.Email == "" {
		return nil, fmt.Errorf("oidc: provider did not return an email")
	}

	email := normalizeEmail(userInfo.Email)
	if organizationID == "" {
		organizationID = "default"
	}

	// Provision or look up the user
	user, _, err := p.auth.userByEmail(ctx, email, organizationID)
	if err != nil {
		// User doesn't exist; auto-provision with viewer role
		_, err = p.db.Pool.Exec(ctx, `
			INSERT INTO auth_users (email, normalized_email, display_name, password_hash, organization_id, roles)
			VALUES ($1, $1, $2, 'oidc-managed', $3, ARRAY['viewer']::text[])
			ON CONFLICT (organization_id, normalized_email) DO NOTHING`,
			email, userInfo.Name, organizationID)
		if err != nil {
			return nil, fmt.Errorf("oidc provision user: %w", err)
		}
		user, _, err = p.auth.userByEmail(ctx, email, organizationID)
		if err != nil {
			return nil, fmt.Errorf("oidc load provisioned user: %w", err)
		}
	}
	if user.Disabled {
		return nil, ErrUserDisabled
	}

	// Create session
	tokens, err := p.auth.createSession(ctx, user, meta)
	if err != nil {
		return nil, err
	}
	_ = p.db.Exec(ctx, `UPDATE auth_users SET last_login_at = now(), updated_at = now() WHERE id = $1`, user.ID)
	return tokens, nil
}
