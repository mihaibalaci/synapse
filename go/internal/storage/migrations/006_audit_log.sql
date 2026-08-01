-- Structured audit log for security, compliance, and debugging.
CREATE TABLE IF NOT EXISTS audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    timestamp timestamptz NOT NULL DEFAULT now(),
    actor_id text NOT NULL DEFAULT '',
    actor_email text NOT NULL DEFAULT '',
    organization_id text NOT NULL DEFAULT '',
    action text NOT NULL,
    resource_type text NOT NULL DEFAULT '',
    resource_id text NOT NULL DEFAULT '',
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip_address text NOT NULL DEFAULT '',
    user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_log_org_ts_idx ON audit_log (organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, timestamp DESC);
