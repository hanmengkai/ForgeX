import { describe, expect, it } from "vitest";

import {
  InMemoryWorkerFleetRepository,
  WorkerFleetService,
  type AuthenticatedPrincipal,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const administrator: AuthenticatedPrincipal = {
  actorKey: "22222222-2222-4222-8222-222222222222",
  actorName: "平台管理员",
  tenantKey,
  roles: ["administrator"],
};
const productOwner: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner"],
};

const registration = (index: number) => ({
  schemaVersion: 1 as const,
  deviceName: `研发电脑 ${index}`,
  accountName: `Codex 账户 ${index}`,
  accountFingerprint: index.toString(16).padStart(64, "0"),
  capabilities: ["typescript", "browser"],
});

const enqueue = (
  service: WorkerFleetService,
  input: {
    requirementKey: string;
    title: string;
    requiredCapabilities: string[];
    requirementRevision?: number;
  },
) =>
  service.enqueueDispatch({
    dispatchKey: input.requirementKey,
    tenantKey,
    projectKey,
    repositoryKey: projectKey,
    requirementKey: input.requirementKey,
    requirementRevision: input.requirementRevision ?? 1,
    title: input.title,
    requiredCapabilities: input.requiredCapabilities,
    skills: [],
    requestedAt: "2026-08-10T05:00:00.000Z",
    dispatchedAt: null,
  });

