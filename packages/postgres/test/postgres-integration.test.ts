import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { loadPostgresMigrations, runPostgresMigrations } from "../src/index.js";

const databaseUrl = process.env.FORGEX_TEST_DATABASE_URL;
const integrationIt = databaseUrl ? it : it.skip;

describe("真实 PostgreSQL 迁移", () => {
  integrationIt(
    "并发执行完整迁移仍只登记一次并生成所有生产表",
    async () => {
      const parsedUrl = new URL(databaseUrl!);
      if (!parsedUrl.pathname.endsWith("_test")) {
        throw new Error(
          "FORGEX_TEST_DATABASE_URL 必须指向名称以 _test 结尾的隔离数据库",
        );
      }
      const schema = `forgex_it_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema}`,
        max: 4,
      });
      try {
        const migrations = await loadPostgresMigrations(
          resolve("packages/postgres/migrations"),
        );
        await Promise.all([
          runPostgresMigrations(pool, migrations),
          runPostgresMigrations(pool, migrations),
        ]);
        await runPostgresMigrations(pool, migrations);

        const applied = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM forgex_schema_migrations",
        );
        expect(Number(applied.rows[0]?.count)).toBe(migrations.length);

        const tables = await pool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
          [schema],
        );
        const tableNames = new Set(tables.rows.map((row) => row.table_name));
        for (const tableName of [
          "forgex_worker_fleets",
          "forgex_requirements",
          "forgex_preview_artifacts",
          "forgex_skill_registries",
          "forgex_mcp_registries",
          "forgex_mcp_invocations",
          "forgex_knowledge_bases",
          "forgex_verification_failures",
        ]) {
          expect(tableNames.has(tableName), tableName).toBe(true);
        }
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
    60_000,
  );
});
