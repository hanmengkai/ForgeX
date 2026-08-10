import { describe, expect, it, vi } from "vitest";

import {
  InMemoryRequirementRepository,
  InMemoryWorkerFleetRepository,
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
const requirementAnalyst: AuthenticatedPrincipal = {
  actorKey: "77777777-7777-4777-8777-777777777777",
  actorName: "需求分析师",
  tenantKey,
  roles: ["requirement_analyst"],
};
const administrator: AuthenticatedPrincipal = {
  actorKey: "88888888-8888-4888-8888-888888888888",
  actorName: "平台管理员",
  tenantKey,
  roles: ["administrator"],
};
const otherTenantOwner: AuthenticatedPrincipal = {
  actorKey: "55555555-5555-4555-8555-555555555555",
  actorName: "其他租户负责人",
  tenantKey: "66666666-6666-4666-8666-666666666666",
  roles: ["product_owner"],
};
const brokenPrincipal: AuthenticatedPrincipal = {
  ...productOwner,
  actorName: "",
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
    ["analyst-session", requirementAnalyst],
    ["admin-session", administrator],
    ["other-tenant-session", otherTenantOwner],
    ["broken-session", brokenPrincipal],
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
    workerFleetRepository: new InMemoryWorkerFleetRepository(),
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

  it("接受同源 HttpOnly Cookie 会话，并保护写操作免受跨站请求", async () => {
    const { app } = createTestApp();

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/requirements",
      headers: { cookie: "forgex_session=product-session" },
    });
    expect(list.statusCode).toBe(200);

    const unprotected = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { cookie: "forgex_session=product-session" },
      payload: validRequirement,
    });
    expect(unprotected.statusCode).toBe(403);
    expect(unprotected.json().error.code).toBe("csrf_validation_failed");

    const protectedRequest = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: {
        cookie: "forgex_session=product-session",
        "x-forgex-csrf": "1",
      },
      payload: validRequirement,
    });
    expect(protectedRequest.statusCode).toBe(201);
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

    const detail = await app.inject({
      method: "GET",
      url: response.headers.location!,
      headers: { authorization: "Bearer product-session" },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.spec).toEqual(validRequirement);
    await app.close();
  });

  it("拒绝只有内部编码的需求标题", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: {
        ...validRequirement,
        title: "REQ-102",
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

  it("单独拒绝调用方夹带的审批人和其他未知字段", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: { ...validRequirement, actorName: "伪造负责人" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details).toEqual([
      {
        field: "actorName",
        message: "不支持这个字段",
        code: "unrecognized_keys",
      },
    ]);
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

    const forgedActor = await app.inject({
      method: "POST",
      url: `${location}/confirm`,
      headers: { authorization: "Bearer product-session" },
      payload: { actorName: "伪造负责人" },
    });
    expect(forgedActor.statusCode).toBe(422);

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
    expect(await repository.listAuditEvents(tenantKey, projectKey)).toEqual([
      expect.objectContaining({ action: "requirement.created" }),
      expect.objectContaining({ action: "requirement.confirmation_submitted" }),
      expect.objectContaining({
        action: "requirement.confirmed",
        actorKey: productOwner.actorKey,
        actorName: "产品负责人",
        recordedAt: "2026-08-10T03:00:00.000Z",
      }),
    ]);
    await app.close();
  });

  it("不同租户看不到也不能操作彼此的需求", async () => {
    const { app } = createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: validRequirement,
    });
    const location = created.headers.location!;

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer other-tenant-session" },
    });
    expect(list.json()).toEqual({ data: [], meta: { nextCursor: null } });

    const operation = await app.inject({
      method: "POST",
      url: `${location}/submit-confirmation`,
      headers: { authorization: "Bearer other-tenant-session" },
      payload: {},
    });
    expect(operation.statusCode).toBe(404);
    expect(operation.json()).toEqual({
      error: {
        code: "requirement_not_found",
        message: "没有找到这个需求",
      },
    });
    await app.close();
  });

  it("重复状态操作返回 409，而不是暴露内部异常", async () => {
    const { app } = createTestApp();
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

    const conflict = await app.inject({
      method: "POST",
      url: `${location}/submit-confirmation`,
      headers: { authorization: "Bearer product-session" },
      payload: {},
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "requirement_state_conflict",
        message: "当前状态不能重复提交确认",
      },
    });
    await app.close();
  });

  it("验收入口只允许产品负责人，并把未完成验证解释为状态冲突", async () => {
    const { app } = createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: validRequirement,
    });
    const location = created.headers.location!;

    const analyst = await app.inject({
      method: "POST",
      url: `${location}/accept`,
      headers: { authorization: "Bearer analyst-session" },
      payload: {},
    });
    expect(analyst.statusCode).toBe(403);

    const premature = await app.inject({
      method: "POST",
      url: `${location}/accept`,
      headers: { authorization: "Bearer product-session" },
      payload: {},
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json()).toEqual({
      error: {
        code: "requirement_state_conflict",
        message: "请先完成独立验证并提交产品验收",
      },
    });
    await app.close();
  });

  it("未知地址也使用统一且可读的错误格式", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/unknown-resource",
      headers: { authorization: "Bearer product-session" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "route_not_found",
        message: "没有找到这个功能入口",
      },
    });
    await app.close();
  });

  it("JSON 损坏时返回 400 且不泄漏解析器细节", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: {
        authorization: "Bearer product-session",
        "content-type": "application/json",
      },
      payload: '{"title":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_json",
        message: "请求内容不是有效的 JSON",
      },
    });
    await app.close();
  });

  it("未登录请求在解析损坏的正文之前就返回 401", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { "content-type": "application/json" },
      payload: '{"title":',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("authentication_required");
    await app.close();
  });

  it("对过大正文和不支持的媒体类型返回受控 413 与 415", async () => {
    const { app } = createTestApp();

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: {
        authorization: "Bearer product-session",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ content: "x".repeat(1_048_576) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe("payload_too_large");

    const unsupported = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: {
        authorization: "Bearer product-session",
        "content-type": "application/xml",
      },
      payload: "<requirement />",
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error.code).toBe("unsupported_media_type");
    await app.close();
  });

  it("认证适配器返回无效身份时按失效会话处理", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer broken-session" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_session",
        message: "登录信息已失效，请重新登录",
      },
    });
    await app.close();
  });

  it("未知基础设施异常返回脱敏 500", async () => {
    const { app, repository } = createTestApp();
    vi.spyOn(repository, "transaction").mockRejectedValueOnce(
      new Error("database-password=do-not-leak"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: validRequirement,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal_error");
    expect(response.body).not.toContain("database-password");
    await app.close();
  });

  it("所有需求路由都统一要求登录", async () => {
    const { app } = createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: validRequirement,
    });
    const location = created.headers.location!;
    const requests = [
      { method: "GET" as const, url: "/api/v1/requirements" },
      {
        method: "POST" as const,
        url: "/api/v1/requirements",
        payload: validRequirement,
      },
      { method: "GET" as const, url: location },
      {
        method: "POST" as const,
        url: `${location}/submit-confirmation`,
        payload: {},
      },
      { method: "POST" as const, url: `${location}/confirm`, payload: {} },
      { method: "POST" as const, url: `${location}/accept`, payload: {} },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });

  it("产品、分析、研发和管理员遵守统一操作权限矩阵", async () => {
    const { app } = createTestApp();

    const developerCreate = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer developer-session" },
      payload: validRequirement,
    });
    expect(developerCreate.statusCode).toBe(403);

    const analystCreate = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer analyst-session" },
      payload: { ...validRequirement, title: "分析师需求" },
    });
    expect(analystCreate.statusCode).toBe(201);
    const analystLocation = analystCreate.headers.location!;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${analystLocation}/submit-confirmation`,
          headers: { authorization: "Bearer analyst-session" },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${analystLocation}/confirm`,
          headers: { authorization: "Bearer analyst-session" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);

    const adminCreate = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer admin-session" },
      payload: { ...validRequirement, title: "管理员需求" },
    });
    const adminLocation = adminCreate.headers.location!;
    await app.inject({
      method: "POST",
      url: `${adminLocation}/submit-confirmation`,
      headers: { authorization: "Bearer admin-session" },
      payload: {},
    });
    const adminConfirm = await app.inject({
      method: "POST",
      url: `${adminLocation}/confirm`,
      headers: { authorization: "Bearer admin-session" },
      payload: {},
    });
    expect(adminConfirm.statusCode).toBe(200);
    await app.close();
  });

  it("列表操作链接同时遵守领域状态和当前账号权限", async () => {
    const { app } = createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: { ...validRequirement, title: "仍在整理" },
    });
    const waiting = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: { ...validRequirement, title: "等待确认" },
    });
    await app.inject({
      method: "POST",
      url: `${waiting.headers.location}/submit-confirmation`,
      headers: { authorization: "Bearer product-session" },
      payload: {},
    });

    const developerItems = (
      await app.inject({
        method: "GET",
        url: "/api/v1/requirements",
        headers: { authorization: "Bearer developer-session" },
      })
    ).json().data;
    expect(
      developerItems.every(
        (item: any) => Object.keys(item.links.actions).length === 0,
      ),
    ).toBe(true);

    const analystItems = (
      await app.inject({
        method: "GET",
        url: "/api/v1/requirements",
        headers: { authorization: "Bearer analyst-session" },
      })
    ).json().data;
    expect(
      analystItems.find((item: any) => item.title === "仍在整理").links.actions,
    ).toHaveProperty("submitConfirmation");
    expect(
      analystItems.find((item: any) => item.title === "等待确认").links.actions,
    ).toEqual({});

    const ownerItems = (
      await app.inject({
        method: "GET",
        url: "/api/v1/requirements",
        headers: { authorization: "Bearer product-session" },
      })
    ).json().data;
    expect(
      ownerItems.find((item: any) => item.title === "等待确认").links.actions,
    ).toHaveProperty("confirm");
    await app.close();
  });

  it("列表使用硬上限游标分页，并提供不展示内部 ID 的可操作链接", async () => {
    const { app } = createTestApp();
    for (const title of ["访客预约", "工单审批"]) {
      await app.inject({
        method: "POST",
        url: "/api/v1/requirements",
        headers: { authorization: "Bearer product-session" },
        payload: { ...validRequirement, title },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/v1/requirements?limit=1",
      headers: { authorization: "Bearer product-session" },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().data).toHaveLength(1);
    expect(firstPage.json().data[0]).not.toHaveProperty("id");
    expect(firstPage.json().data[0]).not.toHaveProperty("key");
    expect(firstPage.json().data[0].links).toMatchObject({
      self: expect.stringMatching(/^\/api\/v1\/requirements\/[0-9a-f-]+$/),
      actions: {
        submitConfirmation: expect.stringMatching(/\/submit-confirmation$/),
      },
    });
    expect(firstPage.json().meta.nextCursor).toEqual(expect.any(String));

    const action = await app.inject({
      method: "POST",
      url: firstPage.json().data[0].links.actions.submitConfirmation,
      headers: { authorization: "Bearer product-session" },
      payload: {},
    });
    expect(action.json().data.status).toBe("等待负责人确认");

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/requirements?limit=1&cursor=${encodeURIComponent(
        firstPage.json().meta.nextCursor,
      )}`,
      headers: { authorization: "Bearer product-session" },
    });
    expect(secondPage.json().data).toHaveLength(1);
    expect(secondPage.json().data[0].title).not.toBe(
      firstPage.json().data[0].title,
    );

    const excessive = await app.inject({
      method: "GET",
      url: "/api/v1/requirements?limit=101",
      headers: { authorization: "Bearer product-session" },
    });
    expect(excessive.statusCode).toBe(422);
    await app.close();
  });
});
