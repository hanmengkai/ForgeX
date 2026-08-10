CREATE TABLE IF NOT EXISTS forgex_verification_failures (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  repository_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  failure_digest text NOT NULL CHECK (failure_digest ~ '^[a-f0-9]{64}$'),
  runner_key uuid NOT NULL,
  key_id uuid NOT NULL,
  verification_completed_at timestamptz NOT NULL,
  checks jsonb NOT NULL CHECK (
    jsonb_typeof(checks) = 'array'
    AND jsonb_array_length(checks) BETWEEN 1 AND 80
  ),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (
    tenant_key,
    project_key,
    requirement_key,
    requirement_revision
  ),
  FOREIGN KEY (
    tenant_key,
    project_key,
    requirement_key,
    requirement_revision
  ) REFERENCES forgex_delivery_runs (
    tenant_key,
    project_key,
    requirement_key,
    requirement_revision
  ) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS forgex_verification_failures_scope_time_idx
  ON forgex_verification_failures (
    tenant_key,
    project_key,
    repository_key,
    recorded_at,
    requirement_key
  );

ALTER TABLE forgex_requirement_audit
  DROP CONSTRAINT IF EXISTS forgex_requirement_audit_action_check;

ALTER TABLE forgex_requirement_audit
  ADD CONSTRAINT forgex_requirement_audit_action_check CHECK (
    action IN (
      'requirement.created',
      'requirement.confirmation_submitted',
      'requirement.confirmed',
      'requirement.accepted',
      'delivery.requested',
      'delivery.dispatched',
      'delivery.completed',
      'verification.preview_recorded',
      'verification.failed',
      'verification.completed'
    )
  );
