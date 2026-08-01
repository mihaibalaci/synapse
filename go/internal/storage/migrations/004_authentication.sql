-- Local browser authentication. Passwords are bcrypt hashes and refresh
-- credentials are stored only as SHA-256 digests, so a database read does not
-- expose reusable session tokens. pgcrypto supplies PostgreSQL's bcrypt
-- implementation without moving reusable plaintext passwords into storage.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS auth_users (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    email text NOT NULL,
    normalized_email text NOT NULL,
    display_name text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    organization_id text NOT NULL,
    roles text[] NOT NULL DEFAULT '{viewer}',
    disabled boolean NOT NULL DEFAULT false,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, normalized_email),
    CHECK (cardinality(roles) > 0)
);
CREATE INDEX IF NOT EXISTS auth_users_org_idx
    ON auth_users (organization_id, disabled);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    replaced_by uuid REFERENCES auth_sessions(id),
    user_agent text NOT NULL DEFAULT '',
    ip_address text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx
    ON auth_sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
    ON auth_sessions (expires_at);
