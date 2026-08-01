-- API keys for service accounts (MCP, CLI, CI pipelines) and user invitations.
CREATE TABLE IF NOT EXISTS api_keys (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT '',
    key_prefix text NOT NULL,
    key_hash bytea NOT NULL UNIQUE,
    scopes text[] NOT NULL DEFAULT '{read,write}',
    expires_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (key_prefix);

CREATE TABLE IF NOT EXISTS user_invitations (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    email text NOT NULL,
    organization_id text NOT NULL,
    roles text[] NOT NULL DEFAULT '{viewer}',
    invited_by uuid NOT NULL REFERENCES auth_users(id),
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL DEFAULT (NOW() + interval '7 days'),
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_org_email_idx ON user_invitations (organization_id, email) WHERE accepted_at IS NULL;
