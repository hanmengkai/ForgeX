CREATE TABLE forgex_extension_catalog (
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  extension_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('knowledge', 'skill', 'mcp')),
  revision integer NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, project_key, extension_key),
  CHECK ((definition ->> 'tenantKey') IS NOT DISTINCT FROM tenant_key::text),
  CHECK ((definition ->> 'projectKey') IS NOT DISTINCT FROM project_key::text),
  CHECK (
    (definition ->> 'extensionKey') IS NOT DISTINCT FROM extension_key::text
  ),
  CHECK ((definition ->> 'kind') IS NOT DISTINCT FROM kind),
  CHECK (
    ((definition ->> 'revision')::integer) IS NOT DISTINCT FROM revision
  ),
  CHECK ((definition ->> 'schemaVersion') IS NOT DISTINCT FROM '1')
);

CREATE UNIQUE INDEX forgex_extension_catalog_kind_name_unique
  ON forgex_extension_catalog (
    tenant_key,
    project_key,
    kind,
    lower(definition ->> 'name')
  );
