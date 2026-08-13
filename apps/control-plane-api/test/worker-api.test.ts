import { describe, expect, it, vi } from "vitest";

import {
  WORKER_REQUIREMENT_COMPLETION_SUMMARY,
  type WorkerRequirementCompletionPayload,
} from "@forgex/contracts";

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
  WorkerFleetService,
  requirementCompletionDigest,
  type AuthenticatedPrincipal,
  type RequirementTransaction,
  type SessionAuthenticator,
} from "@forgex/application";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";
import { EvidenceAuthority } from "@forgex/domain";

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

class FailFirstDeliveryRunSaveRepository extends InMemoryRequirementRepository {
  #shouldFailSave = true;

  override transaction<T>(
    scopedTenantKey: string,
    scopedProjectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    return super.transaction(scopedTenantKey, scopedProjectKey, (transaction) =>
      operation({
        ...transaction,
        saveDeliveryRunResult: (result) => {
          if (this.#shouldFailSave) {
            this.#shouldFailSave = false;
            throw new Error("模拟交付结果首次落库失败");
          }
          transaction.saveDeliveryRunResult(result);
        },
      }),
    );
  }
}

class FailFirstDeliveryRunFinalizeRepository extends InMemoryRequirementRepository {
  #shouldFailFinalize = true;

  override transaction<T>(
    scopedTenantKey: string,
    scopedProjectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    return super.transaction(scopedTenantKey, scopedProjectKey, (transaction) =>
      operation({
        ...transaction,
        markDeliveryRunCompleted: (...args) => {
          if (this.#shouldFailFinalize) {
            this.#shouldFailFinalize = false;
            throw new Error("模拟交付结果收敛失败");
          }
          return transaction.markDeliveryRunCompleted(...args);
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
    runnerAuthenticator: { authenticate: async () => null },
    evidenceAuthority: new EvidenceAuthority({ runners: [] }),
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
    repositoryKey: scopedProjectKey,
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
  const registrationData = registration(index);
  const enrollment = await app.inject({
    method: "POST",
    url: "/api/v1/worker-enrollments",
    headers: { authorization: "Bearer admin-session" },
    payload: {
      schemaVersion: 1,
      deviceName: registrationData.deviceName,
      accountName: registrationData.accountName,
    },
  });
  expect(enrollment.statusCode).toBe(201);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/worker-enrollments/exchange",
    payload: {
      schemaVersion: 1,
      enrollmentToken: enrollment.json().data.enrollmentToken,
      accountFingerprint: registrationData.accountFingerprint,
      capabilities: registrationData.capabilities,
    },
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
  it("当前需求租约可实时上报脱敏过程事件，需求详情按顺序展示", async () => {
    const { app } = createTestApp();
    const connection = await connectWorker(app, 1);
    const { queued, location } = await requestConfirmedDelivery(
      app,
      "显示 Codex 执行过程",
      [],
    );
    expect(queued.statusCode).toBe(202);
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    const assignment = poll.json().data.assignment;
    const event = {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      eventKey: "88888888-8888-4888-8888-888888888888",
      sequence: 1,
      occurredAt: "2026-08-13T04:00:00.000Z",
      event: {
        kind: "tool",
        tool: "search_workspace_text",
        status: "completed",
      },
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/requirement-progress",
      headers: workerHeaders(connection),
      payload: event,
    });
    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/requirement-progress",
      headers: workerHeaders(connection),
      payload: event,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data).toEqual({ alreadyRecorded: false });
    expect(repeated.json().data).toEqual({ alreadyRecorded: true });

    const leaked = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/requirement-progress",
      headers: workerHeaders(connection),
      payload: {
        ...event,
        eventKey: "99999999-9999-4999-8999-999999999999",
        sequence: 2,
        event: { ...event.event, output: "TOKEN=LEAK_MARKER" },
      },
    });
    expect(leaked.statusCode).toBe(422);
    expect(leaked.body).not.toContain("LEAK_MARKER");

    const detail = await app.inject({
      method: "GET",
      url: location,
      headers: { authorization: "Bearer product-session" },
    });
    expect(detail.json().data.executionEvents).toEqual([
      {
        title: "检索相关代码",
        detail: "已完成",
        tone: "success",
        occurredAt: "2026-08-13T04:00:00.000Z",
      },
    ]);
    expect(detail.body).not.toContain(assignment.assignmentKey);
    await app.close();
  });

  it("只有管理员可连接设备，普通列表不泄漏指纹和连接密钥", async () => {
    const { app } = createTestApp();
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/worker-enrollments",
      headers: { authorization: "Bearer developer-session" },
      payload: {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
      },
    });
    expect(forbidden.statusCode).toBe(403);
    const bypass = await app.inject({
      method: "POST",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer admin-session" },
      payload: registration(1),
    });
    expect(bypass.statusCode).toBe(404);

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
        unlimited: true,
      },
      links: { actions: {} },
    });
    expect(list.body).not.toContain("accountFingerprint");
    expect(list.body).not.toContain("sessionKey");
    expect(list.body).not.toContain("workerKey");

    const adminList = await app.inject({
      method: "GET",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer admin-session" },
    });
    expect(adminList.json().links).toEqual({
      actions: { connect: "/api/v1/worker-enrollments" },
    });
    await app.close();
  });

  it("管理员签发短期单设备接入码，响应丢失时同一身份获得相同会话", async () => {
    const { app } = createTestApp();
    const issued = await app.inject({
      method: "POST",
      url: "/api/v1/worker-enrollments",
      headers: { authorization: "Bearer admin-session" },
      payload: {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
      },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.headers["cache-control"]).toBe("no-store");
    expect(issued.headers.pragma).toBe("no-cache");
    const token = issued.json().data.enrollmentToken as string;

    const beforeExchange = await app.inject({
      method: "GET",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer admin-session" },
    });
    expect(beforeExchange.json().meta.connectedAccounts).toBe(0);

    const exchange = (fingerprint: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/worker-enrollments/exchange",
        payload: {
          schemaVersion: 1,
          enrollmentToken: token,
          accountFingerprint: fingerprint,
          capabilities: ["typescript"],
        },
      });
    const first = await exchange("f".repeat(64));
    const retry = await exchange("f".repeat(64));
    const hijack = await exchange("e".repeat(64));
    expect(first.statusCode).toBe(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers.pragma).toBe("no-cache");
    expect(retry.statusCode).toBe(201);
    expect(retry.json().data.connection).toEqual(first.json().data.connection);
    expect(hijack.statusCode).toBe(401);

    const afterExchange = await app.inject({
      method: "GET",
      url: "/api/v1/workers",
      headers: { authorization: "Bearer admin-session" },
    });
    expect(afterExchange.json().meta).toMatchObject({
      connectedAccounts: 1,
      unlimited: true,
    });
    await app.close();
  });

  it("第二代设备已领取任务后，当前接入码的幂等重试不释放租约", async () => {
    const { app } = createTestApp();
    const issue = async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/worker-enrollments",
        headers: { authorization: "Bearer admin-session" },
        payload: {
          schemaVersion: 1,
          deviceName: "研发电脑 1",
          accountName: "Codex 账户 1",
        },
      });
      return response.json().data.enrollmentToken as string;
    };
    const exchange = (token: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/worker-enrollments/exchange",
        payload: {
          schemaVersion: 1,
          enrollmentToken: token,
          accountFingerprint: "f".repeat(64),
          capabilities: ["typescript"],
        },
      });
    await exchange(await issue());
    const currentToken = await issue();
    const current = await exchange(currentToken);
    const connection = current.json().data.connection;
    expect(connection.generation).toBe(2);
    const { queued } = await requestConfirmedDelivery(app, "保持当前设备租约", [
      "typescript",
    ]);
    expect(queued.statusCode).toBe(202);
    const firstPoll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });

    const retry = await exchange(currentToken);
    expect(retry.json().data.connection).toEqual(connection);
    const secondPoll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    expect(secondPoll.json().data.assignment).toMatchObject({
      assignmentKey: firstPoll.json().data.assignment.assignmentKey,
      fencingToken: firstPoll.json().data.assignment.fencingToken,
    });
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
    expect(firstPoll.json().data.assignment.execution).toMatchObject({
      schemaVersion: 1,
      taskType: "requirement_delivery",
      projectKey,
      requirementRevision: 1,
      executionPolicy: {
        workspaceIsolation: "dedicated_worktree",
        productionAccess: "denied",
        credentialHandling: "device_local_only",
        completionEvidence: "independent_runner_required",
      },
    });
    expect(firstPoll.json().data.assignment.execution.spec.title).toBe(
      firstPoll.json().data.assignment.title,
    );
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
    const requirementRepository = new InMemoryRequirementRepository();
    const { app, advanceTo } = createTestApp(
      new InMemoryWorkerFleetRepository(),
      requirementRepository,
    );
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
    const completionCommand = {
      ...command,
      projectKey: assignment.projectKey,
      repositoryKey: assignment.execution.repositoryKey,
      requirementKey: assignment.requirementKey,
      requirementRevision: assignment.requirementRevision,
      gitHashAlgorithm: "sha1",
      baseCommit: "a".repeat(40),
      commitSha: "b".repeat(40),
      branchName: `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`,
      summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
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

    const freeTextSummary = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: {
        ...completionCommand,
        summary: "LEAK_MARKER_DO_NOT_UPLOAD",
      },
    });
    expect(freeTextSummary.statusCode).toBe(422);
    expect(freeTextSummary.body).not.toContain("LEAK_MARKER_DO_NOT_UPLOAD");

    const wrongRepository = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: {
        ...completionCommand,
        repositoryKey: "77777777-7777-4777-8777-777777777777",
      },
    });
    expect(wrongRepository.statusCode).toBe(409);
    expect(wrongRepository.json().error.code).toBe("delivery_completion_stale");

    const firstCompletion = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: completionCommand,
    });
    const repeatedCompletion = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: completionCommand,
    });
    expect(firstCompletion.json().data).toEqual({ alreadyCompleted: false });
    expect(repeatedCompletion.json().data).toEqual({ alreadyCompleted: true });
    const result = await requirementRepository.findDeliveryRunResultByProof(
      tenantKey,
      {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      },
    );
    expect(result).toMatchObject({
      repositoryKey: projectKey,
      commitSha: "b".repeat(40),
      status: "completed",
    });
    const audit = await requirementRepository.listAuditEvents(
      tenantKey,
      projectKey,
    );
    expect(
      audit.filter((event) => event.action === "delivery.completed"),
    ).toHaveLength(1);
    await app.close();
  });

  it("设备完成已提交但结果首次落库失败时，重试依靠永久证明收敛", async () => {
    const requirementRepository = new FailFirstDeliveryRunSaveRepository();
    const { app } = createTestApp(
      new InMemoryWorkerFleetRepository(),
      requirementRepository,
    );
    const connection = await connectWorker(app, 1);
    await requestConfirmedDelivery(app, "恢复交付结果", []);
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    const assignment = poll.json().data.assignment;
    const completion = {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      projectKey: assignment.projectKey,
      repositoryKey: assignment.execution.repositoryKey,
      requirementKey: assignment.requirementKey,
      requirementRevision: assignment.requirementRevision,
      gitHashAlgorithm: "sha1",
      baseCommit: "c".repeat(40),
      commitSha: "d".repeat(40),
      branchName: `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`,
      summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: completion,
    });
    expect(first.statusCode).toBe(500);

    const replaced = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: {
        ...completion,
        commitSha: "e".repeat(40),
        summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
      },
    });
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().error.code).toBe("invalid_lease");
    await expect(
      requirementRepository.findDeliveryRunResultByProof(tenantKey, {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      }),
    ).resolves.toBeNull();

    const retried = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: completion,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().data).toEqual({ alreadyCompleted: true });
    await expect(
      requirementRepository.findDeliveryRunResultByProof(tenantKey, {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    await app.close();
  });

  it("并发提交不同结果时只接受永久证明绑定的那一份", async () => {
    const requirementRepository = new InMemoryRequirementRepository();
    const { app } = createTestApp(
      new InMemoryWorkerFleetRepository(),
      requirementRepository,
    );
    const connection = await connectWorker(app, 1);
    await requestConfirmedDelivery(app, "并发完成证明", []);
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    const assignment = poll.json().data.assignment;
    const completionA: WorkerRequirementCompletionPayload = {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      projectKey: assignment.projectKey,
      repositoryKey: assignment.execution.repositoryKey,
      requirementKey: assignment.requirementKey,
      requirementRevision: assignment.requirementRevision,
      gitHashAlgorithm: "sha1",
      baseCommit: "1".repeat(40),
      commitSha: "2".repeat(40),
      branchName: `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`,
      summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
    };
    const completionB: WorkerRequirementCompletionPayload = {
      ...completionA,
      commitSha: "3".repeat(40),
    };
    const digestA = requirementCompletionDigest(completionA);
    const originalGetCurrentLease =
      WorkerFleetService.prototype.getCurrentLease;
    const originalComplete = WorkerFleetService.prototype.complete;
    let leasesRead = 0;
    let releaseLeaseReads!: () => void;
    const bothLeasesRead = new Promise<void>((resolve) => {
      releaseLeaseReads = resolve;
    });
    let confirmProofA!: () => void;
    const proofAStored = new Promise<void>((resolve) => {
      confirmProofA = resolve;
    });
    let releaseCompletionA!: () => void;
    const completionACanReturn = new Promise<void>((resolve) => {
      releaseCompletionA = resolve;
    });
    const leaseSpy = vi
      .spyOn(WorkerFleetService.prototype, "getCurrentLease")
      .mockImplementation(async function (
        this: WorkerFleetService,
        connectionValue,
        commandValue,
      ) {
        const result = await originalGetCurrentLease.call(
          this,
          connectionValue,
          commandValue,
        );
        leasesRead += 1;
        if (leasesRead === 2) releaseLeaseReads();
        await bothLeasesRead;
        return result;
      });
    const completeSpy = vi
      .spyOn(WorkerFleetService.prototype, "complete")
      .mockImplementation(async function (
        this: WorkerFleetService,
        connectionValue,
        commandValue,
        digest,
      ) {
        if (digest === digestA) {
          const result = await originalComplete.call(
            this,
            connectionValue,
            commandValue,
            digest,
          );
          confirmProofA();
          await completionACanReturn;
          return result;
        }
        await proofAStored;
        return originalComplete.call(
          this,
          connectionValue,
          commandValue,
          digest,
        );
      });

    try {
      const requestA = app.inject({
        method: "POST",
        url: "/api/v1/worker-connection/complete",
        headers: workerHeaders(connection),
        payload: completionA,
      });
      const requestB = app.inject({
        method: "POST",
        url: "/api/v1/worker-connection/complete",
        headers: workerHeaders(connection),
        payload: completionB,
      });
      const rejectedB = await requestB;
      expect(rejectedB.statusCode).toBe(409);
      expect(rejectedB.json().error.code).toBe("delivery_completion_mismatch");
      releaseCompletionA();
      const acceptedA = await requestA;
      expect(acceptedA.statusCode).toBe(200);
      await expect(
        requirementRepository.findDeliveryRunResultByProof(tenantKey, {
          assignmentKey: assignment.assignmentKey,
          fencingToken: assignment.fencingToken,
        }),
      ).resolves.toMatchObject({ commitSha: completionA.commitSha });
    } finally {
      releaseCompletionA();
      leaseSpy.mockRestore();
      completeSpy.mockRestore();
      await app.close();
    }
  });

  it("完成证明与结果均已落库但首次收敛失败时，下一次轮询自动补偿", async () => {
    const requirementRepository = new FailFirstDeliveryRunFinalizeRepository();
    const { app } = createTestApp(
      new InMemoryWorkerFleetRepository(),
      requirementRepository,
    );
    const connection = await connectWorker(app, 1);
    await requestConfirmedDelivery(app, "补偿交付审计", []);
    const firstPoll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    const assignment = firstPoll.json().data.assignment;
    const completion = {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      projectKey: assignment.projectKey,
      repositoryKey: assignment.execution.repositoryKey,
      requirementKey: assignment.requirementKey,
      requirementRevision: assignment.requirementRevision,
      gitHashAlgorithm: "sha1",
      baseCommit: "e".repeat(40),
      commitSha: "f".repeat(40),
      branchName: `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`,
      summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
    };
    const completed = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/complete",
      headers: workerHeaders(connection),
      payload: completion,
    });
    expect(completed.statusCode).toBe(500);
    await expect(
      requirementRepository.findDeliveryRunResultByProof(tenantKey, {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      }),
    ).resolves.toMatchObject({ status: "completion_pending" });

    const recoveryPoll = await app.inject({
      method: "POST",
      url: "/api/v1/worker-connection/poll",
      headers: workerHeaders(connection),
      payload: {},
    });
    expect(recoveryPoll.statusCode).toBe(200);
    await expect(
      requirementRepository.findDeliveryRunResultByProof(tenantKey, {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      }),
    ).resolves.toMatchObject({ status: "completed" });
    const audit = await requirementRepository.listAuditEvents(
      tenantKey,
      projectKey,
    );
    expect(
      audit.filter((event) => event.action === "delivery.completed"),
    ).toHaveLength(1);
    await app.close();
  });

  it("多个 API 副本共享不限量账户和交付租约", async () => {
    const repository = new InMemoryWorkerFleetRepository();
    const requirementRepository = new InMemoryRequirementRepository();
    const { app: firstApp } = createTestApp(repository, requirementRepository);
    const { app: secondApp } = createTestApp(repository, requirementRepository);
    const connections = [];
    for (let index = 1; index <= 5; index += 1) {
      connections.push(
        await connectWorker(index % 2 === 0 ? secondApp : firstApp, index),
      );
    }
    const sixthEnrollment = await secondApp.inject({
      method: "POST",
      url: "/api/v1/worker-enrollments",
      headers: { authorization: "Bearer admin-session" },
      payload: {
        schemaVersion: 1,
        deviceName: registration(6).deviceName,
        accountName: registration(6).accountName,
      },
    });
    const sixth = await secondApp.inject({
      method: "POST",
      url: "/api/v1/worker-enrollments/exchange",
      payload: {
        schemaVersion: 1,
        enrollmentToken: sixthEnrollment.json().data.enrollmentToken,
        accountFingerprint: registration(6).accountFingerprint,
        capabilities: registration(6).capabilities,
      },
    });
    expect(sixth.statusCode).toBe(201);
    connections.push(sixth.json().data.connection);

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
