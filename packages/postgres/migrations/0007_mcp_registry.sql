CREATE TABLE IF NOT EXISTS forgex_mcp_registries (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key),
  CHECK ((state ->> 'schemaVersion') IS NOT DISTINCT FROM '1'),
  CHECK ((state ->> 'tenantKey') IS NOT DISTINCT FROM tenant_key::text),
  CHECK ((state ->> 'projectKey') IS NOT DISTINCT FROM project_key::text)
);

CREATE TABLE IF NOT EXISTS forgex_mcp_enable_audit (
  event_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  server_key uuid NOT NULL,
  server_revision bigint NOT NULL CHECK (server_revision > 0),
  attestation_key uuid NOT NULL,
  action text NOT NULL CHECK (
    action IN ('enabled', 'rolled_back', 'disabled', 'health_disabled')
  ),
  actor_key uuid NOT NULL,
  actor_name text NOT NULL CHECK (
    char_length(btrim(actor_name)) BETWEEN 2 AND 100
  ),
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_key, project_key)
    REFERENCES forgex_mcp_registries (tenant_key, project_key)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS forgex_mcp_enable_audit_scope_time_idx
  ON forgex_mcp_enable_audit (
    tenant_key,
    project_key,
    recorded_at,
    event_key
  );
