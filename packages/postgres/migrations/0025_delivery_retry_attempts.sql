ALTER TABLE forgex_delivery_outbox
  ADD COLUMN IF NOT EXISTS retry_of_dispatch_key uuid;

ALTER TABLE forgex_delivery_outbox
  DROP CONSTRAINT IF EXISTS forgex_delivery_outbox_retry_source_fkey;

ALTER TABLE forgex_delivery_outbox
  ADD CONSTRAINT forgex_delivery_outbox_retry_source_fkey
  FOREIGN KEY (retry_of_dispatch_key)
  REFERENCES forgex_delivery_outbox (dispatch_key)
  ON DELETE RESTRICT;

ALTER TABLE forgex_delivery_outbox
  DROP CONSTRAINT IF EXISTS forgex_delivery_outbox_retry_source_check;

ALTER TABLE forgex_delivery_outbox
  ADD CONSTRAINT forgex_delivery_outbox_retry_source_check CHECK (
    retry_of_dispatch_key IS NULL OR retry_of_dispatch_key <> dispatch_key
  );

CREATE TABLE IF NOT EXISTS forgex_delivery_retry_preparations (
  dispatch_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (dispatch_key)
    REFERENCES forgex_delivery_outbox (dispatch_key)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_key, project_key, requirement_key)
    REFERENCES forgex_requirements (tenant_key, project_key, requirement_key)
    ON DELETE RESTRICT
);
