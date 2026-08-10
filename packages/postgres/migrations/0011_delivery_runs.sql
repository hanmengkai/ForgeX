ALTER TABLE forgex_completed_delivery_work
  ADD COLUMN IF NOT EXISTS completion_digest text;

ALTER TABLE forgex_completed_delivery_work
  DROP CONSTRAINT IF EXISTS forgex_completed_delivery_work_completion_proof_check;

ALTER TABLE forgex_completed_delivery_work
  ADD CONSTRAINT forgex_completed_delivery_work_completion_proof_check
  CHECK (
    (
      work_kind = 'requirement_delivery' AND
      (
        (
          completion_assignment_key IS NULL AND
          completion_fencing_token IS NULL AND
          completion_digest IS NULL
        ) OR (
          completion_assignment_key IS NOT NULL AND
          completion_fencing_token > 0 AND
          completion_digest ~ '^[a-f0-9]{64}$'
        )
      )
    ) OR (
      work_kind = 'mcp_invocation' AND
      completion_assignment_key IS NOT NULL AND
      completion_fencing_token > 0 AND
      completion_digest IS NULL
    )
  );

ALTER TABLE forgex_delivery_outbox
  ADD COLUMN IF NOT EXISTS repository_key uuid;

UPDATE forgex_delivery_outbox
SET repository_key = project_key
WHERE repository_key IS NULL;

ALTER TABLE forgex_delivery_outbox
  ALTER COLUMN repository_key SET NOT NULL;

CREATE TABLE IF NOT EXISTS forgex_delivery_runs (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  repository_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  assignment_key uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  git_hash_algorithm text NOT NULL CHECK (
    git_hash_algorithm IN ('sha1', 'sha256')
  ),
  base_commit text NOT NULL,
  commit_sha text NOT NULL,
  branch_name text NOT NULL CHECK (
    char_length(branch_name) BETWEEN 1 AND 250 AND
    branch_name ~ '^forgex/[a-f0-9-]+/[a-f0-9-]+$'
  ),
  summary text NOT NULL CHECK (
    summary = '已生成本地提交，等待独立验证'
  ),
  status text NOT NULL CHECK (
    status IN ('completion_pending', 'completed')
  ),
  submitted_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (
    tenant_key,
    project_key,
    requirement_key,
    requirement_revision
  ),
  UNIQUE (tenant_key, assignment_key, fencing_token),
  CHECK (base_commit <> commit_sha),
  CHECK (
    (git_hash_algorithm = 'sha1' AND
      base_commit ~ '^[a-f0-9]{40}$' AND
      commit_sha ~ '^[a-f0-9]{40}$') OR
    (git_hash_algorithm = 'sha256' AND
      base_commit ~ '^[a-f0-9]{64}$' AND
      commit_sha ~ '^[a-f0-9]{64}$')
  ),
  CHECK (
    (status = 'completion_pending' AND completed_at IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL)
  ),
  CHECK (completed_at IS NULL OR completed_at >= submitted_at),
  FOREIGN KEY (tenant_key, project_key, requirement_key)
    REFERENCES forgex_requirements (tenant_key, project_key, requirement_key)
    ON DELETE RESTRICT
);

ALTER TABLE forgex_delivery_runs
  DROP CONSTRAINT IF EXISTS forgex_delivery_runs_summary_check;

ALTER TABLE forgex_delivery_runs
  ADD CONSTRAINT forgex_delivery_runs_summary_check
  CHECK (summary = '已生成本地提交，等待独立验证');

CREATE INDEX IF NOT EXISTS forgex_delivery_runs_pending_idx
  ON forgex_delivery_runs (tenant_key, submitted_at, assignment_key)
  WHERE status = 'completion_pending';

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
      'delivery.completed'
    )
  );
