package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mihaibalaci/synapse/internal/storage"
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrInvalidSession     = errors.New("invalid session")
	ErrUserDisabled       = errors.New("user is disabled")
	ErrUserNotFound       = errors.New("user not found")
)

// User is the server-controlled identity embedded in access tokens.
type User struct {
	ID             string   `json:"id"`
	Email          string   `json:"email"`
	DisplayName    string   `json:"displayName"`
	OrganizationID string   `json:"organizationId"`
	Roles          []string `json:"roles"`
	Disabled       bool     `json:"disabled"`
}

// SessionTokens contains a short-lived bearer token and the opaque refresh
// token that must only be placed in an HttpOnly cookie.
type SessionTokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int
	User         User
}

// ClientMetadata is retained for session auditing without trusting it for
// authorization decisions.
type ClientMetadata struct {
	UserAgent string
	IPAddress string
}

// Service owns local users, rotating refresh sessions, and access-token
// issuance. Existing externally issued bearer tokens continue to be accepted
// by Middleware as long as they satisfy the same JWT policy.
type Service struct {
	db         *storage.DB
	secret     []byte
	issuer     string
	audience   string
	accessTTL  time.Duration
	refreshTTL time.Duration
}

func NewService(db *storage.DB, secret, issuer, audience string, accessTTL, refreshTTL time.Duration) *Service {
	if accessTTL <= 0 {
		accessTTL = 15 * time.Minute
	}
	if refreshTTL <= 0 {
		refreshTTL = 7 * 24 * time.Hour
	}
	return &Service{
		db: db, secret: []byte(secret), issuer: issuer, audience: audience,
		accessTTL: accessTTL, refreshTTL: refreshTTL,
	}
}

func (s *Service) RefreshTTL() time.Duration { return s.refreshTTL }

// BootstrapAdmin creates the first user in an organization. It is deliberately
// idempotent and refuses to add a second bootstrap user; later user management
// must happen through authenticated administration or an explicit recovery
// command.
func (s *Service) BootstrapAdmin(ctx context.Context, email, password, displayName, organizationID string) (bool, error) {
	email = normalizeEmail(email)
	organizationID = strings.TrimSpace(organizationID)
	displayName = strings.TrimSpace(displayName)
	if err := validateIdentity(email, password, organizationID); err != nil {
		return false, err
	}
	if displayName == "" {
		displayName = "Synapse Administrator"
	}

	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("begin bootstrap: %w", err)
	}
	defer tx.Rollback(ctx)

	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM auth_users WHERE organization_id = $1`, organizationID).Scan(&count); err != nil {
		return false, fmt.Errorf("count bootstrap users: %w", err)
	}
	if count > 0 {
		return false, tx.Commit(ctx)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO auth_users (email, normalized_email, display_name, password_hash, organization_id, roles)
		VALUES ($1, $1, $2, crypt($3, gen_salt('bf', 12)), $4, ARRAY['admin']::text[])`,
		email, displayName, password, organizationID)
	if err != nil {
		return false, fmt.Errorf("create bootstrap admin: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit bootstrap admin: %w", err)
	}
	return true, nil
}

func (s *Service) Login(ctx context.Context, email, password, organizationID string, meta ClientMetadata) (*SessionTokens, error) {
	email = normalizeEmail(email)
	organizationID = strings.TrimSpace(organizationID)
	if email == "" || password == "" || organizationID == "" {
		s.consumePasswordWork(ctx, password)
		return nil, ErrInvalidCredentials
	}

	user, passwordHash, err := s.userByEmail(ctx, email, organizationID)
	if err != nil {
		s.consumePasswordWork(ctx, password)
		if errors.Is(err, ErrUserNotFound) {
			return nil, ErrInvalidCredentials
		}
		return nil, err
	}
	valid, err := s.verifyPassword(ctx, passwordHash, password)
	if err != nil {
		return nil, err
	}
	if !valid {
		return nil, ErrInvalidCredentials
	}
	if user.Disabled {
		return nil, ErrUserDisabled
	}

	tokens, err := s.createSession(ctx, user, meta)
	if err != nil {
		return nil, err
	}
	_ = s.db.Exec(ctx, `UPDATE auth_users SET last_login_at = now(), updated_at = now() WHERE id = $1`, user.ID)
	return tokens, nil
}

