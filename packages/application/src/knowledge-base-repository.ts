import { createHash } from "node:crypto";

import { z } from "zod";

import {
  KnowledgeBase,
  KnowledgeBaseSnapshotSchema,
  KnowledgeSourceRevisionSchema,
  type KnowledgeBaseSnapshot,
  type KnowledgeSourceRevision,
} from "@forgex/extensions";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const sha256Hash = z.string().regex(/^[0-9a-f]{64}$/);
const actorName = z.string().trim().min(2).max(100);

export const KnowledgeChunkSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantKey: internalKey,
    projectKey: internalKey,
    knowledgeKey: internalKey,
    sourceKey: internalKey,
    sourceRevision: z.number().int().positive().max(1_000),
    sourceTitle: z.string().trim().min(2).max(100),
    contentHash: sha256Hash,
    ordinal: z.number().int().positive().max(1_000),
    content: z.string().trim().min(1).max(1_200),
    normalizedContent: z.string().min(1).max(2_400),
    tokens: z.array(z.string().min(1).max(100)).min(1).max(2_500),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (new Set(chunk.tokens).size !== chunk.tokens.length) {
      context.addIssue({
        code: "custom",
        path: ["tokens"],
        message: "知识片段检索词不能重复",
      });
    }
  });

export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

export type KnowledgeChunkSource = Pick<
  KnowledgeSourceRevision,
  | "tenantKey"
  | "projectKey"
  | "knowledgeKey"
  | "sourceKey"
  | "revision"
  | "title"
  | "contentHash"
  | "byteLength"
>;

const KnowledgeAuditScope = {
  schemaVersion: z.literal(1),
  eventKey: internalKey,
  tenantKey: internalKey,
  projectKey: internalKey,
  knowledgeKey: internalKey,
  actorKey: internalKey,
  actorName,
  recordedAt: z.iso.datetime(),
} as const;

export const KnowledgeBaseAuditEventSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...KnowledgeAuditScope,
      action: z.literal("knowledge_created"),
      creationKey: internalKey,
    })
    .strict(),
  z
    .object({
      ...KnowledgeAuditScope,
      action: z.literal("source_published"),
      publicationKey: internalKey,
      sourceKey: internalKey,
      sourceRevision: z.number().int().positive().max(1_000),
      sourceTitle: z.string().trim().min(2).max(100),
      contentHashAlgorithm: z.literal("sha256"),
      contentHash: sha256Hash,
      byteLength: z.number().int().positive().max(524_288),
    })
    .strict(),
  z
    .object({
      ...KnowledgeAuditScope,
      action: z.literal("source_archived"),
      publicationKey: internalKey,
      sourceKey: internalKey,
      sourceRevision: z.number().int().positive().max(1_000),
      sourceTitle: z.string().trim().min(2).max(100),
      contentHashAlgorithm: z.literal("sha256"),
      contentHash: sha256Hash,
    })
    .strict(),
]);

export type KnowledgeBaseAuditEvent = z.infer<
  typeof KnowledgeBaseAuditEventSchema
>;

export interface KnowledgeSearchQuery {
  normalizedQuery: string;
  tokens: string[];
  minimumTokenMatches: number;
  limit: number;
}

export interface KnowledgeSearchMatch {
  chunk: KnowledgeChunk;
  score: number;
}

export interface KnowledgeBaseTransaction {
  find(knowledgeKey: string): Promise<KnowledgeBaseSnapshot | null>;
  findByCreation(
    actorKey: string,
    creationKey: string,
  ): Promise<KnowledgeBaseSnapshot | null>;
  count(): Promise<number>;
  save(snapshot: KnowledgeBaseSnapshot): void;
  putSource(source: KnowledgeSourceRevision, canonicalContent: string): void;
  archiveSource(knowledgeKey: string, sourceKey: string): void;
  appendAudit(event: KnowledgeBaseAuditEvent): void;
}

export interface KnowledgeBaseRepository {
  transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: KnowledgeBaseTransaction) => Promise<T> | T,
  ): Promise<T>;
  find(
    tenantKey: string,
    projectKey: string,
    knowledgeKey: string,
  ): Promise<KnowledgeBaseSnapshot | null>;
  list(tenantKey: string, projectKey: string): Promise<KnowledgeBaseSnapshot[]>;
  search(
    tenantKey: string,
    projectKey: string,
    knowledgeKey: string,
    query: KnowledgeSearchQuery,
  ): Promise<KnowledgeSearchMatch[]>;
  listAudit(
    tenantKey: string,
    projectKey: string,
    knowledgeKey: string,
    limit?: number,
  ): Promise<KnowledgeBaseAuditEvent[]>;
}

