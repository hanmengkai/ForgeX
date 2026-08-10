CREATE TABLE IF NOT EXISTS forgex_skill_registries (
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

CREATE TABLE IF NOT EXISTS forgex_skill_artifacts (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  skill_key uuid NOT NULL,
  skill_version text NOT NULL CHECK (
    skill_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (
    size_bytes BETWEEN 1 AND 20971520
  ),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, skill_key, skill_version),
  CHECK (octet_length(content) = size_bytes)
);

CREATE TABLE IF NOT EXISTS forgex_skill_activation_audit (
  event_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  skill_key uuid NOT NULL,
  skill_version text NOT NULL CHECK (
    skill_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  ),
  evaluation_key uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('activated', 'rolled_back')),
  actor_key uuid NOT NULL,
  actor_name text NOT NULL CHECK (
    char_length(btrim(actor_name)) BETWEEN 2 AND 100
  ),
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_key, project_key)
    REFERENCES forgex_skill_registries (tenant_key, project_key)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS forgex_skill_activation_audit_scope_time_idx
  ON forgex_skill_activation_audit (
    tenant_key,
    project_key,
    recorded_at,
    event_key
  );