// Refresh rotates an active refresh token. Reuse of a revoked token revokes all
// active sessions for that user, limiting damage from copied credentials.
func (s *Service) Refresh(ctx context.Context, refreshToken string, meta ClientMetadata) (*SessionTokens, error) {
	if refreshToken == "" {
		return nil, ErrInvalidSession
	}
	hash := tokenHash(refreshToken)
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin refresh: %w", err)
	}
	defer tx.Rollback(ctx)

	var user User
	var oldSessionID string
	var expiresAt time.Time
	var revokedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT s.id, s.expires_at, s.revoked_at,
		       u.id, u.email, u.display_name, u.organization_id, u.roles, u.disabled
		FROM auth_sessions s
		JOIN auth_users u ON u.id = s.user_id
		WHERE s.token_hash = $1
		FOR UPDATE OF s`, hash[:]).Scan(
		&oldSessionID, &expiresAt, &revokedAt,
		&user.ID, &user.Email, &user.DisplayName, &user.OrganizationID, &user.Roles, &user.Disabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidSession
	}
	if err != nil {
		return nil, fmt.Errorf("load refresh session: %w", err)
	}
	if revokedAt != nil {
		if _, err := tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1`, user.ID); err != nil {
			return nil, fmt.Errorf("revoke replayed sessions: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit replay revocation: %w", err)
		}
		return nil, ErrInvalidSession
	}
	if user.Disabled || !expiresAt.After(time.Now()) {
		_, _ = tx.Exec(ctx, `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`, oldSessionID)
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit invalid session revocation: %w", err)
		}
		if user.Disabled {
			return nil, ErrUserDisabled
		}
		return nil, ErrInvalidSession
	}

	newID := uuid.NewString()
	newToken, newHash, err := newOpaqueToken()
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, user_agent, ip_address)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		newID, user.ID, newHash[:], time.Now().Add(s.refreshTTL), truncateMeta(meta.UserAgent), truncateMeta(meta.IPAddress)); err != nil {
		return nil, fmt.Errorf("insert rotated session: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE auth_sessions SET revoked_at = now(), replaced_by = $2, last_used_at = now()
		WHERE id = $1`, oldSessionID, newID); err != nil {
		return nil, fmt.Errorf("rotate session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit session rotation: %w", err)
	}

	access, err := s.issueAccessToken(user, newID)
	if err != nil {
		return nil, err
	}
	return &SessionTokens{AccessToken: access, RefreshToken: newToken, ExpiresIn: int(s.accessTTL.Seconds()), User: user}, nil
}

func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}
	hash := tokenHash(refreshToken)
	if err := s.db.Exec(ctx, `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE token_hash = $1`, hash[:]); err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}

func (s *Service) UserByID(ctx context.Context, id string) (User, error) {
	var user User
	err := s.db.QueryRow(ctx, `
		SELECT id, email, display_name, organization_id, roles, disabled
		FROM auth_users WHERE id = $1`, id).Scan(
		&user.ID, &user.Email, &user.DisplayName, &user.OrganizationID, &user.Roles, &user.Disabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("load user: %w", err)
	}
	if user.Disabled {
		return User{}, ErrUserDisabled
	}
	return user, nil
}

func (s *Service) createSession(ctx context.Context, user User, meta ClientMetadata) (*SessionTokens, error) {
	sessionID := uuid.NewString()
	refresh, hash, err := newOpaqueToken()
	if err != nil {
		return nil, err
	}
	if err := s.db.Exec(ctx, `
		INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, user_agent, ip_address)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		sessionID, user.ID, hash[:], time.Now().Add(s.refreshTTL), truncateMeta(meta.UserAgent), truncateMeta(meta.IPAddress)); err != nil {
		return nil, fmt.Errorf("create auth session: %w", err)
	}
	access, err := s.issueAccessToken(user, sessionID)
	if err != nil {
		return nil, err
	}
	return &SessionTokens{AccessToken: access, RefreshToken: refresh, ExpiresIn: int(s.accessTTL.Seconds()), User: user}, nil
}

func (s *Service) issueAccessToken(user User, sessionID string) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"sub": user.ID, "organization_id": user.OrganizationID,
		"roles": user.Roles, "team_ids": []string{}, "repository_access": []string{},
		"sid": sessionID, "iss": s.issuer, "aud": s.audience,
		"iat": now.Unix(), "nbf": now.Add(-5 * time.Second).Unix(),
		"exp": now.Add(s.accessTTL).Unix(), "jti": uuid.NewString(),
	}
	value, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
	if err != nil {
		return "", fmt.Errorf("sign access token: %w", err)
	}
	return value, nil
}

func (s *Service) userByEmail(ctx context.Context, email, organizationID string) (User, string, error) {
	var user User
	var passwordHash string
	err := s.db.QueryRow(ctx, `
		SELECT id, email, display_name, password_hash, organization_id, roles, disabled
		FROM auth_users
		WHERE organization_id = $1 AND normalized_email = $2`, organizationID, email).Scan(
		&user.ID, &user.Email, &user.DisplayName, &passwordHash, &user.OrganizationID, &user.Roles, &user.Disabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", ErrUserNotFound
	}
	if err != nil {
		return User{}, "", fmt.Errorf("load login user: %w", err)
	}
	return user, passwordHash, nil
}

func (s *Service) verifyPassword(ctx context.Context, passwordHash, password string) (bool, error) {
	var valid bool
	if err := s.db.QueryRow(ctx,
		`SELECT $1::text = crypt($2::text, $1::text)`, passwordHash, password,
	).Scan(&valid); err != nil {
		return false, fmt.Errorf("verify password: %w", err)
	}
	return valid, nil
}

func (s *Service) consumePasswordWork(ctx context.Context, password string) {
	// Keep unknown-user timing near a real bcrypt comparison to reduce account
	// enumeration signal. Failure here is intentionally ignored because the
	// caller still receives the same generic authentication error.
	var ignored string
	_ = s.db.QueryRow(ctx, `SELECT crypt($1::text, gen_salt('bf', 12))`, password).Scan(&ignored)
}

func newOpaqueToken() (string, [32]byte, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", [32]byte{}, fmt.Errorf("generate refresh token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw[:])
	return token, sha256.Sum256([]byte(token)), nil
}

func tokenHash(token string) [32]byte { return sha256.Sum256([]byte(token)) }

func normalizeEmail(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func validateIdentity(email, password, organizationID string) error {
	if email == "" || !strings.Contains(email, "@") || strings.ContainsAny(email, " \t\r\n") {
		return fmt.Errorf("a valid email is required")
	}
	if organizationID == "" {
		return fmt.Errorf("organization ID is required")
	}
	if len(password) < 12 || len(password) > 1024 {
		return fmt.Errorf("password must contain between 12 and 1024 characters")
	}
	return nil
}

func truncateMeta(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 512 {
		return value[:512]
	}
	return value
}
