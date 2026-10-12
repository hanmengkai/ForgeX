import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryLifecycleRepository } from "../src/lifecycle-service.js";
import { LifecycleWorkerService } from "../src/lifecycle-worker-service.js";
describe("交付执行器真实状态", () => {
  it("未上报不能当作在线或已登录，过期心跳离线，需求方不能查看内部执行器", async () => {
    const tenantKey = randomUUID(),
      projectKey = randomUUID(),
      repositoryKey = randomUUID(),
      executor = {
        tenantKey,
        projectKey,
        repositoryKey,
        executorKey: randomUUID(),
        capabilities: ["requirements_ai" as const],
        publicKeyBase64: Buffer.alloc(44).toString("base64"),
      };
    let now = new Date("2026-10-12T04:00:00.000Z");
    const service = new LifecycleWorkerService(
      new InMemoryLifecycleRepository(),
      () => [
        {
          principal: executor,
          displayName: "需求与开发执行器",
          provider: "codex",
        },
      ],
      () => now,
    );
    const principal = {
      tenantKey,
      actorKey: randomUUID(),
      actorName: "研发",
      username: "developer",
      roles: ["developer" as const],
    };
    expect((await service.list(principal))[0]).toMatchObject({
      status: "not_connected",
      loginState: "unknown",
    });
    await service.heartbeat(executor, {
      schemaVersion: 1,
      displayName: "研发当前用户",
      provider: "codex",
      loginState: "logged_in",
    });
    expect((await service.list(principal))[0]).toMatchObject({
      status: "idle",
      loginState: "logged_in",
    });
    await service.heartbeat(executor, {
      schemaVersion: 1,
      displayName: "研发当前用户",
      provider: "codex",
      loginState: "logged_in",
      executionState: "awaiting_confirmation",
    });
    expect((await service.list(principal))[0]).toMatchObject({
      status: "awaiting_confirmation",
      currentWork: "任务结果已保留，等待控制面确认",
    });
    now = new Date(now.getTime() + 61000);
    expect((await service.list(principal))[0]?.status).toBe("offline");
    await expect(
      service.list({ ...principal, roles: ["requester"] }),
    ).rejects.toThrow("无权");
    expect(
      await service.list({ ...principal, tenantKey: randomUUID() }),
    ).toEqual([]);
  });
});