const normalizeKey = (value: string, label: string): string => {
  const parsed = internalKey.safeParse(value);
  if (!parsed.success) throw new Error(`${label}格式不正确`);
  return parsed.data;
};

const scopeKey = (tenantKey: string, projectKey: string): string =>
  `${normalizeKey(tenantKey, "租户标识")}:${normalizeKey(projectKey, "项目标识")}`;

const artifactKey = (source: KnowledgeSourceRevision): string =>
  `${source.knowledgeKey}:${source.sourceKey}:${source.revision}:${source.contentHash}`;

const activeSourceKey = (knowledgeKey: string, sourceKey: string): string =>
  `${knowledgeKey}:${sourceKey}`;

const assertSourceContent = (
  source: Pick<KnowledgeSourceRevision, "contentHash" | "byteLength">,
  canonicalContent: string,
): void => {
  const bytes = Buffer.from(canonicalContent, "utf8");
  if (bytes.byteLength !== source.byteLength) {
    throw new Error("业务资料字节数与版本记录不一致");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== source.contentHash) {
    throw new Error("业务资料内容与版本摘要不一致");
  }
};

export const normalizeKnowledgeSearchText = (input: string): string =>
  input.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export const knowledgeSearchTokens = (input: string): string[] => {
  const normalized = normalizeKnowledgeSearchText(input);
  const tokens = new Set<string>();
  for (const value of normalized.match(/[a-z0-9][a-z0-9._-]*/g) ?? []) {
    for (let offset = 0; offset < value.length; offset += 100) {
      tokens.add(value.slice(offset, offset + 100));
    }
  }
  const hanRuns = normalized.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of hanRuns) {
    const characters = [...run];
    if (characters.length === 1) tokens.add(characters[0]!);
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return [...tokens].sort();
};

const splitKnowledgeContent = (content: string): string[] => {
  const pieces: string[] = [];
  for (const paragraph of content.split(/\n{2,}/u)) {
    const normalized = paragraph.trim();
    if (!normalized) continue;
    for (let offset = 0; offset < normalized.length;) {
      let end = Math.min(offset + 1_200, normalized.length);
      if (
        end < normalized.length &&
        /[\uD800-\uDBFF]/u.test(normalized[end - 1] ?? "") &&
        /[\uDC00-\uDFFF]/u.test(normalized[end] ?? "")
      ) {
        end -= 1;
      }
      pieces.push(normalized.slice(offset, end));
      offset = end;
    }
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const next = current ? `${current}\n\n${piece}` : piece;
    if (next.length <= 1_200) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = piece;
  }
  if (current) chunks.push(current);
  return chunks;
};

export const buildKnowledgeChunks = (
  source: KnowledgeChunkSource,
  canonicalContent: string,
): KnowledgeChunk[] => {
  assertSourceContent(source, canonicalContent);
  return splitKnowledgeContent(canonicalContent)
    .map((content) => ({ content, tokens: knowledgeSearchTokens(content) }))
    .filter(({ tokens }) => tokens.length > 0)
    .map(({ content, tokens }, index) =>
      KnowledgeChunkSchema.parse({
        schemaVersion: 1,
        tenantKey: source.tenantKey,
        projectKey: source.projectKey,
        knowledgeKey: source.knowledgeKey,
        sourceKey: source.sourceKey,
        sourceRevision: source.revision,
        sourceTitle: source.title,
        contentHash: source.contentHash,
        ordinal: index + 1,
        content,
        normalizedContent: normalizeKnowledgeSearchText(content),
        tokens,
      }),
    );
};

