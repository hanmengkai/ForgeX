import { createHash, timingSafeEqual } from "node:crypto";

import type {
  PreviewArtifact,
  PreviewArtifactReference,
  PreviewArtifactStore,
} from "@forgex/application";

import type { PostgresPool } from "./postgres-worker-fleet-repository.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const normalizeReference = (
  reference: PreviewArtifactReference,
): PreviewArtifactReference => {
  const tenantKey = reference.tenantKey.trim().toLowerCase();
  const projectKey = reference.projectKey.trim().toLowerCase();
  const requirementKey = reference.requirementKey.trim().toLowerCase();
  if (
    !internalKeyPattern.test(tenantKey) ||
    !internalKeyPattern.test(projectKey) ||
    !internalKeyPattern.test(requirementKey) ||
    !Number.isSafeInteger(reference.requirementRevision) ||
    reference.requirementRevision < 1 ||
    reference.artifactHashAlgorithm !== "sha256" ||
    !sha256Pattern.test(reference.artifactHash)
  ) {
    throw new Error("Preview 制品引用无效");
  }
  return {
    tenantKey,
    projectKey,
    requirementKey,
    requirementRevision: reference.requirementRevision,
    artifactHashAlgorithm: "sha256",
    artifactHash: reference.artifactHash,
  };
};

const digest = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const assertContent = (
  content: Uint8Array,
  reference: PreviewArtifactReference,
): void => {
  if (!(content instanceof Uint8Array)) {
    throw new Error("Preview 制品必须使用字节内容");
  }
  if (content.byteLength < 1 || content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error("Preview 制品超过大小上限");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error("Preview 制品必须是有效的 UTF-8 HTML");
  }
  if (digest(content) !== reference.artifactHash) {
    throw new Error("Preview 制品完整性校验失败");
  }
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));

const contentFromRow = (row: unknown): Uint8Array => {
  if (
    typeof row !== "object" ||
    row === null ||
    !("content" in row) ||
    !(row.content instanceof Uint8Array)
  ) {
    throw new Error("数据库中的 Preview 制品格式无效");
  }
  return Uint8Array.from(row.content);
};

export class PostgresPreviewArtifactStore implements PreviewArtifactStore {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async put(artifact: PreviewArtifact): Promise<void> {
    const reference = normalizeReference(artifact);
    assertContent(artifact.content, reference);
    const client = await this.#pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const inserted = await client.query(
        "INSERT INTO forgex_preview_artifacts (tenant_key, project_key, requirement_key, requirement_revision, artifact_hash, content) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING artifact_hash",
        [
          reference.tenantKey,
          reference.projectKey,
          reference.requirementKey,
          reference.requirementRevision,
          reference.artifactHash,
          Buffer.from(artifact.content),
        ],
      );
      if (inserted.rows.length === 0) {
        const existing = await client.query(
          "SELECT content FROM forgex_preview_artifacts WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4 AND artifact_hash = $5",
          [
            reference.tenantKey,
            reference.projectKey,
            reference.requirementKey,
            reference.requirementRevision,
            reference.artifactHash,
          ],
        );
        const existingContent = contentFromRow(existing.rows[0]);
        if (!sameBytes(existingContent, artifact.content)) {
          throw new Error("内容寻址的 Preview 制品不可覆盖");
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async get(
    requestedReference: PreviewArtifactReference,
  ): Promise<PreviewArtifact | null> {
    const reference = normalizeReference(requestedReference);
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        "SELECT content FROM forgex_preview_artifacts WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4 AND artifact_hash = $5",
        [
          reference.tenantKey,
          reference.projectKey,
          reference.requirementKey,
          reference.requirementRevision,
          reference.artifactHash,
        ],
      );
      if (!result.rows[0]) return null;
      const content = contentFromRow(result.rows[0]);
      assertContent(content, reference);
      return { ...reference, content };
    } finally {
      client.release();
    }
  }
}
