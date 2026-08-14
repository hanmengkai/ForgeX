ALTER TABLE forgex_requirements
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE forgex_requirements
  DROP CONSTRAINT IF EXISTS forgex_requirements_deleted_at_check;

ALTER TABLE forgex_requirements
  ADD CONSTRAINT forgex_requirements_deleted_at_check CHECK (
    deleted_at IS NULL OR deleted_at >= created_at
  );

CREATE INDEX IF NOT EXISTS forgex_requirements_active_scope_position_idx
  ON forgex_requirements (tenant_key, project_key, position)
  WHERE deleted_at IS NULL;

DO $$
DECLARE
  revision_constraint text;
BEGIN
  SELECT conname
  INTO revision_constraint
  FROM pg_constraint
  WHERE conrelid = 'forgex_delivery_outbox'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) =
      'UNIQUE (tenant_key, project_key, requirement_key, requirement_revision)';

  IF revision_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE forgex_delivery_outbox DROP CONSTRAINT %I',
      revision_constraint
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS forgex_delivery_outbox_active_revision_uidx
  ON forgex_delivery_outbox (
    tenant_key,
    project_key,
    requirement_key,
    requirement_revision
  )
  WHERE cancelled_at IS NULL;

ALTER TABLE forgex_requirement_audit
  DROP CONSTRAINT IF EXISTS forgex_requirement_audit_action_check;

ALTER TABLE forgex_requirement_audit
  ADD CONSTRAINT forgex_requirement_audit_action_check CHECK (
    action IN (
      'requirement.created',
      'requirement.revised',
      'requirement.confirmation_submitted',
      'requirement.confirmed',
      'requirement.deleted',
      'requirement.accepted',
      'delivery.requested',
      'delivery.dispatched',
      'delivery.terminated',
      'delivery.completed',
      'verification.preview_recorded',
      'verification.failed',
      'verification.completed'
    )
  );
