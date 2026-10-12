import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  LifecycleArtifactEnvelopeSchema,
  type LifecycleArtifactEnvelope,
} from "@forgex/contracts/lifecycle";
import { openPrivateSqlite } from "./sqlite-lifecycle-repository.js";

export const LifecycleArtifactScopeSchema = z
  .object({
    tenantKey: z.string().uuid(),
    projectKey: z.string().uuid(),
    repositoryKey: z.string().uuid(),
  })
  .strict();
export type LifecycleArtifactScope = z.infer<
  typeof LifecycleArtifactScopeSchema
>;
export interface LifecycleArtifactStore {
  put(
    scope: LifecycleArtifactScope,
    envelope: LifecycleArtifactEnvelope,
  ): Promise<void>;
  get(
    scope: LifecycleArtifactScope,
    digest: string,
    commitSha: string,
  ): Promise<LifecycleArtifactEnvelope | null>;
}
export function verifyLifecycleArtifact(
  envelope: LifecycleArtifactEnvelope,
): Buffer {
  const parsed = LifecycleArtifactEnvelopeSchema.parse(envelope),
    bytes = Buffer.from(parsed.bytesBase64, "base64");
  if (
    bytes.length > 128 * 1024 ||
    bytes.toString("base64") !== parsed.bytesBase64 ||
    createHash("sha256").update(bytes).digest("hex") !== parsed.artifactDigest
  )
    throw new Error("制品摘要或内容大小不符合交接协议");
  return bytes;
}
export class SqliteLifecycleArtifactStore implements LifecycleArtifactStore {
  #closed = false;
  private constructor(readonly database: DatabaseSync) {}
  static async open(file: string): Promise<SqliteLifecycleArtifactStore> {
    const database = await openPrivateSqlite(file);
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS lifecycle_artifacts(tenant_key TEXT NOT NULL,project_key TEXT NOT NULL,repository_key TEXT NOT NULL,digest TEXT NOT NULL,commit_sha TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(tenant_key,project_key,repository_key,digest,commit_sha));",
      );
      return new SqliteLifecycleArtifactStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  async put(
    scope: LifecycleArtifactScope,
    envelope: LifecycleArtifactEnvelope,
  ): Promise<void> {
    LifecycleArtifactScopeSchema.parse({
      tenantKey: scope.tenantKey,
      projectKey: scope.projectKey,
      repositoryKey: scope.repositoryKey,
    });
    verifyLifecycleArtifact(envelope);
    const existing = await this.get(
      scope,
      envelope.artifactDigest,
      envelope.commitSha,
    );
    if (existing && existing.bytesBase64 !== envelope.bytesBase64)
      throw new Error("相同摘要的制品不可覆盖");
    this.database
      .prepare("INSERT OR IGNORE INTO lifecycle_artifacts VALUES (?,?,?,?,?,?)")
      .run(
        scope.tenantKey,
        scope.projectKey,
        scope.repositoryKey,
        envelope.artifactDigest,
        envelope.commitSha,
        JSON.stringify(envelope),
      );
  }
  async get(
    scope: LifecycleArtifactScope,
    digest: string,
    commitSha: string,
  ): Promise<LifecycleArtifactEnvelope | null> {
    LifecycleArtifactScopeSchema.parse({
      tenantKey: scope.tenantKey,
      projectKey: scope.projectKey,
      repositoryKey: scope.repositoryKey,
    });
    z.string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(digest);
    z.string()
      .regex(/^[a-f0-9]{40}$/u)
      .parse(commitSha);
    const row = this.database
      .prepare(
        "SELECT envelope FROM lifecycle_artifacts WHERE tenant_key=? AND project_key=? AND repository_key=? AND digest=? AND commit_sha=?",
      )
      .get(
        scope.tenantKey,
        scope.projectKey,
        scope.repositoryKey,
        digest,
        commitSha,
      );
    if (!row) return null;
    const envelope = LifecycleArtifactEnvelopeSchema.parse(
      JSON.parse(String(row.envelope)),
    );
    if (envelope.artifactDigest !== digest || envelope.commitSha !== commitSha)
      throw new Error("持久化制品索引与摘要不匹配");
    verifyLifecycleArtifact(envelope);
    return envelope;
  }
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.database.close();
    }
  }
}
