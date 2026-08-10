CREATE TABLE forgex_preview_artifacts (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  requirement_key uuid NOT NULL,
  requirement_revision integer NOT NULL CHECK (requirement_revision > 0),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL CHECK (
    octet_length(content) > 0
    AND octet_length(content) <= 5242880
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, requirement_key, requirement_revision, artifact_hash)
);
