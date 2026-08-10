CREATE TABLE IF NOT EXISTS forgex_requirement_evidence (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  evidence_key uuid NOT NULL,
  evidence_digest text NOT NULL CHECK (
    evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  runner_key uuid NOT NULL,
  key_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_key, evidence_key),
  UNIQUE (
    tenant_key,
    project_key,
    requirement_key,
    requirement_revision
  ),
  FOREIGN KEY (tenant_key, project_key, requirement_key)
    REFERENCES forgex_requirements (tenant_key, project_key, requirement_key)
    ON DELETE RESTRICT,
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
  )
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS forgex_requirement_evidence_scope_time_idx
  ON forgex_requirement_evidence (
    tenant_key,
    project_key,
    recorded_at,
    evidence_key
  );

CREATE INDEX IF NOT EXISTS forgex_delivery_runs_verification_idx
  ON forgex_delivery_runs (
    tenant_key,
    project_key,
    repository_key,
    completed_at,
    requirement_key
  )
  WHERE status = 'completed';

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
      'verification.completed'
    )
  );
