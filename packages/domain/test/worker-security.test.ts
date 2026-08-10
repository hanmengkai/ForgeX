import { describe, expect, it } from "vitest";

import { DeliveryQueue, WorkerRegistry } from "../src/index.js";

const accountFingerprint = (index: number) =>
  index.toString(16).padStart(64, "0");

const registration = (index: number) => ({
  deviceName: `研发电脑 ${index}`,
  accountName: `Codex 账户 ${index}`,
  accountFingerprint: accountFingerprint(index),
  capabilities: ["typescript"],
});

const createRegistry = (extra: { offlineAfterMs?: number } = {}) =>
  new WorkerRegistry({
    tenantKey: "tenant-a",
    maxAccounts: 5,
    ...extra,
  });

const dispatch = (
  queue: DeliveryQueue,
  session: ReturnType<WorkerRegistry["register"]>,
  at: string,
) => queue.dispatchForWorker(session, new Date(at));

const enqueue = (
  queue: DeliveryQueue,
  work: { key: string; title: string; requiredCapabilities: string[] },
) =>
  queue.enqueue({
    projectKey: "project-a",
    requirementRevision: 1,
    ...work,
  });

describe("Worker 会话隔离", () => {
  it("登记设备时签发与租户绑定的连接会话", () => {
    const registry = createRegistry();

    const session = registry.register(
      registration(1),
      new Date("2026-08-10T00:00:00Z"),
    );

    expect(session).toMatchObject({
      tenantKey: "tenant-a",
      generation: 1,
      workerKey: expect.any(String),
      sessionKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("规范化账户指纹并让重连使旧会话立即失效", () => {
    const registry = createRegistry();
    const first = registry.register(
      registration(1),
      new Date("2026-08-10T00:00:00Z"),
    );
    const second = registry.register(
      {
        ...registration(1),
        accountFingerprint: `  ${accountFingerprint(1).toUpperCase()}  `,
      },
      new Date("2026-08-10T00:00:01Z"),
    );

    expect(second.workerKey).toBe(first.workerKey);
    expect(second.generation).toBe(2);
    expect(() =>
      registry.heartbeat(first, new Date("2026-08-10T00:00:02Z")),
    ).toThrow("设备连接已经失效，请重新连接");
    expect(() =>
      registry.heartbeat(second, new Date("2026-08-10T00:00:02Z")),
    ).not.toThrow();
  });

  it("复制时间输入，外部修改不能让离线设备伪装在线", () => {
    const registry = createRegistry({ offlineAfterMs: 1_000 });
    const connectedAt = new Date("2026-08-10T00:00:00Z");
    registry.register(registration(1), connectedAt);

    connectedAt.setUTCFullYear(2099);

    expect(
      registry.listForPeople(new Date("2026-08-10T00:00:02Z"))[0]?.status,
    ).toBe("离线");
  });
});

describe("安全任务租约", () => {
  it("任务租约包含租户、会话和递增防重令牌", () => {
    const registry = createRegistry();
    const session = registry.register(
      registration(1),
      new Date("2026-08-10T00:00:00Z"),
    );
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 1_000 });
    enqueue(queue, {
      key: "work-a",
      title: "访客预约",
      requiredCapabilities: [],
    });

    const assignment = dispatch(queue, session, "2026-08-10T00:00:01Z");

    expect(assignment).toMatchObject({
      tenantKey: "tenant-a",
      sessionKey: expect.any(String),
      fencingToken: 1,
      leasedUntil: "2026-08-10T00:00:02.000Z",
    });
  });

  it("拒绝已经过期的续租和完成请求", () => {
    const registry = createRegistry();
    const session = registry.register(
      registration(1),
      new Date("2026-08-10T00:00:00Z"),
    );
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 1_000 });
    enqueue(queue, {
      key: "work-a",
      title: "访客预约",
      requiredCapabilities: [],
    });
    const assignment = dispatch(queue, session, "2026-08-10T00:00:01Z");

    expect(() =>
      queue.renewLease({
        assignment: assignment!,
        renewedAt: new Date("2026-08-10T00:00:03Z"),
      }),
    ).toThrow("任务租约已经过期，请重新领取");
    expect(() =>
      queue.completeLease({
        assignment: assignment!,
        completedAt: new Date("2026-08-10T00:00:03Z"),
      }),
    ).toThrow("任务租约已经过期，请重新领取");
  });

  it("完成上报是幂等的，重复请求不会重复改变状态", () => {
    const registry = createRegistry();
    const session = registry.register(
      registration(1),
      new Date("2026-08-10T00:00:00Z"),
    );
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 10_000 });
    enqueue(queue, {
      key: "work-a",
      title: "访客预约",
      requiredCapabilities: [],
    });
    const assignment = dispatch(queue, session, "2026-08-10T00:00:01Z");
    const completedAt = new Date("2026-08-10T00:00:02Z");

    expect(
      queue.completeLease({ assignment: assignment!, completedAt }),
    ).toEqual({
      alreadyCompleted: false,
    });
    expect(
      queue.completeLease({ assignment: assignment!, completedAt }),
    ).toEqual({
      alreadyCompleted: true,
    });
  });

  it("完成幂等墓碑有容量上限，淘汰后不再保留旧租约", () => {
    const registry = createRegistry();
    const session = registry.register(
      registration(1),
      new Date("2026-08-10T00:00:00Z"),
    );
    const queue = new DeliveryQueue(registry, {
      leaseDurationMs: 10_000,
      maxCompletionTombstones: 1,
      completionRetentionMs: 60_000,
    });
    enqueue(queue, {
      key: "work-a",
      title: "需求一",
      requiredCapabilities: [],
    });
    const first = dispatch(queue, session, "2026-08-10T00:00:01Z");
    queue.completeLease({
      assignment: first!,
      completedAt: new Date("2026-08-10T00:00:02Z"),
    });
    enqueue(queue, {
      key: "work-b",
      title: "需求二",
      requiredCapabilities: [],
    });
    const second = dispatch(queue, session, "2026-08-10T00:00:03Z");
    queue.completeLease({
      assignment: second!,
      completedAt: new Date("2026-08-10T00:00:04Z"),
    });

    expect(() =>
      queue.completeLease({
        assignment: first!,
        completedAt: new Date("2026-08-10T00:00:05Z"),
      }),
    ).toThrow("任务租约已经失效，请重新领取");
    expect(
      queue.completeLease({
        assignment: second!,
        completedAt: new Date("2026-08-10T00:00:05Z"),
      }),
    ).toEqual({ alreadyCompleted: true });
  });

  it("外部修改派发结果不能改变内部租约期限", () => {
    const registry = createRegistry();
    const session = registry.register(
      registration(1),
      new Date("2026-08-10T00:00:00Z"),
    );
    const queue = new DeliveryQueue(registry, { leaseDurationMs: 1_000 });
    enqueue(queue, {
      key: "work-a",
      title: "访客预约",
      requiredCapabilities: [],
    });
    const assignment = dispatch(queue, session, "2026-08-10T00:00:01Z");

    assignment!.leasedUntil = "2099-01-01T00:00:00.000Z";

    expect(queue.reclaimExpired(new Date("2026-08-10T00:00:03Z"))).toEqual([
      "访客预约",
    ]);
  });
});
