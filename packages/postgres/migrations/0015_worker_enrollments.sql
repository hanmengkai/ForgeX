CREATE TABLE IF NOT EXISTS forgex_worker_enrollments (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  repository_key uuid NOT NULL,
  auth_realm_revision text NOT NULL CHECK (auth_realm_revision ~ '^[a-f0-9]{64}$'),
  actor_key uuid NOT NULL,
  principal jsonb NOT NULL CHECK (jsonb_typeof(principal) = 'object'),
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 2 AND 100),
  account_name text NOT NULL CHECK (char_length(account_name) BETWEEN 2 AND 100),
  fingerprint_digest text CHECK (fingerprint_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  UNIQUE (tenant_key, project_key, repository_key, actor_key)
);

CREATE INDEX IF NOT EXISTS forgex_worker_enrollments_expiry_idx
  ON forgex_worker_enrollments (expires_at);
