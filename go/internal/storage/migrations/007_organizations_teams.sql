-- Organizations and teams hierarchy. Users belong to teams within an
-- organization. Teams have leads who manage team membership.
CREATE TABLE IF NOT EXISTS organizations (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the default organization that existing users belong to.
INSERT INTO organizations (id, name, description)
VALUES ('default', 'Default Organization', 'Initial organization')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS teams (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member',
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id);
