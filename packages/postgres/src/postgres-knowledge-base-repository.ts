import { createHash } from "node:crypto";

import type { Pool } from "pg";

import {
  KnowledgeBaseAuditEventSchema,
  KnowledgeChunkSchema,
  buildKnowledgeChunks,
  type KnowledgeBaseAuditEvent,
  type KnowledgeBaseRepository,
  type KnowledgeBaseTransaction,
  type KnowledgeChunk,
  type KnowledgeSearchMatch,
  type KnowledgeSearchQuery,
} from "@forgex/application";
import {
  KnowledgeBase,
  KnowledgeBaseSnapshotSchema,
  KnowledgeSourceRevisionSchema,
  type KnowledgeBaseSnapshot,
  type KnowledgeSourceRevision,
} from "@forgex/extensions";

import type {
  PostgresClient,
  PostgresPool,
} from "./postgres-worker-fleet-repository.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertInternalKey = (value: string, label: string): string => {
  const normalized = value.toLowerCase();
  if (!internalKeyPattern.test(normalized)) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
};

const stateValue = (row: unknown): unknown => {
  if (!isRecord(row) || !("state" in row)) {
    throw new Error("数据库中的知识库记录格式无效");
  }
  return typeof row.state === "string"
    ? (JSON.parse(row.state) as unknown)
    : row.state;
};

const snapshotFromRow = (row: unknown): KnowledgeBaseSnapshot => {
  const snapshot = KnowledgeBaseSnapshotSchema.parse(stateValue(row));
  KnowledgeBase.fromSnapshot(snapshot);
  return structuredClone(snapshot);
};

const auditFromRow = (row: unknown): KnowledgeBaseAuditEvent =>
  KnowledgeBaseAuditEventSchema.parse(stateValue(row));

const chunkFromRow = (row: unknown): KnowledgeChunk => {
  if (!isRecord(row)) throw new Error("数据库中的知识片段格式无效");
  return KnowledgeChunkSchema.parse({
    schemaVersion: row.schema_version,
    tenantKey: row.tenant_key,
    projectKey: row.project_key,
    knowledgeKey: row.knowledge_key,
    sourceKey: row.source_key,
    sourceRevision: Number(row.source_revision),
    sourceTitle: row.source_title,
    contentHash: row.content_hash,
    ordinal: Number(row.ordinal),
    content: row.content,
    normalizedContent: row.normalized_content,
    tokens: row.tokens,
  });
};

interface StagedSource {
  source: KnowledgeSourceRevision;
  content: string;
  chunks: KnowledgeChunk[];
}

