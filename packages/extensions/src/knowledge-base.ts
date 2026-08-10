import { z } from "zod";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const sha256Hash = z.string().regex(/^[0-9a-f]{64}$/);
const unsafeVisibleCharacters =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const visibleText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) => !unsafeVisibleCharacters.test(value),
      "可见文字不能包含控制或方向欺骗字符",
    );
const businessName = visibleText(2, 100).refine(
  (value) => !/^[a-z][a-z0-9_.-]*(?:\(\))?$/i.test(value),
  "请使用业务名称，不要只填写技术标识",
);
const actorName = visibleText(2, 100);

export const KnowledgeActorSchema = z
  .object({
    actorKey: internalKey,
    actorName,
  })
  .strict();

export const KnowledgeSourceRevisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantKey: internalKey,
    projectKey: internalKey,
    knowledgeKey: internalKey,
    publicationKey: internalKey,
    sourceKey: internalKey,
    revision: z.number().int().positive().max(1_000),
    title: businessName,
    mediaType: z.enum(["text/plain", "text/markdown"]),
    contentHashAlgorithm: z.literal("sha256"),
    contentHash: sha256Hash,
    byteLength: z.number().int().positive().max(524_288),
    status: z.enum(["active", "archived"]),
    contentTrust: z.literal("reference_only"),
    publishedBy: KnowledgeActorSchema,
    publishedAt: z.iso.datetime(),
  })
  .strict();

export const KnowledgeBaseSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantKey: internalKey,
    projectKey: internalKey,
    knowledgeKey: internalKey,
    creationKey: internalKey,
    revision: z.number().int().positive().max(1_001),
    name: businessName,
    summary: visibleText(4, 500),
    classification: z.enum(["team", "restricted"]),
    createdBy: KnowledgeActorSchema,
    createdAt: z.iso.datetime(),
    sourceHistory: z.array(KnowledgeSourceRevisionSchema).max(1_000),
  })
  .strict();

const KnowledgeBaseOptionsSchema = KnowledgeBaseSnapshotSchema.omit({
  schemaVersion: true,
  revision: true,
  sourceHistory: true,
});

export type KnowledgeActor = z.infer<typeof KnowledgeActorSchema>;
export type KnowledgeSourceRevision = z.infer<
  typeof KnowledgeSourceRevisionSchema
>;
export type KnowledgeBaseSnapshot = z.infer<typeof KnowledgeBaseSnapshotSchema>;
export type KnowledgeBaseOptions = z.input<typeof KnowledgeBaseOptionsSchema>;

export interface KnowledgeBasePeopleView {
  name: string;
  summary: string;
  classification: "项目成员可使用" | "仅授权成员可使用";
  status: "可使用" | "需要补充资料";
  detail: string;
  lastUpdatedAt: string;
}

export interface KnowledgeBaseItemForPeople {
  knowledgeKey: string;
  view: KnowledgeBasePeopleView;
}

const normalizedVisibleName = (value: string): string =>
  value.normalize("NFKC").trim().toLowerCase();

