CREATE TABLE forgex_project_initializations (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  preset_key text NOT NULL CHECK (length(btrim(preset_key)) BETWEEN 1 AND 100),
  preset_version integer NOT NULL CHECK (preset_version > 0),
  request_key uuid NOT NULL,
  created_by_key uuid NOT NULL,
  created_by_name text NOT NULL CHECK (
    length(btrim(created_by_name)) BETWEEN 2 AND 100
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_key, project_key),
  UNIQUE (tenant_key, request_key),
  FOREIGN KEY (tenant_key, project_key)
    REFERENCES forgex_platform_projects (tenant_key, project_key)
    ON DELETE RESTRICT
);

CREATE INDEX forgex_project_initializations_preset_idx
  ON forgex_project_initializations (
    tenant_key,
    preset_key,
    preset_version,
    created_at
  );
