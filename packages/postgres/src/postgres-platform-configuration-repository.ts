import { randomUUID } from "node:crypto";

import {
  ApplicationError,
  type PlatformConfigurationDeleteInput,
  type PlatformConfigurationRepository,
  type PlatformCustomer,
  type PlatformCustomerCreateInput,
  type PlatformCustomerUpdateInput,
  type PlatformProject,
  type PlatformProjectCreateInput,
  type PlatformProjectUpdateInput,
  type PlatformRepositoryBinding,
  type PlatformRepositoryCreateInput,
  type PlatformRepositoryUpdateInput,
} from "@forgex/application";
import { z } from "zod";

import type { PostgresQueryResult } from "./postgres-worker-fleet-repository.js";

export interface PostgresPlatformConfigurationPool {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

const customerRowSchema = z
  .object({
    customer_key: z.string().uuid(),
    tenant_key: z.string().uuid(),
    name: z.string(),
    summary: z.string(),
    enabled: z.boolean(),
    revision: z.coerce.number().int().positive(),
  })
  .passthrough();
const projectRowSchema = z
  .object({
    project_key: z.string().uuid(),
    customer_key: z.string().uuid(),
    tenant_key: z.string().uuid(),
    name: z.string(),
    summary: z.string(),
    enabled: z.boolean(),
    revision: z.coerce.number().int().positive(),
  })
  .passthrough();
const repositoryRowSchema = z
  .object({
    repository_key: z.string().uuid(),
    project_key: z.string().uuid(),
    tenant_key: z.string().uuid(),
    name: z.string(),
    git_url: z.string(),
    local_path: z.string(),
    default_branch: z.string(),
    enabled: z.boolean(),
    revision: z.coerce.number().int().positive(),
  })
  .passthrough();

const customerFrom = (row: unknown): PlatformCustomer => {
  const parsed = customerRowSchema.parse(row);
  return {
    schemaVersion: 1,
    customerKey: parsed.customer_key.toLowerCase(),
    tenantKey: parsed.tenant_key.toLowerCase(),
    name: parsed.name,
    summary: parsed.summary,
    enabled: parsed.enabled,
    revision: parsed.revision,
    projects: [],
  };
};
const projectFrom = (row: unknown): PlatformProject => {
  const parsed = projectRowSchema.parse(row);
  return {
    schemaVersion: 1,
    projectKey: parsed.project_key.toLowerCase(),
    customerKey: parsed.customer_key.toLowerCase(),
    tenantKey: parsed.tenant_key.toLowerCase(),
    name: parsed.name,
    summary: parsed.summary,
    enabled: parsed.enabled,
    revision: parsed.revision,
    repositories: [],
  };
};
const repositoryFrom = (row: unknown): PlatformRepositoryBinding => {
  const parsed = repositoryRowSchema.parse(row);
  return {
    schemaVersion: 1,
    repositoryKey: parsed.repository_key.toLowerCase(),
    projectKey: parsed.project_key.toLowerCase(),
    tenantKey: parsed.tenant_key.toLowerCase(),
    name: parsed.name,
    gitUrl: parsed.git_url,
    localPath: parsed.local_path,
    defaultBranch: parsed.default_branch,
    enabled: parsed.enabled,
    revision: parsed.revision,
  };
};

const postgresCode = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
const revisionConflict = (): ApplicationError =>
  new ApplicationError(
    409,
    "platform_configuration_revision_conflict",
    "配置信息已经更新，请刷新后重试",
  );
const notFound = (label: string): ApplicationError =>
  new ApplicationError(
    404,
    "platform_configuration_not_found",
    `没有找到这个${label}`,
  );
const conflict = (message: string): ApplicationError =>
  new ApplicationError(409, "platform_configuration_conflict", message);

const customerColumns =
  "customer_key, tenant_key, name, summary, enabled, revision";
const projectColumns =
  "project_key, customer_key, tenant_key, name, summary, enabled, revision";
const repositoryColumns =
  "repository_key, project_key, tenant_key, name, git_url, local_path, default_branch, enabled, revision";

export class PostgresPlatformConfigurationRepository implements PlatformConfigurationRepository {
  constructor(readonly pool: PostgresPlatformConfigurationPool) {}

