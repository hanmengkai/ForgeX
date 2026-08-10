import { describe, expect, it } from "vitest";

import {
  InMemoryRequirementRepository,
  InMemoryExtensionCatalogRepository,
  InMemoryMcpRegistryRepository,
  InMemoryMcpInputSchemaStore,
  InMemoryMcpInvocationRepository,
  InMemoryKnowledgeBaseRepository,
  InMemoryPreviewArtifactStore,
  InMemorySkillArtifactStore,
  InMemorySkillRegistryRepository,
  InMemoryWorkerFleetRepository,
  type AuthenticatedPrincipal,
  type RequirementTransaction,
  type SessionAuthenticator,
} from "@forgex/application";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";

import { buildControlPlaneApi } from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const administrator: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "平台管理员",
  tenantKey,
  roles: ["administrator"],
};
const productOwner: AuthenticatedPrincipal = {
  actorKey: "44444444-4444-4444-8444-444444444444",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner"],
};
const developer: AuthenticatedPrincipal = {
  actorKey: "55555555-5555-4555-8555-555555555555",
  actorName: "初级研发",
  tenantKey,
  roles: ["developer"],
};

const registration = (index: number) => ({
  schemaVersion: 1,
  deviceName: `研发电脑 ${index}`,
  accountName: `Codex 账户 ${index}`,
  accountFingerprint: index.toString(16).padStart(64, "0"),
  capabilities: ["typescript", "browser"],
});

class ObservedRequirementRepository extends InMemoryRequirementRepository {
  pendingDispatchReads = 0;

  override async listPendingDeliveryDispatches(
    scopedTenantKey: string,
    scopedProjectKey: string,
    limit: number,
  ) {
    this.pendingDispatchReads += 1;
    return super.listPendingDeliveryDispatches(
      scopedTenantKey,
      scopedProjectKey,
      limit,
    );
  }
}

class FailFirstDispatchMarkRepository extends InMemoryRequirementRepository {
  #shouldFailMark = true;

  override transaction<T>(
    scopedTenantKey: string,
    scopedProjectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    return super.transaction(scopedTenantKey, scopedProjectKey, (transaction) =>
      operation({
        ...transaction,
        markDeliveryDispatched: (dispatchKey, dispatchedAt) => {
          if (this.#shouldFailMark) {
            this.#shouldFailMark = false;
            throw new Error("模拟项目 A 派发标记失败");
          }
          return transaction.markDeliveryDispatched(dispatchKey, dispatchedAt);
        },
      }),
    );
  }
}

const requirementSpec = (title: string) => ({
  schemaVersion: 1,
  title,
  goal: `完成${title}并可由产品负责人验收`,
  userStories: [],
  acceptanceCriteria: [
    {
      title: `${title}可以正常使用`,
      description: "按确认后的业务流程操作能够得到预期结果",
      priority: "must",
    },
  ],
  openQuestions: [],
});

const createTestApp = (
  workerFleetRepository = new InMemoryWorkerFleetRepository(),
  requirementRepository = new InMemoryRequirementRepository(),
  scopedProjectKey = projectKey,
) => {
  let now = new Date("2026-08-10T05:00:00.000Z");
  const sessions = new Map<string, AuthenticatedPrincipal>([
    ["admin-session", administrator],
    ["product-session", productOwner],
    ["developer-session", developer],
  ]);
  const authenticator: SessionAuthenticator = {
    authenticate: async (authorization) =>
      authorization?.startsWith("Bearer ")
        ? (sessions.get(authorization.slice("Bearer ".length)) ?? null)
        : null,
  };
  const app = buildControlPlaneApi({
    authenticator,
    extensionCatalogRepository: new InMemoryExtensionCatalogRepository(),
    knowledgeBaseRepository: new InMemoryKnowledgeBaseRepository(),
    mcpRegistryRepository: new InMemoryMcpRegistryRepository(),
    mcpHealthAuthority: new McpHealthAuthority({ verifiers: [] }),
    mcpInputSchemaStore: new InMemoryMcpInputSchemaStore(),
    mcpInvocationRepository: new InMemoryMcpInvocationRepository(),
    skillRegistryRepository: new InMemorySkillRegistryRepository(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    skillEvaluationAuthority: new SkillEvaluationAuthority({ evaluators: [] }),
    requirementRepository,
    previewArtifactStore: new InMemoryPreviewArtifactStore(),
    workerFleetRepository,
    projectKey: scopedProjectKey,
    clock: () => new Date(now.getTime()),
  });
  return {
    app,
    advanceTo: (value: string) => {
      now = new Date(value);
    },
  };
};

const connectWorker = async (
  app: ReturnType<typeof buildControlPlaneApi>,
  index: number,
) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/workers",
    headers: { authorization: "Bearer admin-session" },
    payload: registration(index),
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.connection as {
    schemaVersion: 1;
    tenantKey: string;
    workerKey: string;
    sessionKey: string;
    generation: number;
  };
};

