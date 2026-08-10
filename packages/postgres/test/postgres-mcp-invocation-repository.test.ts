import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  canonicalizeMcpInputSchema,
  canonicalizeMcpArguments,
  type McpInvocationAuditEvent,
  type McpInvocationRecord,
} from "@forgex/application";

import {
  PostgresMcpInputSchemaStore,
  PostgresMcpInvocationRepository,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const invocationKey = "33333333-3333-4333-8333-333333333333";
const requestKey = "44444444-4444-4444-8444-444444444444";
const schema = {
  type: "object",
  properties: {
    target: { type: "string", title: "操作目标", writeOnly: false },
  },
  required: ["target"],
  additionalProperties: false,
};
const schemaHash = canonicalizeMcpInputSchema(schema).hash;

const record: McpInvocationRecord = {
  schemaVersion: 1,
  invocationKey,
  requestKey,
  tenantKey,
  projectKey,
  serverKey: "55555555-5555-4555-8555-555555555555",
  serverRevision: 2,
  serverName: "代码仓库助手",
  manifestHashAlgorithm: "sha256",
  manifestHash: "a".repeat(64),
  toolKey: "66666666-6666-4666-8666-666666666666",
  technicalName: "repository.create_branch",
  toolDisplayName: "创建交付分支",
  effect: "write",
  approvalMode: "review_required",
  connectionBindingKey: "77777777-7777-4777-8777-777777777777",
  inputSchemaHashAlgorithm: "sha256",
  inputSchemaHash: schemaHash,
  argumentsHashAlgorithm: "sha256",
  argumentsHash: canonicalizeMcpArguments({ target: "feature/payment" }).hash,
  arguments: { target: "feature/payment" },
  requestedByKey: "88888888-8888-4888-8888-888888888888",
  requestedByName: "初级研发",
  requestedAt: "2026-08-10T10:00:00.000Z",
  status: "awaiting_approval",
  approval: null,
  executionLease: null,
  result: null,
};
const audit: McpInvocationAuditEvent = {
  schemaVersion: 1,
  eventKey: "99999999-9999-4999-8999-999999999999",
  tenantKey,
  projectKey,
  invocationKey,
  action: "approved",
  actorKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  actorName: "产品负责人",
  recordedAt: "2026-08-10T10:01:00.000Z",
  manifestHashAlgorithm: "sha256",
  manifestHash: record.manifestHash,
  argumentsHashAlgorithm: "sha256",
  argumentsHash: record.argumentsHash,
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

describe("Postgres MCP 调用持久化", () => {
  it("不可变保存并按范围读取输入 Schema", async () => {
    const database = fakePool([
      [{ inputSchemaHash: schemaHash }],
      [{ schema }],
    ]);
    const store = new PostgresMcpInputSchemaStore(database.pool);
    const reference = {
      tenantKey,
      projectKey,
      hashAlgorithm: "sha256" as const,
      hash: schemaHash,
    };

    await store.put(reference, schema);
    await expect(store.get(reference)).resolves.toEqual(schema);
    expect(database.queries[0]?.text).toContain(
      "INSERT INTO forgex_mcp_input_schemas",
    );
    expect(database.queries[0]?.values?.slice(0, 3)).toEqual([
      tenantKey,
      projectKey,
      schemaHash,
    ]);
    expect(database.queries[1]?.text).toContain(
      "WHERE tenant_key = $1 AND project_key = $2",
    );
  });

  it("在项目级事务锁内保存调用和审批审计", async () => {
    const database = fakePool([[], [], [], [], [], []]);
    const repository = new PostgresMcpInvocationRepository(database.pool);

    await repository.transaction(tenantKey, projectKey, async (transaction) => {
      await expect(transaction.find(invocationKey)).resolves.toBeNull();
      transaction.save(record);
      transaction.appendAudit(audit);
    });

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT state"),
      expect.stringContaining("INSERT INTO forgex_mcp_invocations"),
      expect.stringContaining("INSERT INTO forgex_mcp_invocation_audit"),
      "COMMIT",
    ]);
    expect(database.queries[1]?.values).toEqual([
      `${tenantKey}:mcp-invocations`,
    ]);
    expect(JSON.parse(String(database.queries[3]?.values?.[4]))).toEqual(
      record,
    );
    expect(JSON.parse(String(database.queries[4]?.values?.[4]))).toEqual(audit);
  });

  it("在租户事务锁内统计未完成调用，为并发创建提供硬上限", async () => {
    const database = fakePool([[], [], [{ count: "42" }], []]);
    const repository = new PostgresMcpInvocationRepository(database.pool);

    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.countOutstandingAcrossTenant(),
      ),
    ).resolves.toBe(42);
    expect(database.queries[1]?.values).toEqual([
      `${tenantKey}:mcp-invocations`,
    ]);
    expect(database.queries[2]?.text).toContain(
      "tenant_key = $1 AND status IN ('awaiting_approval', 'queued', 'leased'",
    );
  });

  it("读取时重新校验调用记录和租户项目范围", async () => {
    const repository = new PostgresMcpInvocationRepository(
      fakePool([[{ state: record }]]).pool,
    );
    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual([
      record,
    ]);

    const crossed = new PostgresMcpInvocationRepository(
      fakePool([
        [
          {
            state: {
              ...record,
              projectKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            },
          },
        ],
      ]).pool,
    );
    await expect(crossed.list(tenantKey, projectKey)).rejects.toThrow(
      "数据库中的 MCP 调用不属于查询范围",
    );
  });

  it("迁移包含不可变 Schema、请求幂等、范围绑定和审批外键", () => {
    const migration = readFileSync(
      new URL("../migrations/0008_mcp_invocations.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "PRIMARY KEY (tenant_key, project_key, input_schema_hash)",
    );
    expect(migration).toContain(
      "UNIQUE (tenant_key, project_key, requested_by_key, request_key)",
    );
    expect(migration).toContain(
      "(state ->> 'manifestHash') IS NOT DISTINCT FROM manifest_hash",
    );
    expect(migration).toContain(
      "REFERENCES forgex_mcp_input_schemas (tenant_key, project_key, input_schema_hash)",
    );
    expect(migration).toContain(
      "REFERENCES forgex_mcp_invocations (tenant_key, project_key, invocation_key)",
    );
    expect(migration).toContain(
      "action IN ('approved', 'leased', 'completed', 'cancelled', 'outcome_unknown')",
    );
    expect(migration).toContain("forgex_mcp_invocations_dispatch_idx");
    expect(migration).toContain("forgex_mcp_invocations_outstanding_idx");
  });

  it("在数据库层只按租户读取最旧的可派发与待清理调用", async () => {
    const queued = {
      ...record,
      status: "queued" as const,
      approval: {
        actorKey: audit.actorKey,
        actorName: audit.actorName,
        approvedAt: audit.recordedAt,
      },
    };
    const database = fakePool([[{ project_key: projectKey, state: queued }]]);
    const repository = new PostgresMcpInvocationRepository(database.pool);

    await expect(
      repository.listDispatchableAcrossProjects(tenantKey, 25),
    ).resolves.toEqual([queued]);
    expect(database.queries[0]?.text).toContain(
      "status IN ('queued', 'leased', 'cancellation_pending', 'completion_pending', 'outcome_unknown_pending_cleanup')",
    );
    expect(database.queries[0]?.text).toContain(
      "ORDER BY CASE WHEN status IN ('cancellation_pending', 'outcome_unknown_pending_cleanup') THEN 0 WHEN status = 'completion_pending' THEN 1 WHEN status = 'leased' THEN 2 ELSE 3 END, requested_at ASC, invocation_key ASC",
    );
    expect(database.queries[0]?.values).toEqual([tenantKey, 25]);
  });
});
