CREATE TABLE IF NOT EXISTS forgex_requirements (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  created_at timestamptz NOT NULL,
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  workflow jsonb NOT NULL CHECK (jsonb_typeof(workflow) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, requirement_key)
);

CREATE INDEX IF NOT EXISTS forgex_requirements_scope_position_idx
  ON forgex_requirements (tenant_key, project_key, position);

CREATE TABLE IF NOT EXISTS forgex_requirement_audit (
  event_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  action text NOT NULL CHECK (
    action IN (
      'requirement.created',
      'requirement.confirmation_submitted',
      'requirement.confirmed',
      'delivery.requested',
      'delivery.dispatched'
    )
  ),
  actor_key uuid NOT NULL,
  actor_name text NOT NULL CHECK (
    char_length(btrim(actor_name)) BETWEEN 2 AND 100
  ),
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_key, project_key, requirement_key)
    REFERENCES forgex_requirements (tenant_key, project_key, requirement_key)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS forgex_requirement_audit_scope_time_idx
  ON forgex_requirement_audit (tenant_key, project_key, recorded_at, event_key);

CREATE TABLE IF NOT EXISTS forgex_delivery_outbox (
  dispatch_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 2 AND 150),
  required_capabilities jsonb NOT NULL CHECK (
    jsonb_typeof(required_capabilities) = 'array'
  ),
  requested_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  CHECK (dispatched_at IS NULL OR dispatched_at >= requested_at),
  UNIQUE (tenant_key, project_key, requirement_key, requirement_revision),
  FOREIGN KEY (tenant_key, project_key, requirement_key)
    REFERENCES forgex_requirements (tenant_key, project_key, requirement_key)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS forgex_delivery_outbox_pending_idx
  ON forgex_delivery_outbox (tenant_key, requested_at, dispatch_key)
  WHERE dispatched_at IS NULL;
