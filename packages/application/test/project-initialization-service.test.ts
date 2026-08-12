import { describe, expect, it } from "vitest";

import {
  InMemoryProjectInitializationRepository,
  ProjectInitializationService,
  type AuthenticatedPrincipal,
  type ProjectInitializationReadiness,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const administrator: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "平台管理员",
  username: "platform.admin",
  tenantKey,
  roles: ["administrator"],
};
const member: AuthenticatedPrincipal = {
  actorKey: "44444444-4444-4444-8444-444444444444",
  actorName: "产品负责人",
  username: "product.owner",
  tenantKey,
  roles: ["product_owner"],
};

const createService = (readiness: ProjectInitializationReadiness) =>
  new ProjectInitializationService({
    repository: new InMemoryProjectInitializationRepository(),
    readiness: { inspect: async () => readiness },
    clock: () => new Date("2026-08-12T10:00:00.000Z"),
  });

describe("项目标准交付初始化", () => {
  it("读取未初始化项目时不产生写入，并给出三项安全待办", async () => {
    const service = createService({
      knowledgeReady: false,
      skillReady: false,
      mcpReady: false,
    });

    const first = await service.get(member, projectKey);
    const second = await service.get(member, projectKey);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "not_started",
      preset: { key: "standard-delivery", version: 1 },
      tasks: [
        { key: "knowledge", status: "action_required" },
        { key: "skill", status: "action_required" },
        { key: "mcp", status: "action_required" },
      ],
    });
  });

  it("仅管理员可以初始化，同一预设重复执行返回同一条记录", async () => {
    const service = createService({
      knowledgeReady: false,
      skillReady: false,
      mcpReady: false,
    });
    const command = {
      schemaVersion: 1 as const,
      presetKey: "standard-delivery" as const,
      presetVersion: 1 as const,
      requestKey: "55555555-5555-4555-8555-555555555555",
    };

    await expect(
      service.initialize(member, projectKey, command),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "project_initialization_admin_required",
    });

    const first = await service.initialize(administrator, projectKey, command);
    const repeated = await service.initialize(administrator, projectKey, {
      ...command,
      requestKey: "66666666-6666-4666-8666-666666666666",
    });

    expect(first.status).toBe("action_required");
    expect(repeated.record).toEqual(first.record);
    expect(repeated.record?.requestKey).toBe(command.requestKey);
  });

  it("拒绝用不同预设覆盖已经初始化的项目", async () => {
    const service = createService({
      knowledgeReady: false,
      skillReady: false,
      mcpReady: false,
    });
    await service.initialize(administrator, projectKey, {
      schemaVersion: 1,
      presetKey: "standard-delivery",
      presetVersion: 1,
      requestKey: "77777777-7777-4777-8777-777777777777",
    });

    await expect(
      service.initialize(administrator, projectKey, {
        schemaVersion: 1,
        presetKey: "standard-delivery",
        presetVersion: 2,
        requestKey: "88888888-8888-4888-8888-888888888888",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "project_initialization_conflict",
    });
  });

  it("拒绝把同一个初始化请求键复用到另一个项目", async () => {
    const service = createService({
      knowledgeReady: false,
      skillReady: false,
      mcpReady: false,
    });
    const requestKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await service.initialize(administrator, projectKey, {
      schemaVersion: 1,
      presetKey: "standard-delivery",
      presetVersion: 1,
      requestKey,
    });

    await expect(
      service.initialize(
        administrator,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        {
          schemaVersion: 1,
          presetKey: "standard-delivery",
          presetVersion: 1,
          requestKey,
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "project_initialization_request_conflict",
    });
  });

  it("只有可信知识、已激活 Skill 和健康 MCP 全部存在时才就绪", async () => {
    let readiness: ProjectInitializationReadiness = {
      knowledgeReady: true,
      skillReady: false,
      mcpReady: true,
    };
    const service = new ProjectInitializationService({
      repository: new InMemoryProjectInitializationRepository(),
      readiness: { inspect: async () => readiness },
    });
    await service.initialize(administrator, projectKey, {
      schemaVersion: 1,
      presetKey: "standard-delivery",
      presetVersion: 1,
      requestKey: "99999999-9999-4999-8999-999999999999",
    });

    const waiting = await service.get(member, projectKey);
    expect(waiting.status).toBe("action_required");
    expect(waiting.tasks).toEqual([
      expect.objectContaining({ key: "knowledge", status: "ready" }),
      expect.objectContaining({ key: "skill", status: "action_required" }),
      expect.objectContaining({ key: "mcp", status: "ready" }),
    ]);

    readiness = { knowledgeReady: true, skillReady: true, mcpReady: true };
    await expect(service.get(member, projectKey)).resolves.toMatchObject({
      status: "ready",
    });
  });
});
