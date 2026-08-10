import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PostgresExtensionCatalogRepository,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const entry = {
  schemaVersion: 1 as const,
  extensionKey: "33333333-3333-4333-8333-333333333333",
  tenantKey: "11111111-1111-4111-8111-111111111111",
  projectKey: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  kind: "skill" as const,
  name: "需求风险检查",
  summary: "在进入开发前检查遗漏、歧义和高风险变更",
  status: "ready" as const,
  version: "1.0.0",
  compatibleBlueprints: [],
  successRate: null,
  evaluationCount: 0,
  updatedAt: "2026-08-10T06:00:00.000Z",
};

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

const fakePool = (responses: unknown[][]) => {
  const queries: RecordedQuery[] = [];
  const client: PostgresClient = {
    query: async (text, values) => {
      queries.push(values ? { text, values } : { text });
      return { rows: responses.shift() ?? [] };
    },
    release: () => undefined,
  };
  const pool: PostgresPool = { connect: async () => client };
  return { pool, queries };
};

describe("PostgresExtensionCatalogRepository", () => {
  it("在项目事务锁内校验版本并保存严格定义", async () => {
    const database = fakePool([[], [], [], [], []]);
    const repository = new PostgresExtensionCatalogRepository(database.pool);

    await repository.publish(entry);

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT definition"),
      expect.stringContaining("INSERT INTO forgex_extension_catalog"),
      "COMMIT",
    ]);
    expect(database.queries[1]?.values).toEqual([
      `${entry.tenantKey}:${entry.projectKey}`,
    ]);
    expect(database.queries[3]?.values?.slice(0, 5)).toEqual([
      entry.tenantKey,
      entry.projectKey,
      entry.extensionKey,
      entry.kind,
      entry.revision,
    ]);
    expect(JSON.parse(String(database.queries[3]?.values?.[5]))).toEqual(entry);
  });

  it("从数据库最新版本恢复后可以继续发布下一版本", async () => {
    const revisionTwo = { ...entry, revision: 2, version: "1.1.0" };
    const database = fakePool([[], [], [{ definition: revisionTwo }], [], []]);
    const repository = new PostgresExtensionCatalogRepository(database.pool);

    await expect(
      repository.publish({ ...entry, revision: 3, version: "1.2.0" }),
    ).resolves.toBeUndefined();

    expect(database.queries[3]?.values?.[4]).toBe(3);
  });

  it("一个扩展升级后仍可发布同项目的另一个扩展", async () => {
    const revisionTwo = { ...entry, revision: 2, version: "1.1.0" };
    const another = {
      ...entry,
      extensionKey: "44444444-4444-4444-8444-444444444444",
      name: "交付风险检查",
    };
    const database = fakePool([[], [], [{ definition: revisionTwo }], [], []]);
    const repository = new PostgresExtensionCatalogRepository(database.pool);

    await expect(repository.publish(another)).resolves.toBeUndefined();
    expect(database.queries[3]?.values?.[2]).toBe(another.extensionKey);
  });

  it("读取时拒绝数据库中的宽松或跨范围定义", async () => {
    const database = fakePool([
      [
        {
          definition: {
            ...entry,
            projectKey: "44444444-4444-4444-8444-444444444444",
          },
        },
      ],
    ]);
    const repository = new PostgresExtensionCatalogRepository(database.pool);

    await expect(
      repository.list(entry.tenantKey, entry.projectKey),
    ).rejects.toThrow("数据库中的扩展不属于查询范围");
  });

  it("迁移建立项目范围主键、类型约束和同类名称唯一约束", () => {
    const migration = readFileSync(
      new URL("../migrations/0005_extension_catalog.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      "PRIMARY KEY (tenant_key, project_key, extension_key)",
    );
    expect(migration).toContain(
      "CHECK (kind IN ('knowledge', 'skill', 'mcp'))",
    );
    expect(migration).toContain(
      "(definition ->> 'extensionKey') IS NOT DISTINCT FROM extension_key::text",
    );
    expect(migration).toContain(
      "((definition ->> 'revision')::integer) IS NOT DISTINCT FROM revision",
    );
    expect(migration).toContain("forgex_extension_catalog_kind_name_unique");
  });

  it("生产文档把扩展迁移和共享仓储接在 Preview 之后", () => {
    const readme = readFileSync(
      new URL("../../../README.md", import.meta.url),
      "utf8",
    );
    expect(readme.indexOf("0005_extension_catalog.sql")).toBeGreaterThan(
      readme.indexOf("0004_preview_artifacts.sql"),
    );
    expect(readme).toContain("PostgresExtensionCatalogRepository");
  });
});