describe("WorkerFleetService", () => {
  it("每个租户默认不限制账户数量，普通列表不暴露指纹和连接密钥", async () => {
    const service = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    for (let index = 1; index <= 8; index += 1) {
      await service.connect(administrator, registration(index));
    }

    const views = await service.listForPeople(productOwner);
    expect(views).toHaveLength(8);
    expect(views[0]).not.toHaveProperty("workerKey");
    expect(views[0]).not.toHaveProperty("sessionKey");
    expect(views[0]).not.toHaveProperty("accountFingerprint");
  });

  it("设备概况明确返回不限数量且离线账户仍计入已连接数量", async () => {
    let now = new Date("2026-08-10T05:00:00.000Z");
    const service = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now),
    });
    await service.connect(administrator, registration(1));
    await service.connect(administrator, registration(2));
    now = new Date("2026-08-10T05:01:00.000Z");

    const overview = await service.overviewForPeople(productOwner);

    expect(overview.capacity).toEqual({
      connectedAccounts: 2,
      unlimited: true,
    });
    expect(overview.workers).toHaveLength(2);
    expect(overview.workers.every((worker) => worker.status === "离线")).toBe(
      true,
    );
  });

  it("两台设备并行领取两个需求，且同一设备不会同时领取第二项", async () => {
    const service = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    const first = (await service.connect(administrator, registration(1)))
      .connection;
    const second = (await service.connect(administrator, registration(2)))
      .connection;
    await enqueue(service, {
      requirementKey: "44444444-4444-4444-8444-444444444444",
      title: "完善访客预约",
      requiredCapabilities: ["typescript"],
    });
    await enqueue(service, {
      requirementKey: "55555555-5555-4555-8555-555555555555",
      title: "增加到访统计",
      requiredCapabilities: ["browser"],
    });

    const firstLease = (await service.poll(first)).assignment;
    expect(
      (await service.listForPeople(productOwner)).map((item) => item.status),
    ).toEqual(["正在工作", "空闲"]);
    const secondLease = (await service.poll(second)).assignment;

    expect(firstLease).not.toBeNull();
    expect(secondLease).not.toBeNull();
    expect(firstLease?.requirementKey).not.toBe(secondLease?.requirementKey);
    expect((await service.poll(first)).assignment).toEqual(firstLease);
  });

  it("同一设备并发轮询只会得到同一份租约", async () => {
    const service = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    const connection = (await service.connect(administrator, registration(1)))
      .connection;
    await enqueue(service, {
      requirementKey: "44444444-4444-4444-8444-444444444444",
      title: "完善访客预约",
      requiredCapabilities: [],
    });

    const [first, second] = await Promise.all([
      service.poll(connection),
      service.poll(connection),
    ]);

    expect(first.assignment).not.toBeNull();
    expect(second.assignment).toEqual(first.assignment);
  });

  it("重连立即废止旧连接，租约完成上报保持幂等", async () => {
    const service = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    const oldConnection = (
      await service.connect(administrator, registration(1))
    ).connection;
    const currentConnection = (
      await service.connect(administrator, registration(1))
    ).connection;

    await expect(service.heartbeat(oldConnection)).rejects.toThrow(
      "设备连接已经失效，请重新连接",
    );

    await enqueue(service, {
      requirementKey: "44444444-4444-4444-8444-444444444444",
      title: "完善访客预约",
      requiredCapabilities: [],
    });
    const assignment = (await service.poll(currentConnection)).assignment!;
    const command = {
      schemaVersion: 1 as const,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
    };

    await expect(
      service.complete(currentConnection, command, "d".repeat(64)),
    ).resolves.toEqual({
      alreadyCompleted: false,
    });
    await expect(
      service.complete(currentConnection, command, "d".repeat(64)),
    ).resolves.toEqual({
      alreadyCompleted: true,
    });
  });

  it("设备带着进行中任务重连时立即回收旧租约并重新派发", async () => {
    const service = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    const oldConnection = (
      await service.connect(administrator, registration(1))
    ).connection;
    await enqueue(service, {
      requirementKey: "44444444-4444-4444-8444-444444444444",
      title: "完善访客预约",
      requiredCapabilities: [],
    });
    const oldAssignment = (await service.poll(oldConnection)).assignment!;

    const currentConnection = (
      await service.connect(administrator, registration(1))
    ).connection;
    const reassigned = (await service.poll(currentConnection)).assignment!;

    expect(reassigned.requirementKey).toBe(oldAssignment.requirementKey);
    expect(reassigned.assignmentKey).not.toBe(oldAssignment.assignmentKey);
    expect(reassigned.fencingToken).toBeGreaterThan(oldAssignment.fencingToken);
  });

  it("完成后只在有界窗口内保留最小幂等记录", async () => {
    let now = new Date("2026-08-10T05:00:00.000Z");
    const service = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now.getTime()),
      maxCompletionTombstones: 1,
      completionRetentionMs: 60_000,
    });
    const connection = (await service.connect(administrator, registration(1)))
      .connection;
    const completeWork = async (requirementKey: string, title: string) => {
      await enqueue(service, {
        requirementKey,
        title,
        requiredCapabilities: [],
      });
      const assignment = (await service.poll(connection)).assignment!;
      const command = {
        schemaVersion: 1 as const,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      };
      await service.complete(connection, command, "d".repeat(64));
      return command;
    };
    const first = await completeWork(
      "44444444-4444-4444-8444-444444444444",
      "需求一",
    );
    now = new Date("2026-08-10T05:00:10.000Z");
    const second = await completeWork(
      "55555555-5555-4555-8555-555555555555",
      "需求二",
    );

    await expect(
      service.complete(connection, first, "d".repeat(64)),
    ).rejects.toThrow("任务租约已经失效，请重新领取");
    await expect(
      service.complete(connection, second, "d".repeat(64)),
    ).resolves.toEqual({
      alreadyCompleted: true,
    });
  });

  it("多个服务实例共享不限量账户、队列和单调 fencing token", async () => {
    const repository = new InMemoryWorkerFleetRepository();
    const options = {
      repository,
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    };
    const firstService = new WorkerFleetService(options);
    const secondService = new WorkerFleetService(options);
    const connections = [];
    for (let index = 1; index <= 6; index += 1) {
      const service = index % 2 === 0 ? secondService : firstService;
      connections.push(
        (await service.connect(administrator, registration(index))).connection,
      );
    }
    expect(await secondService.listForPeople(productOwner)).toHaveLength(6);

    await enqueue(firstService, {
      requirementKey: "66666666-6666-4666-8666-666666666666",
      title: "跨实例交付",
      requiredCapabilities: [],
    });
    const firstLease = (await secondService.poll(connections[0]!)).assignment!;
    await secondService.complete(
      connections[0]!,
      {
        schemaVersion: 1,
        assignmentKey: firstLease.assignmentKey,
        fencingToken: firstLease.fencingToken,
      },
      "d".repeat(64),
    );

    await enqueue(secondService, {
      requirementKey: "77777777-7777-4777-8777-777777777777",
      title: "继续跨实例交付",
      requiredCapabilities: [],
    });
    const nextLease = (await firstService.poll(connections[0]!)).assignment!;
    expect(nextLease.fencingToken).toBeGreaterThan(firstLease.fencingToken);
  });

  it("持久快照不保存连接密钥，并在短期墓碑淘汰后仍拒绝重复交付", async () => {
    const repository = new InMemoryWorkerFleetRepository();
    const service = new WorkerFleetService({
      repository,
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
      maxCompletionTombstones: 1,
    });
    const connection = (await service.connect(administrator, registration(1)))
      .connection;
    const complete = async (requirementKey: string, title: string) => {
      await enqueue(service, {
        requirementKey,
        title,
        requiredCapabilities: [],
      });
      const assignment = (await service.poll(connection)).assignment!;
      await service.complete(
        connection,
        {
          schemaVersion: 1,
          assignmentKey: assignment.assignmentKey,
          fencingToken: assignment.fencingToken,
        },
        "d".repeat(64),
      );
    };
    const firstRequirementKey = "88888888-8888-4888-8888-888888888888";
    await complete(firstRequirementKey, "最早完成的需求");
    await complete("99999999-9999-4999-8999-999999999999", "后续完成的需求");

    const snapshotText = await repository.transaction(
      tenantKey,
      (transaction) => JSON.stringify(transaction.load()),
    );
    expect(snapshotText).not.toContain(connection.sessionKey);
    await expect(
      enqueue(service, {
        requirementKey: firstRequirementKey,
        title: "不应再次执行",
        requiredCapabilities: [],
      }),
    ).resolves.toEqual({ title: "不应再次执行", status: "已经完成" });

    await expect(
      enqueue(service, {
        requirementKey: firstRequirementKey,
        requirementRevision: 2,
        title: "负责人重新确认后的第二版",
        requiredCapabilities: [],
      }),
    ).resolves.toEqual({
      title: "负责人重新确认后的第二版",
      status: "等待空闲设备",
    });
    expect((await service.poll(connection)).assignment).toMatchObject({
      projectKey,
      requirementKey: firstRequirementKey,
      requirementRevision: 2,
    });
  });

  it("拒绝使用与持久状态不一致的舰队参数启动副本", async () => {
    const repository = new InMemoryWorkerFleetRepository();
    const firstService = new WorkerFleetService({ repository });
    await firstService.connect(administrator, registration(1));
    const driftedService = new WorkerFleetService({
      repository,
      maxAccounts: 4,
    });

    await expect(driftedService.listForPeople(productOwner)).rejects.toThrow(
      "Worker 舰队运行参数与持久化配置不一致",
    );
  });
});