const workerHeaders = (connection: {
  tenantKey: string;
  workerKey: string;
  sessionKey: string;
  generation: number;
}) => ({
  authorization: `Worker ${connection.sessionKey}`,
  "x-forgex-tenant-key": connection.tenantKey,
  "x-forgex-worker-key": connection.workerKey,
  "x-forgex-worker-generation": String(connection.generation),
});

const createConfirmedRequirement = async (
  app: ReturnType<typeof buildControlPlaneApi>,
  title: string,
) => {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/requirements",
    headers: { authorization: "Bearer product-session" },
    payload: requirementSpec(title),
  });
  expect(created.statusCode).toBe(201);
  const location = created.headers.location!;
  const submitted = await app.inject({
    method: "POST",
    url: `${location}/submit-confirmation`,
    headers: { authorization: "Bearer product-session" },
    payload: {},
  });
  expect(submitted.statusCode).toBe(200);
  const confirmed = await app.inject({
    method: "POST",
    url: `${location}/confirm`,
    headers: { authorization: "Bearer product-session" },
    payload: {},
  });
  expect(confirmed.statusCode).toBe(200);
  return location;
};

const requestConfirmedDelivery = async (
  app: ReturnType<typeof buildControlPlaneApi>,
  title: string,
  requiredCapabilities: string[],
) => {
  const location = await createConfirmedRequirement(app, title);
  const queued = await app.inject({
    method: "POST",
    url: `${location}/start-delivery`,
    headers: { authorization: "Bearer product-session" },
    payload: { schemaVersion: 1, requiredCapabilities },
  });
  return { queued, location };
};

