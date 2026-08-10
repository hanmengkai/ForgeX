import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PostgresMcpRegistryRepository,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const serverKey = "33333333-3333-4333-8333-333333333333";
const attestationKey = "44444444-4444-4444-8444-444444444444";
const snapshot = {
  schemaVersion: 1 as const,
  tenantKey,
  projectKey,
  servers: [],
  enableRecords: [],
};
const audit = {
  eventKey: "55555555-5555-4555-8555-555555555555",
  tenantKey,
  projectKey,
  action: "enabled" as const,
  actorKey: "66666666-6666-4666-8666-666666666666",
  actorName: "平台管理员",
  serverKey,
  revision: 1,
  attestationKey,
  recordedAt: "2026-08-10T09:00:00.000Z",
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

describe("PostgresMcpRegistryRepository", () => {
  it("在项目级事务锁内原子保存快照和启用审计", async () => {
    const database = fakePool([[], [], [], [], [], []]);
    const repository = new PostgresMcpRegistryRepository(database.pool);

    await repository.transaction(tenantKey, projectKey, (transaction) => {
      expect(transaction.load()).toBeNull();
      transaction.save(snapshot);
      transaction.appendAudit(audit);
    });

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT state"),
      expect.stringContaining("INSERT INTO forgex_mcp_registries"),
      expect.stringContaining("INSERT INTO forgex_mcp_enable_audit"),
      "COMMIT",
    ]);
    expect(database.queries[1]?.values).toEqual([
      `${tenantKey}:${projectKey}:mcp-registry`,
    ]);
    expect(JSON.parse(String(database.queries[3]?.values?.[2]))).toEqual(
      snapshot,
    );
    expect(database.queries[4]?.values).toEqual([
      audit.eventKey,
      tenantKey,
      projectKey,
      serverKey,
      1,
      attestationKey,
      "enabled",
      audit.actorKey,
      audit.actorName,
      audit.recordedAt,
    ]);
  });

  it("读取审计时校验租户项目范围", async () => {
    const repository = new PostgresMcpRegistryRepository(
      fakePool([[audit]]).pool,
    );
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      audit,
    ]);

    const crossed = fakePool([
      [
        {
          ...audit,
          projectKey: "77777777-7777-4777-8777-777777777777",
        },
      ],
    ]);
    await expect(
      new PostgresMcpRegistryRepository(crossed.pool).listAudit(
        tenantKey,
        projectKey,
      ),
    ).rejects.toThrow("数据库中的 MCP 审计不属于查询范围");
  });

  it("迁移约束快照范围、操作类型和审计外键", () => {
    const migration = readFileSync(
      new URL("../migrations/0007_mcp_registry.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("PRIMARY KEY (tenant_key, project_key)");
    expect(migration).toContain(
      "(state ->> 'projectKey') IS NOT DISTINCT FROM project_key::text",
    );
    expect(migration).toContain(
      "action IN ('enabled', 'rolled_back', 'disabled', 'health_disabled')",
    );
    expect(migration).toContain(
      "REFERENCES forgex_mcp_registries (tenant_key, project_key)",
    );
  });

  it("生产文档把 MCP 迁移和共享注入接在 Skill 注册表之后", () => {
    const readme = readFileSync(
      new URL("../../../README.md", import.meta.url),
      "utf8",
    );
    expect(readme.indexOf("0007_mcp_registry.sql")).toBeGreaterThan(
      readme.indexOf("0006_skill_registry.sql"),
    );
    expect(readme).toContain("PostgresMcpRegistryRepository");
  });
});
