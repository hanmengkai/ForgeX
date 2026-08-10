ALTER TABLE forgex_completed_delivery_work
  ADD COLUMN IF NOT EXISTS work_kind text NOT NULL DEFAULT 'requirement_delivery';

ALTER TABLE forgex_completed_delivery_work
  ADD COLUMN IF NOT EXISTS completion_assignment_key uuid,
  ADD COLUMN IF NOT EXISTS completion_fencing_token bigint;

ALTER TABLE forgex_completed_delivery_work
  DROP CONSTRAINT IF EXISTS forgex_completed_delivery_work_work_kind_check;

ALTER TABLE forgex_completed_delivery_work
  ADD CONSTRAINT forgex_completed_delivery_work_work_kind_check
  CHECK (work_kind IN ('requirement_delivery', 'mcp_invocation'));

ALTER TABLE forgex_completed_delivery_work
  DROP CONSTRAINT IF EXISTS forgex_completed_delivery_work_completion_proof_check;

ALTER TABLE forgex_completed_delivery_work
  ADD CONSTRAINT forgex_completed_delivery_work_completion_proof_check
  CHECK (
    (
      work_kind = 'requirement_delivery'
      AND completion_assignment_key IS NULL
      AND completion_fencing_token IS NULL
    )
    OR
    (
      work_kind = 'mcp_invocation'
      AND completion_assignment_key IS NOT NULL
      AND completion_fencing_token > 0
    )
  );

ALTER TABLE forgex_completed_delivery_work
  DROP CONSTRAINT IF EXISTS forgex_completed_delivery_work_pkey;

ALTER TABLE forgex_completed_delivery_work
  ADD PRIMARY KEY (
    tenant_key,
    project_key,
    work_key,
    requirement_revision,
    work_kind
  );
