-- 正式控制面保存版本化制品原始字节，重传不可覆盖已有范围内的内容。
CREATE TABLE forgex_lifecycle_artifacts (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  repository_key uuid NOT NULL,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 131072),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, repository_key, artifact_digest, commit_sha)
);
