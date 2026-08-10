CREATE TABLE IF NOT EXISTS forgex_mcp_input_schemas (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  input_schema_hash text NOT NULL CHECK (input_schema_hash ~ '^[0-9a-f]{64}$'),
  schema jsonb NOT NULL CHECK (jsonb_typeof(schema) = 'object'),
  canonical_size_bytes integer NOT NULL CHECK (
    canonical_size_bytes > 0 AND canonical_size_bytes <= 65536
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, input_schema_hash)
);

CREATE TABLE IF NOT EXISTS forgex_mcp_invocations (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  invocation_key uuid NOT NULL,
  request_key uuid NOT NULL,
  requested_by_key uuid NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  input_schema_hash text NOT NULL CHECK (input_schema_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (
    status IN (
      'awaiting_approval',
      'queued',
      'leased',
      'completion_pending',
      'succeeded',
      'failed',
      'cancellation_pending',
      'cancelled',
      'outcome_unknown_pending_cleanup',
      'outcome_unknown'
    )
  ),
  state jsonb NOT NULL,
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, invocation_key),
  UNIQUE (tenant_key, project_key, requested_by_key, request_key),
  CONSTRAINT forgex_mcp_invocations_state_scope_check CHECK (
    (state ->> 'tenantKey') IS NOT DISTINCT FROM tenant_key::text
    AND (state ->> 'projectKey') IS NOT DISTINCT FROM project_key::text
    AND (state ->> 'invocationKey') IS NOT DISTINCT FROM invocation_key::text
    AND (state ->> 'requestKey') IS NOT DISTINCT FROM request_key::text
    AND (state ->> 'requestedByKey') IS NOT DISTINCT FROM requested_by_key::text
    AND (state ->> 'manifestHash') IS NOT DISTINCT FROM manifest_hash
    AND (state ->> 'inputSchemaHash') IS NOT DISTINCT FROM input_schema_hash
    AND (state ->> 'status') IS NOT DISTINCT FROM status
  ),
  FOREIGN KEY (tenant_key, project_key, input_schema_hash)
    REFERENCES forgex_mcp_input_schemas (tenant_key, project_key, input_schema_hash)
);

CREATE TABLE IF NOT EXISTS forgex_mcp_invocation_audit (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  event_key uuid NOT NULL,
  invocation_key uuid NOT NULL,
  action text NOT NULL CHECK (
    action IN ('approved', 'leased', 'completed', 'cancelled', 'outcome_unknown')
  ),
  state jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_key, project_key, event_key),
  CONSTRAINT forgex_mcp_invocation_audit_state_scope_check CHECK (
    (state ->> 'tenantKey') IS NOT DISTINCT FROM tenant_key::text
    AND (state ->> 'projectKey') IS NOT DISTINCT FROM project_key::text
    AND (state ->> 'eventKey') IS NOT DISTINCT FROM event_key::text
    AND (state ->> 'invocationKey') IS NOT DISTINCT FROM invocation_key::text
    AND (state ->> 'action') IS NOT DISTINCT FROM action
  ),
  FOREIGN KEY (tenant_key, project_key, invocation_key)
    REFERENCES forgex_mcp_invocations (tenant_key, project_key, invocation_key)
);

CREATE INDEX IF NOT EXISTS forgex_mcp_invocations_queue_idx
  ON forgex_mcp_invocations (tenant_key, project_key, status, requested_at);

CREATE INDEX IF NOT EXISTS forgex_mcp_invocations_outstanding_idx
  ON forgex_mcp_invocations (tenant_key, status)
  WHERE status IN (
    'awaiting_approval',
    'queued',
    'leased',
    'completion_pending',
    'cancellation_pending',
    'outcome_unknown_pending_cleanup'
  );

CREATE INDEX IF NOT EXISTS forgex_mcp_invocations_dispatch_idx
  ON forgex_mcp_invocations (
    tenant_key,
    (
      CASE
        WHEN status IN ('cancellation_pending', 'outcome_unknown_pending_cleanup') THEN 0
        WHEN status = 'completion_pending' THEN 1
        WHEN status = 'leased' THEN 2
        ELSE 3
      END
    ),
    requested_at,
    invocation_key
  )
  WHERE status IN (
    'queued',
    'leased',
    'cancellation_pending',
    'completion_pending',
    'outcome_unknown_pending_cleanup'
  );
