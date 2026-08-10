import { ExtensionCatalog } from "@forgex/extensions";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";
import type { ExtensionCatalogRepository } from "./extension-catalog-repository.js";

export interface ExtensionCatalogApplicationServiceOptions {
  repository: ExtensionCatalogRepository;
  projectKey: string;
}

export interface ExtensionItemForPeople {
  name: string;
  summary: string;
  status: "可使用" | "正在更新" | "需要处理" | "暂不可用";
  detail: string;
  supportingText: string;
  links: { self: string };
}

export interface ExtensionCatalogOverviewForPeople {
  businessKnowledge: ExtensionItemForPeople[];
  teamCapabilities: ExtensionItemForPeople[];
  externalTools: ExtensionItemForPeople[];
}

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ExtensionCatalogApplicationService {
  readonly #repository: ExtensionCatalogRepository;
  readonly #projectKey: string;

  constructor(options: ExtensionCatalogApplicationServiceOptions) {
    if (!internalKeyPattern.test(options.projectKey)) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    this.#repository = options.repository;
    this.#projectKey = options.projectKey.toLowerCase();
  }

  async overviewForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<ExtensionCatalogOverviewForPeople> {
    const catalog = await this.#catalogFor(principal);
    const overview: ExtensionCatalogOverviewForPeople = {
      businessKnowledge: [],
      teamCapabilities: [],
      externalTools: [],
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
          overview.teamCapabilities.push(view);
          break;
        case "mcp":
          overview.externalTools.push(view);
          break;
      }
    }
    return overview;
  }

  async detailForPeople(
    principal: AuthenticatedPrincipal,
    extensionKey: string,
  ): Promise<ExtensionItemForPeople> {
    const normalizedKey = extensionKey.toLowerCase();
    const item = (await this.#catalogFor(principal))
      .listForPeople()
      .find((candidate) => candidate.extensionKey === normalizedKey);
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