  async list(tenantKey: string): Promise<PlatformCustomer[]> {
    const [customerRows, projectRows, repositoryRows] = await Promise.all([
      this.pool.query(
        `SELECT ${customerColumns} FROM forgex_platform_customers WHERE tenant_key = $1 ORDER BY created_at, customer_key`,
        [tenantKey],
      ),
      this.pool.query(
        `SELECT ${projectColumns} FROM forgex_platform_projects WHERE tenant_key = $1 ORDER BY created_at, project_key`,
        [tenantKey],
      ),
      this.pool.query(
        `SELECT ${repositoryColumns} FROM forgex_platform_repositories WHERE tenant_key = $1 ORDER BY created_at, repository_key`,
        [tenantKey],
      ),
    ]);
    const customers = customerRows.rows.map(customerFrom);
    const customersByKey = new Map(
      customers.map((customer) => [customer.customerKey, customer]),
    );
    const projects = projectRows.rows.map(projectFrom);
    const projectsByKey = new Map(
      projects.map((project) => [project.projectKey, project]),
    );
    for (const project of projects) {
      const customer = customersByKey.get(project.customerKey);
      if (!customer) throw new Error("平台项目缺少所属客户");
      customer.projects.push(project);
    }
    for (const repository of repositoryRows.rows.map(repositoryFrom)) {
      const project = projectsByKey.get(repository.projectKey);
      if (!project) throw new Error("代码仓库缺少所属项目");
      project.repositories.push(repository);
    }
    return customers;
  }

  async createCustomer(
    tenantKey: string,
    input: PlatformCustomerCreateInput,
  ): Promise<PlatformCustomer> {
    try {
      const result = await this.pool.query(
        `INSERT INTO forgex_platform_customers (customer_key, tenant_key, name, summary) VALUES ($1, $2, $3, $4) RETURNING ${customerColumns}`,
        [randomUUID(), tenantKey, input.name, input.summary],
      );
      return customerFrom(result.rows[0]);
    } catch (error) {
      if (postgresCode(error) === "23505") throw conflict("这个客户已经存在");
      throw error;
    }
  }

  async updateCustomer(
    tenantKey: string,
    customerKey: string,
    input: PlatformCustomerUpdateInput,
  ): Promise<PlatformCustomer> {
    try {
      const result = await this.pool.query(
        `UPDATE forgex_platform_customers SET name = $4, summary = $5, enabled = $6, revision = revision + 1, updated_at = now() WHERE tenant_key = $1 AND customer_key = $2 AND revision = $3 RETURNING ${customerColumns}`,
        [
          tenantKey,
          customerKey,
          input.expectedRevision,
          input.name,
          input.summary,
          input.enabled,
        ],
      );
      if (result.rows[0]) return customerFrom(result.rows[0]);
      return this.throwMissingOrRevision(
        "forgex_platform_customers",
        "customer_key",
        tenantKey,
        customerKey,
        "客户",
      );
    } catch (error) {
      if (postgresCode(error) === "23505")
        throw conflict("这个客户名称已经被使用");
      throw error;
    }
  }

  async deleteCustomer(
    tenantKey: string,
    customerKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    try {
      const result = await this.pool.query(
        "DELETE FROM forgex_platform_customers WHERE tenant_key = $1 AND customer_key = $2 AND revision = $3 RETURNING customer_key",
        [tenantKey, customerKey, input.expectedRevision],
      );
      if (result.rows[0]) return;
      await this.throwMissingOrRevision(
        "forgex_platform_customers",
        "customer_key",
        tenantKey,
        customerKey,
        "客户",
      );
    } catch (error) {
      if (postgresCode(error) === "23503")
        throw conflict("请先删除这个客户下的项目");
      throw error;
    }
  }

  async createProject(
    tenantKey: string,
    customerKey: string,
    input: PlatformProjectCreateInput,
  ): Promise<PlatformProject> {
    try {
      const result = await this.pool.query(
        `INSERT INTO forgex_platform_projects (project_key, tenant_key, customer_key, name, summary) SELECT $1, $2, customer_key, $4, $5 FROM forgex_platform_customers WHERE tenant_key = $2 AND customer_key = $3 RETURNING ${projectColumns}`,
        [randomUUID(), tenantKey, customerKey, input.name, input.summary],
      );
      if (!result.rows[0]) throw notFound("客户");
      return projectFrom(result.rows[0]);
    } catch (error) {
      if (postgresCode(error) === "23505")
        throw conflict("这个客户下已经有同名项目");
      throw error;
    }
  }

