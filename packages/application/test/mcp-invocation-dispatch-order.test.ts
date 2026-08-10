import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  InMemoryMcpInvocationRepository,
  canonicalizeMcpArguments,
  type McpInvocationRecord,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";

const queuedRecord = (): McpInvocationRecord => ({
  schemaVersion: 1,
  invocationKey: randomUUID(),
  requestKey: randomUUID(),
  tenantKey,
  projectKey,
  serverKey: "33333333-3333-4333-8333-333333333333",
  serverRevision: 1,
  serverName: "代码仓库助手",
  manifestHashAlgorithm: "sha256",
  manifestHash: "a".repeat(64),
  toolKey: "44444444-4444-4444-8444-444444444444",
  technicalName: "repository.read_structure",
  toolDisplayName: "读取项目结构",
  effect: "read",
  approvalMode: "automatic",
  connectionBindingKey: "55555555-5555-4555-8555-555555555555",
  inputSchemaHashAlgorithm: "sha256",
  inputSchemaHash: "b".repeat(64),
  argumentsHashAlgorithm: "sha256",
  argumentsHash: canonicalizeMcpArguments({ target: "src" }).hash,
  arguments: { target: "src" },
  requestedByKey: "66666666-6666-4666-8666-666666666666",
  requestedByName: "初级研发",
  requestedAt: "2026-08-10T10:00:00.000Z",
  status: "queued",
  approval: null,
  executionLease: null,
  result: null,
});

describe("MCP 调用跨项目派发顺序", () => {
  it("已结束记录超过一百条时不会挤掉更早等待派发的调用", async () => {
    const repository = new InMemoryMcpInvocationRepository();
    const queued = queuedRecord();
    await repository.transaction(tenantKey, projectKey, (transaction) => {
      transaction.save(queued);
      for (let index = 0; index < 100; index += 1) {
        transaction.save({
          ...queued,
          invocationKey: randomUUID(),
          requestKey: randomUUID(),
          requestedAt: new Date(
            Date.parse(queued.requestedAt) + index + 1,
          ).toISOString(),
          status: "cancelled",
        });
      }
    });

    await expect(
      repository.listDispatchableAcrossProjects(tenantKey, 1),
    ).resolves.toEqual([queued]);
  });

  it("待清理调用优先于一百条普通等待调用，补偿不会饥饿", async () => {
    const repository = new InMemoryMcpInvocationRepository();
    const base = queuedRecord();
    const cleanup = {
      ...base,
      invocationKey: randomUUID(),
      requestKey: randomUUID(),
      requestedAt: "2026-08-10T11:00:00.000Z",
      status: "cancellation_pending" as const,
    };
    await repository.transaction(tenantKey, projectKey, (transaction) => {
      for (let index = 0; index < 100; index += 1) {
        transaction.save({
          ...base,
          invocationKey: randomUUID(),
          requestKey: randomUUID(),
          requestedAt: new Date(
            Date.parse(base.requestedAt) + index,
          ).toISOString(),
        });
      }
      transaction.save(cleanup);
    });

    const dispatchable = await repository.listDispatchableAcrossProjects(
      tenantKey,
      100,
    );
    expect(dispatchable).toHaveLength(100);
    expect(dispatchable[0]?.invocationKey).toBe(cleanup.invocationKey);
  });
});
