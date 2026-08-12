import { z } from "zod";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";

const internalKeySchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

const initializationCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    presetKey: z.string().trim().min(1).max(100),
    presetVersion: z.number().int().positive(),
    requestKey: internalKeySchema,
  })
  .strict();

export const STANDARD_DELIVERY_PRESET = {
  key: "standard-delivery",
  version: 1,
  name: "标准 AI 交付",
} as const;

export interface ProjectInitializationRecord {
  schemaVersion: 1;
  tenantKey: string;
  projectKey: string;
  presetKey: string;
  presetVersion: number;
  requestKey: string;
  createdByKey: string;
  createdByName: string;
  createdAt: string;
}

export interface ProjectInitializationRepository {
  find(
    tenantKey: string,
    projectKey: string,
  ): Promise<ProjectInitializationRecord | null>;
  findByRequest(
    tenantKey: string,
    requestKey: string,
  ): Promise<ProjectInitializationRecord | null>;
  createIfAbsent(
    record: ProjectInitializationRecord,
  ): Promise<ProjectInitializationRecord>;
}

export interface ProjectInitializationReadiness {
  knowledgeReady: boolean;
  skillReady: boolean;
  mcpReady: boolean;
}

export interface ProjectInitializationReadinessInspector {
  inspect(
    tenantKey: string,
    projectKey: string,
  ): Promise<ProjectInitializationReadiness>;
}

export interface ProjectInitializationTask {
  key: "knowledge" | "skill" | "mcp";
  name: string;
  detail: string;
  status: "ready" | "action_required";
}

export interface ProjectInitializationView {
  status: "not_started" | "action_required" | "ready";
  preset: typeof STANDARD_DELIVERY_PRESET;
  record: ProjectInitializationRecord | null;
  tasks: ProjectInitializationTask[];
}

export type ProjectInitializationCommand = z.input<
  typeof initializationCommandSchema
>;

const cloneRecord = (
  record: ProjectInitializationRecord,
): ProjectInitializationRecord => ({ ...record });

export class InMemoryProjectInitializationRepository implements ProjectInitializationRepository {
  readonly #records = new Map<string, ProjectInitializationRecord>();
  readonly #requestProjects = new Map<string, string>();

  async find(
    tenantKey: string,
    projectKey: string,
  ): Promise<ProjectInitializationRecord | null> {
    const key = this.#key(tenantKey, projectKey);
    const record = this.#records.get(key);
    return record ? cloneRecord(record) : null;
  }

  async findByRequest(
    tenantKey: string,
    requestKey: string,
  ): Promise<ProjectInitializationRecord | null> {
    const tenant = internalKeySchema.parse(tenantKey);
    const request = internalKeySchema.parse(requestKey);
    const projectKey = this.#requestProjects.get(`${tenant}:${request}`);
    if (!projectKey) return null;
    const record = this.#records.get(`${tenant}:${projectKey}`);
    return record ? cloneRecord(record) : null;
  }

  async createIfAbsent(
    input: ProjectInitializationRecord,
  ): Promise<ProjectInitializationRecord> {
    const key = this.#key(input.tenantKey, input.projectKey);
    const existing = this.#records.get(key);
    if (existing) return cloneRecord(existing);
    const requestKey = `${internalKeySchema.parse(input.tenantKey)}:${internalKeySchema.parse(input.requestKey)}`;
    const requestProject = this.#requestProjects.get(requestKey);
    if (requestProject && requestProject !== input.projectKey) {
      throw new ApplicationError(
        409,
        "project_initialization_request_conflict",
        "这个初始化请求已经用于另一个项目，请刷新后重试",
      );
    }
    const record = cloneRecord(input);
    this.#records.set(key, record);
    this.#requestProjects.set(requestKey, record.projectKey);
    return cloneRecord(record);
  }

  #key(tenantKey: string, projectKey: string): string {
    return `${internalKeySchema.parse(tenantKey)}:${internalKeySchema.parse(projectKey)}`;
  }
}

export interface ProjectInitializationServiceOptions {
  repository: ProjectInitializationRepository;
  readiness: ProjectInitializationReadinessInspector;
  clock?: () => Date;
}