describe("Codex 设备网关 API", () => {
  it("只有管理员可连接设备，普通列表不泄漏指纹和连接密钥", async () => {
    const { app } = createTestApp();
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer developer-session" },
      payload: registration(1),
    });
    expect(forbidden.statusCode).toBe(403);

    const connection = await connectWorker(app, 1);
    expect(connection.sessionKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer product-session" },
    });
    expect(list.json()).toEqual({
      data: [
        {
          deviceName: "研发电脑 1",
          accountName: "Codex 账户 1",
          status: "空闲",
          currentWork: null,
        },
      ],
      meta: {
        connectedAccounts: 1,
        maxAccounts: 5,
        availableSlots: 4,
      },
    });
    expect(list.body).not.toContain("accountFingerprint");
    expect(list.body).not.toContain("sessionKey");
    expect(list.body).not.toContain("workerKey");
    await app.close();
  });

  it("两台 Codex 设备通过出站轮询并行领取不同需求", async () => {
    const { app } = createTestApp();
    const first = await connectWorker(app, 1);
    const second = await connectWorker(app, 2);
    for (const [title, capability] of [
      ["完善访客预约", "typescript"],
      ["增加到访统计", "browser"],
    ]) {
      const { queued } = await requestConfirmedDelivery(app, title!, [
        capability!,
      ]);
      expect(queued.statusCode).toBe(202);
    }

    const firstPoll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(first),
      payload: {},
    });
    const afterFirstPoll = await app.inject({
      method: "GET",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer product-session" },
    });
    expect(
      afterFirstPoll.json().data.map((item: { status: string }) => item.status),
    ).toEqual(["正在工作", "空闲"]);
    const secondPoll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(second),
      payload: {},
    });
    expect(firstPoll.statusCode).toBe(200);
    expect(secondPoll.statusCode).toBe(200);
    expect(firstPoll.json().data.assignment.requirementKey).not.toBe(
      secondPoll.json().data.assignment.requirementKey,
    );

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer product-session" },
    });
    expect(
      list.json().data.map((item: { status: string }) => item.status),
    ).toEqual(["正在工作", "正在工作"]);
    await app.close();
  });

  it("设备重连立即废止旧连接，缺失连接信息统一返回 401", async () => {
    const { app } = createTestApp();
    const oldConnection = await connectWorker(app, 1);
    const currentConnection = await connectWorker(app, 1);

    const oldHeartbeat = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/heartbeat",
      headers: workerHeaders(oldConnection),
      payload: {},
    });
    expect(oldHeartbeat.statusCode).toBe(401);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/heartbeat",
      payload: '{"broken":',
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(401);

    const current = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/heartbeat",
      headers: workerHeaders(currentConnection),
      payload: {},
    });
    expect(current.statusCode).toBe(200);
    await app.close();
  });

  it("格式合法但无效的设备连接不能触发 outbox 派发", async () => {
    const requirementRepository = new ObservedRequirementRepository();
    const { app } = createTestApp(
      new InMemoryWorkerFleetRepository(),
      requirementRepository,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: {
        authorization: `Worker ${"a".repeat(43)}`,
        "x-forgex-tenant-key": tenantKey,
        "x-forgex-worker-key": "99999999-9999-4999-8999-999999999999",
        "x-forgex-worker-generation": "1",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(requirementRepository.pendingDispatchReads).toBe(0);
    await app.close();
  });

  it("只有已确认的真实需求可开始交付，标题由服务端固定", async () => {
    const { app } = createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requirements",
      headers: { authorization: "Bearer product-session" },
      payload: requirementSpec("尚未确认的需求"),
    });
    const draftLocation = created.headers.location!;
    const unconfirmed = await app.inject({
      method: "POST",
      url: `${draftLocation}/start-delivery`,
      headers: { authorization: "Bearer product-session" },
      payload: { schemaVersion: 1, requiredCapabilities: [] },
    });
    expect(unconfirmed.statusCode).toBe(409);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/99999999-9999-4999-8999-999999999999/start-delivery",
      headers: { authorization: "Bearer product-session" },
      payload: { schemaVersion: 1, requiredCapabilities: [] },
    });
    expect(missing.statusCode).toBe(404);

    const confirmedLocation = await createConfirmedRequirement(
      app,
      "已确认的权威标题",
    );
    const forgedTitle = await app.inject({
      method: "POST",
      url: `${confirmedLocation}/start-delivery`,
      headers: { authorization: "Bearer product-session" },
      payload: {
        schemaVersion: 1,
        title: "调用方伪造标题",
        requiredCapabilities: [],
      },
    });
    expect(forgedTitle.statusCode).toBe(422);
    const forbidden = await app.inject({
      method: "POST",
      url: `${confirmedLocation}/start-delivery`,
      headers: { authorization: "Bearer developer-session" },
      payload: { schemaVersion: 1, requiredCapabilities: [] },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("租约可续期，完成上报幂等且不会把协议标识展示在设备列表", async () => {
    const { app, advanceTo } = createTestApp();
    const connection = await connectWorker(app, 1);
    const { queued } = await requestConfirmedDelivery(app, "完善访客预约", []);
    expect(queued.statusCode).toBe(202);
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    const assignment = poll.json().data.assignment;
    const command = {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
    };

    advanceTo("2026-08-10T05:00:10.000Z");
    const renewed = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/renew",
      headers: workerHeaders(connection),
      payload: command,
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().data.leasedUntil).toBe("2026-08-10T05:01:10.000Z");

    const firstCompletion = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: command,
    });
    const repeatedCompletion = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: command,
    });
    expect(firstCompletion.json().data).toEqual({ alreadyCompleted: false });
    expect(repeatedCompletion.json().data).toEqual({ alreadyCompleted: true });
    await app.close();
  });

  it("多个 API 副本共享五账户上限和交付租约", async () => {
    const repository = new InMemoryWorkerFleetRepository();
    const { app: firstApp } = createTestApp(repository);
    const { app: secondApp } = createTestApp(repository);
    const connections = [];
    for (let index = 1; index <= 5; index += 1) {
      connections.push(
        await connectWorker(index % 2 === 0 ? secondApp : firstApp, index),
      );
    }
    const rejected = await secondApp.inject({
      method: "POST",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer admin-session" },
      payload: registration(6),
    });
    expect(rejected.statusCode).toBe(409);

    const { queued } = await requestConfirmedDelivery(
      firstApp,
      "跨副本交付",
      [],
    );
    expect(queued.statusCode).toBe(202);
    const poll = await secondApp.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connections[0]!),
      payload: {},
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().data.assignment.title).toBe("跨副本交付");

    await Promise.all([firstApp.close(), secondApp.close()]);
  });

  it("项目 A 派发中断后只轮询项目 B 也能恢复权威范围和审计", async () => {
    const fleetRepository = new InMemoryWorkerFleetRepository();
    const requirementRepository = new FailFirstDispatchMarkRepository();
    const otherProjectKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { app: firstProjectApp } = createTestApp(
      fleetRepository,
      requirementRepository,
    );
    const { app: secondProjectApp } = createTestApp(
      fleetRepository,
      requirementRepository,
      otherProjectKey,
    );
    const connection = await connectWorker(firstProjectApp, 1);
    const { queued } = await requestConfirmedDelivery(
      firstProjectApp,
      "项目 A 的交付",
      [],
    );
    expect(queued.statusCode).toBe(500);

    const poll = await secondProjectApp.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().data.assignment).toMatchObject({
      projectKey,
      requirementRevision: 1,
      title: "项目 A 的交付",
    });
    await expect(
      requirementRepository.listPendingDeliveryDispatches(tenantKey, null, 100),
    ).resolves.toEqual([]);
    const audit = await requirementRepository.listAuditEvents(
      tenantKey,
      projectKey,
    );
    expect(
      audit.filter((event) => event.action === "delivery.dispatched"),
    ).toHaveLength(1);

    await Promise.all([firstProjectApp.close(), secondProjectApp.close()]);
  });
});
