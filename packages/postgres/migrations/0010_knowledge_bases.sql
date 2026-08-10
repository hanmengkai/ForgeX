CREATE TABLE IF NOT EXISTS forgex_knowledge_bases (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  knowledge_key uuid NOT NULL,
  creation_key uuid NOT NULL,
  created_by_key uuid NOT NULL,
  state jsonb NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, knowledge_key),
  UNIQUE (tenant_key, project_key, created_by_key, creation_key),
  CONSTRAINT forgex_knowledge_bases_state_scope_check CHECK (
    state ->> 'tenantKey' = tenant_key::text
    AND state ->> 'projectKey' = project_key::text
    AND state ->> 'knowledgeKey' = knowledge_key::text
    AND state ->> 'creationKey' = creation_key::text
    AND state #>> '{createdBy,actorKey}' = created_by_key::text
    AND (state ->> 'revision')::bigint = revision
  )
);

CREATE TABLE IF NOT EXISTS forgex_knowledge_source_artifacts (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  knowledge_key uuid NOT NULL,
  source_key uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 524288),
  media_type text NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_key,
    project_key,
    knowledge_key,
    source_key,
    source_revision
  ),
  UNIQUE (
    tenant_key,
    project_key,
    knowledge_key,
    source_key,
    source_revision,
    content_hash
  ),
  CONSTRAINT forgex_knowledge_source_artifact_bytes_check CHECK (
    octet_length(convert_to(content, 'UTF8')) = byte_length
  ),
  CONSTRAINT forgex_knowledge_source_artifact_base_fk FOREIGN KEY (
    tenant_key,
    project_key,
    knowledge_key
  ) REFERENCES forgex_knowledge_bases (
    tenant_key,
    project_key,
    knowledge_key
  ) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS forgex_knowledge_active_chunks (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  knowledge_key uuid NOT NULL,
  source_key uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  source_title text NOT NULL CHECK (char_length(source_title) BETWEEN 2 AND 100),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  ordinal integer NOT NULL CHECK (ordinal > 0 AND ordinal <= 1000),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1200),
  normalized_content text NOT NULL CHECK (
    char_length(normalized_content) BETWEEN 1 AND 2400
  ),
  tokens text[] NOT NULL CHECK (cardinality(tokens) BETWEEN 1 AND 2500),
  PRIMARY KEY (tenant_key, project_key, knowledge_key, source_key, ordinal),
  CONSTRAINT forgex_knowledge_active_chunk_artifact_fk FOREIGN KEY (
    tenant_key,
    project_key,
    knowledge_key,
    source_key,
    source_revision,
    content_hash
  ) REFERENCES forgex_knowledge_source_artifacts (
    tenant_key,
    project_key,
    knowledge_key,
    source_key,
    source_revision,
    content_hash
  ) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS forgex_knowledge_active_chunks_tokens_idx
  ON forgex_knowledge_active_chunks USING gin (tokens);

CREATE TABLE IF NOT EXISTS forgex_knowledge_audit (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  knowledge_key uuid NOT NULL,
  event_key uuid NOT NULL,
  action text NOT NULL CHECK (
    action IN ('knowledge_created', 'source_published', 'source_archived')
  ),
  state jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_key, project_key, event_key),
  CONSTRAINT forgex_knowledge_audit_state_scope_check CHECK (
    state ->> 'tenantKey' = tenant_key::text
    AND state ->> 'projectKey' = project_key::text
    AND state ->> 'knowledgeKey' = knowledge_key::text
    AND state ->> 'eventKey' = event_key::text
    AND state ->> 'action' = action
    AND (state ->> 'recordedAt')::timestamptz = recorded_at
  ),
  CONSTRAINT forgex_knowledge_audit_base_fk FOREIGN KEY (
    tenant_key,
    project_key,
    knowledge_key
  ) REFERENCES forgex_knowledge_bases (
    tenant_key,
    project_key,
    knowledge_key
  ) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS forgex_knowledge_audit_scope_idx
  ON forgex_knowledge_audit (
    tenant_key,
    project_key,
    knowledge_key,
    recorded_at DESC,
    event_key DESC
  );