export class ProjectInitializationService {
  readonly #repository: ProjectInitializationRepository;
  readonly #readiness: ProjectInitializationReadinessInspector;
  readonly #clock: () => Date;

  constructor(options: ProjectInitializationServiceOptions) {
    this.#repository = options.repository;
    this.#readiness = options.readiness;
    this.#clock = options.clock ?? (() => new Date());
  }

  async get(
    principal: AuthenticatedPrincipal,
    projectKey: string,
  ): Promise<ProjectInitializationView> {
    const project = internalKeySchema.parse(projectKey);
    const record = await this.#repository.find(principal.tenantKey, project);
    const readiness = await this.#readiness.inspect(
      principal.tenantKey,
      project,
    );
    return this.#view(record, readiness);
  }

  async initialize(
    principal: AuthenticatedPrincipal,
    projectKey: string,
    input: ProjectInitializationCommand,
  ): Promise<ProjectInitializationView> {
    if (!principal.roles.includes("administrator")) {
      throw new ApplicationError(
        403,
        "project_initialization_admin_required",
        "只有平台管理员可以初始化项目",
      );
    }
    const project = internalKeySchema.parse(projectKey);
    const command = initializationCommandSchema.parse(input);
    const requestRecord = await this.#repository.findByRequest(
      principal.tenantKey,
      command.requestKey,
    );
    if (requestRecord && requestRecord.projectKey !== project) {
      throw new ApplicationError(
        409,
        "project_initialization_request_conflict",
        "这个初始化请求已经用于另一个项目，请刷新后重试",
      );
    }
    const existing = await this.#repository.find(principal.tenantKey, project);
    if (existing) {
      this.#assertCompatible(existing, command);
      return this.#view(
        existing,
        await this.#readiness.inspect(principal.tenantKey, project),
      );
    }
    if (
      command.presetKey !== STANDARD_DELIVERY_PRESET.key ||
      command.presetVersion !== STANDARD_DELIVERY_PRESET.version
    ) {
      throw new ApplicationError(
        422,
        "project_initialization_preset_unsupported",
        "当前版本不支持这个项目初始化预设",
      );
    }
    const created = await this.#repository.createIfAbsent({
      schemaVersion: 1,
      tenantKey: principal.tenantKey,
      projectKey: project,
      presetKey: command.presetKey,
      presetVersion: command.presetVersion,
      requestKey: command.requestKey,
      createdByKey: principal.actorKey,
      createdByName: principal.actorName,
      createdAt: this.#clock().toISOString(),
    });
    this.#assertCompatible(created, command);
    return this.#view(
      created,
      await this.#readiness.inspect(principal.tenantKey, project),
    );
  }

  #assertCompatible(
    record: ProjectInitializationRecord,
    command: ProjectInitializationCommand,
  ): void {
    if (
      record.presetKey !== command.presetKey ||
      record.presetVersion !== command.presetVersion
    ) {
      throw new ApplicationError(
        409,
        "project_initialization_conflict",
        "项目已经使用另一套预设初始化，不能直接覆盖",
      );
    }
  }

  #view(
    record: ProjectInitializationRecord | null,
    readiness: ProjectInitializationReadiness,
  ): ProjectInitializationView {
    const tasks: ProjectInitializationTask[] = [
      {
        key: "knowledge",
        name: "补充项目规则资料",
        detail: "加入项目约束、术语和交付说明，资料不能包含密码或令牌。",
        status: readiness.knowledgeReady ? "ready" : "action_required",
      },
      {
        key: "skill",
        name: "安装并评测团队 Skill",
        detail: "只有绑定当前项目且通过可信评测的 Skill 才能参与交付。",
        status: readiness.skillReady ? "ready" : "action_required",
      },
      {
        key: "mcp",
        name: "连接并验证外部工具",
        detail: "MCP 凭据保留在设备本地，健康验证通过后才能启用。",
        status: readiness.mcpReady ? "ready" : "action_required",
      },
    ];
    return {
      status:
        record === null
          ? "not_started"
          : tasks.every((task) => task.status === "ready")
            ? "ready"
            : "action_required",
      preset: STANDARD_DELIVERY_PRESET,
      record: record ? cloneRecord(record) : null,
      tasks,
    };
  }
}
