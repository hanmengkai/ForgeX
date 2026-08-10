import { describe, expect, it } from "vitest";

import {
  InMemoryRequirementRepository,
  type AuthenticatedPrincipal,
  type SessionAuthenticator,
} from "@forgex/application";

import { buildControlPlaneApi } from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const productOwner: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner"],
};
const juniorDeveloper: AuthenticatedPrincipal = {
  actorKey: "44444444-4444-4444-8444-444444444444",
  actorName: "初级研发",
  tenantKey,
  roles: ["developer"],
};

const validRequirement = {
  schemaVersion: 1,
  title: "访客预约",
  goal: "让访客到访过程更顺畅",
  userStories: [
    {
      role: "物业前台",
      need: "查看今天即将到访的访客",
      value: "提前做好接待准备",
    },
  ],
  acceptanceCriteria: [
    {
      title: "访客可以提交预约",
      description: "填写姓名、手机号和到访时间后能够提交",
      priority: "must",
    },
  ],
  openQuestions: [],
};

const createTestApp = () => {
  const repository = new InMemoryRequirementRepository();
  const sessions = new Map<string, AuthenticatedPrincipal>([
    ["product-session", productOwner],
    ["developer-session", juniorDeveloper],
  ]);
  const authenticator: SessionAuthenticator = {
    authenticate: async (authorization) =>
      authorization?.startsWith("Bearer ")
        ? (sessions.get(authorization.slice("Bearer ".length)) ?? null)
        : null,
  };
  const app = buildControlPlaneApi({
    authenticator,
    requirementRepository: repository,
    projectKey,
    clock: () => new Date("2026-08-10T03:00:00.000Z"),
  });
  return { app, repository };
};

describe("需求 API", () => {
  it("未登录时返回清晰的 401 错误", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      payload: validRequirement,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "authentication_required",
        message: "请先登录后再继续",
      },
    });
    await app.close();
  });

  it("创建需求只返回业务视图，内部标识仅用于 Location", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: validRequirement,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toMatch(
      /^\/api\/v1\/requirements\/[0-9a-f-]+$/,
    );
    expect(response.json()).toEqual({
      data: {
        title: "访客预约",
        summary: "让访客到访过程更顺畅",
        version: "第 1 版",
        status: "正在整理",
        nextStep: "完善内容后提交确认",
        acceptanceProgress: "尚未开始验证",
      },
    });
    expect(response.json().data).not.toHaveProperty("id");
    expect(response.json().data).not.toHaveProperty("key");
    await app.close();
  });

  it("拒绝内部编码标题、额外审批人和其他未知字段", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: {
        ...validRequirement,
        title: "REQ-102",
        actorName: "伪造负责人",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "需求内容需要调整",
      },
    });
    await app.close();
  });

  it("审批身份来自登录会话并写入追加式审计", async () => {
    const { app, repository } = createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: validRequirement,
    });
    const location = created.headers.location!;
    await app.inject({
      method: "POST",
      url: `${location}/submit-confirmation`,
      headers: { authorization: "Bearer product-session" },
      payload: {},
    });

    const forbidden = await app.inject({
      method: "POST",
      url: `${location}/confirm`,
      headers: { authorization: "Bearer developer-session" },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const confirmed = await app.inject({
      method: "POST",
      url: `${location}/confirm`,
      headers: { authorization: "Bearer product-session" },
      payload: {},
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data).toMatchObject({
      status: "已确认，等待交付",
    });
    expect(await repository.listAuditEvents(tenantKey)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "requirement.confirmed",
          actorKey: productOwner.actorKey,
          actorName: "产品负责人",
          recordedAt: "2026-08-10T03:00:00.000Z",
        }),
      ]),
    );
    await app.close();
  });
});
