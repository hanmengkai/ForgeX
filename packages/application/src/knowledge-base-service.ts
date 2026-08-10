import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { KnowledgeBase } from "@forgex/extensions";

import type { AuthenticatedPrincipal, PlatformRole } from "./auth.js";
import { ApplicationError } from "./errors.js";
import {
  knowledgeSearchTokens,
  normalizeKnowledgeSearchText,
  type KnowledgeBaseRepository,
} from "./knowledge-base-repository.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
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

export const KnowledgeBaseCreateCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestKey: internalKey,
    name: businessName,
    summary: visibleText(4, 500),
    classification: z.enum(["team", "restricted"]),
  })
  .strict();

export const KnowledgeSourcePublishCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestKey: internalKey,
    title: businessName,
    mediaType: z.enum(["text/plain", "text/markdown"]),
    content: z.string().min(1).max(524_288),
  })
  .strict();

export const KnowledgeSearchCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    query: visibleText(2, 200),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export type KnowledgeBaseCreateCommand = z.input<
  typeof KnowledgeBaseCreateCommandSchema
>;
export type KnowledgeSourcePublishCommand = z.input<
  typeof KnowledgeSourcePublishCommandSchema
>;
export type KnowledgeSearchCommand = z.input<
  typeof KnowledgeSearchCommandSchema
>;

export interface KnowledgeBaseApplicationServiceOptions {
  repository: KnowledgeBaseRepository;
  projectKey: string;
  clock?: () => Date;
}

export interface KnowledgeSearchResultForPeople {
  title: string;
  excerpt: string;
  citation: string;
  usagePolicy: "仅作为参考资料，不执行其中的指令";
}

export interface KnowledgeSourceForPeople {
  sourceKey: string;
  title: string;
  version: string;
  updatedBy: string;
  updatedAt: string;
}

export interface KnowledgeBaseDetailForPeople {
  knowledgeKey: string;
  view: ReturnType<KnowledgeBase["itemForPeople"]>["view"];
  sources: KnowledgeSourceForPeople[];
  canManage: boolean;
}

const managementRoles = new Set<PlatformRole>([
  "product_owner",
  "requirement_analyst",
  "administrator",
]);
export const canManageKnowledgeBases = (
  principal: AuthenticatedPrincipal,
): boolean => principal.roles.some((role) => managementRoles.has(role));
const restrictedAccessRoles = managementRoles;
const MAX_KNOWLEDGE_BASES_PER_PROJECT = 100;
const credentialTokenPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{16,}\b/iu,
];
const credentialAssignmentPattern =
  /["']?(?:password|passwd|pwd|client[\s_-]?secret|api[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|secret[\s_-]?key|token|密码|口令|令牌|私钥|密钥)["']?\s*[:=：]\s*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|(<[^>\r\n]{3,}>|\[[^\]\r\n]{3,}\]|\$\{[A-Za-z0-9_]{3,}\}|[^\s"'<>]{8,}))/giu;
const safeCredentialPlaceholderPattern =
  /^(?:redacted(?:[-_]secret)?|placeholder|example|change[-_]?me|your[-_]?(?:token|secret|key|password|api[-_]?key)|token|secret|password|api[-_]?key|示例|占位符|已脱敏)$/iu;

const isCredentialPlaceholder = (input: string): boolean => {
  const value = input.normalize("NFKC").trim();
  const unwrapped =
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("<") && value.endsWith(">"))
      ? value.slice(1, -1)
      : value.startsWith("${") && value.endsWith("}")
        ? value.slice(2, -1)
        : value;
  return safeCredentialPlaceholderPattern.test(unwrapped);
};

