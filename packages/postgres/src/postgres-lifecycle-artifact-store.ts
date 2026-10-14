import { z } from "zod";
import {
  LifecycleArtifactScopeSchema,
  verifyLifecycleArtifact,
  type LifecycleArtifactScope,
  type LifecycleArtifactStore,
} from "@forgex/application";
import type { LifecycleArtifactEnvelope } from "@forgex/contracts/lifecycle";
import type { PostgresPool } from "./postgres-worker-fleet-repository.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const artifactScope = (scope: LifecycleArtifactScope) =>
  LifecycleArtifactScopeSchema.parse({
    tenantKey: scope.tenantKey,
    projectKey: scope.projectKey,
    repositoryKey: scope.repositoryKey,
  });
const bytes = (row: unknown): Buffer => {
  if (
    !row ||
    typeof row !== "object" ||
    !("content" in row) ||
    !(row.content instanceof Uint8Array)
  )
    throw new Error("持久化交付制品内容格式不正确");
  return Buffer.from(row.content);
};

export class PostgresLifecycleArtifactStore implements LifecycleArtifactStore {
  constructor(readonly pool: PostgresPool) {}
  async put(
    scope: LifecycleArtifactScope,
    envelope: LifecycleArtifactEnvelope,
  ): Promise<void> {
    const validated = artifactScope(scope);
    const content = verifyLifecycleArtifact(envelope);
    const values = [
      validated.tenantKey,
      validated.projectKey,
      validated.repositoryKey,
      envelope.artifactDigest,
      envelope.commitSha,
    ];
    const client = await this.pool.connect();
    let started = false;
    try {
      await client.query("BEGIN");
      started = true;
      const inserted = await client.query(
        "INSERT INTO forgex_lifecycle_artifacts (tenant_key, project_key, repository_key, artifact_digest, commit_sha, content) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING artifact_digest",
        [...values, content],
      );
      if (!inserted.rows.length) {
        const existing = await client.query(
          "SELECT content FROM forgex_lifecycle_artifacts WHERE tenant_key=$1 AND project_key=$2 AND repository_key=$3 AND artifact_digest=$4 AND commit_sha=$5",
          values,
        );
        if (!bytes(existing.rows[0]).equals(content))
          throw new Error("同一提交和摘要的交付制品不可覆盖");
      }
      await client.query("COMMIT");
      started = false;
    } catch (error) {
      if (started) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async get(
    scope: LifecycleArtifactScope,
    digest: string,
    commitSha: string,
  ): Promise<LifecycleArtifactEnvelope | null> {
    const validated = artifactScope(scope);
    digestSchema.parse(digest);
    commitSchema.parse(commitSha);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT content FROM forgex_lifecycle_artifacts WHERE tenant_key=$1 AND project_key=$2 AND repository_key=$3 AND artifact_digest=$4 AND commit_sha=$5",
        [
          validated.tenantKey,
          validated.projectKey,
          validated.repositoryKey,
          digest,
          commitSha,
        ],
      );
      if (!result.rows[0]) return null;
      const envelope: LifecycleArtifactEnvelope = {
        schemaVersion: 1,
        artifactDigest: digest,
        commitSha,
        bytesBase64: bytes(result.rows[0]).toString("base64"),
      };
      verifyLifecycleArtifact(envelope);
      return envelope;
    } finally {
      client.release();
    }
  }
}
