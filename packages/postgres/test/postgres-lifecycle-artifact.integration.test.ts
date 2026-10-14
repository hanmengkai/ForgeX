import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  PostgresLifecycleArtifactStore,
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../src/index.js";
const databaseUrl = process.env.FORGEX_TEST_DATABASE_URL;
describe("正式制品的真实 PostgreSQL 验收", () => {
  (databaseUrl ? it : it.skip)(
    "多实例并发重传、恢复读取、范围隔离及损坏检测",
    async () => {
      const parsed = new URL(databaseUrl!);
      if (!parsed.pathname.endsWith("_test"))
        throw new Error("只允许隔离测试数据库");
      const schema = `forgex_artifact_${randomUUID().replaceAll("-", "")}`,
        admin = new Pool({ connectionString: databaseUrl, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema}`,
        max: 3,
      });
      try {
        await runPostgresMigrations(
          pool,
          await loadPostgresMigrations(resolve("packages/postgres/migrations")),
        );
        const scope = {
            tenantKey: randomUUID(),
            projectKey: randomUUID(),
            repositoryKey: randomUUID(),
          },
          content = Buffer.from("真实 TypeScript 项目制品");
        const envelope = {
          schemaVersion: 1 as const,
          artifactDigest: createHash("sha256").update(content).digest("hex"),
          commitSha: "a".repeat(40),
          bytesBase64: content.toString("base64"),
        };
        await Promise.all([
          new PostgresLifecycleArtifactStore(pool).put(scope, envelope),
          new PostgresLifecycleArtifactStore(pool).put(scope, envelope),
        ]);
        const restored = new PostgresLifecycleArtifactStore(pool);
        expect(
          await restored.get(
            scope,
            envelope.artifactDigest,
            envelope.commitSha,
          ),
        ).toEqual(envelope);
        for (const field of [
          "tenantKey",
          "projectKey",
          "repositoryKey",
        ] as const)
          expect(
            await restored.get(
              { ...scope, [field]: randomUUID() },
              envelope.artifactDigest,
              envelope.commitSha,
            ),
          ).toBeNull();
        expect(
          await restored.get(scope, envelope.artifactDigest, "b".repeat(40)),
        ).toBeNull();
        expect(
          (
            await pool.query(
              "SELECT count(*)::integer AS count FROM forgex_lifecycle_artifacts",
            )
          ).rows[0].count,
        ).toBe(1);
        await pool.query("UPDATE forgex_lifecycle_artifacts SET content=$1", [
          Buffer.from("损坏"),
        ]);
        await expect(
          restored.get(scope, envelope.artifactDigest, envelope.commitSha),
        ).rejects.toThrow();
        await expect(restored.put(scope, envelope)).rejects.toThrow("不可覆盖");
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
    60000,
  );
});
