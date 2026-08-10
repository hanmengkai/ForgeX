import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "@forgex/postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresBrowserSessionManager } from "../src/postgres-browser-session.js";

const databaseUrl = process.env.FORGEX_TEST_DATABASE_URL;
const integrationIt = databaseUrl ? it : it.skip;

describe("PostgreSQL 浏览器会话集成", () => {
  integrationIt(
    "同一人员的过期旧行可以被新登录稳定替换",
    async () => {
      const parsedUrl = new URL(databaseUrl!);
      if (!parsedUrl.pathname.endsWith("_test")) {
        throw new Error(
          "FORGEX_TEST_DATABASE_URL 必须指向名称以 _test 结尾的隔离数据库",
        );
      }
      const schema = `forgex_session_it_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl, max: 1 });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema}`,
        max: 2,
      });
      try {
        const migrations = await loadPostgresMigrations(
          resolve("packages/postgres/migrations"),
        );
        await runPostgresMigrations(pool, migrations);
        const sessions = new PostgresBrowserSessionManager(pool, {
          projectKey: "22222222-2222-4222-8222-222222222222",
          repositoryKey: "33333333-3333-4333-8333-333333333333",
          authRealmRevision: "a".repeat(64),
        });
        const principal = {
          actorKey: "44444444-4444-4444-8444-444444444444",
          actorName: "产品负责人",
          tenantKey: "11111111-1111-4111-8111-111111111111",
          roles: ["product_owner" as const],
        };
        const expired = await sessions.create(principal, 60);
        await pool.query(
          "UPDATE forgex_browser_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'",
        );

        const current = await sessions.create(principal, 60);

        await expect(sessions.authenticate(expired)).resolves.toBeNull();
        await expect(sessions.authenticate(current)).resolves.toEqual(
          principal,
        );
        const count = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM forgex_browser_sessions",
        );
        expect(count.rows[0]?.count).toBe("1");
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
    60_000,
  );
});
