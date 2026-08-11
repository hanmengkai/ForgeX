ALTER TABLE forgex_requirements
  ADD COLUMN repository_key uuid;

CREATE INDEX forgex_requirements_repository_idx
  ON forgex_requirements (tenant_key, project_key, repository_key, position);
