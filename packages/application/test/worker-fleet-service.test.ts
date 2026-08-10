import { describe, expect, it } from "vitest";

import {
  WorkerFleetService,
  type AuthenticatedPrincipal,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
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

describe("WorkerFleetService", () => {
  it("每个租户最多连接五个账户，普通列表不暴露指纹和连接密钥", () => {
    const service = new WorkerFleetService({
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    for (let index = 1; index <= 5; index += 1) {
      service.connect(administrator, registration(index));
    }

    expect(() => service.connect(administrator, registration(6))).toThrow(
      "最多可连接 5 个 Codex 账户",
    );
    const views = service.listForPeople(productOwner);
    expect(views).toHaveLength(5);
    expect(views[0]).not.toHaveProperty("workerKey");
    expect(views[0]).not.toHaveProperty("sessionKey");
    expect(views[0]).not.toHaveProperty("accountFingerprint");
  });

  it("两台设备并行领取两个需求，且同一设备不会同时领取第二项", () => {
    const service = new WorkerFleetService({
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    const first = service.connect(administrator, registration(1)).connection;
    const second = service.connect(administrator, registration(2)).connection;
    service.enqueue(productOwner, {
      schemaVersion: 1,
      requirementKey: "44444444-4444-4444-8444-444444444444",
      title: "完善访客预约",
      requiredCapabilities: ["typescript"],
    });
    service.enqueue(productOwner, {
      schemaVersion: 1,
      requirementKey: "55555555-5555-4555-8555-555555555555",
      title: "增加到访统计",
      requiredCapabilities: ["browser"],
    });

    const firstLease = service.poll(first).assignment;
    const secondLease = service.poll(second).assignment;

    expect(firstLease).not.toBeNull();
    expect(secondLease).not.toBeNull();
    expect(firstLease?.requirementKey).not.toBe(secondLease?.requirementKey);
    expect(service.poll(first).assignment).toEqual(firstLease);
  });

  it("重连立即废止旧连接，租约完成上报保持幂等", () => {
    const service = new WorkerFleetService({
      clock: () => new Date("2026-08-10T05:00:00.000Z"),
    });
    const oldConnection = service.connect(
      administrator,
      registration(1),
    ).connection;
    const currentConnection = service.connect(
      administrator,
      registration(1),
    ).connection;

    expect(() => service.heartbeat(oldConnection)).toThrow(
      "设备连接已经失效，请重新连接",
    );

    service.enqueue(productOwner, {
      schemaVersion: 1,
      requirementKey: "44444444-4444-4444-8444-444444444444",
      title: "完善访客预约",
      requiredCapabilities: [],
    });
    const assignment = service.poll(currentConnection).assignment!;
    const command = {
      schemaVersion: 1 as const,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
    };

    expect(service.complete(currentConnection, command)).toEqual({
      alreadyCompleted: false,
    });
    expect(service.complete(currentConnection, command)).toEqual({
      alreadyCompleted: true,
    });
  });
});
