import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { WorkerFleetSnapshot } from "@forgex/application";

import {
  PostgresWorkerFleetRepository,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const workKey = "33333333-3333-4333-8333-333333333333";

const snapshot = (): WorkerFleetSnapshot => ({
  schemaVersion: 1,
  registry: {
    schemaVersion: 1,
    tenantKey,
    maxAccounts: 5,
    offlineAfterMs: 30_000,
    nextFencingToken: 1,
    workers: [],
    workTitles: [],
  },
  queue: {
    schemaVersion: 1,
    leaseDurationMs: 60_000,
    maxPendingWork: 500,
    completionRetentionMs: 86_400_000,
    maxCompletionTombstones: 1_000,
    pending: [],
    active: [],
    completed: [],
  },
});

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

const fakeDatabase = (options?: {
  storedState?: WorkerFleetSnapshot;
  completed?: boolean;
  completionProof?: {
    assignmentKey: string;
    fencingToken: number;
    completionDigest?: string;
  };
}) => {
  const queries: RecordedQuery[] = [];
  let released = false;
  const client: PostgresClient = {
    query: async (text, values) => {
      queries.push(values ? { text, values } : { text });
      if (text.includes("SELECT state")) {
        return {
          rows: options?.storedState ? [{ state: options.storedState }] : [],
        };
      }
      if (text.includes("SELECT completion_assignment_key")) {
        return {
          rows: options?.completed
            ? [
                options.completionProof
                  ? {
                      completion_assignment_key:
                        options.completionProof.assignmentKey,
                      completion_fencing_token:
                        options.completionProof.fencingToken,
                      completion_digest:
                        options.completionProof.completionDigest ?? null,
                    }
                  : {},
              ]
            : [],
        };
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const pool: PostgresPool = {
    connect: async () => client,
  };
  return { pool, queries, wasReleased: () => released };
};

describe("PostgresWorkerFleetRepository", () => {
  it("在同一数据库事务内锁定租户、保存快照和完成唯一记录", async () => {
    const database = fakeDatabase();
    const repository = new PostgresWorkerFleetRepository(database.pool);

    await expect(
      repository.transaction(tenantKey, async (transaction) => {
        expect(transaction.load()).toBeNull();
        expect(await transaction.hasCompletedWork(projectKey, workKey, 2)).toBe(
          false,
        );
        transaction.save(snapshot());
        await transaction.markCompletedWork(projectKey, workKey, 2);
        return "已提交";
      }),
    ).resolves.toBe("已提交");

    expect(database.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("SELECT state"),
      expect.stringContaining("SELECT completion_assignment_key"),
      expect.stringContaining("INSERT INTO forgex_completed_delivery_work"),
      expect.stringContaining("INSERT INTO forgex_worker_fleets"),
      "COMMIT",
    ]);
    expect(database.queries[1]?.values).toEqual([tenantKey]);
    expect(database.queries[2]?.values).toEqual([tenantKey]);
    expect(database.queries[4]?.values).toEqual([
      tenantKey,
      projectKey,
      workKey,
      2,
      "requirement_delivery",
      null,
      null,
      null,
    ]);
    expect(database.wasReleased()).toBe(true);
  });

  it("失败时回滚，且加载结果与仓储内部状态隔离", async () => {
    const stored = snapshot();
    const database = fakeDatabase({ storedState: stored });
    const repository = new PostgresWorkerFleetRepository(database.pool);

    await expect(
      repository.transaction(tenantKey, (transaction) => {
        const loaded = transaction.load()!;
        loaded.registry.maxAccounts = 1;
        expect(transaction.load()?.registry.maxAccounts).toBe(5);
        throw new Error("模拟失败");
      }),
    ).rejects.toThrow("模拟失败");

    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(database.queries.some((query) => query.text === "COMMIT")).toBe(
      false,
    );
    expect(database.wasReleased()).toBe(true);
  });

  it("接受控制面契约允许的 UUID v7 范围", async () => {
    const database = fakeDatabase();
    const repository = new PostgresWorkerFleetRepository(database.pool);
    const tenantV7 = "019fe98a-8638-74b3-a37d-5d509ba9ac96";
    const projectV7 = "019fe98a-8638-74b3-a37d-5d509ba9ac97";
    const workV7 = "019fe98a-8638-74b3-a37d-5d509ba9ac98";

    await expect(
      repository.transaction(tenantV7, async (transaction) => {
        expect(await transaction.hasCompletedWork(projectV7, workV7, 1)).toBe(
          false,
        );
      }),
    ).resolves.toBeUndefined();
  });

  it("MCP 永久完成证明严格绑定原租约和隔离令牌", async () => {
    const proof = {
      assignmentKey: "44444444-4444-4444-8444-444444444444",
      fencingToken: 7,
    };
    const database = fakeDatabase({ completed: true, completionProof: proof });
    const repository = new PostgresWorkerFleetRepository(database.pool);

    await repository.transaction(tenantKey, async (transaction) => {
      await expect(
        transaction.hasCompletedWork(
          projectKey,
          workKey,
          2,
          "mcp_invocation",
          proof,
        ),
      ).resolves.toBe(true);
      await expect(
        transaction.hasCompletedWork(projectKey, workKey, 2, "mcp_invocation", {
          ...proof,
          fencingToken: 8,
        }),
      ).resolves.toBe(false);
    });
  });

  it("需求永久完成证明同时绑定完整交付内容摘要", async () => {
    const proof = {
      assignmentKey: "44444444-4444-4444-8444-444444444444",
      fencingToken: 7,
      completionDigest: "a".repeat(64),
    };
    const database = fakeDatabase({ completed: true, completionProof: proof });
    const repository = new PostgresWorkerFleetRepository(database.pool);

    await repository.transaction(tenantKey, async (transaction) => {
      await expect(
        transaction.hasCompletedWork(
          projectKey,
          workKey,
          2,
          "requirement_delivery",
          proof,
        ),
      ).resolves.toBe(true);
      await expect(
        transaction.hasCompletedWork(
          projectKey,
          workKey,
          2,
          "requirement_delivery",
          { ...proof, completionDigest: "b".repeat(64) },
        ),
      ).resolves.toBe(false);
      await transaction.markCompletedWork(
        projectKey,
        workKey,
        2,
        "requirement_delivery",
        proof,
      );
    });
    expect(
      database.queries.find((query) =>
        query.text.includes("INSERT INTO forgex_completed_delivery_work"),
      )?.values,
    ).toEqual([
      tenantKey,
      projectKey,
      workKey,
      2,
      "requirement_delivery",
      proof.assignmentKey,
      proof.fencingToken,
      proof.completionDigest,
    ]);
  });

  it("工作类型迁移兼容旧交付记录并把类型纳入唯一键", () => {
    const migration = readFileSync(
      new URL("../migrations/0009_worker_work_kinds.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "work_kind text NOT NULL DEFAULT 'requirement_delivery'",
    );
    expect(migration).toContain(
      "work_kind IN ('requirement_delivery', 'mcp_invocation')",
    );
    expect(migration).toContain("completion_assignment_key uuid");
    expect(migration).toContain("completion_fencing_token > 0");
    expect(migration).toContain("requirement_revision,\n    work_kind\n  )");
  });

  it("交付结果迁移要求新需求完成证明绑定内容摘要", () => {
    const migration = readFileSync(
      new URL("../migrations/0011_delivery_runs.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS completion_digest");
    expect(migration).toContain("completion_digest ~ '^[a-f0-9]{64}$'");
    expect(migration).toContain(
      "work_kind = 'mcp_invocation' AND\n      completion_assignment_key IS NOT NULL",
    );
  });
});
