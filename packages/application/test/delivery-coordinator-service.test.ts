import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  WORKER_REQUIREMENT_COMPLETION_SUMMARY,
  type RequirementSpec,
} from "@forgex/contracts";
import { SkillPackageCodec } from "@forgex/extensions";

import {
  DeliveryCoordinatorService,
  InMemoryRequirementRepository,
  InMemoryWorkerFleetRepository,
  RequirementApplicationService,
  WorkerFleetService,
  requirementCompletionDigest,
  type AuthenticatedPrincipal,
  type RequirementRepository,
  type RequirementTransaction,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const repositoryKey = "44444444-4444-4444-8444-444444444444";
const principal: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner", "administrator"],
};
const spec: RequirementSpec = {
  schemaVersion: 1,
  title: "访客预约",
  goal: "让访客到访过程更顺畅",
  userStories: [],
  acceptanceCriteria: [
    {
      title: "访客可以提交预约",
      description: "填写完整信息后能够提交",
      priority: "must",
    },
  ],
  openQuestions: [],
};

class FailFirstDispatchMarkRepository implements RequirementRepository {
  readonly #inner = new InMemoryRequirementRepository();
  #shouldFailMark = true;

  transaction<T>(
    scopedTenantKey: string,
    scopedProjectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    return this.#inner.transaction(
      scopedTenantKey,
      scopedProjectKey,
      (transaction) =>
        operation({
          ...transaction,
          markDeliveryDispatched: (dispatchKey, dispatchedAt) => {
            if (this.#shouldFailMark) {
              this.#shouldFailMark = false;
              throw new Error("模拟派发标记落库失败");
            }
            return transaction.markDeliveryDispatched(
              dispatchKey,
              dispatchedAt,
            );
          },
        }),
    );
  }

  listForPeople = this.#inner.listForPeople.bind(this.#inner);
  listAuditEvents = this.#inner.listAuditEvents.bind(this.#inner);
  listPendingDeliveryDispatches =
    this.#inner.listPendingDeliveryDispatches.bind(this.#inner);
  listPendingDeliveryRunResults =
    this.#inner.listPendingDeliveryRunResults.bind(this.#inner);
  findDeliveryRunResultByProof = this.#inner.findDeliveryRunResultByProof.bind(
    this.#inner,
  );
  listDeliveryRunsAwaitingVerification =
    this.#inner.listDeliveryRunsAwaitingVerification.bind(this.#inner);
}

