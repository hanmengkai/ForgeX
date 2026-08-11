import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";

const internalKeySchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
    "名称不能包含控制字符",
  );
const summarySchema = z.string().trim().min(4).max(500);
const defaultBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine(
    (value) => !value.includes("..") && !value.includes("@{"),
    "默认分支格式不正确",
  );
const localPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(value) &&
      !/[\u0000\r\n]/u.test(value),
    "本地路径必须是 Windows、UNC 或 Linux 绝对路径",
  );
const gitUrlSchema = z
  .string()
  .trim()
  .min(4)
  .max(1_000)
  .refine((value) => {
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(value)) return true;
    try {
      const url = new URL(value);
      return (
        ["https:", "ssh:", "git:"].includes(url.protocol) &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "Git 地址必须使用 HTTPS、SSH 或 Git 协议，且不能包含密码、查询参数或片段");

const customerCreateSchema = z
  .object({ name: nameSchema, summary: summarySchema })
  .strict();
const projectCreateSchema = customerCreateSchema;
const repositoryCreateSchema = z
  .object({
    name: nameSchema,
    gitUrl: gitUrlSchema,
    localPath: localPathSchema,
    defaultBranch: defaultBranchSchema,
  })
  .strict();
const updateBase = {
  expectedRevision: z.number().int().positive(),
  name: nameSchema,
  enabled: z.boolean(),
} as const;
const customerUpdateSchema = z
  .object({ ...updateBase, summary: summarySchema })
  .strict();
const projectUpdateSchema = customerUpdateSchema;
const repositoryUpdateSchema = z
  .object({
    ...updateBase,
    gitUrl: gitUrlSchema,
    localPath: localPathSchema,
    defaultBranch: defaultBranchSchema,
  })
  .strict();
const deleteSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

export interface PlatformRepositoryBinding {
  schemaVersion: 1;
  repositoryKey: string;
  projectKey: string;
  tenantKey: string;
  name: string;
  gitUrl: string;
  localPath: string;
  defaultBranch: string;
  enabled: boolean;
  revision: number;
}

export interface PlatformProject {
  schemaVersion: 1;
  projectKey: string;
  customerKey: string;
  tenantKey: string;
  name: string;
  summary: string;
  enabled: boolean;
  revision: number;
  repositories: PlatformRepositoryBinding[];
}

export interface PlatformCustomer {
  schemaVersion: 1;
  customerKey: string;
  tenantKey: string;
  name: string;
  summary: string;
  enabled: boolean;
  revision: number;
  projects: PlatformProject[];
}

export type PlatformCustomerCreateInput = z.input<typeof customerCreateSchema>;
export type PlatformCustomerUpdateInput = z.input<typeof customerUpdateSchema>;
export type PlatformProjectCreateInput = z.input<typeof projectCreateSchema>;
export type PlatformProjectUpdateInput = z.input<typeof projectUpdateSchema>;
export type PlatformRepositoryCreateInput = z.input<
  typeof repositoryCreateSchema
>;
export type PlatformRepositoryUpdateInput = z.input<
  typeof repositoryUpdateSchema
>;
export type PlatformConfigurationDeleteInput = z.input<typeof deleteSchema>;

export interface PlatformConfigurationRepository {
  list(tenantKey: string): Promise<PlatformCustomer[]>;
  createCustomer(
    tenantKey: string,
    input: PlatformCustomerCreateInput,
  ): Promise<PlatformCustomer>;
  updateCustomer(
    tenantKey: string,
    customerKey: string,
    input: PlatformCustomerUpdateInput,
  ): Promise<PlatformCustomer>;
  deleteCustomer(
    tenantKey: string,
    customerKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void>;
  createProject(
    tenantKey: string,
    customerKey: string,
    input: PlatformProjectCreateInput,
  ): Promise<PlatformProject>;
  updateProject(
    tenantKey: string,
    projectKey: string,
    input: PlatformProjectUpdateInput,
  ): Promise<PlatformProject>;
  deleteProject(
    tenantKey: string,
    projectKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void>;
  createRepository(
    tenantKey: string,
    projectKey: string,
    input: PlatformRepositoryCreateInput,
  ): Promise<PlatformRepositoryBinding>;
  updateRepository(
    tenantKey: string,
    repositoryKey: string,
    input: PlatformRepositoryUpdateInput,
  ): Promise<PlatformRepositoryBinding>;
  deleteRepository(
    tenantKey: string,
    repositoryKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void>;
}

const cloneRepository = (
  repository: PlatformRepositoryBinding,
): PlatformRepositoryBinding => ({ ...repository });
const cloneProject = (project: PlatformProject): PlatformProject => ({
  ...project,
  repositories: project.repositories.map(cloneRepository),
});
const cloneCustomer = (customer: PlatformCustomer): PlatformCustomer => ({
  ...customer,
  projects: customer.projects.map(cloneProject),
});

const conflict = (message: string): ApplicationError =>
  new ApplicationError(409, "platform_configuration_conflict", message);
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

export class InMemoryPlatformConfigurationRepository implements PlatformConfigurationRepository {
  readonly #customers = new Map<string, PlatformCustomer>();

  async list(tenantKey: string): Promise<PlatformCustomer[]> {
    const tenant = internalKeySchema.parse(tenantKey);
    return [...this.#customers.values()]
      .filter((customer) => customer.tenantKey === tenant)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
      .map(cloneCustomer);
  }

  async createCustomer(
    tenantKey: string,
    input: PlatformCustomerCreateInput,
  ): Promise<PlatformCustomer> {
    const tenant = internalKeySchema.parse(tenantKey);
    const parsed = customerCreateSchema.parse(input);
    if (
      [...this.#customers.values()].some(
        (item) => item.tenantKey === tenant && item.name === parsed.name,
      )
    ) {
      throw conflict("这个客户已经存在");
    }
    const customer: PlatformCustomer = {
      schemaVersion: 1,
      customerKey: randomUUID(),
      tenantKey: tenant,
      ...parsed,
      enabled: true,
      revision: 1,
      projects: [],
    };
    this.#customers.set(customer.customerKey, customer);
    return cloneCustomer(customer);
  }

  async updateCustomer(
    tenantKey: string,
    customerKey: string,
    input: PlatformCustomerUpdateInput,
  ): Promise<PlatformCustomer> {
    const tenant = internalKeySchema.parse(tenantKey);
    const key = internalKeySchema.parse(customerKey);
    const parsed = customerUpdateSchema.parse(input);
    const customer = this.#customers.get(key);
    if (!customer || customer.tenantKey !== tenant) throw notFound("客户");
    if (customer.revision !== parsed.expectedRevision) throw revisionConflict();
    if (
      [...this.#customers.values()].some(
        (item) =>
          item.customerKey !== key &&
          item.tenantKey === tenant &&
          item.name === parsed.name,
      )
    ) {
      throw conflict("这个客户名称已经被使用");
    }
    Object.assign(customer, {
      name: parsed.name,
      summary: parsed.summary,
      enabled: parsed.enabled,
      revision: customer.revision + 1,
    });
    return cloneCustomer(customer);
  }

  async deleteCustomer(
    tenantKey: string,
    customerKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    const customer = this.#customer(tenantKey, customerKey);
    const parsed = deleteSchema.parse(input);
    if (customer.revision !== parsed.expectedRevision) throw revisionConflict();
    if (customer.projects.length > 0) {
      throw conflict("请先删除这个客户下的项目");
    }
    this.#customers.delete(customer.customerKey);
  }

  async createProject(
    tenantKey: string,
    customerKey: string,
    input: PlatformProjectCreateInput,
  ): Promise<PlatformProject> {
    const customer = this.#customer(tenantKey, customerKey);
    const parsed = projectCreateSchema.parse(input);
    if (customer.projects.some((item) => item.name === parsed.name)) {
      throw conflict("这个客户下已经有同名项目");
    }
    const project: PlatformProject = {
      schemaVersion: 1,
      projectKey: randomUUID(),
      customerKey: customer.customerKey,
      tenantKey: customer.tenantKey,
      ...parsed,
      enabled: true,
      revision: 1,
      repositories: [],
    };
    customer.projects.push(project);
    return cloneProject(project);
  }

  async updateProject(
    tenantKey: string,
    projectKey: string,
    input: PlatformProjectUpdateInput,
  ): Promise<PlatformProject> {
    const { customer, project } = this.#project(tenantKey, projectKey);
    const parsed = projectUpdateSchema.parse(input);
    if (project.revision !== parsed.expectedRevision) throw revisionConflict();
    if (
      customer.projects.some(
        (item) =>
          item.projectKey !== project.projectKey && item.name === parsed.name,
      )
    ) {
      throw conflict("这个客户下已经有同名项目");
    }
    Object.assign(project, {
      name: parsed.name,
      summary: parsed.summary,
      enabled: parsed.enabled,
      revision: project.revision + 1,
    });
    return cloneProject(project);
  }

  async deleteProject(
    tenantKey: string,
    projectKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    const { customer, project } = this.#project(tenantKey, projectKey);
    const parsed = deleteSchema.parse(input);
    if (project.revision !== parsed.expectedRevision) throw revisionConflict();
    if (project.repositories.length > 0) {
      throw conflict("请先删除这个项目下的代码仓库");
    }
    customer.projects = customer.projects.filter(
      (item) => item.projectKey !== project.projectKey,
    );
  }

  async createRepository(
    tenantKey: string,
    projectKey: string,
    input: PlatformRepositoryCreateInput,
  ): Promise<PlatformRepositoryBinding> {
    const { project } = this.#project(tenantKey, projectKey);
    const parsed = repositoryCreateSchema.parse(input);
    if (
      project.repositories.some(
        (item) =>
          item.name === parsed.name ||
          item.gitUrl === parsed.gitUrl ||
          item.localPath.toLowerCase() === parsed.localPath.toLowerCase(),
      )
    ) {
      throw conflict("这个项目下已经有相同名称、Git 地址或本地路径的仓库");
    }
    const repository: PlatformRepositoryBinding = {
      schemaVersion: 1,
      repositoryKey: randomUUID(),
      projectKey: project.projectKey,
      tenantKey: project.tenantKey,
      ...parsed,
      enabled: true,
      revision: 1,
    };
    project.repositories.push(repository);
    return cloneRepository(repository);
  }

  async updateRepository(
    tenantKey: string,
    repositoryKey: string,
    input: PlatformRepositoryUpdateInput,
  ): Promise<PlatformRepositoryBinding> {
    const { project, repository } = this.#repository(tenantKey, repositoryKey);
    const parsed = repositoryUpdateSchema.parse(input);
    if (repository.revision !== parsed.expectedRevision)
      throw revisionConflict();
    if (
      project.repositories.some(
        (item) =>
          item.repositoryKey !== repository.repositoryKey &&
          (item.name === parsed.name ||
            item.gitUrl === parsed.gitUrl ||
            item.localPath.toLowerCase() === parsed.localPath.toLowerCase()),
      )
    ) {
      throw conflict("这个项目下已经有相同名称、Git 地址或本地路径的仓库");
    }
    Object.assign(repository, {
      name: parsed.name,
      gitUrl: parsed.gitUrl,
      localPath: parsed.localPath,
      defaultBranch: parsed.defaultBranch,
      enabled: parsed.enabled,
      revision: repository.revision + 1,
    });
    return cloneRepository(repository);
  }

  async deleteRepository(
    tenantKey: string,
    repositoryKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    const { project, repository } = this.#repository(tenantKey, repositoryKey);
    const parsed = deleteSchema.parse(input);
    if (repository.revision !== parsed.expectedRevision)
      throw revisionConflict();
    project.repositories = project.repositories.filter(
      (item) => item.repositoryKey !== repository.repositoryKey,
    );
  }

  #customer(tenantKey: string, customerKey: string): PlatformCustomer {
    const tenant = internalKeySchema.parse(tenantKey);
    const key = internalKeySchema.parse(customerKey);
    const customer = this.#customers.get(key);
    if (!customer || customer.tenantKey !== tenant) throw notFound("客户");
    return customer;
  }

  #project(
    tenantKey: string,
    projectKey: string,
  ): { customer: PlatformCustomer; project: PlatformProject } {
    const tenant = internalKeySchema.parse(tenantKey);
    const key = internalKeySchema.parse(projectKey);
    for (const customer of this.#customers.values()) {
      if (customer.tenantKey !== tenant) continue;
      const project = customer.projects.find((item) => item.projectKey === key);
      if (project) return { customer, project };
    }
    throw notFound("项目");
  }

  #repository(
    tenantKey: string,
    repositoryKey: string,
  ): { project: PlatformProject; repository: PlatformRepositoryBinding } {
    const tenant = internalKeySchema.parse(tenantKey);
    const key = internalKeySchema.parse(repositoryKey);
    for (const customer of this.#customers.values()) {
      if (customer.tenantKey !== tenant) continue;
      for (const project of customer.projects) {
        const repository = project.repositories.find(
          (item) => item.repositoryKey === key,
        );
        if (repository) return { project, repository };
      }
    }
    throw notFound("代码仓库");
  }
}

const requireAdministrator = (principal: AuthenticatedPrincipal): void => {
  if (!principal.roles.includes("administrator")) {
    throw new ApplicationError(
      403,
      "platform_configuration_admin_required",
      "只有超级管理员可以管理客户、项目和代码仓库",
    );
  }
};

const requirementContextNotFound = (): ApplicationError =>
  new ApplicationError(
    404,
    "requirement_context_not_found",
    "没有找到可用的客户、项目或代码仓库，请刷新后重新选择",
  );

export class PlatformConfigurationService {
  constructor(readonly repository: PlatformConfigurationRepository) {}

  async list(principal: AuthenticatedPrincipal): Promise<PlatformCustomer[]> {
    requireAdministrator(principal);
    return this.repository.list(principal.tenantKey);
  }

  async listRequirementContexts(
    principal: AuthenticatedPrincipal,
  ): Promise<PlatformCustomer[]> {
    const customers = await this.repository.list(principal.tenantKey);
    return customers
      .filter((customer) => customer.enabled)
      .map((customer) => ({
        ...customer,
        projects: customer.projects
          .filter((project) => project.enabled)
          .map((project) => ({
            ...project,
            repositories: project.repositories
              .filter((repository) => repository.enabled)
              .map(cloneRepository),
          })),
      }));
  }

  async getRequirementProject(
    principal: AuthenticatedPrincipal,
    projectKey: string,
  ): Promise<PlatformProject> {
    const project = internalKeySchema.parse(projectKey);
    const customers = await this.listRequirementContexts(principal);
    const match = customers
      .flatMap((customer) => customer.projects)
      .find((candidate) => candidate.projectKey === project);
    if (!match) throw requirementContextNotFound();
    return cloneProject(match);
  }

  async getRequirementRepository(
    principal: AuthenticatedPrincipal,
    projectKey: string,
    repositoryKey: string,
  ): Promise<PlatformRepositoryBinding> {
    const project = await this.getRequirementProject(principal, projectKey);
    const repository = internalKeySchema.parse(repositoryKey);
    const match = project.repositories.find(
      (candidate) => candidate.repositoryKey === repository,
    );
    if (!match) throw requirementContextNotFound();
    return cloneRepository(match);
  }

  async createCustomer(
    principal: AuthenticatedPrincipal,
    input: PlatformCustomerCreateInput,
  ): Promise<PlatformCustomer> {
    requireAdministrator(principal);
    return this.repository.createCustomer(
      principal.tenantKey,
      customerCreateSchema.parse(input),
    );
  }

  async updateCustomer(
    principal: AuthenticatedPrincipal,
    customerKey: string,
    input: PlatformCustomerUpdateInput,
  ): Promise<PlatformCustomer> {
    requireAdministrator(principal);
    return this.repository.updateCustomer(
      principal.tenantKey,
      internalKeySchema.parse(customerKey),
      customerUpdateSchema.parse(input),
    );
  }

  async deleteCustomer(
    principal: AuthenticatedPrincipal,
    customerKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    requireAdministrator(principal);
    return this.repository.deleteCustomer(
      principal.tenantKey,
      internalKeySchema.parse(customerKey),
      deleteSchema.parse(input),
    );
  }

  async createProject(
    principal: AuthenticatedPrincipal,
    customerKey: string,
    input: PlatformProjectCreateInput,
  ): Promise<PlatformProject> {
    requireAdministrator(principal);
    return this.repository.createProject(
      principal.tenantKey,
      internalKeySchema.parse(customerKey),
      projectCreateSchema.parse(input),
    );
  }

  async updateProject(
    principal: AuthenticatedPrincipal,
    projectKey: string,
    input: PlatformProjectUpdateInput,
  ): Promise<PlatformProject> {
    requireAdministrator(principal);
    return this.repository.updateProject(
      principal.tenantKey,
      internalKeySchema.parse(projectKey),
      projectUpdateSchema.parse(input),
    );
  }

  async deleteProject(
    principal: AuthenticatedPrincipal,
    projectKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    requireAdministrator(principal);
    return this.repository.deleteProject(
      principal.tenantKey,
      internalKeySchema.parse(projectKey),
      deleteSchema.parse(input),
    );
  }

  async createRepository(
    principal: AuthenticatedPrincipal,
    projectKey: string,
    input: PlatformRepositoryCreateInput,
  ): Promise<PlatformRepositoryBinding> {
    requireAdministrator(principal);
    return this.repository.createRepository(
      principal.tenantKey,
      internalKeySchema.parse(projectKey),
      repositoryCreateSchema.parse(input),
    );
  }

  async updateRepository(
    principal: AuthenticatedPrincipal,
    repositoryKey: string,
    input: PlatformRepositoryUpdateInput,
  ): Promise<PlatformRepositoryBinding> {
    requireAdministrator(principal);
    return this.repository.updateRepository(
      principal.tenantKey,
      internalKeySchema.parse(repositoryKey),
      repositoryUpdateSchema.parse(input),
    );
  }

  async deleteRepository(
    principal: AuthenticatedPrincipal,
    repositoryKey: string,
    input: PlatformConfigurationDeleteInput,
  ): Promise<void> {
    requireAdministrator(principal);
    return this.repository.deleteRepository(
      principal.tenantKey,
      internalKeySchema.parse(repositoryKey),
      deleteSchema.parse(input),
    );
  }
}
