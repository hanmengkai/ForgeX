import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  McpHealthAuthority,
  type McpServerManifest,
  type McpToolDefinition,
} from "@forgex/extensions";

import {
  InMemoryMcpInputSchemaStore,
  InMemoryMcpInvocationRepository,
  InMemoryWorkerFleetRepository,
  McpInvocationApplicationService,
  WorkerFleetService,
  canonicalizeMcpArguments,
  canonicalizeMcpInputSchema,
  type AuthenticatedPrincipal,
  type McpInvocationRepository,
  type TrustedMcpToolDirectory,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const serverKey = "33333333-3333-4333-8333-333333333333";
const readToolKey = "44444444-4444-4444-8444-444444444444";
const writeToolKey = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-08-10T10:00:00.000Z");

const inputSchema = {
  type: "object",
  properties: {
    target: {
      type: "string",
      title: "操作目标",
      writeOnly: false,
      minLength: 2,
      maxLength: 100,
    },
  },
  required: ["target"],
  additionalProperties: false,
} as const;
const schemaHash = canonicalizeMcpInputSchema(inputSchema).hash;

const readTool: McpToolDefinition = {
  toolKey: readToolKey,
  technicalName: "repository.read_structure",
  displayName: "读取项目结构",
  description: "读取项目目录和受版本控制文件的结构摘要",
  effect: "read",
  approval: "automatic",
  inputSchemaHashAlgorithm: "sha256",
  inputSchemaHash: schemaHash,
};
const writeTool: McpToolDefinition = {
  ...readTool,
  toolKey: writeToolKey,
  technicalName: "repository.create_branch",
  displayName: "创建交付分支",
  description: "在明确确认后创建本次需求的交付分支",
  effect: "write",
  approval: "review_required",
};
const manifest: McpServerManifest = {
  schemaVersion: 1,
  serverKey,
  tenantKey,
  projectKey,
  revision: 3,
  name: "代码仓库助手",
  summary: "读取项目结构并在确认后创建交付分支",
  transport: "stdio",
  connectionBindingKey: "66666666-6666-4666-8666-666666666666",
  protocolVersion: "2025-06-18",
  tools: [readTool, writeTool],
  publishedAt: "2026-08-10T09:00:00.000Z",
};

const developer: AuthenticatedPrincipal = {
  actorKey: "77777777-7777-4777-8777-777777777777",
  actorName: "初级研发",
  tenantKey,
  roles: ["developer"],
};
const productOwner: AuthenticatedPrincipal = {
  actorKey: "88888888-8888-4888-8888-888888888888",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner"],
};
const administrator: AuthenticatedPrincipal = {
  actorKey: "99999999-9999-4999-8999-999999999999",
  actorName: "平台管理员",
  tenantKey,
  roles: ["administrator"],
};

class MutableToolDirectory implements TrustedMcpToolDirectory {
  enabled = true;
  currentManifest = manifest;
  returnedToolOverride: McpToolDefinition | null = null;

  async getEnabledToolForInvocation(
    requestedTenantKey: string,
    requestedServerKey: string,
    requestedToolKey: string,
    _projectKey?: string,
  ): Promise<{ manifest: McpServerManifest; tool: McpToolDefinition } | null> {
    if (
      !this.enabled ||
      requestedTenantKey !== tenantKey ||
      requestedServerKey !== serverKey
    ) {
      return null;
    }
    const tool = this.currentManifest.tools.find(
      (candidate) => candidate.toolKey === requestedToolKey,
    );
    return tool
      ? {
          manifest: this.currentManifest,
          tool: this.returnedToolOverride ?? tool,
        }
      : null;
  }
}

const createService = async (
  clock: () => Date = () => new Date(now.getTime()),
) => {
  const repository = new InMemoryMcpInvocationRepository();
  const schemaStore = new InMemoryMcpInputSchemaStore();
  const toolDirectory = new MutableToolDirectory();
  await schemaStore.put(
    {
      tenantKey,
      projectKey,
      hashAlgorithm: "sha256",
      hash: schemaHash,
    },
    inputSchema,
  );
  return {
    repository,
    schemaStore,
    toolDirectory,
    service: new McpInvocationApplicationService({
      repository,
      schemaStore,
      toolDirectory,
      projectKey,
      clock,
    }),
  };
};

describe("McpInvocationApplicationService", () => {
  it("将已验证的只读能力自动排队，成员视图不暴露内部标识、技术名和参数", async () => {
    const { service, repository } = await createService();
    const result = await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });

    expect(result).toEqual({
      invocationKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: "等待设备执行",
      title: "读取项目结构",
    });
    await expect(service.listForPeople(developer)).resolves.toEqual([
      {
        title: "读取项目结构",
        serviceName: "代码仓库助手",
        status: "等待设备执行",
        requestedBy: "初级研发",
        requestedAt: now.toISOString(),
        detail: "只读操作，已通过安全规则自动确认",
        inputs: [
          {
            label: "操作目标",
            display: "single",
            values: ["src"],
            sensitive: false,
          },
        ],
      },
    ]);
    const records = await repository.list(tenantKey, projectKey);
    expect(records[0]).toMatchObject({
      status: "queued",
      serverRevision: 3,
      manifestHash: McpHealthAuthority.manifestHash(manifest),
      technicalName: "repository.read_structure",
      arguments: { target: "src" },
      argumentsHashAlgorithm: "sha256",
      inputSchemaHash: schemaHash,
    });
    expect(
      JSON.stringify((await service.listForPeople(developer))[0]),
    ).not.toMatch(/serverKey|toolKey|technicalName|"target"|[0-9a-f]{8}-/);
  });

  it("写入能力等待产品确认，普通研发不能审批且成功审批会原子记录审计", async () => {
    const { service, repository } = await createService();
    const requestKey = randomUUID();
    await expect(
      service.request(developer, {
        schemaVersion: 1,
        requestKey,
        serverKey,
        toolKey: writeToolKey,
        arguments: { target: "feature/payment" },
      }),
    ).resolves.toMatchObject({ status: "等待产品确认" });

    const [record] = await repository.list(tenantKey, projectKey);
    await expect(
      service.approve(developer, record!.invocationKey),
    ).rejects.toMatchObject({ statusCode: 403, code: "mcp_approval_required" });
    await service.approve(productOwner, record!.invocationKey);
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        action: "approved",
        invocationKey: record!.invocationKey,
        actorName: "产品负责人",
        manifestHash: McpHealthAuthority.manifestHash(manifest),
        argumentsHash: record!.argumentsHash,
      }),
    ]);
    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        status: "queued",
        approval: expect.objectContaining({ actorName: "产品负责人" }),
      }),
    ]);
  });

  it("缺失 Schema、MCP 已停用或参数不合法时拒绝创建调用", async () => {
    const { service, schemaStore, toolDirectory } = await createService();
    toolDirectory.enabled = false;
    await expect(
      service.request(developer, {
        schemaVersion: 1,
        requestKey: randomUUID(),
        serverKey,
        toolKey: readToolKey,
        arguments: { target: "src" },
      }),
    ).rejects.toMatchObject({ code: "mcp_tool_unavailable" });

    toolDirectory.enabled = true;
    const serviceWithoutSchema = new McpInvocationApplicationService({
      repository: new InMemoryMcpInvocationRepository(),
      schemaStore: {
        put: schemaStore.put.bind(schemaStore),
        get: async () => null,
      },
      toolDirectory,
      projectKey,
      clock: () => new Date(now.getTime()),
    });
    await expect(
      serviceWithoutSchema.request(developer, {
        schemaVersion: 1,
        requestKey: randomUUID(),
        serverKey,
        toolKey: readToolKey,
        arguments: { target: "src" },
      }),
    ).rejects.toMatchObject({ code: "mcp_schema_unavailable" });

    await expect(
      service.request(developer, {
        schemaVersion: 1,
        requestKey: randomUUID(),
        serverKey,
        toolKey: readToolKey,
        arguments: { target: "s", extra: true },
      }),
    ).rejects.toMatchObject({ code: "mcp_arguments_invalid" });
  });

  it("审批时 MCP 版本或安全状态变化会失败关闭且不写审批记录", async () => {
    const { service, repository, toolDirectory } = await createService();
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: writeToolKey,
      arguments: { target: "feature/payment" },
    });
    const [record] = await repository.list(tenantKey, projectKey);

    toolDirectory.currentManifest = {
      ...manifest,
      revision: 4,
      publishedAt: "2026-08-10T09:30:00.000Z",
    };
    await expect(
      service.approve(productOwner, record!.invocationKey),
    ).rejects.toMatchObject({ code: "mcp_invocation_stale" });
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual(
      [],
    );
    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({ status: "awaiting_approval", approval: null }),
    ]);
  });

  it("同一请求键并发重试保持幂等，不会创建两次调用", async () => {
    const { service, repository, toolDirectory } = await createService();
    const command = {
      schemaVersion: 1 as const,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    };

    await Promise.all([
      service.request(developer, command),
      service.request(developer, command),
    ]);
    toolDirectory.enabled = false;
    await expect(service.request(developer, command)).resolves.toMatchObject({
      title: "读取项目结构",
      status: "等待设备执行",
    });
    await expect(repository.list(tenantKey, projectKey)).resolves.toHaveLength(
      1,
    );
  });

  it("只采用签名清单中的完整工具定义，目录不能夹带降级后的独立工具", async () => {
    const { service, repository, toolDirectory } = await createService();
    toolDirectory.returnedToolOverride = {
      ...writeTool,
      technicalName: "destructive.operation",
      displayName: "普通查询",
      effect: "read",
      approval: "automatic",
    };

    await expect(
      service.request(developer, {
        schemaVersion: 1,
        requestKey: randomUUID(),
        serverKey,
        toolKey: writeToolKey,
        arguments: { target: "production" },
      }),
    ).resolves.toMatchObject({
      title: writeTool.displayName,
      status: "等待产品确认",
    });
    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        technicalName: writeTool.technicalName,
        toolDisplayName: writeTool.displayName,
        effect: "write",
        approvalMode: "review_required",
      }),
    ]);
  });

  it("目录不能用含同名能力的另一个服务替换用户选择的服务", async () => {
    const { service, repository, toolDirectory } = await createService();
    toolDirectory.currentManifest = {
      ...manifest,
      serverKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      connectionBindingKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "另一个外部服务",
    };

    await expect(
      service.request(developer, {
        schemaVersion: 1,
        requestKey: randomUUID(),
        serverKey,
        toolKey: readToolKey,
        arguments: { target: "src" },
      }),
    ).rejects.toThrow("可信 MCP 目录返回了错误的租户、项目或能力绑定");
    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual([]);
  });

  it("租户未完成调用达到上限后拒绝新建，但同一请求的幂等重试仍可返回", async () => {
    const { service, repository } = await createService();
    const commands = Array.from({ length: 101 }, () => ({
      schemaVersion: 1 as const,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    }));

    const outcomes = await Promise.allSettled(
      commands.map((command) => service.request(developer, command)),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(100);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual(
      [
        expect.objectContaining({
          reason: expect.objectContaining({
            statusCode: 429,
            code: "mcp_invocation_capacity",
          }),
        }),
      ],
    );
    await expect(
      service.request(developer, commands[0]!),
    ).resolves.toMatchObject({ status: "等待设备执行" });
    await expect(repository.list(tenantKey, projectKey)).resolves.toHaveLength(
      100,
    );
  });

  it("发起人可以取消待确认操作并释放租户额度，审计保留操作人", async () => {
    const { service, repository } = await createService();
    const commands = Array.from({ length: 100 }, () => ({
      schemaVersion: 1 as const,
      requestKey: randomUUID(),
      serverKey,
      toolKey: writeToolKey,
      arguments: { target: "feature/payment" },
    }));
    for (const command of commands) await service.request(developer, command);
    await expect(
      service.request(developer, {
        ...commands[0]!,
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "mcp_invocation_capacity" });

    const record = (await repository.list(tenantKey, projectKey))[0]!;
    await expect(
      service.requestCancellation(developer, record.invocationKey),
    ).resolves.toMatchObject({ invocationKey: record.invocationKey });
    await service.finalizeCancellation(
      tenantKey,
      projectKey,
      record.invocationKey,
    );

    await expect(
      service.request(developer, {
        ...commands[0]!,
        requestKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "等待产品确认" });
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        action: "cancelled",
        source: "user",
        actorKey: developer.actorKey,
        actorName: developer.actorName,
      }),
    ]);
  });

  it("目录和 Schema 校验不会发生在调用仓储事务内部", async () => {
    const base = await createService();
    let transactionOpen = false;
    const guardedRepository: McpInvocationRepository = {
      transaction: (tenant, project, operation) =>
        base.repository.transaction(tenant, project, async (transaction) => {
          transactionOpen = true;
          try {
            return await operation(transaction);
          } finally {
            transactionOpen = false;
          }
        }),
      list: base.repository.list.bind(base.repository),
      listDispatchableAcrossProjects:
        base.repository.listDispatchableAcrossProjects.bind(base.repository),
      listAudit: base.repository.listAudit.bind(base.repository),
    };
    const guardedDirectory: TrustedMcpToolDirectory = {
      getEnabledToolForInvocation: (...input) => {
        if (transactionOpen) throw new Error("目录查询发生在调用事务内部");
        return base.toolDirectory.getEnabledToolForInvocation(...input);
      },
    };
    const guardedSchemaStore = {
      put: base.schemaStore.put.bind(base.schemaStore),
      get: (...input: Parameters<typeof base.schemaStore.get>) => {
        if (transactionOpen) throw new Error("Schema 查询发生在调用事务内部");
        return base.schemaStore.get(...input);
      },
    };
    const service = new McpInvocationApplicationService({
      repository: guardedRepository,
      schemaStore: guardedSchemaStore,
      toolDirectory: guardedDirectory,
      projectKey,
      clock: () => new Date(now.getTime()),
    });
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now.getTime()),
    });
    const connection = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "3".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });

    await expect(
      service.flushQueuedToWorkers(tenantKey, workers),
    ).resolves.toBe(1);
    const assignment = (await workers.poll(connection)).assignment!;
    await expect(
      service.leaseForExecution(tenantKey, assignment),
    ).resolves.toMatchObject({ technicalName: readTool.technicalName });
  });

  it("租户共享设备从项目 A 轮询时可以派发项目 B 的可信调用", async () => {
    const projectB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const repository = new InMemoryMcpInvocationRepository();
    const schemaStore = new InMemoryMcpInputSchemaStore();
    const manifests = new Map<string, McpServerManifest>([
      [projectKey, manifest],
      [projectB, { ...manifest, projectKey: projectB }],
    ]);
    for (const scope of [projectKey, projectB]) {
      await schemaStore.put(
        {
          tenantKey,
          projectKey: scope,
          hashAlgorithm: "sha256",
          hash: schemaHash,
        },
        inputSchema,
      );
    }
    const directory = (defaultProjectKey: string): TrustedMcpToolDirectory => ({
      getEnabledToolForInvocation: async (
        requestedTenantKey,
        requestedServerKey,
        requestedToolKey,
        requestedProjectKey = defaultProjectKey,
      ) => {
        const scopedManifest = manifests.get(requestedProjectKey);
        const tool = scopedManifest?.tools.find(
          (candidate) => candidate.toolKey === requestedToolKey,
        );
        return requestedTenantKey === tenantKey &&
          requestedServerKey === serverKey &&
          scopedManifest &&
          tool
          ? { manifest: scopedManifest, tool }
          : null;
      },
    });
    const serviceA = new McpInvocationApplicationService({
      repository,
      schemaStore,
      toolDirectory: directory(projectKey),
      projectKey,
      clock: () => new Date(now.getTime()),
    });
    const serviceB = new McpInvocationApplicationService({
      repository,
      schemaStore,
      toolDirectory: directory(projectB),
      projectKey: projectB,
      clock: () => new Date(now.getTime()),
    });
    await serviceB.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    const enqueued: Array<{ projectKey: string; invocationKey: string }> = [];

    await expect(
      serviceA.flushQueuedToWorkers(tenantKey, {
        enqueueMcpInvocation: async (dispatch) => {
          enqueued.push({
            projectKey: dispatch.projectKey,
            invocationKey: dispatch.invocationKey,
          });
        },
        cancelPendingMcpInvocation: async () => {
          throw new Error("合法跨项目调用不应被取消");
        },
        isMcpInvocationCompleted: async () => false,
      }),
    ).resolves.toBe(1);
    expect(enqueued).toEqual([
      expect.objectContaining({ projectKey: projectB }),
    ]);
    expect((await repository.list(tenantKey, projectB))[0]?.status).toBe(
      "queued",
    );
  });

  it("只在设备最终领取时再次验证精确绑定，并用同一租约完成调用", async () => {
    const { service, repository } = await createService();
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now.getTime()),
    });
    const connection = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "a".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });

    await expect(
      service.flushQueuedToWorkers(tenantKey, workers),
    ).resolves.toBe(1);
    const assignment = (await workers.poll(connection)).assignment!;
    expect(assignment).toMatchObject({
      workKind: "mcp_invocation",
      invocationKey: expect.any(String),
    });
    await expect(
      service.leaseForExecution(tenantKey, assignment),
    ).resolves.toEqual({
      connectionBindingKey: manifest.connectionBindingKey,
      serviceName: "代码仓库助手",
      toolName: "读取项目结构",
      technicalName: "repository.read_structure",
      transport: "stdio",
      effect: "read",
      serverRevision: manifest.revision,
      manifestHashAlgorithm: "sha256",
      manifestHash: McpHealthAuthority.manifestHash(manifest),
      inputSchemaHashAlgorithm: "sha256",
      inputSchemaHash: schemaHash,
      argumentsHashAlgorithm: "sha256",
      argumentsHash: canonicalizeMcpArguments({ target: "src" }).hash,
      arguments: { target: "src" },
    });
    const command = {
      schemaVersion: 1 as const,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
    };
    await service.completeExecution(tenantKey, assignment, {
      outcome: "succeeded",
      summary: "项目结构读取完成",
    });
    await expect(
      service.flushQueuedToWorkers(tenantKey, workers),
    ).resolves.toBe(0);
    expect((await repository.list(tenantKey, projectKey))[0]?.status).toBe(
      "completion_pending",
    );
    await expect(
      workers.getMcpLease(connection, command),
    ).resolves.toMatchObject({ assignmentKey: assignment.assignmentKey });
    const completed = await workers.completeMcp(connection, command);
    await service.finalizeExecutionResult(tenantKey, completed.completion);
    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        status: "succeeded",
        executionLease: expect.objectContaining({
          assignmentKey: command.assignmentKey,
          fencingToken: command.fencingToken,
          workerKey: assignment.workerKey,
          workerGeneration: assignment.generation,
        }),
        result: expect.objectContaining({
          outcome: "succeeded",
          summary: "项目结构读取完成",
        }),
      }),
    ]);
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        action: "completed",
        workerKey: assignment.workerKey,
        assignmentKey: assignment.assignmentKey,
        argumentsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        action: "leased",
        workerKey: assignment.workerKey,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      }),
    ]);
  });

  it("租约过期后可由更高 fencing 的设备重新领取，旧设备结果会被拒绝", async () => {
    let current = new Date(now.getTime());
    const { service, repository } = await createService(
      () => new Date(current.getTime()),
    );
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(current.getTime()),
      leaseDurationMs: 1_000,
    });
    const first = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "c".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    const second = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 2",
        accountName: "Codex 账户 2",
        accountFingerprint: "d".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    await service.flushQueuedToWorkers(tenantKey, workers);
    const oldAssignment = (await workers.poll(first)).assignment!;
    await service.leaseForExecution(tenantKey, oldAssignment);

    current = new Date(now.getTime() + 2_000);
    const newAssignment = (await workers.poll(second)).assignment!;
    expect(newAssignment.fencingToken).toBeGreaterThan(
      oldAssignment.fencingToken,
    );
    await expect(
      service.leaseForExecution(tenantKey, newAssignment),
    ).resolves.toMatchObject({ technicalName: readTool.technicalName });
    await expect(
      service.completeExecution(tenantKey, oldAssignment, {
        outcome: "succeeded",
        summary: "旧设备迟到结果",
      }),
    ).rejects.toMatchObject({ code: "mcp_invocation_state_conflict" });
    expect((await repository.list(tenantKey, projectKey))[0]).toMatchObject({
      status: "leased",
      executionLease: {
        assignmentKey: newAssignment.assignmentKey,
        fencingToken: newAssignment.fencingToken,
        workerKey: newAssignment.workerKey,
        workerGeneration: newAssignment.generation,
        leasedUntil: newAssignment.leasedUntil,
      },
    });
  });

  it("只读重派在最终校验期间再次过期后会回到队列并可继续领取", async () => {
    let current = new Date(now.getTime());
    const { service, repository, schemaStore, toolDirectory } =
      await createService(() => new Date(current.getTime()));
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(current.getTime()),
      leaseDurationMs: 1_000,
    });
    const connect = async (name: string, fingerprint: string) =>
      (
        await workers.connect(administrator, {
          schemaVersion: 1,
          deviceName: name,
          accountName: name,
          accountFingerprint: fingerprint.repeat(64),
          capabilities: [manifest.connectionBindingKey],
        })
      ).connection;
    const first = await connect("研发电脑 1", "3");
    const second = await connect("研发电脑 2", "4");
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    await service.flushQueuedToWorkers(tenantKey, workers);
    const oldAssignment = (await workers.poll(first)).assignment!;
    await service.leaseForExecution(tenantKey, oldAssignment);

    current = new Date(now.getTime() + 2_000);
    const replacement = (await workers.poll(second)).assignment!;
    const delayedValidation = new McpInvocationApplicationService({
      repository,
      toolDirectory,
      projectKey,
      clock: () => new Date(current.getTime()),
      schemaStore: {
        put: schemaStore.put.bind(schemaStore),
        get: async (reference) => {
          current = new Date(current.getTime() + 2_000);
          return schemaStore.get(reference);
        },
      },
    });
    await expect(
      delayedValidation.leaseForExecution(tenantKey, replacement),
    ).rejects.toMatchObject({ code: "expired_lease" });
    expect((await repository.list(tenantKey, projectKey))[0]?.status).toBe(
      "queued",
    );
    await workers.cancelMcpLease(second, {
      schemaVersion: 1,
      assignmentKey: replacement.assignmentKey,
      fencingToken: replacement.fencingToken,
    });
    await expect(
      service.flushQueuedToWorkers(tenantKey, workers),
    ).resolves.toBe(1);
    const retried = (await workers.poll(second)).assignment!;
    expect(retried.fencingToken).toBeGreaterThan(replacement.fencingToken);
  });

  it("同一设备在活跃只读租约期间重连后可接续执行，旧会话结果被 fencing 拒绝", async () => {
    const { service } = await createService();
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now.getTime()),
    });
    const registration = {
      schemaVersion: 1 as const,
      deviceName: "研发电脑 1",
      accountName: "Codex 账户 1",
      accountFingerprint: "e".repeat(64),
      capabilities: [manifest.connectionBindingKey],
    };
    const oldConnection = (await workers.connect(administrator, registration))
      .connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    await service.flushQueuedToWorkers(tenantKey, workers);
    const oldAssignment = (await workers.poll(oldConnection)).assignment!;
    await service.leaseForExecution(tenantKey, oldAssignment);

    const newConnection = (await workers.connect(administrator, registration))
      .connection;
    const newAssignment = (await workers.poll(newConnection)).assignment!;
    expect(newAssignment.generation).toBeGreaterThan(oldAssignment.generation);
    expect(newAssignment.fencingToken).toBeGreaterThan(
      oldAssignment.fencingToken,
    );
    await expect(
      service.leaseForExecution(tenantKey, newAssignment),
    ).resolves.toMatchObject({ technicalName: readTool.technicalName });
    await expect(
      service.completeExecution(tenantKey, oldAssignment, {
        outcome: "succeeded",
        summary: "旧会话迟到结果",
      }),
    ).rejects.toMatchObject({ code: "mcp_invocation_state_conflict" });
  });

  it("写入调用的租约失效后进入结果待核对，不会自动重复外部副作用", async () => {
    let current = new Date(now.getTime());
    const { service, repository } = await createService(
      () => new Date(current.getTime()),
    );
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(current.getTime()),
      leaseDurationMs: 1_000,
    });
    const first = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "f".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    const second = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 2",
        accountName: "Codex 账户 2",
        accountFingerprint: "1".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: writeToolKey,
      arguments: { target: "production" },
    });
    const [created] = await repository.list(tenantKey, projectKey);
    await service.approve(productOwner, created!.invocationKey);
    await service.flushQueuedToWorkers(tenantKey, workers);
    const oldAssignment = (await workers.poll(first)).assignment!;
    await service.leaseForExecution(tenantKey, oldAssignment);

    current = new Date(now.getTime() + 2_000);
    const replacement = (await workers.poll(second)).assignment!;
    await expect(
      service.leaseForExecution(tenantKey, replacement),
    ).rejects.toMatchObject({ code: "mcp_outcome_unknown" });
    await workers.cancelMcpLease(second, {
      schemaVersion: 1,
      assignmentKey: replacement.assignmentKey,
      fencingToken: replacement.fencingToken,
    });
    await service.finalizeOutcomeUnknownCleanup(
      tenantKey,
      projectKey,
      replacement.invocationKey!,
    );
    expect((await repository.list(tenantKey, projectKey))[0]).toMatchObject({
      status: "outcome_unknown",
    });
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "outcome_unknown",
          assignmentKey: oldAssignment.assignmentKey,
        }),
      ]),
    );
  });

  it("设备持久意图无法确认结果时可主动进入结果待核对并幂等清理租约", async () => {
    const { service, repository } = await createService();
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now.getTime()),
    });
    const connection = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "f".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: writeToolKey,
      arguments: { target: "production" },
    });
    const [created] = await repository.list(tenantKey, projectKey);
    await service.approve(productOwner, created!.invocationKey);
    await service.flushQueuedToWorkers(tenantKey, workers);
    const assignment = (await workers.poll(connection)).assignment!;
    await service.leaseForExecution(tenantKey, assignment);

    const report = {
      projectKey,
      invocationKey: created!.invocationKey,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      workerKey: connection.workerKey,
      workerGeneration: connection.generation,
    };
    await expect(
      service.reportExecutionOutcomeUnknown(tenantKey, report),
    ).resolves.toBe("pending_cleanup");
    await expect(
      service.reportExecutionOutcomeUnknown(tenantKey, report),
    ).resolves.toBe("pending_cleanup");
    await workers.cancelMcpLease(connection, {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
    });
    await service.finalizeOutcomeUnknownCleanup(
      tenantKey,
      projectKey,
      created!.invocationKey,
    );
    expect((await repository.list(tenantKey, projectKey))[0]).toMatchObject({
      status: "outcome_unknown",
    });
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "outcome_unknown",
          assignmentKey: assignment.assignmentKey,
        }),
      ]),
    );
  });

  it("Worker 续租已提交但调用侧同步失败后，先补偿或先重试都会保持失败关闭", async () => {
    const prepare = async () => {
      let current = new Date(now.getTime());
      const prepared = await createService(() => new Date(current.getTime()));
      const workers = new WorkerFleetService({
        repository: new InMemoryWorkerFleetRepository(),
        clock: () => new Date(current.getTime()),
        leaseDurationMs: 1_000,
      });
      const connection = (
        await workers.connect(administrator, {
          schemaVersion: 1,
          deviceName: "研发电脑 1",
          accountName: "Codex 账户 1",
          accountFingerprint: "5".repeat(64),
          capabilities: [manifest.connectionBindingKey],
        })
      ).connection;
      await prepared.service.request(developer, {
        schemaVersion: 1,
        requestKey: randomUUID(),
        serverKey,
        toolKey: writeToolKey,
        arguments: { target: "production" },
      });
      const [created] = await prepared.repository.list(tenantKey, projectKey);
      await prepared.service.approve(productOwner, created!.invocationKey);
      await prepared.service.flushQueuedToWorkers(tenantKey, workers);
      const assignment = (await workers.poll(connection)).assignment!;
      await prepared.service.leaseForExecution(tenantKey, assignment);
      current = new Date(now.getTime() + 900);
      const command = {
        schemaVersion: 1 as const,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      };
      await workers.renew(connection, command);
      current = new Date(now.getTime() + 1_100);
      return {
        ...prepared,
        workers,
        connection,
        command,
        currentLease: () => workers.getCurrentLease(connection, command),
      };
    };

    const pollFirst = await prepare();
    await expect(
      pollFirst.service.flushQueuedToWorkers(tenantKey, pollFirst.workers),
    ).resolves.toBe(0);
    expect(
      (await pollFirst.repository.list(tenantKey, projectKey))[0]?.status,
    ).toBe("outcome_unknown");

    const renewFirst = await prepare();
    await renewFirst.workers.renew(renewFirst.connection, renewFirst.command);
    const currentLease = await renewFirst.currentLease();
    await expect(
      renewFirst.service.renewExecutionLease(tenantKey, currentLease),
    ).rejects.toMatchObject({ code: "mcp_outcome_unknown" });
    await renewFirst.workers.cancelMcpLease(
      renewFirst.connection,
      renewFirst.command,
    );
    await renewFirst.service.finalizeOutcomeUnknownCleanup(
      tenantKey,
      projectKey,
      currentLease.invocationKey!,
    );
    expect(
      (await renewFirst.repository.list(tenantKey, projectKey))[0]?.status,
    ).toBe("outcome_unknown");
  });

  it("设备结果已持久化后可由补偿扫描直接收敛，不依赖短期完成墓碑", async () => {
    const { service, repository } = await createService();
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now.getTime()),
    });
    const connection = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "2".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    await service.flushQueuedToWorkers(tenantKey, workers);
    const assignment = (await workers.poll(connection)).assignment!;
    await service.leaseForExecution(tenantKey, assignment);
    await service.completeExecution(tenantKey, assignment, {
      outcome: "succeeded",
      summary: "结果已安全写入调用记录",
    });
    await workers.completeMcp(connection, {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
    });

    await expect(
      service.flushQueuedToWorkers(tenantKey, workers),
    ).resolves.toBe(0);
    expect((await repository.list(tenantKey, projectKey))[0]).toMatchObject({
      status: "succeeded",
      result: expect.objectContaining({ outcome: "succeeded" }),
    });
    await expect(workers.poll(connection)).resolves.toEqual({
      assignment: null,
    });
  });

  it("一百条待收敛结果会在本轮完成，下一轮仍能派发普通等待调用", async () => {
    const { service, repository } = await createService();
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    const [queued] = await repository.list(tenantKey, projectKey);
    await repository.transaction(tenantKey, projectKey, (transaction) => {
      for (let index = 0; index < 100; index += 1) {
        transaction.save({
          ...queued!,
          invocationKey: randomUUID(),
          requestKey: randomUUID(),
          requestedAt: new Date(now.getTime() - 200 + index).toISOString(),
          status: "completion_pending",
          executionLease: {
            assignmentKey: randomUUID(),
            fencingToken: index + 1,
            workerKey: randomUUID(),
            workerGeneration: 1,
            workerFingerprintHash: "a".repeat(64),
            leasedUntil: new Date(now.getTime() + 60_000).toISOString(),
          },
          result: {
            outcome: "succeeded",
            summary: "设备结果已写入",
            completedAt: now.toISOString(),
          },
        });
      }
    });
    let queuedDispatches = 0;
    const dispatcher = {
      enqueueMcpInvocation: async () => {
        queuedDispatches += 1;
      },
      cancelPendingMcpInvocation: async () => undefined,
      isMcpInvocationCompleted: async () => true,
    };

    await expect(
      service.flushQueuedToWorkers(tenantKey, dispatcher),
    ).resolves.toBe(0);
    await expect(
      service.flushQueuedToWorkers(tenantKey, dispatcher),
    ).resolves.toBe(1);
    expect(queuedDispatches).toBe(1);
  });

  it("派发后并发取消且队列清理失败时会保留可重试清理状态", async () => {
    const { service, repository } = await createService();
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    let cleanupAttempts = 0;
    const dispatcher = {
      enqueueMcpInvocation: async (dispatch: {
        tenantKey: string;
        projectKey: string;
        invocationKey: string;
      }) => {
        await repository.transaction(
          dispatch.tenantKey,
          dispatch.projectKey,
          async (transaction) => {
            const record = await transaction.find(dispatch.invocationKey);
            transaction.save({
              ...record!,
              status: "cancellation_pending",
              executionLease: null,
              result: null,
            });
          },
        );
        await service.finalizeCancellation(
          dispatch.tenantKey,
          dispatch.projectKey,
          dispatch.invocationKey,
        );
      },
      cancelPendingMcpInvocation: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("模拟队列暂时不可用");
      },
      isMcpInvocationCompleted: async () => false,
    };

    await expect(
      service.flushQueuedToWorkers(tenantKey, dispatcher),
    ).rejects.toThrow("模拟队列暂时不可用");
    expect((await repository.list(tenantKey, projectKey))[0]?.status).toBe(
      "cancellation_pending",
    );
    await expect(
      service.flushQueuedToWorkers(tenantKey, dispatcher),
    ).resolves.toBe(0);
    expect(cleanupAttempts).toBe(2);
    expect((await repository.list(tenantKey, projectKey))[0]?.status).toBe(
      "cancelled",
    );
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({ action: "cancelled" }),
    ]);
  });

  it("最终领取前能力失效会持久进入可恢复取消流程并释放设备租约", async () => {
    const { service, repository, toolDirectory } = await createService();
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now.getTime()),
    });
    const connection = (
      await workers.connect(administrator, {
        schemaVersion: 1,
        deviceName: "研发电脑 1",
        accountName: "Codex 账户 1",
        accountFingerprint: "b".repeat(64),
        capabilities: [manifest.connectionBindingKey],
      })
    ).connection;
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: readToolKey,
      arguments: { target: "src" },
    });
    await service.flushQueuedToWorkers(tenantKey, workers);
    const assignment = (await workers.poll(connection)).assignment!;
    toolDirectory.enabled = false;

    await expect(
      service.leaseForExecution(tenantKey, assignment),
    ).rejects.toMatchObject({ code: "mcp_invocation_stale" });
    expect((await repository.list(tenantKey, projectKey))[0]?.status).toBe(
      "cancellation_pending",
    );
    await workers.cancelMcpLease(connection, {
      schemaVersion: 1,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
    });
    await service.finalizeCancellation(
      tenantKey,
      projectKey,
      assignment.invocationKey!,
    );
    expect((await repository.list(tenantKey, projectKey))[0]?.status).toBe(
      "cancelled",
    );
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        action: "cancelled",
        invocationKey: assignment.invocationKey,
      }),
    ]);
    await expect(workers.poll(connection)).resolves.toEqual({
      assignment: null,
    });
  });

  it("持久化边界拒绝参数摘要不一致和无需审批的写入调用", async () => {
    const { service, repository } = await createService();
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: writeToolKey,
      arguments: { target: "feature/payment" },
    });
    const [record] = await repository.list(tenantKey, projectKey);
    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.save({ ...record!, arguments: { target: "production" } }),
      ),
    ).rejects.toThrow("调用参数与审计摘要不一致");
    await expect(
      repository.transaction(tenantKey, projectKey, (transaction) =>
        transaction.save({ ...record!, approvalMode: "automatic" }),
      ),
    ).rejects.toThrow("写入或外部动作必须经过人工确认");
  });

  it("持久化展示名称被篡改后不能通过可信能力复核", async () => {
    const { service, repository } = await createService();
    await service.request(developer, {
      schemaVersion: 1,
      requestKey: randomUUID(),
      serverKey,
      toolKey: writeToolKey,
      arguments: { target: "feature/payment" },
    });
    const [record] = await repository.list(tenantKey, projectKey);
    await repository.transaction(tenantKey, projectKey, (transaction) =>
      transaction.save({
        ...record!,
        serverName: "安全服务",
        toolDisplayName: "无风险操作",
      }),
    );

    await expect(
      service.approve(productOwner, record!.invocationKey),
    ).rejects.toMatchObject({ code: "mcp_invocation_stale" });
  });
});
