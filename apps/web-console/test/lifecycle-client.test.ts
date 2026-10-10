import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InMemoryLifecycleRepository,
  LifecycleService,
} from "@forgex/application";
import { createLifecycleClient } from "../src/lifecycle-client.js";

describe("生命周期浏览器请求", () => {
  it("提交响应丢失时重试相同幂等请求，不创建第二条需求", async () => {
    const projectKey = randomUUID(),
      repositoryKey = randomUUID(),
      actorKey = randomUUID(),
      tenantKey = randomUUID();
    const service = new LifecycleService(new InMemoryLifecycleRepository(), {
      projectKey,
      repositoryKey,
    });
    const principal = {
      actorKey,
      tenantKey,
      actorName: "甲",
      roles: ["requester" as const],
    };
    let calls = 0;
    const bodies: string[] = [];
    const api = createLifecycleClient(async (_path, options) => {
      bodies.push(String(options?.body));
      const result = await service.create(
        principal,
        JSON.parse(String(options?.body)),
      );
      if (++calls === 1) throw new TypeError("响应已丢失");
      return Response.json({ data: result });
    });
    const result = await api.create({
      title: "访客预约",
      brief: "提交预约并获得编号",
      context: {
        schemaVersion: 2,
        projectKey,
        repositoryKey,
        actorKey,
        actorName: "甲",
        roles: ["requester"],
      },
    });
    expect(result.title).toBe("访客预约");
    expect(bodies[0]).toBe(bodies[1]);
    expect(await service.list(principal)).toHaveLength(1);
  });
  it("业务错误不自动重试；缺少版本化业务数据的响应被拒绝", async () => {
    let calls = 0;
    const api = createLifecycleClient(async () => {
      calls++;
      throw new Error("当前版本已经更新");
    });
    await expect(api.repairBug(randomUUID(), "resolve")).rejects.toThrow(
      "当前版本已经更新",
    );
    expect(calls).toBe(1);
    const malformed = createLifecycleClient(async () =>
      Response.json({ data: { status: "success" } }),
    );
    await expect(malformed.context()).rejects.toThrow();
  });
});