describe("DeliveryCoordinatorService", () => {
  it("无交付权限的身份在读取任何 Skill 制品前被拒绝", async () => {
    const getActiveForExecution = vi.fn();
    const requirementRepository = new InMemoryRequirementRepository();
    const coordinator = new DeliveryCoordinatorService({
      requirements: new RequirementApplicationService({
        repository: requirementRepository,
        projectKey,
        repositoryKey,
      }),
      requirementRepository,
      workers: new WorkerFleetService({
        repository: new InMemoryWorkerFleetRepository(),
      }),
      projectKey,
      skillDirectory: {
        getActiveForExecution,
        getVersionForExecution: vi.fn(),
      },
    });
    const developer: AuthenticatedPrincipal = {
      ...principal,
      roles: ["developer"],
    };

    await expect(
      coordinator.requestDelivery(developer, randomUUID(), {
        schemaVersion: 1,
        requiredCapabilities: [],
        skillKeys: Array.from({ length: 10 }, () => randomUUID()),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "permission_denied" });
    expect(getActiveForExecution).not.toHaveBeenCalled();
  });

  it("把本次交付选择的已激活团队能力绑定进设备执行信封", async () => {
    const skillKey = "55555555-5555-4555-8555-555555555555";
    const bytes = SkillPackageCodec.encode({
      schemaVersion: 1,
      instructions:
        "# 团队代码审查规范\n\n修改前先确认边界，完成后检查错误处理与可维护性。",
      resources: [
        {
          path: "references/review-policy.md",
          mediaType: "text/markdown",
          encoding: "utf8",
          content: "# 审查政策\n\n所有外部输入都必须在边界处完成校验。",
        },
      ],
    });
    const nextBytes = SkillPackageCodec.encode({
      schemaVersion: 1,
      instructions:
        "# 下一版团队规范\n\n这一版在交付排队后才激活，不能静默替换已经确认的能力。",
      resources: [],
    });
    const manifest = {
      schemaVersion: 1 as const,
      skillKey,
      tenantKey,
      projectKey,
      version: "1.0.0",
      name: "团队代码审查规范",
      summary: "在交付过程中应用团队代码审查规范",
      artifactHashAlgorithm: "sha256" as const,
      artifactHash: createHash("sha256").update(bytes).digest("hex"),
      artifactSizeBytes: bytes.byteLength,
      entrypoint: "SKILL.md" as const,
      compatibleBlueprints: ["Web 应用"],
      requiredCapabilities: ["读取项目文件"],
      permissions: {
        workspace: "read_only" as const,
        network: "none" as const,
        commands: "none" as const,
      },
      createdAt: "2026-08-10T04:00:00.000Z",
    };
    const nextManifest = {
      ...manifest,
      version: "2.0.0",
      artifactHash: createHash("sha256").update(nextBytes).digest("hex"),
      artifactSizeBytes: nextBytes.byteLength,
      createdAt: "2026-08-10T05:00:00.000Z",
    };
    let active = { manifest, bytes };
    const requirementRepository = new InMemoryRequirementRepository();
    const requirements = new RequirementApplicationService({
      repository: requirementRepository,
      projectKey,
      repositoryKey,
    });
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
    });
    const coordinator = new DeliveryCoordinatorService({
      requirements,
      requirementRepository,
      workers,
      projectKey,
      skillDirectory: {
        getActiveForExecution: async (
          _tenant,
          selectedProjectKey,
          selectedSkillKey,
        ) =>
          selectedProjectKey === projectKey && selectedSkillKey === skillKey
            ? active
            : null,
        getVersionForExecution: async (
          _tenant,
          selectedProjectKey,
          selectedSkillKey,
          version,
        ) =>
          selectedProjectKey === projectKey &&
          selectedSkillKey === skillKey &&
          version === manifest.version
            ? { manifest, bytes }
            : null,
      },
    });
    const connection = (
      await workers.connect(principal, {
        schemaVersion: 1,
        deviceName: "研发电脑",
        accountName: "Codex 账户",
        accountFingerprint: "c".repeat(64),
        capabilities: [],
      })
    ).connection;
    const created = await requirements.create(principal, spec);
    await requirements.submitForConfirmation(principal, created.requirementKey);
    await requirements.confirm(principal, created.requirementKey);
    await coordinator.requestDelivery(principal, created.requirementKey, {
      schemaVersion: 1,
      requiredCapabilities: [],
      skillKeys: [skillKey],
    });
    active = { manifest: nextManifest, bytes: nextBytes };
    const assignment = (await workers.poll(connection)).assignment!;

    await expect(
      coordinator.executionForWorker(tenantKey, {
        workKind: "requirement_delivery",
        projectKey,
        requirementKey: created.requirementKey,
        requirementRevision: 1,
        title: spec.title,
      }),
    ).resolves.toMatchObject({
      skills: [
        {
          skillKey,
          version: "1.0.0",
          name: "团队代码审查规范",
          artifactHashAlgorithm: "sha256",
          artifactHash: createHash("sha256").update(bytes).digest("hex"),
          instructions: expect.stringContaining("检查错误处理"),
          resources: [
            {
              path: "references/review-policy.md",
              mediaType: "text/markdown",
              content: expect.stringContaining("外部输入"),
            },
          ],
        },
      ],
    });
    expect(assignment.requirementKey).toBe(created.requirementKey);
  });

  it("派发后标记失败时由 outbox 重试，且同一版本只进入队列一次", async () => {
    const requirementRepository = new FailFirstDispatchMarkRepository();
    const requirements = new RequirementApplicationService({
      repository: requirementRepository,
      projectKey,
      repositoryKey,
    });
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
    });
    const coordinator = new DeliveryCoordinatorService({
      requirements,
      requirementRepository,
      workers,
      projectKey,
    });
    const connection = (
      await workers.connect(principal, {
        schemaVersion: 1,
        deviceName: "研发电脑",
        accountName: "Codex 账户",
        accountFingerprint: "a".repeat(64),
        capabilities: ["typescript"],
      })
    ).connection;
    const created = await requirements.create(principal, spec);
    await requirements.submitForConfirmation(principal, created.requirementKey);
    await requirements.confirm(principal, created.requirementKey);

    await expect(
      coordinator.requestDelivery(principal, created.requirementKey, {
        schemaVersion: 1,
        requiredCapabilities: ["typescript"],
      }),
    ).rejects.toThrow("模拟派发标记落库失败");
    await expect(coordinator.flushPending(tenantKey)).resolves.toBe(1);
    await expect(coordinator.flushPending(tenantKey)).resolves.toBe(0);

    const first = (await workers.poll(connection)).assignment;
    const repeated = (await workers.poll(connection)).assignment;
    expect(first).toMatchObject({
      projectKey,
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      title: spec.title,
    });
    expect(repeated).toEqual(first);
    await expect(
      coordinator.executionForWorker(tenantKey, {
        workKind: "requirement_delivery",
        projectKey: first!.projectKey,
        requirementKey: first!.requirementKey,
        requirementRevision: first!.requirementRevision,
        title: first!.title,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      taskType: "requirement_delivery",
      projectKey,
      repositoryKey,
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      spec,
      executionPolicy: {
        workspaceIsolation: "dedicated_worktree",
        productionAccess: "denied",
        credentialHandling: "device_local_only",
        completionEvidence: "independent_runner_required",
      },
    });
    const audit = await requirementRepository.listAuditEvents(
      tenantKey,
      projectKey,
    );
    expect(
      audit.filter((event) => event.action === "delivery.dispatched"),
    ).toHaveLength(1);
  });

  it("设备执行信封拒绝错项目、错版本和调用方伪造的标题", async () => {
    const requirementRepository = new InMemoryRequirementRepository();
    const requirements = new RequirementApplicationService({
      repository: requirementRepository,
      projectKey,
      repositoryKey,
    });
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
    });
    const coordinator = new DeliveryCoordinatorService({
      requirements,
      requirementRepository,
      workers,
      projectKey,
    });
    const created = await requirements.create(principal, spec);
    await requirements.submitForConfirmation(principal, created.requirementKey);
    await requirements.confirm(principal, created.requirementKey);
    await coordinator.requestDelivery(principal, created.requirementKey, {
      schemaVersion: 1,
      requiredCapabilities: [],
    });

    await expect(
      coordinator.executionForWorker(tenantKey, {
        workKind: "requirement_delivery",
        projectKey,
        requirementKey: created.requirementKey,
        requirementRevision: 2,
        title: "调用方伪造标题",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "delivery_assignment_stale",
    });
  });

  it("交付提交只在永久设备完成证明存在后收敛，并且重复上报不重复审计", async () => {
    let now = new Date("2026-08-10T06:00:00.000Z");
    const requirementRepository = new InMemoryRequirementRepository();
    const requirements = new RequirementApplicationService({
      repository: requirementRepository,
      projectKey,
      repositoryKey,
      clock: () => new Date(now),
    });
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
      clock: () => new Date(now),
    });
    const coordinator = new DeliveryCoordinatorService({
      requirements,
      requirementRepository,
      workers,
      projectKey,
      clock: () => new Date(now),
    });
    const connection = (
      await workers.connect(principal, {
        schemaVersion: 1,
        deviceName: "研发电脑",
        accountName: "Codex 账号",
        accountFingerprint: "b".repeat(64),
        capabilities: [],
      })
    ).connection;
    const created = await requirements.create(principal, spec);
    await requirements.submitForConfirmation(principal, created.requirementKey);
    await requirements.confirm(principal, created.requirementKey);
    await coordinator.requestDelivery(principal, created.requirementKey, {
      schemaVersion: 1,
      requiredCapabilities: [],
    });
    const assignment = (await workers.poll(connection)).assignment!;
    const completion = {
      schemaVersion: 1 as const,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      projectKey,
      repositoryKey,
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      gitHashAlgorithm: "sha1" as const,
      baseCommit: "a".repeat(40),
      commitSha: "b".repeat(40),
      branchName: `forgex/${projectKey.slice(0, 8)}/${assignment.assignmentKey}`,
      summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
    };
    const resultBinding = {
      workKind: "requirement_delivery" as const,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      projectKey,
      requirementKey: created.requirementKey,
      requirementRevision: 1,
    };
    const run = await coordinator.submitExecutionResult(
      tenantKey,
      resultBinding,
      completion,
    );
    await expect(coordinator.finalizeExecutionResult(run)).resolves.toBe(false);

    now = new Date("2026-08-10T06:00:10.000Z");
    await workers.complete(
      connection,
      {
        schemaVersion: 1,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      },
      requirementCompletionDigest(completion),
    );
    await expect(coordinator.flushCompleted(tenantKey)).resolves.toBe(1);
    await expect(coordinator.flushCompleted(tenantKey)).resolves.toBe(0);
    await expect(
      coordinator.submitExecutionResult(tenantKey, resultBinding, completion),
    ).resolves.toMatchObject({ status: "completed" });
    const persisted = await requirementRepository.findDeliveryRunResultByProof(
      tenantKey,
      {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      },
    );
    expect(persisted).toMatchObject({
      repositoryKey,
      baseCommit: "a".repeat(40),
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

    await expect(
      coordinator.submitExecutionResult(tenantKey, resultBinding, {
        ...completion,
        repositoryKey: projectKey,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "delivery_completion_stale",
    });
  });
});
