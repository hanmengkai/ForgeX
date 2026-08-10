import { z } from "zod";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const businessName = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine(
    (value) => !/^[a-z][a-z0-9_.-]*(?:\(\))?$/i.test(value),
    "请使用业务名称，不要只填写技术标识",
  );
const humanLabel = z.string().trim().min(2).max(100);
const extensionStatus = z.enum(["ready", "syncing", "attention", "offline"]);
const common = {
  schemaVersion: z.literal(1),
  extensionKey: internalKey,
  tenantKey: internalKey,
  projectKey: internalKey,
  revision: z.number().int().min(1),
  name: businessName,
  summary: z.string().trim().min(4).max(500),
  status: extensionStatus,
};

const KnowledgeExtensionSchema = z
  .object({
    ...common,
    kind: z.literal("knowledge"),
    sourceCount: z.number().int().min(0).max(10_000),
    classification: z.enum(["team", "restricted"]),
    lastSyncedAt: z.iso.datetime().nullable(),
  })
  .strict();

const SkillExtensionSchema = z
  .object({
    ...common,
    kind: z.literal("skill"),
    version: z
      .string()
      .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
    compatibleBlueprints: z.array(humanLabel).max(20),
    successRate: z.number().min(0).max(100).nullable(),
    evaluationCount: z.number().int().min(0).max(1_000_000),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const McpExtensionSchema = z
  .object({
    ...common,
    kind: z.literal("mcp"),
    transport: z.enum(["stdio", "streamable_http"]),
    capabilities: z.array(humanLabel).min(1).max(50),
    approvalMode: z.enum(["automatic_read", "always_review"]),
    lastCheckedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((extension, context) => {
    if (
      new Set(extension.capabilities).size !== extension.capabilities.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "业务能力不能重复",
      });
    }
  });

export const ExtensionCatalogEntrySchema = z.discriminatedUnion("kind", [
  KnowledgeExtensionSchema,
  SkillExtensionSchema,
  McpExtensionSchema,
]);

export type ExtensionCatalogEntry = z.infer<typeof ExtensionCatalogEntrySchema>;
export type ExtensionKind = ExtensionCatalogEntry["kind"];
export type ExtensionStatus = ExtensionCatalogEntry["status"];

export interface ExtensionPeopleView {
  name: string;
  summary: string;
  status: "可使用" | "正在更新" | "需要处理" | "暂不可用";
  detail: string;
  supportingText: string;
}

export interface ExtensionCatalogItemForPeople {
  extensionKey: string;
  kind: ExtensionKind;
  view: ExtensionPeopleView;
}

export interface ExtensionCatalogOptions {
  tenantKey: string;
  projectKey: string;
}

const statusForPeople = (
  status: ExtensionStatus,
): ExtensionPeopleView["status"] => {
  switch (status) {
    case "ready":
      return "可使用";
    case "syncing":
      return "正在更新";
    case "attention":
      return "需要处理";
    case "offline":
      return "暂不可用";
  }
};

const itemForPeople = (
  entry: ExtensionCatalogEntry,
): ExtensionCatalogItemForPeople => {
  const base = {
    extensionKey: entry.extensionKey,
    kind: entry.kind,
    view: {
      name: entry.name,
      summary: entry.summary,
      status: statusForPeople(entry.status),
    },
  };
  switch (entry.kind) {
    case "knowledge":
      return {
        ...base,
        view: {
          ...base.view,
          detail:
            entry.sourceCount === 0
              ? "尚未加入资料"
              : `已整理 ${entry.sourceCount} 份资料`,
          supportingText:
            entry.classification === "team"
              ? "项目成员可使用"
              : "仅授权成员可使用",
        },
      };
    case "skill":
      return {
        ...base,
        view: {
          ...base.view,
          detail: `版本 ${entry.version} · 已验证 ${entry.evaluationCount} 次`,
          supportingText:
            entry.successRate === null
              ? "等待积累评估结果"
              : `成功率 ${entry.successRate}%`,
        },
      };
    case "mcp":
      return {
        ...base,
        view: {
          ...base.view,
          detail: `${entry.capabilities.length} 项业务能力`,
          supportingText:
            entry.approvalMode === "automatic_read"
              ? "读取自动放行，变更需要确认"
              : "每次使用前都要确认",
        },
      };
  }
};

const kindOrder: Record<ExtensionKind, number> = {
  knowledge: 0,
  skill: 1,
  mcp: 2,
};
const MAX_ENTRIES_PER_KIND = 100;

export class ExtensionCatalog {
  readonly #tenantKey: string;
  readonly #projectKey: string;
  readonly #entries = new Map<string, ExtensionCatalogEntry>();

  constructor(options: ExtensionCatalogOptions) {
    const scope = z
      .object({ tenantKey: internalKey, projectKey: internalKey })
      .strict()
      .parse(options);
    this.#tenantKey = scope.tenantKey;
    this.#projectKey = scope.projectKey;
  }

  static restoreLatest(
    options: ExtensionCatalogOptions,
    persistedEntries: readonly ExtensionCatalogEntry[],
  ): ExtensionCatalog {
    const catalog = new ExtensionCatalog(options);
    for (const input of persistedEntries) {
      const entry = ExtensionCatalogEntrySchema.parse(input);
      catalog.#assertScope(entry);
      if (catalog.#entries.has(entry.extensionKey)) {
        throw new Error("持久化扩展不能包含重复记录");
      }
      catalog.#assertCapacity(entry);
      catalog.#assertUniqueName(entry);
      catalog.#entries.set(entry.extensionKey, structuredClone(entry));
    }
    return catalog;
  }

  publish(input: ExtensionCatalogEntry): void {
    const entry = ExtensionCatalogEntrySchema.parse(input);
    this.#assertScope(entry);
    const existing = this.#entries.get(entry.extensionKey);
    if (!existing && entry.revision !== 1) {
      throw new Error("扩展必须从第一个版本开始发布");
    }
    if (!existing) this.#assertCapacity(entry);
    if (existing) {
      if (entry.kind !== existing.kind) {
        throw new Error("已经发布的扩展不能改变类型");
      }
      if (entry.revision === existing.revision) {
        if (JSON.stringify(entry) === JSON.stringify(existing)) return;
        throw new Error("同一版本的扩展内容不能被覆盖");
      }
      if (entry.revision !== existing.revision + 1) {
        throw new Error("扩展版本必须连续发布");
      }
    }
    this.#assertUniqueName(entry);
    this.#entries.set(entry.extensionKey, structuredClone(entry));
  }

  #assertScope(entry: ExtensionCatalogEntry): void {
    if (
      entry.tenantKey !== this.#tenantKey ||
      entry.projectKey !== this.#projectKey
    ) {
      throw new Error("扩展不属于当前租户和项目");
    }
  }

  #assertCapacity(entry: ExtensionCatalogEntry): void {
    if (
      [...this.#entries.values()].filter(
        (candidate) => candidate.kind === entry.kind,
      ).length >= MAX_ENTRIES_PER_KIND
    ) {
      throw new Error("同一类扩展最多发布 100 项");
    }
  }

  #assertUniqueName(entry: ExtensionCatalogEntry): void {
    const duplicateName = [...this.#entries.values()].find(
      (candidate) =>
        candidate.extensionKey !== entry.extensionKey &&
        candidate.kind === entry.kind &&
        candidate.name.toLowerCase() === entry.name.toLowerCase(),
    );
    if (duplicateName) {
      throw new Error("同一类扩展不能使用重复名称");
    }
  }

  list(): ExtensionCatalogEntry[] {
    return [...this.#entries.values()]
      .sort((left, right) => {
        const byKind = kindOrder[left.kind] - kindOrder[right.kind];
        if (byKind !== 0) return byKind;
        if (left.name < right.name) return -1;
        if (left.name > right.name) return 1;
        return left.extensionKey < right.extensionKey ? -1 : 1;
      })
      .map((entry) => structuredClone(entry));
  }

  listForPeople(): ExtensionCatalogItemForPeople[] {
    return this.list().map(itemForPeople);
  }
}
