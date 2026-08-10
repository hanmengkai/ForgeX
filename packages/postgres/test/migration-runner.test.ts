import { describe, expect, it } from "vitest";

import {
  assertPostgresMigrationsCurrent,
  runPostgresMigrations,
  type PostgresClient,
  type PostgresMigration,
  type PostgresQueryResult,
} from "../src/index.js";

class FakeClient implements PostgresClient {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  released = false;

  constructor(
    readonly applied: Array<{
      version: string;
      name: string;
      checksum: string;
    }> = [],
  ) {}

  async query(text: string, values?: unknown[]): Promise<PostgresQueryResult> {
    this.queries.push({ text, ...(values ? { values } : {}) });
    if (text.includes("SELECT version") && text.includes("checksum")) {
      return { rows: this.applied.map((row) => ({ ...row })) };
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

const migration = (
  version: string,
  name: string,
  sql: string,
): PostgresMigration => ({ version, name, sql });

describe("PostgreSQL migration runner", () => {
  it("在同一事务和 advisory lock 下按版本执行并登记迁移摘要", async () => {
    const client = new FakeClient();
    const migrations = [
      migration("0001", "worker_fleet", "CREATE TABLE worker_fleet(id uuid);"),
      migration("0002", "requirements", "CREATE TABLE requirements(id uuid);"),
    ];

    await runPostgresMigrations({ connect: async () => client }, migrations);

    expect(client.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining(
        "CREATE TABLE IF NOT EXISTS forgex_schema_migrations",
      ),
      expect.stringContaining("SELECT version, name, checksum"),
      migrations[0]!.sql,
      expect.stringContaining("INSERT INTO forgex_schema_migrations"),
      migrations[1]!.sql,
      expect.stringContaining("INSERT INTO forgex_schema_migrations"),
      "COMMIT",
    ]);
    expect(client.released).toBe(true);
  });

  it("已执行迁移摘要一致时跳过，摘要漂移时回滚并拒绝启动", async () => {
    const original = migration(
      "0001",
      "worker_fleet",
      "CREATE TABLE worker_fleet(id uuid);",
    );
    const first = new FakeClient();
    await runPostgresMigrations({ connect: async () => first }, [original]);
    const insert = first.queries.find((query) =>
      query.text.includes("INSERT INTO forgex_schema_migrations"),
    );
    const checksum = String(insert!.values![2]);

    const exact = new FakeClient([
      { version: "0001", name: "worker_fleet", checksum },
    ]);
    await runPostgresMigrations({ connect: async () => exact }, [original]);
    expect(exact.queries.map((query) => query.text)).not.toContain(
      original.sql,
    );

    const changed = new FakeClient([
      { version: "0001", name: "worker_fleet", checksum },
    ]);
    await expect(
      runPostgresMigrations({ connect: async () => changed }, [
        { ...original, sql: `${original.sql}\n-- changed` },
      ]),
    ).rejects.toThrow("摘要不一致");
    expect(changed.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(changed.released).toBe(true);
  });

  it("就绪检查要求数据库迁移版本、名称与摘要和当前程序完全一致", async () => {
    const expected = migration(
      "0014",
      "browser_sessions",
      "CREATE TABLE browser_sessions(id text);",
    );
    const migrated = new FakeClient();
    await runPostgresMigrations({ connect: async () => migrated }, [expected]);
    const insert = migrated.queries.find((query) =>
      query.text.includes("INSERT INTO forgex_schema_migrations"),
    );
    const checksum = String(insert!.values![2]);

    const exact = new FakeClient([
      { version: "0014", name: "browser_sessions", checksum },
    ]);
    await expect(
      assertPostgresMigrationsCurrent({ connect: async () => exact }, [
        expected,
      ]),
    ).resolves.toBeUndefined();

    const missing = new FakeClient();
    await expect(
      assertPostgresMigrationsCurrent({ connect: async () => missing }, [
        expected,
      ]),
    ).rejects.toThrow("迁移状态");
    const renamed = new FakeClient([
      { version: "0014", name: "wrong_name", checksum },
    ]);
    await expect(
      assertPostgresMigrationsCurrent({ connect: async () => renamed }, [
        expected,
      ]),
    ).rejects.toThrow("迁移状态");
  });

  it("拒绝乱序、重复或非四位版本的迁移清单", async () => {
    const client = new FakeClient();
    await expect(
      runPostgresMigrations({ connect: async () => client }, [
        migration("0002", "second", "SELECT 2"),
        migration("0001", "first", "SELECT 1"),
      ]),
    ).rejects.toThrow("严格递增");
    await expect(
      runPostgresMigrations({ connect: async () => client }, [
        migration("1", "bad", "SELECT 1"),
      ]),
    ).rejects.toThrow("迁移版本");
  });
});
