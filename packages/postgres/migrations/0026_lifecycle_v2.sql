-- 2.0 生命周期与审批、任务、通知在同一租户事务中持久化。
CREATE TABLE forgex_lifecycle_states (
  tenant_key uuid PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version = 2),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE forgex_platform_accounts DROP CONSTRAINT forgex_platform_accounts_roles_check;
ALTER TABLE forgex_platform_accounts ADD CONSTRAINT forgex_platform_accounts_roles_check
  CHECK (cardinality(roles) BETWEEN 1 AND 8 AND roles <@ ARRAY['product_owner', 'requirement_analyst', 'developer', 'administrator', 'requester', 'tester', 'test_ops', 'production_ops']::text[]);
