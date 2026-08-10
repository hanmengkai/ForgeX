CREATE TABLE IF NOT EXISTS forgex_worker_fleets (
  tenant_key uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forgex_completed_delivery_work (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  work_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, work_key, requirement_revision)
);
