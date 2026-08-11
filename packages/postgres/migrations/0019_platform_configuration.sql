CREATE TABLE forgex_platform_customers (
  customer_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 100),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 4 AND 500),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_key, customer_key),
  UNIQUE (tenant_key, name)
);

CREATE TABLE forgex_platform_projects (
  project_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  customer_key uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 100),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 4 AND 500),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_key, project_key),
  UNIQUE (customer_key, name),
  FOREIGN KEY (tenant_key, customer_key)
    REFERENCES forgex_platform_customers (tenant_key, customer_key)
    ON DELETE RESTRICT
);

CREATE TABLE forgex_platform_repositories (
  repository_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  project_key uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 100),
  git_url text NOT NULL CHECK (length(btrim(git_url)) BETWEEN 4 AND 1000),
  local_path text NOT NULL CHECK (length(btrim(local_path)) BETWEEN 1 AND 1000),
  default_branch text NOT NULL CHECK (length(btrim(default_branch)) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_key, name),
  UNIQUE (project_key, git_url),
  UNIQUE (project_key, local_path),
  FOREIGN KEY (tenant_key, project_key)
    REFERENCES forgex_platform_projects (tenant_key, project_key)
    ON DELETE RESTRICT
);

CREATE INDEX forgex_platform_projects_customer_idx
  ON forgex_platform_projects (tenant_key, customer_key, name);

CREATE INDEX forgex_platform_repositories_project_idx
  ON forgex_platform_repositories (tenant_key, project_key, name);
