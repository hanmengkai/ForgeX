import { describe, expect, it } from "vitest";

import { DeliveryQueue, WorkerRegistry } from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const workKey = "33333333-3333-4333-8333-333333333333";

describe("DeliveryQueue MCP 取消与快照边界", () => {
  it("按业务任务取消已领取的 MCP 租约并立即释放设备", () => {
    const registry = new WorkerRegistry({ tenantKey, maxAccounts: 5 });
    const session = registry.register(
      {
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "a".repeat(64),
        capabilities: ["repository.local"],
      },
      new Date("2026-08-10T00:00:00.000Z"),
    );
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 60_000 });
    queue.enqueue({
      workKind: "mcp_invocation",
      projectKey,
      requirementRevision: 1,
      key: workKey,
      title: "读取项目结构",
      requiredCapabilities: ["repository.local"],
    });
    expect(
      queue.dispatchForWorker(session, new Date("2026-08-10T00:00:01.000Z")),
    ).not.toBeNull();

    expect(
      queue.cancelWork({
        workKind: "mcp_invocation",
        projectKey,
        workKey,
        workRevision: 1,
      }),
    ).toBe(true);
    expect(queue.currentAssignmentForWorker(session)).toBeNull();
    expect(queue.toSnapshot().pending).toEqual([]);
    expect(queue.toSnapshot().active).toEqual([]);
  });

  it("恢复时拒绝未知工作类型，避免把损坏任务误当普通交付", () => {
    const registry = new WorkerRegistry({ tenantKey, maxAccounts: 5 });
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 60_000 });
    queue.enqueue({
      projectKey,
      requirementRevision: 1,
      key: workKey,
      title: "正常交付",
      requiredCapabilities: [],
    });
    const snapshot = queue.toSnapshot();
    (snapshot.pending[0] as { workKind?: string }).workKind = "unknown";

    expect(() => DeliveryQueue.fromSnapshot(registry, snapshot)).toThrow(
      "交付队列快照包含无效等待任务",
    );
  });

  it("MCP 独立配额耗尽时仍为正常需求交付保留队列容量", () => {
    const registry = new WorkerRegistry({ tenantKey, maxAccounts: 5 });
    const queue = new DeliveryQueue(registry, {
      leaseDurationMs: 60_000,
      maxPendingWork: 2,
      maxMcpPendingWork: 1,
    });
    queue.enqueue({
      workKind: "mcp_invocation",
      projectKey,
      requirementRevision: 1,
      key: workKey,
      title: "等待外部服务恢复",
      requiredCapabilities: ["missing.binding"],
    });
    expect(() =>
      queue.enqueue({
        workKind: "mcp_invocation",
        projectKey,
        requirementRevision: 1,
        key: "44444444-4444-4444-8444-444444444444",
        title: "第二项外部操作",
        requiredCapabilities: ["missing.binding"],
      }),
    ).toThrow("等待执行的外部操作过多");
    expect(() =>
      queue.enqueue({
        workKind: "requirement_delivery",
        projectKey,
        requirementRevision: 1,
        key: "55555555-5555-4555-8555-555555555555",
        title: "正常需求交付",
        requiredCapabilities: [],
      }),
    ).not.toThrow();
  });
});
