CREATE TABLE forgex_platform_accounts (
  account_key uuid PRIMARY KEY,
  tenant_key uuid NOT NULL,
  username text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$' AND length(username) BETWEEN 3 AND 64),
  actor_name text NOT NULL CHECK (length(btrim(actor_name)) BETWEEN 2 AND 100),
  roles text[] NOT NULL CHECK (cardinality(roles) BETWEEN 1 AND 4 AND roles <@ ARRAY['product_owner', 'requirement_analyst', 'developer', 'administrator']::text[]),
  password_salt bytea NOT NULL CHECK (octet_length(password_salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 32),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX forgex_platform_accounts_tenant_username_idx
  ON forgex_platform_accounts (tenant_key, username);