const sameRevision = (
  left: KnowledgeSourceRevision,
  right: KnowledgeSourceRevision,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export class KnowledgeBase {
  readonly #tenantKey: string;
  readonly #projectKey: string;
  readonly #knowledgeKey: string;
  readonly #creationKey: string;
  readonly #name: string;
  readonly #summary: string;
  readonly #classification: "team" | "restricted";
  readonly #createdBy: KnowledgeActor;
  readonly #createdAt: string;
  readonly #sourceHistory: KnowledgeSourceRevision[] = [];

  constructor(input: KnowledgeBaseOptions) {
    const options = KnowledgeBaseOptionsSchema.parse(input);
    this.#tenantKey = options.tenantKey;
    this.#projectKey = options.projectKey;
    this.#knowledgeKey = options.knowledgeKey;
    this.#creationKey = options.creationKey;
    this.#name = options.name;
    this.#summary = options.summary;
    this.#classification = options.classification;
    this.#createdBy = structuredClone(options.createdBy);
    this.#createdAt = options.createdAt;
  }

  static fromSnapshot(input: KnowledgeBaseSnapshot): KnowledgeBase {
    const snapshot = KnowledgeBaseSnapshotSchema.parse(input);
    if (snapshot.revision !== snapshot.sourceHistory.length + 1) {
      throw new Error("知识库版本与资料历史不一致");
    }
    const knowledge = new KnowledgeBase({
      tenantKey: snapshot.tenantKey,
      projectKey: snapshot.projectKey,
      knowledgeKey: snapshot.knowledgeKey,
      creationKey: snapshot.creationKey,
      name: snapshot.name,
      summary: snapshot.summary,
      classification: snapshot.classification,
      createdBy: snapshot.createdBy,
      createdAt: snapshot.createdAt,
    });
    for (const revision of snapshot.sourceHistory) {
      if (!knowledge.#applyRevision(revision)) {
        throw new Error("知识库历史不能包含重复资料版本");
      }
    }
    return knowledge;
  }

  get tenantKey(): string {
    return this.#tenantKey;
  }

  get projectKey(): string {
    return this.#projectKey;
  }

  get knowledgeKey(): string {
    return this.#knowledgeKey;
  }

  publishSource(input: KnowledgeSourceRevision): void {
    const revision = KnowledgeSourceRevisionSchema.parse(input);
    if (revision.status !== "active") {
      throw new Error("发布业务资料时必须使用可用状态");
    }
    this.#applyRevision(revision);
  }

  archiveSource(
    sourceKeyInput: string,
    publicationKeyInput: string,
    actorInput: KnowledgeActor,
    publishedAtInput: string,
  ): void {
    const sourceKey = internalKey.parse(sourceKeyInput);
    const publicationKey = internalKey.parse(publicationKeyInput);
    const actor = KnowledgeActorSchema.parse(actorInput);
    const publishedAt = z.iso.datetime().parse(publishedAtInput);
    const latest = this.#latestSources().get(sourceKey);
    if (!latest) throw new Error("找不到要归档的业务资料");
    if (latest.status === "archived") return;
    this.#applyRevision({
      ...latest,
      publicationKey,
      revision: latest.revision + 1,
      status: "archived",
      publishedBy: actor,
      publishedAt,
    });
  }

  listActiveSources(): KnowledgeSourceRevision[] {
    return [...this.#latestSources().values()]
      .filter((source) => source.status === "active")
      .sort((left, right) =>
        left.title === right.title ? 0 : left.title < right.title ? -1 : 1,
      )
      .map((source) => structuredClone(source));
  }

  itemForPeople(): KnowledgeBaseItemForPeople {
    const activeSources = this.listActiveSources();
    const lastUpdatedAt =
      this.#sourceHistory.at(-1)?.publishedAt ?? this.#createdAt;
    return {
      knowledgeKey: this.#knowledgeKey,
      view: {
        name: this.#name,
        summary: this.#summary,
        classification:
          this.#classification === "team"
            ? "项目成员可使用"
            : "仅授权成员可使用",
        status: activeSources.length > 0 ? "可使用" : "需要补充资料",
        detail:
          activeSources.length === 0
            ? "尚未加入可用资料"
            : `已整理 ${activeSources.length} 份资料`,
        lastUpdatedAt,
      },
    };
  }

  snapshot(): KnowledgeBaseSnapshot {
    return {
      schemaVersion: 1,
      tenantKey: this.#tenantKey,
      projectKey: this.#projectKey,
      knowledgeKey: this.#knowledgeKey,
      creationKey: this.#creationKey,
      revision: this.#sourceHistory.length + 1,
      name: this.#name,
      summary: this.#summary,
      classification: this.#classification,
      createdBy: structuredClone(this.#createdBy),
      createdAt: this.#createdAt,
      sourceHistory: structuredClone(this.#sourceHistory),
    };
  }

  #applyRevision(input: KnowledgeSourceRevision): boolean {
    const revision = KnowledgeSourceRevisionSchema.parse(input);
    this.#assertScope(revision);
    const existing = this.#sourceHistory.find(
      (candidate) =>
        candidate.sourceKey === revision.sourceKey &&
        candidate.revision === revision.revision,
    );
    if (existing) {
      if (sameRevision(existing, revision)) return false;
      throw new Error("同一版本的业务资料不能被覆盖");
    }
    if (
      this.#sourceHistory.some(
        (candidate) => candidate.publicationKey === revision.publicationKey,
      )
    ) {
      throw new Error("业务资料发布请求不能重复用于其他版本");
    }
    if (this.#sourceHistory.length >= 1_000) {
      throw new Error("知识库版本历史已达到上限，请先归档导出");
    }
    const latest = this.#latestSources().get(revision.sourceKey);
    if (!latest && revision.revision !== 1) {
      throw new Error("业务资料必须从第一个版本开始发布");
    }
    if (latest && revision.revision !== latest.revision + 1) {
      throw new Error("业务资料版本必须连续发布");
    }
    if (
      latest &&
      Date.parse(revision.publishedAt) < Date.parse(latest.publishedAt)
    ) {
      throw new Error("业务资料发布时间不能早于上一版本");
    }
    const previousGlobal = this.#sourceHistory.at(-1);
    if (
      previousGlobal &&
      Date.parse(revision.publishedAt) < Date.parse(previousGlobal.publishedAt)
    ) {
      throw new Error("知识库资料历史必须按发布时间排列");
    }
    if (revision.status === "archived") {
      if (
        !latest ||
        latest.status !== "active" ||
        latest.title !== revision.title ||
        latest.mediaType !== revision.mediaType ||
        latest.contentHash !== revision.contentHash ||
        latest.byteLength !== revision.byteLength
      ) {
        throw new Error("归档记录必须引用上一版可用资料");
      }
    } else {
      const active = [...this.#latestSources().values()].filter(
        (candidate) =>
          candidate.status === "active" &&
          candidate.sourceKey !== revision.sourceKey,
      );
      if (
        active.some(
          (candidate) =>
            normalizedVisibleName(candidate.title) ===
            normalizedVisibleName(revision.title),
        )
      ) {
        throw new Error("可用业务资料名称不能重复");
      }
      if (!latest && active.length >= 100) {
        throw new Error("每个知识库最多保留 100 份可用资料");
      }
    }
    this.#sourceHistory.push(structuredClone(revision));
    return true;
  }

  #latestSources(): Map<string, KnowledgeSourceRevision> {
    const latest = new Map<string, KnowledgeSourceRevision>();
    for (const revision of this.#sourceHistory) {
      latest.set(revision.sourceKey, revision);
    }
    return latest;
  }

  #assertScope(revision: KnowledgeSourceRevision): void {
    if (
      revision.tenantKey !== this.#tenantKey ||
      revision.projectKey !== this.#projectKey ||
      revision.knowledgeKey !== this.#knowledgeKey
    ) {
      throw new Error("业务资料不属于当前知识库");
    }
  }
}
