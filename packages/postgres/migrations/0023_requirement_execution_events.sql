CREATE TABLE IF NOT EXISTS forgex_requirement_execution_events (
  event_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  assignment_key uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0 AND sequence <= 1000000),
  occurred_at timestamptz NOT NULL,
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  UNIQUE (tenant_key, assignment_key, sequence),
  FOREIGN KEY (tenant_key, project_key, requirement_key)
    REFERENCES forgex_requirements (tenant_key, project_key, requirement_key)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS forgex_requirement_execution_events_scope_idx
  ON forgex_requirement_execution_events (
    tenant_key,
    project_key,
    requirement_key,
    requirement_revision,
    sequence DESC
  );