  async updateProject(
    tenantKey: string,
    projectKey: string,
    input: PlatformProjectUpdateInput,
  ): Promise<PlatformProject> {
    try {
      const result = await this.pool.query(
        `UPDATE forgex_platform_projects SET name = $4, summary = $5, enabled = $6, revision = revision + 1, updated_at = now() WHERE tenant_key = $1 AND project_key = $2 AND revision = $3 RETURNING ${projectColumns}`,
        [
          tenantKey,
          projectKey,
          input.expectedRevision,
          input.name,
          input.summary,
          input.enabled,
        ],
      );
      if (result.rows[0]) return projectFrom(result.rows[0]);
      return this.throwMissingOrRevision(
        "forgex_platform_projects",
        "project_key",
        tenantKey,
        projectKey,
        "项目",
      );
    } catch (error) {
      if (postgresCode(error) === "23505")
        throw conflict("这个客户下已经有同名项目");
      throw error;
    }
  }

  async deleteProject(
    tenantKey: string,
    projectKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    try {
      const result = await this.pool.query(
        "DELETE FROM forgex_platform_projects WHERE tenant_key = $1 AND project_key = $2 AND revision = $3 RETURNING project_key",
        [tenantKey, projectKey, input.expectedRevision],
      );
      if (result.rows[0]) return;
      await this.throwMissingOrRevision(
        "forgex_platform_projects",
        "project_key",
        tenantKey,
        projectKey,
        "项目",
      );
    } catch (error) {
      if (postgresCode(error) === "23503")
        throw conflict("请先删除这个项目下的代码仓库");
      throw error;
    }
  }

  async createRepository(
    tenantKey: string,
    projectKey: string,
    input: PlatformRepositoryCreateInput,
  ): Promise<PlatformRepositoryBinding> {
    try {
      const result = await this.pool.query(
        `INSERT INTO forgex_platform_repositories (repository_key, tenant_key, project_key, name, git_url, local_path, default_branch) SELECT $1, $2, project_key, $4, $5, $6, $7 FROM forgex_platform_projects WHERE tenant_key = $2 AND project_key = $3 RETURNING ${repositoryColumns}`,
        [
          randomUUID(),
          tenantKey,
          projectKey,
          input.name,
          input.gitUrl,
          input.localPath,
          input.defaultBranch,
        ],
      );
      if (!result.rows[0]) throw notFound("项目");
      return repositoryFrom(result.rows[0]);
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw conflict("这个项目下已经有相同名称、Git 地址或本地路径的仓库");
      }
      throw error;
    }
  }

  async updateRepository(
    tenantKey: string,
    repositoryKey: string,
    input: PlatformRepositoryUpdateInput,
  ): Promise<PlatformRepositoryBinding> {
    try {
      const result = await this.pool.query(
        `UPDATE forgex_platform_repositories SET name = $4, git_url = $5, local_path = $6, default_branch = $7, enabled = $8, revision = revision + 1, updated_at = now() WHERE tenant_key = $1 AND repository_key = $2 AND revision = $3 RETURNING ${repositoryColumns}`,
        [
          tenantKey,
          repositoryKey,
          input.expectedRevision,
          input.name,
          input.gitUrl,
          input.localPath,
          input.defaultBranch,
          input.enabled,
        ],
      );
      if (result.rows[0]) return repositoryFrom(result.rows[0]);
      return this.throwMissingOrRevision(
        "forgex_platform_repositories",
        "repository_key",
        tenantKey,
        repositoryKey,
        "代码仓库",
      );
    } catch (error) {
      if (postgresCode(error) === "23505") {
        throw conflict("这个项目下已经有相同名称、Git 地址或本地路径的仓库");
      }
      throw error;
    }
  }

  async deleteRepository(
    tenantKey: string,
    repositoryKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    const result = await this.pool.query(
      "DELETE FROM forgex_platform_repositories WHERE tenant_key = $1 AND repository_key = $2 AND revision = $3 RETURNING repository_key",
      [tenantKey, repositoryKey, input.expectedRevision],
    );
    if (result.rows[0]) return;
    await this.throwMissingOrRevision(
      "forgex_platform_repositories",
      "repository_key",
      tenantKey,
      repositoryKey,
      "代码仓库",
    );
  }

  private async throwMissingOrRevision<T>(
    table: string,
    keyColumn: string,
    tenantKey: string,
    resourceKey: string,
    label: string,
  ): Promise<T> {
    const allowed = new Map([
      ["forgex_platform_customers", "customer_key"],
      ["forgex_platform_projects", "project_key"],
      ["forgex_platform_repositories", "repository_key"],
    ]);
    if (allowed.get(table) !== keyColumn) {
      throw new Error("平台配置资源类型无效");
    }
    const existing = await this.pool.query(
      `SELECT 1 FROM ${table} WHERE tenant_key = $1 AND ${keyColumn} = $2`,
      [tenantKey, resourceKey],
    );
    if (!existing.rows[0]) throw notFound(label);
    throw revisionConflict();
  }
}
