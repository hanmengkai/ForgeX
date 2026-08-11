import {
  ExtensionCatalog,
  type McpServerRegistryItemForPeople,
  type SkillRegistryItemForPeople,
} from "@forgex/extensions";
import type {
  ExtensionCatalogOverviewForPeople,
  ExtensionItemForPeople,
} from "@forgex/contracts";

export type {
  ExtensionCatalogOverviewForPeople,
  ExtensionItemForPeople,
} from "@forgex/contracts";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";
import type { ExtensionCatalogRepository } from "./extension-catalog-repository.js";
import {
  canManageKnowledgeBases,
  type KnowledgeBaseApplicationService,
} from "./knowledge-base-service.js";

export interface ExtensionCatalogApplicationServiceOptions {
  repository: ExtensionCatalogRepository;
  skillRegistry: TrustedSkillDirectory;
  mcpRegistry: TrustedMcpDirectory;
  knowledgeDirectory?: TrustedKnowledgeDirectory;
  projectKey: string;
}

export interface TrustedSkillDirectory {
  listItemsForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<SkillRegistryItemForPeople[]>;
}

export interface TrustedMcpDirectory {
  listItemsForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<McpServerRegistryItemForPeople[]>;
}

export interface TrustedKnowledgeDirectory {
  listItemsForPeople: KnowledgeBaseApplicationService["listItemsForPeople"];
}

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ExtensionCatalogApplicationService {
  readonly #repository: ExtensionCatalogRepository;
  readonly #skillRegistry: TrustedSkillDirectory;
  readonly #mcpRegistry: TrustedMcpDirectory;
  readonly #knowledgeDirectory: TrustedKnowledgeDirectory | null;
  readonly #projectKey: string;

  constructor(options: ExtensionCatalogApplicationServiceOptions) {
    if (!internalKeyPattern.test(options.projectKey)) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    this.#repository = options.repository;
    this.#skillRegistry = options.skillRegistry;
    this.#mcpRegistry = options.mcpRegistry;
    this.#knowledgeDirectory = options.knowledgeDirectory ?? null;
    this.#projectKey = options.projectKey.toLowerCase();
  }

  async overviewForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<ExtensionCatalogOverviewForPeople> {
    const catalog = await this.#catalogFor(principal);
    const trustedSkills =
      await this.#skillRegistry.listItemsForPeople(principal);
    const trustedMcpServers =
      await this.#mcpRegistry.listItemsForPeople(principal);
    const trustedKnowledge = this.#knowledgeDirectory
      ? await this.#knowledgeDirectory.listItemsForPeople(principal)
      : [];
    const overview: ExtensionCatalogOverviewForPeople = {
      businessKnowledge: [],
      teamCapabilities: [],
      externalTools: [],
      links: {
        actions: {
          ...(this.#knowledgeDirectory && canManageKnowledgeBases(principal)
            ? { createKnowledge: "/api/v1/knowledge-bases" }
            : {}),
          ...(principal.roles.includes("administrator")
            ? {
                publishSkill: "/api/v1/extensions/skills",
                publishMcp: "/api/v1/extensions/mcp",
              }
            : {}),
        },
      },
    };
    for (const item of catalog.listForPeople()) {
      const view = {
        ...item.view,
        links: { self: `/api/v1/extensions/${item.extensionKey}` },
      };
      switch (item.kind) {
        case "knowledge":
          overview.businessKnowledge.push(view);
          break;
        case "skill":
          break;
        case "mcp":
          break;
      }
    }
    const trustedKnowledgeViews = trustedKnowledge.map((item) => ({
      name: item.view.name,
      summary: item.view.summary,
      status: (item.view.status === "可使用" ? "可使用" : "需要处理") as
        "可使用" | "需要处理",
      detail: item.view.detail,
      supportingText: `${item.view.classification} · 检索结果始终标注资料来源`,
      links: { self: `/api/v1/knowledge-bases/${item.knowledgeKey}` },
    }));
    overview.businessKnowledge = this.#knowledgeDirectory
      ? trustedKnowledgeViews.slice(0, 100)
      : overview.businessKnowledge.slice(0, 100);
    overview.teamCapabilities = trustedSkills.map((item) => ({
      name: item.view.name,
      summary: item.view.summary,
      status: item.view.status === "可使用" ? "可使用" : "需要处理",
      detail: item.view.activeVersion
        ? `版本 ${item.view.activeVersion} · ${item.view.quality}`
        : item.view.quality,
      supportingText: item.view.safety,
      links: {
        self: `/api/v1/extensions/skills/${item.skillKey}`,
      },
    }));
    overview.externalTools = trustedMcpServers.map((item) => ({
      name: item.view.name,
      summary: item.view.summary,
      status: item.view.status === "可使用" ? "可使用" : "需要处理",
      detail: item.view.detail,
      supportingText: item.view.supportingText,
      links: { self: `/api/v1/extensions/mcp/${item.serverKey}` },
    }));
    return overview;
  }

  async detailForPeople(
    principal: AuthenticatedPrincipal,
    extensionKey: string,
  ): Promise<ExtensionItemForPeople> {
    if (this.#knowledgeDirectory) {
      throw new ApplicationError(
        404,
        "extension_not_found",
        "没有找到这个扩展",
      );
    }
    const normalizedKey = extensionKey.toLowerCase();
    const item = (await this.#catalogFor(principal))
      .listForPeople()
      .find(
        (candidate) =>
          candidate.kind === "knowledge" &&
          candidate.extensionKey === normalizedKey,
      );
    if (!item) {
      throw new ApplicationError(
        404,
        "extension_not_found",
        "没有找到这个扩展",
      );
    }
    return {
      ...item.view,
      links: { self: `/api/v1/extensions/${item.extensionKey}` },
    };
  }

  async skillDetailForPeople(
    principal: AuthenticatedPrincipal,
    skillKey: string,
  ): Promise<ExtensionItemForPeople> {
    const normalizedKey = skillKey.toLowerCase();
    const item = (await this.#skillRegistry.listItemsForPeople(principal)).find(
      (candidate) => candidate.skillKey === normalizedKey,
    );
    if (!item) {
      throw new ApplicationError(
        404,
        "extension_not_found",
        "没有找到这个扩展",
      );
    }
    return {
      name: item.view.name,
      summary: item.view.summary,
      status: item.view.status === "可使用" ? "可使用" : "需要处理",
      detail: item.view.activeVersion
        ? `版本 ${item.view.activeVersion} · ${item.view.quality}`
        : item.view.quality,
      supportingText: item.view.safety,
      links: { self: `/api/v1/extensions/skills/${item.skillKey}` },
    };
  }

  async mcpDetailForPeople(
    principal: AuthenticatedPrincipal,
    serverKey: string,
  ): Promise<ExtensionItemForPeople> {
    const normalizedKey = serverKey.toLowerCase();
    const item = (await this.#mcpRegistry.listItemsForPeople(principal)).find(
      (candidate) => candidate.serverKey === normalizedKey,
    );
    if (!item) {
      throw new ApplicationError(
        404,
        "extension_not_found",
        "没有找到这个扩展",
      );
    }
    return {
      name: item.view.name,
      summary: item.view.summary,
      status: item.view.status === "可使用" ? "可使用" : "需要处理",
      detail: item.view.detail,
      supportingText: item.view.supportingText,
      links: { self: `/api/v1/extensions/mcp/${item.serverKey}` },
    };
  }

  async #catalogFor(
    principal: AuthenticatedPrincipal,
  ): Promise<ExtensionCatalog> {
    return ExtensionCatalog.restoreLatest(
      {
        tenantKey: principal.tenantKey,
        projectKey: this.#projectKey,
      },
      await this.#repository.list(principal.tenantKey, this.#projectKey),
    );
  }
}
