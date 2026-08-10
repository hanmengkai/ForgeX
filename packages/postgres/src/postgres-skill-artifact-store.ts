import type { SkillArtifactStore } from "@forgex/application";
import { verifySkillArtifactBytes } from "@forgex/application";
import {
  SkillPackageManifestSchema,
  type SkillPackageManifest,
} from "@forgex/extensions";

import type { PostgresPool } from "./postgres-worker-fleet-repository.js";

const rowBytes = (row: unknown, manifest: SkillPackageManifest): Uint8Array => {
  if (
    typeof row !== "object" ||
    row === null ||
    !("artifactHash" in row) ||
    !("sizeBytes" in row) ||
    !("content" in row)
  ) {
    throw new Error("数据库中的 Skill 制品记录格式无效");
  }
  if (
    row.artifactHash !== manifest.artifactHash ||
    Number(row.sizeBytes) !== manifest.artifactSizeBytes ||
    !(row.content instanceof Uint8Array)
  ) {
    throw new Error("数据库中的 Skill 制品与清单不一致");
  }
  return verifySkillArtifactBytes(manifest, row.content);
};

export class PostgresSkillArtifactStore implements SkillArtifactStore {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async put(
    manifestInput: SkillPackageManifest,
    input: Uint8Array,
  ): Promise<void> {
    const manifest = SkillPackageManifestSchema.parse(manifestInput);
    const bytes = verifySkillArtifactBytes(manifest, input);
    const client = await this.#pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `${manifest.tenantKey}:${manifest.projectKey}:${manifest.skillKey}:${manifest.version}:skill-artifact`,
        ],
      );
      const stored = await client.query(
        'SELECT artifact_hash AS "artifactHash", size_bytes AS "sizeBytes", content FROM forgex_skill_artifacts WHERE tenant_key = $1 AND project_key = $2 AND skill_key = $3 AND skill_version = $4',
        [
          manifest.tenantKey,
          manifest.projectKey,
          manifest.skillKey,
          manifest.version,
        ],
      );
      if (stored.rows[0]) {
        const existing = rowBytes(stored.rows[0], manifest);
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
          throw new Error("同一版本的 Skill 制品不能被覆盖");
        }
      } else {
        await client.query(
          "INSERT INTO forgex_skill_artifacts (tenant_key, project_key, skill_key, skill_version, artifact_hash, size_bytes, content) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [
            manifest.tenantKey,
            manifest.projectKey,
            manifest.skillKey,
            manifest.version,
            manifest.artifactHash,
            manifest.artifactSizeBytes,
            Buffer.from(bytes),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Skill 制品事务失败且回滚未完成",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async get(manifestInput: SkillPackageManifest): Promise<Uint8Array | null> {
    const manifest = SkillPackageManifestSchema.parse(manifestInput);
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        'SELECT artifact_hash AS "artifactHash", size_bytes AS "sizeBytes", content FROM forgex_skill_artifacts WHERE tenant_key = $1 AND project_key = $2 AND skill_key = $3 AND skill_version = $4',
        [
          manifest.tenantKey,
          manifest.projectKey,
          manifest.skillKey,
          manifest.version,
        ],
      );
      return result.rows[0]
        ? Uint8Array.from(rowBytes(result.rows[0], manifest))
        : null;
    } finally {
      client.release();
    }
  }
}
