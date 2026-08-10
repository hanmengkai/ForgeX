import { describe, expect, it } from "vitest";

import { DeliveryQueue, WorkerRegistry } from "../src/index.js";

const worker = (index: number) => ({
  deviceName: `研发电脑 ${index}`,
  accountName: `Codex 账户 ${index}`,
  accountFingerprint: index.toString(16).padStart(64, "0"),
  capabilities: ["typescript", "browser"]
});

const registryOptions = (maxAccounts = 5) => ({
  tenantKey: "tenant-a",
  maxAccounts
});

describe("WorkerRegistry", () => {
  it("拒绝无效的账户上限", () => {
    expect(() => new WorkerRegistry(registryOptions(0))).toThrow(
      "Codex 账户上限必须是正整数"
    );
  });

  it("一个租户最多登记五个 Codex 账户", () => {
    const registry = new WorkerRegistry(registryOptions());

    for (let index = 1; index <= 5; index += 1) {
      registry.register(worker(index), new Date("2026-08-10T00:00:00Z"));
    }

    expect(() =>
      registry.register(worker(6), new Date("2026-08-10T00:00:00Z"))
    ).toThrow("最多可连接 5 个 Codex 账户");
  });

  it("普通视图只展示可读信息，不暴露内部标识和账户指纹", () => {
    const registry = new WorkerRegistry(registryOptions());
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

  it("同一账户重新连接时更新设备信息但不占用新名额", () => {
    const registry = new WorkerRegistry(registryOptions(1));
    const firstKey = registry.register(
      worker(1),
      new Date("2026-08-10T00:00:00Z")
    );
    const secondKey = registry.register(
      {
        ...worker(1),
        deviceName: "重新连接的研发电脑",
        capabilities: ["typescript"]
      },
      new Date("2026-08-10T00:00:10Z")
    );

    expect(secondKey.workerKey).toBe(firstKey.workerKey);
    expect(registry.listForPeople(new Date("2026-08-10T00:00:11Z"))[0]).toMatchObject({
      deviceName: "重新连接的研发电脑",
      status: "空闲"
    });
  });

  it.each([
    [{ ...worker(1), deviceName: "" }, "请为设备填写容易识别的名称"],
    [{ ...worker(1), accountName: "" }, "请为 Codex 账户填写昵称"],
    [{ ...worker(1), accountFingerprint: "" }, "账户指纹不能为空"]
  ])("拒绝不完整的设备登记信息", (registration, message) => {
    const registry = new WorkerRegistry(registryOptions());

    expect(() =>
      registry.register(registration, new Date("2026-08-10T00:00:00Z"))
    ).toThrow(message);
  });

  it("心跳超时后显示离线且不再领取工作", () => {
    const registry = new WorkerRegistry({
      ...registryOptions(),
      offlineAfterMs: 1_000
    });
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));

    expect(registry.listForPeople(new Date("2026-08-10T00:00:02Z"))[0]).toEqual({
      deviceName: "研发电脑 1",
      accountName: "Codex 账户 1",
      status: "离线",
      currentWork: null
    });
    expect(
      registry.findAvailable(["typescript"], new Date("2026-08-10T00:00:02Z"))
    ).toBeNull();
  });

  it("找不到设备时返回可读错误", () => {
    const registry = new WorkerRegistry(registryOptions());

    expect(() =>
      registry.heartbeat(
        {
          tenantKey: "tenant-a",
          workerKey: "missing",
          sessionKey: "missing",
          generation: 1
        },
        new Date()
      )
    ).toThrow(
      "找不到对应的 Codex 设备"
    );
  });
});

describe("DeliveryQueue", () => {
  it("拒绝无效租约时长", () => {
    const registry = new WorkerRegistry(registryOptions());

    expect(() => new DeliveryQueue(registry, { leaseDurationMs: 0 })).toThrow(
      "任务租约时间必须大于零"
    );
  });

  it("把多个需求并行分配给不同的空闲账户", () => {
    const registry = new WorkerRegistry(registryOptions());
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
    const registry = new WorkerRegistry(registryOptions());
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 60_000 });
    queue.enqueue({ key: "work-a", title: "需求一", requiredCapabilities: [] });
    queue.enqueue({ key: "work-b", title: "需求二", requiredCapabilities: [] });

    expect(queue.dispatch(new Date("2026-08-10T00:00:10Z"))).toHaveLength(1);
    expect(queue.dispatch(new Date("2026-08-10T00:00:20Z"))).toHaveLength(0);
  });

  it("租约超时后把需求重新排队，不伪造完成状态", () => {
    const registry = new WorkerRegistry(registryOptions());
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

  it("完成当前需求后账户可以继续领取下一项", () => {
    const registry = new WorkerRegistry(registryOptions());
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 60_000 });
    queue.enqueue({ key: "work-a", title: "需求一", requiredCapabilities: [] });
    queue.enqueue({ key: "work-b", title: "需求二", requiredCapabilities: [] });
    const [first] = queue.dispatch(new Date("2026-08-10T00:00:01Z"));

    queue.completeLease({
      assignment: first!,
      completedAt: new Date("2026-08-10T00:00:01.500Z")
    });

    expect(queue.dispatch(new Date("2026-08-10T00:00:02Z"))[0]?.workTitle).toBe(
      "需求二"
    );
  });

  it("没有匹配能力时保留等待状态", () => {
    const registry = new WorkerRegistry(registryOptions());
    registry.register(
      { ...worker(1), capabilities: ["typescript"] },
      new Date("2026-08-10T00:00:00Z")
    );
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 60_000 });
    queue.enqueue({ key: "work-a", title: "移动端需求", requiredCapabilities: ["flutter"] });

    expect(queue.dispatch(new Date("2026-08-10T00:00:01Z"))).toEqual([]);
    expect(queue.listForPeople()).toEqual([
      { title: "移动端需求", status: "等待空闲设备" }
    ]);
  });

  it("拒绝空标题和重复入队", () => {
    const queue = new DeliveryQueue(new WorkerRegistry(registryOptions()), {
      leaseDurationMs: 60_000
    });

    expect(() =>
      queue.enqueue({ key: "empty", title: " ", requiredCapabilities: [] })
    ).toThrow("需求标题不能为空");

    queue.enqueue({ key: "same", title: "同一需求", requiredCapabilities: [] });
    expect(() =>
      queue.enqueue({ key: "same", title: "同一需求", requiredCapabilities: [] })
    ).toThrow("这个需求已经在交付队列中");
  });

  it("支持续租，并对失效租约给出可读错误", () => {
    const registry = new WorkerRegistry(registryOptions());
    registry.register(worker(1), new Date("2026-08-10T00:00:00Z"));
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 1_000 });
    queue.enqueue({ key: "work-a", title: "长时间需求", requiredCapabilities: [] });
    const [assignment] = queue.dispatch(new Date("2026-08-10T00:00:01Z"));

    expect(
      queue.renewLease({
        assignment: assignment!,
        renewedAt: new Date("2026-08-10T00:00:01.500Z")
      })
    ).toBe("2026-08-10T00:00:02.500Z");
    expect(queue.reclaimExpired(new Date("2026-08-10T00:00:02Z"))).toEqual([]);
    expect(() =>
      queue.renewLease({
        assignment: {
          assignmentKey: "missing",
          tenantKey: "tenant-a",
          workKey: "missing",
          workTitle: "missing",
          workerKey: "missing",
          sessionKey: "missing",
          generation: 1,
          fencingToken: 1,
          leasedUntil: new Date().toISOString()
        },
        renewedAt: new Date()
      })
    ).toThrow(
      "任务租约已经失效，请重新领取"
    );
  });
});