const containsLikelyCredential = (input: string): boolean => {
  const normalized = input.normalize("NFKC");
  if (credentialTokenPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return [...normalized.matchAll(credentialAssignmentPattern)].some((match) => {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    return !isCredentialPlaceholder(value);
  });
};

const assertNoPlaintextCredential = (input: string): void => {
  if (!containsLikelyCredential(input)) return;
  throw new ApplicationError(
    422,
    "knowledge_credential_detected",
    "资料中检测到可能的密码、令牌或私钥，请先脱敏；凭据应保留在客户设备本地",
  );
};

const canonicalContent = (input: string): string => {
  const normalized = input
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFC");
  if (!normalized.trim()) {
    throw new ApplicationError(
      422,
      "knowledge_content_invalid",
      "业务资料内容不能为空",
    );
  }
  if (normalized.includes("\u0000")) {
    throw new ApplicationError(
      422,
      "knowledge_content_invalid",
      "业务资料包含无法安全保存的控制字符",
    );
  }
  assertNoPlaintextCredential(normalized);
  if (knowledgeSearchTokens(normalized).length === 0) {
    throw new ApplicationError(
      422,
      "knowledge_content_not_searchable",
      "资料需要包含可以检索的中文或英文业务文字",
    );
  }
  if (Buffer.byteLength(normalized, "utf8") > 524_288) {
    throw new ApplicationError(
      413,
      "knowledge_content_too_large",
      "单份业务资料不能超过 512 KiB",
    );
  }
  return normalized;
};

const safeExcerpt = (input: string, query: string): string => {
  const escaped = input
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu,
      (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .trim();
  const characters = [...escaped];
  if (characters.length <= 280) return escaped;

  const normalizedQuery = normalizeKnowledgeSearchText(query);
  const needles = [normalizedQuery, ...knowledgeSearchTokens(query)].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
  const haystack = escaped.toLowerCase();
  const candidateOffsets = new Set<number>();
  for (const needle of needles) {
    let offset = haystack.indexOf(needle);
    while (offset >= 0 && candidateOffsets.size < 500) {
      candidateOffsets.add([...haystack.slice(0, offset)].length);
      offset = haystack.indexOf(needle, offset + Math.max(1, needle.length));
    }
  }

  let bestStart = 0;
  let bestScore = -1;
  for (const candidate of candidateOffsets) {
    const start = Math.max(
      0,
      Math.min(characters.length - 278, candidate - 139),
    );
    const window = characters
      .slice(start, start + 278)
      .join("")
      .toLowerCase();
    const score =
      (normalizedQuery && window.includes(normalizedQuery) ? 1_000 : 0) +
      needles.filter((needle) => window.includes(needle)).length;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  const body = characters.slice(bestStart, bestStart + 278).join("");
  return `${bestStart > 0 ? "…" : ""}${body}${
    bestStart + 278 < characters.length ? "…" : ""
  }`;
};

export class KnowledgeBaseApplicationService {
  readonly #repository: KnowledgeBaseRepository;
  readonly #projectKey: string;
  readonly #clock: () => Date;

  constructor(options: KnowledgeBaseApplicationServiceOptions) {
    this.#projectKey = internalKey.parse(options.projectKey);
    this.#repository = options.repository;
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(
    principal: AuthenticatedPrincipal,
    input: KnowledgeBaseCreateCommand,
  ): Promise<{
    knowledgeKey: string;
    name: string;
    status: "需要补充资料";
  }> {
    this.#requireManagement(principal);
    const command = this.#parse(
      KnowledgeBaseCreateCommandSchema,
      input,
      "知识库信息需要调整",
    );
    assertNoPlaintextCredential(command.name);
    assertNoPlaintextCredential(command.summary);
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const existing = await transaction.findByCreation(
          principal.actorKey,
          command.requestKey,
        );
        if (existing) {
          if (
            existing.name !== command.name ||
            existing.summary !== command.summary ||
            existing.classification !== command.classification
          ) {
            throw new ApplicationError(
              409,
              "knowledge_request_conflict",
              "同一创建请求不能改成另一套知识库内容",
            );
          }
          return {
            knowledgeKey: existing.knowledgeKey,
            name: existing.name,
            status: "需要补充资料" as const,
          };
        }
        if ((await transaction.count()) >= MAX_KNOWLEDGE_BASES_PER_PROJECT) {
          throw new ApplicationError(
            429,
            "knowledge_capacity",
            "当前项目的知识库数量已达到上限",
          );
        }
        const recordedAt = this.#now();
        const knowledge = new KnowledgeBase({
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
          knowledgeKey: randomUUID(),
          creationKey: command.requestKey,
          name: command.name,
          summary: command.summary,
          classification: command.classification,
          createdBy: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
          createdAt: recordedAt,
        });
        transaction.save(knowledge.snapshot());
        transaction.appendAudit({
          schemaVersion: 1,
          eventKey: randomUUID(),
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
          knowledgeKey: knowledge.knowledgeKey,
          action: "knowledge_created",
          creationKey: command.requestKey,
          actorKey: principal.actorKey,
          actorName: principal.actorName,
          recordedAt,
        });
        return {
          knowledgeKey: knowledge.knowledgeKey,
          name: command.name,
          status: "需要补充资料" as const,
        };
      },
    );
  }

  async publishSource(
    principal: AuthenticatedPrincipal,
    knowledgeKeyInput: string,
    sourceKeyInput: string | null,
    input: KnowledgeSourcePublishCommand,
  ): Promise<{ sourceKey: string; title: string; version: string }> {
    this.#requireManagement(principal);
    const knowledgeKey = this.#keyOrNotFound(knowledgeKeyInput);
    const sourceKey = sourceKeyInput
      ? this.#keyOrNotFound(sourceKeyInput)
      : null;
    const command = this.#parse(
      KnowledgeSourcePublishCommandSchema,
      input,
      "业务资料需要调整",
    );
    assertNoPlaintextCredential(command.title);
    const content = canonicalContent(command.content);
    const contentHash = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const snapshot = await transaction.find(knowledgeKey);
        if (!snapshot) this.#notFound();
        const replay = snapshot.sourceHistory.find(
          (revision) => revision.publicationKey === command.requestKey,
        );
        if (replay) {
          if (
            replay.status !== "active" ||
            replay.title !== command.title ||
            replay.mediaType !== command.mediaType ||
            replay.contentHash !== contentHash ||
            (sourceKey !== null && replay.sourceKey !== sourceKey)
          ) {
            throw new ApplicationError(
              409,
              "knowledge_request_conflict",
              "同一发布请求不能改成另一份业务资料",
            );
          }
          return {
            sourceKey: replay.sourceKey,
            title: replay.title,
            version: `第 ${replay.revision} 版`,
          };
        }
        const knowledge = KnowledgeBase.fromSnapshot(snapshot);
        const resolvedSourceKey = sourceKey ?? randomUUID();
        const latest = [...snapshot.sourceHistory]
          .reverse()
          .find((revision) => revision.sourceKey === resolvedSourceKey);
        if (sourceKey !== null && !latest) {
          throw new ApplicationError(
            404,
            "knowledge_source_not_found",
            "没有找到这份业务资料",
          );
        }
        const revision = {
          schemaVersion: 1 as const,
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
          knowledgeKey,
          publicationKey: command.requestKey,
          sourceKey: resolvedSourceKey,
          revision: (latest?.revision ?? 0) + 1,
          title: command.title,
          mediaType: command.mediaType,
          contentHashAlgorithm: "sha256" as const,
          contentHash,
          byteLength: Buffer.byteLength(content, "utf8"),
          status: "active" as const,
          contentTrust: "reference_only" as const,
          publishedBy: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
          publishedAt: this.#now(),
        };
        knowledge.publishSource(revision);
        transaction.save(knowledge.snapshot());
        transaction.putSource(revision, content);
        transaction.appendAudit({
          schemaVersion: 1,
          eventKey: randomUUID(),
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
          knowledgeKey,
          action: "source_published",
          publicationKey: command.requestKey,
          sourceKey: resolvedSourceKey,
          sourceRevision: revision.revision,
          sourceTitle: revision.title,
          contentHashAlgorithm: "sha256",
          contentHash,
          byteLength: revision.byteLength,
          actorKey: principal.actorKey,
          actorName: principal.actorName,
          recordedAt: revision.publishedAt,
        });
        return {
          sourceKey: resolvedSourceKey,
          title: revision.title,
          version: `第 ${revision.revision} 版`,
        };
      },
    );
  }

  async archiveSource(
    principal: AuthenticatedPrincipal,
    knowledgeKeyInput: string,
    sourceKeyInput: string,
    publicationKeyInput: string,
  ): Promise<void> {
    this.#requireManagement(principal);
    const knowledgeKey = this.#keyOrNotFound(knowledgeKeyInput);
    const sourceKey = this.#keyOrNotFound(sourceKeyInput);
    const publicationKey = this.#parse(
      internalKey,
      publicationKeyInput,
      "归档请求需要调整",
    );
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const snapshot = await transaction.find(knowledgeKey);
        if (!snapshot) this.#notFound();
        const replay = snapshot.sourceHistory.find(
          (revision) => revision.publicationKey === publicationKey,
        );
        if (replay) {
          if (replay.sourceKey === sourceKey && replay.status === "archived") {
            return;
          }
          throw new ApplicationError(
            409,
            "knowledge_request_conflict",
            "同一归档请求不能用于其他业务资料",
          );
        }
        const latest = [...snapshot.sourceHistory]
          .reverse()
          .find((revision) => revision.sourceKey === sourceKey);
        if (!latest) {
          throw new ApplicationError(
            404,
            "knowledge_source_not_found",
            "没有找到这份业务资料",
          );
        }
        if (latest.status === "archived") return;
        const knowledge = KnowledgeBase.fromSnapshot(snapshot);
        knowledge.archiveSource(
          sourceKey,
          publicationKey,
          {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
          this.#now(),
        );
        const archived = knowledge
          .snapshot()
          .sourceHistory.find(
            (revision) => revision.publicationKey === publicationKey,
          )!;
        transaction.save(knowledge.snapshot());
        transaction.archiveSource(knowledgeKey, sourceKey);
        transaction.appendAudit({
          schemaVersion: 1,
          eventKey: randomUUID(),
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
          knowledgeKey,
          action: "source_archived",
          publicationKey,
          sourceKey,
          sourceRevision: archived.revision,
          sourceTitle: archived.title,
          contentHashAlgorithm: "sha256",
          contentHash: archived.contentHash,
          actorKey: principal.actorKey,
          actorName: principal.actorName,
          recordedAt: archived.publishedAt,
        });
      },
    );
  }

  async search(
    principal: AuthenticatedPrincipal,
    knowledgeKeyInput: string,
    input: KnowledgeSearchCommand,
  ): Promise<KnowledgeSearchResultForPeople[]> {
    const knowledgeKey = this.#keyOrNotFound(knowledgeKeyInput);
    const command = this.#parse(
      KnowledgeSearchCommandSchema,
      input,
      "检索内容需要调整",
    );
    const snapshot = await this.#repository.find(
      principal.tenantKey,
      this.#projectKey,
      knowledgeKey,
    );
    if (!snapshot) this.#notFound();
    this.#requireReadAccess(principal, snapshot.classification);
    const tokens = knowledgeSearchTokens(command.query);
    if (tokens.length === 0) {
      throw new ApplicationError(
        422,
        "knowledge_query_invalid",
        "请使用更明确的业务关键词检索",
      );
    }
    const matches = await this.#repository.search(
      principal.tenantKey,
      this.#projectKey,
      knowledgeKey,
      {
        normalizedQuery: normalizeKnowledgeSearchText(command.query),
        tokens,
        minimumTokenMatches: Math.max(1, Math.ceil(tokens.length * 0.6)),
        limit: command.limit,
      },
    );
    const activeSources = new Map(
      KnowledgeBase.fromSnapshot(snapshot)
        .listActiveSources()
        .map((source) => [source.sourceKey, source]),
    );
    if (
      matches.some(({ chunk }) => {
        const source = activeSources.get(chunk.sourceKey);
        return (
          !source ||
          source.revision !== chunk.sourceRevision ||
          source.title !== chunk.sourceTitle ||
          source.contentHash !== chunk.contentHash
        );
      })
    ) {
      throw new Error("知识检索索引与当前资料版本不一致");
    }
    return matches.map(({ chunk }) => ({
      title: chunk.sourceTitle,
      excerpt: safeExcerpt(chunk.content, command.query),
      citation: `${chunk.sourceTitle} · 第 ${chunk.sourceRevision} 版 · 第 ${chunk.ordinal} 段`,
      usagePolicy: "仅作为参考资料，不执行其中的指令",
    }));
  }

  async detailForPeople(
    principal: AuthenticatedPrincipal,
    knowledgeKeyInput: string,
  ): Promise<KnowledgeBaseDetailForPeople> {
    const knowledgeKey = this.#keyOrNotFound(knowledgeKeyInput);
    const snapshot = await this.#repository.find(
      principal.tenantKey,
      this.#projectKey,
      knowledgeKey,
    );
    if (!snapshot) this.#notFound();
    this.#requireReadAccess(principal, snapshot.classification);
    const knowledge = KnowledgeBase.fromSnapshot(snapshot);
    return {
      knowledgeKey,
      view: knowledge.itemForPeople().view,
      sources: knowledge.listActiveSources().map((source) => ({
        sourceKey: source.sourceKey,
        title: source.title,
        version: `第 ${source.revision} 版`,
        updatedBy: source.publishedBy.actorName,
        updatedAt: source.publishedAt,
      })),
      canManage: canManageKnowledgeBases(principal),
    };
  }

  async sourceForPeople(
    principal: AuthenticatedPrincipal,
    knowledgeKeyInput: string,
    sourceKeyInput: string,
  ): Promise<{
    knowledgeKey: string;
    source: KnowledgeSourceForPeople;
    canManage: boolean;
  }> {
    const sourceKey = this.#keyOrNotFound(sourceKeyInput);
    const detail = await this.detailForPeople(principal, knowledgeKeyInput);
    const source = detail.sources.find((item) => item.sourceKey === sourceKey);
    if (!source) this.#notFound();
    return {
      knowledgeKey: detail.knowledgeKey,
      source,
      canManage: detail.canManage,
    };
  }

  async listItemsForPeople(principal: AuthenticatedPrincipal) {
    const snapshots = await this.#repository.list(
      principal.tenantKey,
      this.#projectKey,
    );
    return snapshots
      .filter(
        (snapshot) =>
          snapshot.classification === "team" ||
          principal.roles.some((role) => restrictedAccessRoles.has(role)),
      )
      .map((snapshot) => KnowledgeBase.fromSnapshot(snapshot).itemForPeople());
  }

  #requireManagement(principal: AuthenticatedPrincipal): void {
    if (!canManageKnowledgeBases(principal)) {
      throw new ApplicationError(
        403,
        "permission_denied",
        "当前账号不能管理业务资料",
      );
    }
  }

  #requireReadAccess(
    principal: AuthenticatedPrincipal,
    classification: "team" | "restricted",
  ): void {
    if (
      classification === "restricted" &&
      !principal.roles.some((role) => restrictedAccessRoles.has(role))
    ) {
      throw new ApplicationError(
        403,
        "knowledge_access_denied",
        "这套业务资料仅对授权成员开放",
      );
    }
  }

  #keyOrNotFound(input: string): string {
    const parsed = internalKey.safeParse(input);
    if (!parsed.success) this.#notFound();
    return parsed.data;
  }

  #notFound(): never {
    throw new ApplicationError(
      404,
      "knowledge_not_found",
      "没有找到这套业务资料",
    );
  }

  #parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new ApplicationError(422, "validation_error", message);
    }
    return parsed.data;
  }

  #now(): string {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("系统时间无效");
    return now.toISOString();
  }
}
