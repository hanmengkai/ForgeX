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
      if (text.includes("SELECT 1 AS completed")) {
        return { rows: options?.completed ? [{ completed: 1 }] : [] };
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
      expect.stringContaining("SELECT 1 AS completed"),
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
});