export class PostgresKnowledgeBaseRepository implements KnowledgeBaseRepository {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: KnowledgeBaseTransaction) => Promise<T> | T,
  ): Promise<T> {
    const tenant = assertInternalKey(tenantKey, "租户标识");
    const project = assertInternalKey(projectKey, "项目标识");
    const client = await this.#pool.connect();
    let transactionStarted = false;
    const stagedSnapshots = new Map<string, KnowledgeBaseSnapshot>();
    const stagedSources: StagedSource[] = [];
    const stagedArchives = new Set<string>();
    const stagedAudit: KnowledgeBaseAuditEvent[] = [];
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenant}:${project}`],
      );
      const transaction: KnowledgeBaseTransaction = {
        find: async (knowledgeKeyInput) => {
          const knowledgeKey = assertInternalKey(
            knowledgeKeyInput,
            "知识库标识",
          );
          const staged = stagedSnapshots.get(knowledgeKey);
          if (staged) return structuredClone(staged);
          const result = await client.query(
            "SELECT state FROM forgex_knowledge_bases WHERE tenant_key = $1 AND project_key = $2 AND knowledge_key = $3",
            [tenant, project, knowledgeKey],
          );
          return result.rows[0] ? snapshotFromRow(result.rows[0]) : null;
        },
        findByCreation: async (actorKeyInput, creationKeyInput) => {
          const actorKey = assertInternalKey(actorKeyInput, "操作人标识");
          const creationKey = assertInternalKey(
            creationKeyInput,
            "创建请求标识",
          );
          const staged = [...stagedSnapshots.values()].find(
            (snapshot) =>
              snapshot.createdBy.actorKey === actorKey &&
              snapshot.creationKey === creationKey,
          );
          if (staged) return structuredClone(staged);
          const result = await client.query(
            "SELECT state FROM forgex_knowledge_bases WHERE tenant_key = $1 AND project_key = $2 AND created_by_key = $3 AND creation_key = $4",
            [tenant, project, actorKey, creationKey],
          );
          return result.rows[0] ? snapshotFromRow(result.rows[0]) : null;
        },
        count: async () => {
          const result = await client.query(
            "SELECT count(*) AS count FROM forgex_knowledge_bases WHERE tenant_key = $1 AND project_key = $2",
            [tenant, project],
          );
          const stored = Number(
            isRecord(result.rows[0]) ? result.rows[0].count : 0,
          );
          return stored + stagedSnapshots.size;
        },
        save: (input) => {
          const snapshot = KnowledgeBaseSnapshotSchema.parse(input);
          if (
            snapshot.tenantKey !== tenant ||
            snapshot.projectKey !== project
          ) {
            throw new Error("知识库事务不能写入其他租户或项目");
          }
          KnowledgeBase.fromSnapshot(snapshot);
          stagedSnapshots.set(snapshot.knowledgeKey, structuredClone(snapshot));
        },
        putSource: (sourceInput, content) => {
          const source = KnowledgeSourceRevisionSchema.parse(sourceInput);
          if (
            source.status !== "active" ||
            source.tenantKey !== tenant ||
            source.projectKey !== project
          ) {
            throw new Error("知识库事务不能写入其他范围的资料");
          }
          const snapshot = stagedSnapshots.get(source.knowledgeKey);
          const current = snapshot
            ? KnowledgeBase.fromSnapshot(snapshot)
                .listActiveSources()
                .find((candidate) => candidate.sourceKey === source.sourceKey)
            : null;
          if (!current || JSON.stringify(current) !== JSON.stringify(source)) {
            throw new Error("检索内容必须绑定知识库当前可用资料版本");
          }
          if (
            Buffer.byteLength(content, "utf8") !== source.byteLength ||
            createHash("sha256").update(content, "utf8").digest("hex") !==
              source.contentHash
          ) {
            throw new Error("业务资料内容与版本摘要不一致");
          }
          const chunks = buildKnowledgeChunks(source, content);
          if (
            chunks.length < 1 ||
            chunks.length > 1_000 ||
            chunks.some(
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
          stagedSources.push({
            source: structuredClone(source),
            content,
            chunks: structuredClone(chunks),
          });
        },
        archiveSource: (knowledgeKeyInput, sourceKeyInput) => {
          const knowledgeKey = assertInternalKey(
            knowledgeKeyInput,
            "知识库标识",
          );
          const sourceKey = assertInternalKey(sourceKeyInput, "业务资料标识");
          stagedArchives.add(`${knowledgeKey}:${sourceKey}`);
        },
        appendAudit: (input) => {
          const event = KnowledgeBaseAuditEventSchema.parse(input);
          if (event.tenantKey !== tenant || event.projectKey !== project) {
            throw new Error("知识库事务不能写入其他范围的审计");
          }
          stagedAudit.push(structuredClone(event));
        },
      };

      const result = await operation(transaction);
      for (const snapshot of stagedSnapshots.values()) {
        await client.query(
          "INSERT INTO forgex_knowledge_bases (tenant_key, project_key, knowledge_key, creation_key, created_by_key, state, revision, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now()) ON CONFLICT (tenant_key, project_key, knowledge_key) DO UPDATE SET state = EXCLUDED.state, revision = EXCLUDED.revision, updated_at = now()",
          [
            tenant,
            project,
            snapshot.knowledgeKey,
            snapshot.creationKey,
            snapshot.createdBy.actorKey,
            JSON.stringify(snapshot),
            snapshot.revision,
            snapshot.createdAt,
          ],
        );
      }
      for (const staged of stagedSources) {
        const artifact = await client.query(
          "INSERT INTO forgex_knowledge_source_artifacts (tenant_key, project_key, knowledge_key, source_key, source_revision, content_hash, byte_length, media_type, content) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_key, project_key, knowledge_key, source_key, source_revision) DO UPDATE SET content_hash = forgex_knowledge_source_artifacts.content_hash WHERE forgex_knowledge_source_artifacts.content_hash = EXCLUDED.content_hash AND forgex_knowledge_source_artifacts.byte_length = EXCLUDED.byte_length AND forgex_knowledge_source_artifacts.media_type = EXCLUDED.media_type AND forgex_knowledge_source_artifacts.content = EXCLUDED.content RETURNING content_hash",
          [
            tenant,
            project,
            staged.source.knowledgeKey,
            staged.source.sourceKey,
            staged.source.revision,
            staged.source.contentHash,
            staged.source.byteLength,
            staged.source.mediaType,
            staged.content,
          ],
        );
        if (!artifact.rows[0]) {
          throw new Error("内容寻址的业务资料不能被覆盖");
        }
        await client.query(
          "DELETE FROM forgex_knowledge_active_chunks WHERE tenant_key = $1 AND project_key = $2 AND knowledge_key = $3 AND source_key = $4",
          [
            tenant,
            project,
            staged.source.knowledgeKey,
            staged.source.sourceKey,
          ],
        );
        await client.query(
          "INSERT INTO forgex_knowledge_active_chunks (tenant_key, project_key, knowledge_key, source_key, source_revision, source_title, content_hash, ordinal, content, normalized_content, tokens) SELECT tenant_key, project_key, knowledge_key, source_key, source_revision, source_title, content_hash, ordinal, content, normalized_content, tokens FROM jsonb_to_recordset($1::jsonb) AS chunk(tenant_key uuid, project_key uuid, knowledge_key uuid, source_key uuid, source_revision integer, source_title text, content_hash text, ordinal integer, content text, normalized_content text, tokens text[])",
          [
            JSON.stringify(
              staged.chunks.map((chunk) => ({
                tenant_key: chunk.tenantKey,
                project_key: chunk.projectKey,
                knowledge_key: chunk.knowledgeKey,
                source_key: chunk.sourceKey,
                source_revision: chunk.sourceRevision,
                source_title: chunk.sourceTitle,
                content_hash: chunk.contentHash,
                ordinal: chunk.ordinal,
                content: chunk.content,
                normalized_content: chunk.normalizedContent,
                tokens: chunk.tokens,
              })),
            ),
          ],
        );
      }
      for (const value of stagedArchives) {
        const [knowledgeKey, sourceKey] = value.split(":") as [string, string];
        await client.query(
          "DELETE FROM forgex_knowledge_active_chunks WHERE tenant_key = $1 AND project_key = $2 AND knowledge_key = $3 AND source_key = $4",
          [tenant, project, knowledgeKey, sourceKey],
        );
      }
      for (const event of stagedAudit) {
        await client.query(
          "INSERT INTO forgex_knowledge_audit (tenant_key, project_key, knowledge_key, event_key, action, state, recorded_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
          [
            tenant,
            project,
            event.knowledgeKey,
            event.eventKey,
            event.action,
            JSON.stringify(event),
            event.recordedAt,
          ],
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "知识库事务失败且回滚未完成",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async find(
    tenantKey: string,
    projectKey: string,
    knowledgeKey: string,
  ): Promise<KnowledgeBaseSnapshot | null> {
    const rows = await this.#query(
      "SELECT state FROM forgex_knowledge_bases WHERE tenant_key = $1 AND project_key = $2 AND knowledge_key = $3",
      [
        assertInternalKey(tenantKey, "租户标识"),
        assertInternalKey(projectKey, "项目标识"),
        assertInternalKey(knowledgeKey, "知识库标识"),
      ],
    );
    return rows[0] ? snapshotFromRow(rows[0]) : null;
  }

  async list(
    tenantKey: string,
    projectKey: string,
  ): Promise<KnowledgeBaseSnapshot[]> {
    const rows = await this.#query(
      "SELECT state FROM forgex_knowledge_bases WHERE tenant_key = $1 AND project_key = $2 ORDER BY state ->> 'name', knowledge_key",
      [
        assertInternalKey(tenantKey, "租户标识"),
        assertInternalKey(projectKey, "项目标识"),
      ],
    );
    return rows.map(snapshotFromRow);
  }

  async search(
    tenantKey: string,
    projectKey: string,
    knowledgeKey: string,
    query: KnowledgeSearchQuery,
  ): Promise<KnowledgeSearchMatch[]> {
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
    const rows = await this.#query(
      "WITH ranked AS (SELECT 1 AS schema_version, chunk.tenant_key, chunk.project_key, chunk.knowledge_key, chunk.source_key, chunk.source_revision, chunk.source_title, chunk.content_hash, chunk.ordinal, chunk.content, chunk.normalized_content, chunk.tokens, artifact.content AS artifact_content, CASE WHEN strpos(chunk.normalized_content, $5) > 0 THEN 100 ELSE 0 END AS phrase_score, (SELECT count(*) FROM unnest(chunk.tokens) AS token WHERE token = ANY($4::text[]))::integer AS token_score FROM forgex_knowledge_active_chunks AS chunk INNER JOIN forgex_knowledge_source_artifacts AS artifact ON artifact.tenant_key = chunk.tenant_key AND artifact.project_key = chunk.project_key AND artifact.knowledge_key = chunk.knowledge_key AND artifact.source_key = chunk.source_key AND artifact.source_revision = chunk.source_revision AND artifact.content_hash = chunk.content_hash WHERE chunk.tenant_key = $1 AND chunk.project_key = $2 AND chunk.knowledge_key = $3 AND (strpos(chunk.normalized_content, $5) > 0 OR chunk.tokens && $4::text[])) SELECT *, phrase_score + token_score AS score FROM ranked WHERE phrase_score > 0 OR token_score >= $6 ORDER BY score DESC, source_title, ordinal LIMIT $7",
      [
        assertInternalKey(tenantKey, "租户标识"),
        assertInternalKey(projectKey, "项目标识"),
        assertInternalKey(knowledgeKey, "知识库标识"),
        query.tokens,
        query.normalizedQuery,
        query.minimumTokenMatches,
        query.limit,
      ],
    );
    return rows.map((row) => {
      const score = Number(isRecord(row) ? row.score : Number.NaN);
      if (!Number.isFinite(score) || score < 1) {
        throw new Error("数据库中的知识片段评分无效");
      }
      const chunk = chunkFromRow(row);
      if (!isRecord(row) || typeof row.artifact_content !== "string") {
        throw new Error("数据库中的知识片段缺少原始资料");
      }
      const expected = buildKnowledgeChunks(
        {
          tenantKey: chunk.tenantKey,
          projectKey: chunk.projectKey,
          knowledgeKey: chunk.knowledgeKey,
          sourceKey: chunk.sourceKey,
          revision: chunk.sourceRevision,
          title: chunk.sourceTitle,
          contentHash: chunk.contentHash,
          byteLength: Buffer.byteLength(row.artifact_content, "utf8"),
        },
        row.artifact_content,
      ).find((candidate) => candidate.ordinal === chunk.ordinal);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(chunk)) {
        throw new Error("数据库中的知识片段与原始资料不一致");
      }
      return { chunk, score };
    });
  }

  async listAudit(
    tenantKey: string,
    projectKey: string,
    knowledgeKey: string,
    limit = 100,
  ): Promise<KnowledgeBaseAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("知识库审计查询条数必须在 1 到 100 之间");
    }
    const rows = await this.#query(
      "SELECT state FROM forgex_knowledge_audit WHERE tenant_key = $1 AND project_key = $2 AND knowledge_key = $3 ORDER BY recorded_at DESC, event_key DESC LIMIT $4",
      [
        assertInternalKey(tenantKey, "租户标识"),
        assertInternalKey(projectKey, "项目标识"),
        assertInternalKey(knowledgeKey, "知识库标识"),
        limit,
      ],
    );
    return rows.map(auditFromRow);
  }

  async #query(text: string, values: unknown[]): Promise<unknown[]> {
    const client: PostgresClient = await this.#pool.connect();
    try {
      return (await client.query(text, values)).rows;
    } finally {
      client.release();
    }
  }
}

export const createPostgresKnowledgeBaseRepository = (
  pool: Pool,
): PostgresKnowledgeBaseRepository => new PostgresKnowledgeBaseRepository(pool);
