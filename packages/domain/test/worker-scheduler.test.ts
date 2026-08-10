import { describe, expect, it } from "vitest";

import { DeliveryQueue, WorkerRegistry } from "../src/index.js";

const worker = (index: number) => ({
  deviceName: `研发电脑 ${index}`,
  accountName: `Codex 账户 ${index}`,
  accountFingerprint: `fingerprint-${index}`,
  capabilities: ["typescript", "browser"]
});

describe("WorkerRegistry", () => {
  it("一个租户最多登记五个 Codex 账户", () => {
    const registry = new WorkerRegistry({ maxAccounts: 5 });

    for (let index = 1; index <= 5; index += 1) {
      registry.register(worker(index), new Date("2026-08-10T00:00:00Z"));
    }

    expect(() =>
      registry.register(worker(6), new Date("2026-08-10T00:00:00Z"))
    ).toThrow("最多可连接 5 个 Codex 账户");
  });

  it("普通视图只展示可读信息，不暴露内部标识和账户指纹", () => {
    const registry = new WorkerRegistry({ maxAccounts: 5 });
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));

    const [item] = registry.listForPeople(new Date("2026-08-10T00:00:05Z"));

    expect(item).toEqual({
      deviceName: "研发电脑 1",
      accountName: "Codex 账户 1",
      status: "空闲",
      currentWork: null
    });
    expect(item).not.toHaveProperty("id");
    expect(item).not.toHaveProperty("accountFingerprint");
  });
});

describe("DeliveryQueue", () => {
  it("把多个需求并行分配给不同的空闲账户", () => {
    const registry = new WorkerRegistry({ maxAccounts: 5 });
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));
    registry.register(worker(2), new Date("2026-08-10T00:00:00Z"));
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 60_000 });

    queue.enqueue({ key: "work-a", title: "完善访客预约", requiredCapabilities: ["typescript"] });
    queue.enqueue({ key: "work-b", title: "增加到访统计", requiredCapabilities: ["browser"] });

    const assignments = queue.dispatch(new Date("2026-08-10T00:00:10Z"));

    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((item) => item.workerKey)).size).toBe(2);
    expect(registry.listForPeople(new Date("2026-08-10T00:00:11Z"))).toEqual([
      {
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        status: "正在工作",
        currentWork: "完善访客预约"
      },
      {
        deviceName: "研发电脑 2",
        accountName: "Codex 账户 2",
        status: "正在工作",
        currentWork: "增加到访统计"
      }
    ]);
  });

  it("同一账户在完成前不会领取第二个需求", () => {
    const registry = new WorkerRegistry({ maxAccounts: 5 });
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 60_000 });
    queue.enqueue({ key: "work-a", title: "需求一", requiredCapabilities: [] });
    queue.enqueue({ key: "work-b", title: "需求二", requiredCapabilities: [] });

    expect(queue.dispatch(new Date("2026-08-10T00:00:10Z"))).toHaveLength(1);
    expect(queue.dispatch(new Date("2026-08-10T00:00:20Z"))).toHaveLength(0);
  });

  it("租约超时后把需求重新排队，不伪造完成状态", () => {
    const registry = new WorkerRegistry({ maxAccounts: 5 });
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 1_000 });
    queue.enqueue({ key: "work-a", title: "容易中断的需求", requiredCapabilities: [] });
    queue.dispatch(new Date("2026-08-10T00:00:01Z"));

    const reclaimed = queue.reclaimExpired(new Date("2026-08-10T00:00:03Z"));

    expect(reclaimed).toEqual(["容易中断的需求"]);
    expect(queue.listForPeople()).toEqual([
      { title: "容易中断的需求", status: "等待空闲设备" }
    ]);
  });
});