export class InMemoryKnowledgeBaseRepository implements KnowledgeBaseRepository {
  readonly #snapshotsByScope = new Map<
    string,
    Map<string, KnowledgeBaseSnapshot>
  >();
  readonly #artifactsByScope = new Map<string, Map<string, string>>();
  readonly #chunksByScope = new Map<string, Map<string, KnowledgeChunk[]>>();
  readonly #auditByScope = new Map<string, KnowledgeBaseAuditEvent[]>();
  readonly #scopeTails = new Map<string, Promise<void>>();

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: KnowledgeBaseTransaction) => Promise<T> | T,
  ): Promise<T> {
    const key = scopeKey(tenantKey, projectKey);
    const previous = this.#scopeTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#scopeTails.set(key, current);
    await previous;

    const snapshots = new Map(
      [...(this.#snapshotsByScope.get(key) ?? new Map()).entries()].map(
        ([knowledgeKey, snapshot]) => [knowledgeKey, structuredClone(snapshot)],
      ),
    );
    const artifacts = new Map(this.#artifactsByScope.get(key) ?? []);
    const chunks = new Map(
      [...(this.#chunksByScope.get(key) ?? new Map()).entries()].map(
        ([sourceKey, values]) => [sourceKey, structuredClone(values)],
      ),
    );
    const audit = structuredClone(this.#auditByScope.get(key) ?? []);
    let changed = false;
    const transaction: KnowledgeBaseTransaction = {
      find: async (knowledgeKey) => {
        const snapshot = snapshots.get(
          normalizeKey(knowledgeKey, "知识库标识"),
        );
        return snapshot ? structuredClone(snapshot) : null;
      },
      findByCreation: async (actorKey, creationKey) => {
        const actor = normalizeKey(actorKey, "操作人标识");
        const request = normalizeKey(creationKey, "创建请求标识");
        const snapshot = [...snapshots.values()].find(
          (candidate) =>
            candidate.createdBy.actorKey === actor &&
            candidate.creationKey === request,
        );
        return snapshot ? structuredClone(snapshot) : null;
      },
      count: async () => snapshots.size,
      save: (input) => {
        const snapshot = KnowledgeBaseSnapshotSchema.parse(input);
        if (scopeKey(snapshot.tenantKey, snapshot.projectKey) !== key) {
          throw new Error("知识库事务不能写入其他租户或项目");
        }
        KnowledgeBase.fromSnapshot(snapshot);
        const duplicateCreation = [...snapshots.values()].find(
          (candidate) =>
            candidate.knowledgeKey !== snapshot.knowledgeKey &&
            candidate.createdBy.actorKey === snapshot.createdBy.actorKey &&
            candidate.creationKey === snapshot.creationKey,
        );
        if (duplicateCreation) throw new Error("知识库创建请求不能重复");
        snapshots.set(snapshot.knowledgeKey, structuredClone(snapshot));
        changed = true;
      },
      putSource: (sourceInput, canonicalContent) => {
        const source = KnowledgeSourceRevisionSchema.parse(sourceInput);
        if (source.status !== "active") {
          throw new Error("只有可用业务资料可以建立检索索引");
        }
        if (scopeKey(source.tenantKey, source.projectKey) !== key) {
          throw new Error("知识库事务不能写入其他范围的资料");
        }
        const snapshot = snapshots.get(source.knowledgeKey);
        const current = snapshot
          ? KnowledgeBase.fromSnapshot(snapshot)
              .listActiveSources()
              .find((candidate) => candidate.sourceKey === source.sourceKey)
          : null;
        if (!current || JSON.stringify(current) !== JSON.stringify(source)) {
          throw new Error("检索内容必须绑定知识库当前可用资料版本");
        }
        assertSourceContent(source, canonicalContent);
        const storedArtifact = artifacts.get(artifactKey(source));
        if (
          storedArtifact !== undefined &&
          storedArtifact !== canonicalContent
        ) {
          throw new Error("内容寻址的业务资料不能被覆盖");
        }
        const parsedChunks = buildKnowledgeChunks(source, canonicalContent);
        if (
          parsedChunks.length < 1 ||
          parsedChunks.length > 1_000 ||
          parsedChunks.some(
            (chunk, index) =>
              chunk.tenantKey !== source.tenantKey ||
              chunk.projectKey !== source.projectKey ||
              chunk.knowledgeKey !== source.knowledgeKey ||
              chunk.sourceKey !== source.sourceKey ||
              chunk.sourceRevision !== source.revision ||
              chunk.sourceTitle !== source.title ||
              chunk.contentHash !== source.contentHash ||
              chunk.ordinal !== index + 1,
          )
        ) {
          throw new Error("业务资料检索片段与当前版本不一致");
        }
        artifacts.set(artifactKey(source), canonicalContent);
        chunks.set(
          activeSourceKey(source.knowledgeKey, source.sourceKey),
          structuredClone(parsedChunks),
        );
        changed = true;
      },
      archiveSource: (knowledgeKeyInput, sourceKeyInput) => {
        const knowledgeKey = normalizeKey(knowledgeKeyInput, "知识库标识");
        const sourceKey = normalizeKey(sourceKeyInput, "业务资料标识");
        chunks.delete(activeSourceKey(knowledgeKey, sourceKey));
        changed = true;
      },
      appendAudit: (input) => {
        const event = KnowledgeBaseAuditEventSchema.parse(input);
        if (scopeKey(event.tenantKey, event.projectKey) !== key) {
          throw new Error("知识库事务不能写入其他范围的审计");
        }
        if (audit.some((candidate) => candidate.eventKey === event.eventKey)) {
          throw new Error("知识库审计标识不能重复");
        }
        audit.push(structuredClone(event));
        changed = true;
      },
    };

    try {
      const result = await operation(transaction);
      if (changed) {
        this.#snapshotsByScope.set(key, snapshots);
        this.#artifactsByScope.set(key, artifacts);
        this.#chunksByScope.set(key, chunks);
        this.#auditByScope.set(key, audit);
      }
      return result;
    } finally {
      release();
      if (this.#scopeTails.get(key) === current) this.#scopeTails.delete(key);
    }
  }

  async find(
    tenantKey: string,
    projectKey: string,
    knowledgeKey: string,
  ): Promise<KnowledgeBaseSnapshot | null> {
    const key = scopeKey(tenantKey, projectKey);
    await this.#scopeTails.get(key);
    const snapshot = this.#snapshotsByScope
      .get(key)
      ?.get(normalizeKey(knowledgeKey, "知识库标识"));
    return snapshot ? structuredClone(snapshot) : null;
  }

  async list(
    tenantKey: string,
    projectKey: string,
  ): Promise<KnowledgeBaseSnapshot[]> {
    const key = scopeKey(tenantKey, projectKey);
    await this.#scopeTails.get(key);
    return [...(this.#snapshotsByScope.get(key) ?? new Map()).values()]
      .sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
      )
      .map((snapshot) => structuredClone(snapshot));
  }

  async search(
    tenantKey: string,
    projectKey: string,
    knowledgeKeyInput: string,
    query: KnowledgeSearchQuery,
  ): Promise<KnowledgeSearchMatch[]> {
    const key = scopeKey(tenantKey, projectKey);
    const knowledgeKey = normalizeKey(knowledgeKeyInput, "知识库标识");
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 20 ||
      query.tokens.length < 1 ||
      query.tokens.length > 400 ||
      !Number.isSafeInteger(query.minimumTokenMatches) ||
      query.minimumTokenMatches < 1 ||
      query.minimumTokenMatches > query.tokens.length
    ) {
      throw new Error("知识库检索范围无效");
    }
    await this.#scopeTails.get(key);
    const queryTokens = new Set(query.tokens);
    return [
      ...(
        this.#chunksByScope.get(key) ?? new Map<string, KnowledgeChunk[]>()
      ).entries(),
    ]
      .filter(([sourceKey]) => sourceKey.startsWith(`${knowledgeKey}:`))
      .flatMap(([, chunks]) => chunks)
      .map((chunk) => {
        const tokenScore = chunk.tokens.reduce(
          (score, token) => score + (queryTokens.has(token) ? 1 : 0),
          0,
        );
        const phraseScore = chunk.normalizedContent.includes(
          query.normalizedQuery,
        )
          ? 100
          : 0;
        return { chunk, score: phraseScore + tokenScore };
      })
      .filter(
        (match) =>
          match.score >= 100 + query.minimumTokenMatches ||
          match.score >= query.minimumTokenMatches,
      )
      .sort((left, right) =>
        right.score !== left.score
          ? right.score - left.score
          : left.chunk.sourceTitle !== right.chunk.sourceTitle
            ? left.chunk.sourceTitle < right.chunk.sourceTitle
              ? -1
              : 1
            : left.chunk.ordinal - right.chunk.ordinal,
      )
      .slice(0, query.limit)
      .map((match) => structuredClone(match));
  }

  async listAudit(
    tenantKey: string,
    projectKey: string,
    knowledgeKeyInput: string,
    limit = 100,
  ): Promise<KnowledgeBaseAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("知识库审计查询条数必须在 1 到 100 之间");
    }
    const key = scopeKey(tenantKey, projectKey);
    const knowledgeKey = normalizeKey(knowledgeKeyInput, "知识库标识");
    await this.#scopeTails.get(key);
    return structuredClone(
      (this.#auditByScope.get(key) ?? [])
        .filter((event) => event.knowledgeKey === knowledgeKey)
        .slice(-limit)
        .reverse(),
    );
  }
}
