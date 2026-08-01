-- Structured audit log for security, compliance, and debugging.
-- Adds missing columns to the existing audit_log table if it was created
-- by an earlier deployment with a different schema.
CREATE TABLE IF NOT EXISTS audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    timestamp timestamptz NOT NULL DEFAULT now(),
    user_id text NOT NULL DEFAULT '',
    organization_id text NOT NULL DEFAULT '',
    action text NOT NULL,
    resource_type text NOT NULL DEFAULT '',
    resource_id text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address text NOT NULL DEFAULT '',
    user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_log_org_ts_idx ON audit_log (organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, timestamp DESC);
