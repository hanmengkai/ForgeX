CREATE TABLE IF NOT EXISTS forgex_browser_sessions (
  session_digest text PRIMARY KEY CHECK (session_digest ~ '^[a-f0-9]{64}$'),
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  repository_key uuid NOT NULL,
  auth_realm_revision text NOT NULL CHECK (auth_realm_revision ~ '^[a-f0-9]{64}$'),
  actor_key uuid NOT NULL,
  principal jsonb NOT NULL CHECK (jsonb_typeof(principal) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  UNIQUE (tenant_key, project_key, repository_key, actor_key)
);

CREATE INDEX IF NOT EXISTS forgex_browser_sessions_expiry_idx
  ON forgex_browser_sessions (expires_at);
