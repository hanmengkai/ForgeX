import { createHash, randomUUID } from "node:crypto";

import {
  RequirementExecutionEnvelopeSchema,
  StartDeliveryCommandSchema,
  WorkerRequirementCompletionSchema,
  type RequirementExecutionEnvelope,
  type StartDeliveryCommandPayload,
  type WorkerRequirementCompletionPayload,
} from "@forgex/contracts";
import {
  SkillPackageCodec,
  type SkillPackageManifest,
} from "@forgex/extensions";

import type { AuthenticatedPrincipal } from "./auth.js";
import { containsLikelyPlaintextCredential } from "./credential-safety.js";
import { requirementCompletionDigest } from "./delivery-completion.js";
import { ApplicationError } from "./errors.js";
import { canPerformRequirementAction } from "./requirement-authorization.js";
import type {
  DeliveryDispatchRecord,
  DeliveryRunResult,
  DeliverySkillBinding,
  RequirementRepository,
} from "./requirement-repository.js";
import type { RequirementApplicationService } from "./requirement-service.js";
import type { WorkerFleetService } from "./worker-fleet-service.js";

export interface DeliveryCoordinatorServiceOptions {
  requirements: RequirementApplicationService;
  requirementRepository: RequirementRepository;
  workers: WorkerFleetService;
  projectKey: string;
  skillDirectory?: DeliverySkillDirectory;
  clock?: () => Date;
}

export interface DeliverySkillDirectory {
  getActiveForExecution(
    tenantKey: string,
    projectKey: string,
    skillKey: string,
  ): Promise<{ manifest: SkillPackageManifest; bytes: Uint8Array } | null>;
  getVersionForExecution(
    tenantKey: string,
    projectKey: string,
    skillKey: string,
    version: string,
  ): Promise<{ manifest: SkillPackageManifest; bytes: Uint8Array } | null>;
}

const deliveryResourceMediaTypes = new Set([
  "text/markdown",
  "text/plain",
  "application/json",
]);

const deliveryResourceContent = (resource: {
  encoding: "utf8" | "base64";
  content: string;
}): string => {
  if (resource.encoding === "utf8") return resource.content;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(resource.content, "base64"),
    );
  } catch {
    throw new ApplicationError(
      409,
      "delivery_skill_resource_unsupported",
      "本次交付绑定的团队能力包含无法安全读取的资源",
    );
  }
};

export class DeliveryCoordinatorService {
  readonly #requirements: RequirementApplicationService;
  readonly #requirementRepository: RequirementRepository;
  readonly #workers: WorkerFleetService;
  readonly #projectKey: string;
  readonly #skillDirectory: DeliverySkillDirectory | null;
  readonly #clock: () => Date;

  constructor(options: DeliveryCoordinatorServiceOptions) {
    this.#requirements = options.requirements;
    this.#requirementRepository = options.requirementRepository;
    this.#workers = options.workers;
    this.#projectKey = options.projectKey.toLowerCase();
    this.#skillDirectory = options.skillDirectory ?? null;
    this.#clock = options.clock ?? (() => new Date());
  }

  async requestDelivery(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    command: StartDeliveryCommandPayload,
    scope?: {
      projectKey: string;
      requirements: RequirementApplicationService;
    },
  ): Promise<{
    title: string;
    requirementRevision: number;
    status: "等待空闲设备" | "已经完成";
  }> {
    if (!canPerformRequirementAction(principal, "startDelivery")) {
      throw new ApplicationError(
        403,
        "permission_denied",
        "当前账号没有执行此操作的权限",
      );
    }
    const parsedCommand = StartDeliveryCommandSchema.safeParse(command);
    if (!parsedCommand.success) {
      throw new ApplicationError(
        422,
        "invalid_delivery_command",
        "交付安排需要调整",
      );
    }
    const projectKey = scope?.projectKey.toLowerCase() ?? this.#projectKey;
    const requirementService = scope?.requirements ?? this.#requirements;
    const skills = await this.#resolveSkills(
      principal.tenantKey,
      projectKey,
      parsedCommand.data.skillKeys ?? [],
    );
    const dispatch = await requirementService.requestDelivery(
      principal,
      requirementKey,
      parsedCommand.data,
      skills.map(
        ({ skillKey, version, artifactHashAlgorithm, artifactHash }) => ({
          skillKey,
          version,
          artifactHashAlgorithm,
          artifactHash,
        }),
      ),
    );
    let result: Awaited<ReturnType<WorkerFleetService["enqueueDispatch"]>>;
    try {
      result = await this.#workers.enqueueDispatch(dispatch);
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "queue_full") {
        throw error;
      }
      return {
        title: dispatch.title,
        requirementRevision: dispatch.requirementRevision,
        status: "等待空闲设备",
      };
    }
    await this.#markDispatched(dispatch);
    return {
      title: result.title,
      requirementRevision: dispatch.requirementRevision,
      status: result.status,
    };
  }

  async terminateDelivery(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    scope?: {
      projectKey: string;
      requirements: RequirementApplicationService;
    },
  ) {
    const requirementService = scope?.requirements ?? this.#requirements;
    return requirementService.terminateDelivery(
      principal,
      requirementKey,
      (dispatch) => this.#workers.cancelRequirementDelivery(dispatch),
    );
  }

  async flushPending(tenantKey: string): Promise<number> {
    const pending =
      await this.#requirementRepository.listPendingDeliveryDispatches(
        tenantKey,
        null,
        100,
      );
    let dispatched = 0;
    for (const record of pending) {
      try {
        await this.#workers.enqueueDispatch(record);
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "queue_full") {
          break;
        }
        throw error;
      }
      await this.#markDispatched(record);
      dispatched += 1;
    }
    return dispatched;
  }

  async flushPendingCancellations(tenantKey: string): Promise<number> {
    let completed = 0;
    let pending: DeliveryDispatchRecord[];
    do {
      pending =
        await this.#requirementRepository.listPendingDeliveryCancellations(
          tenantKey,
          100,
        );
      for (const dispatch of pending) {
        await this.#workers.cancelRequirementDelivery(dispatch);
        await this.#requirementRepository.transaction(
          dispatch.tenantKey,
          dispatch.projectKey,
          async (transaction) => {
            await transaction.markDeliveryCancellationCompleted(
              dispatch.dispatchKey,
              this.#clock().toISOString(),
            );
          },
        );
        completed += 1;
      }
    } while (pending.length === 100);
    return completed;
  }

  async assertRequirementDeliveryActive(
    tenantKey: string,
    assignment: {
      workKind: "requirement_delivery";
      projectKey: string;
      requirementKey: string;
      requirementRevision: number;
      title: string;
    },
  ): Promise<void> {
    await this.#requireExecutionAuthority(tenantKey, assignment);
  }

  async executionForWorker(
    tenantKey: string,
    assignment: {
      workKind: "requirement_delivery";
      projectKey: string;
      requirementKey: string;
      requirementRevision: number;
      title: string;
    },
  ): Promise<RequirementExecutionEnvelope> {
    const authority = await this.#requireExecutionAuthority(
      tenantKey,
      assignment,
    );
    const skills = await this.#resolveSkills(
      tenantKey,
      assignment.projectKey,
      authority.skills,
    );
    return RequirementExecutionEnvelopeSchema.parse({
      ...authority.envelope,
      ...(skills.length > 0 ? { skills } : {}),
    });
  }

  async #requireExecutionAuthority(
    tenantKey: string,
    assignment: {
      workKind: "requirement_delivery";
      projectKey: string;
      requirementKey: string;
      requirementRevision: number;
      title: string;
    },
  ) {
    return this.#requirementRepository.transaction(
      tenantKey,
      assignment.projectKey,
      async (transaction) => {
        const record = await transaction.find(assignment.requirementKey);
        const dispatch = await transaction.findDeliveryDispatch(
          assignment.requirementKey,
          assignment.requirementRevision,
        );
        if (
          !record ||
          !dispatch ||
          record.tenantKey !== tenantKey.toLowerCase() ||
          record.projectKey !== assignment.projectKey.toLowerCase() ||
          record.requirementKey !== assignment.requirementKey.toLowerCase() ||
          record.workflow.currentRevision !== assignment.requirementRevision ||
          record.workflow.toSnapshot().status !== "inDelivery" ||
          record.spec.title !== assignment.title ||
          dispatch.title !== assignment.title ||
          dispatch.dispatchedAt === null
        ) {
          throw new ApplicationError(
            409,
            "delivery_assignment_stale",
            "这项交付已不再对应当前确认的需求版本，请等待平台重新安排",
          );
        }
        record.workflow.assertSpecIntegrity(record.spec);
        return {
          skills: dispatch.skills.map((skill) => ({ ...skill })),
          envelope: {
            schemaVersion: 1,
            taskType: "requirement_delivery",
            projectKey: record.projectKey,
            repositoryKey: dispatch.repositoryKey,
            requirementKey: record.requirementKey,
            requirementRevision: record.workflow.currentRevision,
            spec: structuredClone(record.spec),
            executionPolicy: {
              workspaceIsolation: "dedicated_worktree",
              productionAccess: "denied",
              credentialHandling: "device_local_only",
              completionEvidence: "independent_runner_required",
            },
          },
        };
      },
    );
  }

  async #resolveSkills(
    tenantKey: string,
    projectKey: string,
    selection: string[] | DeliverySkillBinding[],
  ): Promise<NonNullable<RequirementExecutionEnvelope["skills"]>> {
    if (selection.length === 0) return [];
    if (!this.#skillDirectory) {
      throw new ApplicationError(
        409,
        "delivery_skill_unavailable",
        "当前控制面没有接入可信 Skill 目录",
      );
    }
    const resolved: NonNullable<RequirementExecutionEnvelope["skills"]> = [];
    let totalInstructionBytes = 0;
    for (const selected of selection) {
      const skillKey =
        typeof selected === "string" ? selected : selected.skillKey;
      const active =
        typeof selected === "string"
          ? await this.#skillDirectory.getActiveForExecution(
              tenantKey,
              projectKey,
              skillKey,
            )
          : await this.#skillDirectory.getVersionForExecution(
              tenantKey,
              projectKey,
              skillKey,
              selected.version,
            );
      if (!active) {
        throw new ApplicationError(
          409,
          "delivery_skill_unavailable",
          "本次交付选择的团队能力已经不可用",
        );
      }
      if (
        active.manifest.tenantKey !== tenantKey.toLowerCase() ||
        active.manifest.projectKey !== projectKey.toLowerCase() ||
        active.manifest.skillKey !== skillKey
      ) {
        throw new ApplicationError(
          409,
          "delivery_skill_changed",
          "本次交付选择的团队能力与可信目录范围不一致，请重新安排交付",
        );
      }
      if (
        typeof selected !== "string" &&
        (active.manifest.version !== selected.version ||
          active.manifest.artifactHashAlgorithm !==
            selected.artifactHashAlgorithm ||
          active.manifest.artifactHash !== selected.artifactHash)
      ) {
        throw new ApplicationError(
          409,
          "delivery_skill_changed",
          "本次交付选择的团队能力版本已经变化，请重新安排交付",
        );
      }
      if (
        active.manifest.permissions.workspace !== "read_only" ||
        active.manifest.permissions.network !== "none" ||
        active.manifest.permissions.commands !== "none"
      ) {
        throw new ApplicationError(
          409,
          "delivery_skill_not_safe",
          "设备交付只接受只读、无网络且不执行命令的团队能力",
        );
      }
      const content = SkillPackageCodec.decode(active.bytes);
      const unsupportedResource = content.resources.find(
        (resource) =>
          !deliveryResourceMediaTypes.has(resource.mediaType) ||
          resource.path.startsWith("scripts/"),
      );
      if (unsupportedResource) {
        throw new ApplicationError(
          409,
          "delivery_skill_resource_unsupported",
          "本次交付绑定的团队能力包含不受支持的可执行或二进制资源",
        );
      }
      const resources = content.resources.map((resource) => ({
        path: resource.path,
        mediaType: resource.mediaType as
          "text/markdown" | "text/plain" | "application/json",
        content: deliveryResourceContent(resource),
      }));
      if (
        containsLikelyPlaintextCredential(content.instructions) ||
        resources.some((resource) =>
          containsLikelyPlaintextCredential(resource.content),
        )
      ) {
        throw new ApplicationError(
          409,
          "delivery_skill_credential_detected",
          "本次交付绑定的团队能力包含明文凭据，不能下发到设备",
        );
      }
      if (
        active.manifest.artifactSizeBytes !== active.bytes.byteLength ||
        active.manifest.artifactHash !==
          createHash("sha256").update(active.bytes).digest("hex")
      ) {
        throw new Error("已激活 Skill 的制品与可信清单不一致");
      }
      const instructionBytes = new TextEncoder().encode(
        content.instructions,
      ).byteLength;
      const resourceBytes = resources.reduce(
        (total, resource) =>
          total + new TextEncoder().encode(resource.content).byteLength,
        0,
      );
      totalInstructionBytes += instructionBytes + resourceBytes;
      if (
        instructionBytes > 40_000 ||
        resources.some(
          (resource) =>
            new TextEncoder().encode(resource.content).byteLength > 40_000,
        ) ||
        totalInstructionBytes > 100_000
      ) {
        throw new ApplicationError(
          409,
          "delivery_skill_too_large",
          "本次交付选择的团队能力说明超过设备安全上限",
        );
      }
      resolved.push({
        skillKey: active.manifest.skillKey,
        version: active.manifest.version,
        name: active.manifest.name,
        artifactHashAlgorithm: active.manifest.artifactHashAlgorithm,
        artifactHash: active.manifest.artifactHash,
        instructions: content.instructions,
        resources,
      });
    }
    return resolved;
  }

  async submitExecutionResult(
    tenantKey: string,
    assignment: {
      workKind: "requirement_delivery";
      assignmentKey: string;
      fencingToken: number;
      projectKey: string;
      requirementKey: string;
      requirementRevision: number;
    },
    input: WorkerRequirementCompletionPayload,
  ): Promise<DeliveryRunResult> {
    const completion = WorkerRequirementCompletionSchema.parse(input);
    if (
      completion.assignmentKey !== assignment.assignmentKey ||
      completion.fencingToken !== assignment.fencingToken
    ) {
      throw new ApplicationError(
        409,
        "delivery_completion_mismatch",
        "交付结果没有绑定当前设备租约",
      );
    }
    return this.#requirementRepository.transaction(
      tenantKey,
      assignment.projectKey,
      async (transaction) => {
        const record = await transaction.find(assignment.requirementKey);
        const dispatch = await transaction.findDeliveryDispatch(
          assignment.requirementKey,
          assignment.requirementRevision,
        );
        const expectedBranch = `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`;
        if (
          !record ||
          !dispatch ||
          record.tenantKey !== tenantKey.toLowerCase() ||
          record.projectKey !== assignment.projectKey.toLowerCase() ||
          record.requirementKey !== assignment.requirementKey.toLowerCase() ||
          record.workflow.currentRevision !== assignment.requirementRevision ||
          record.workflow.toSnapshot().status !== "inDelivery" ||
          completion.projectKey !== assignment.projectKey ||
          completion.requirementKey !== assignment.requirementKey ||
          completion.requirementRevision !== assignment.requirementRevision ||
          dispatch.dispatchedAt === null ||
          dispatch.repositoryKey !== completion.repositoryKey ||
          completion.branchName !== expectedBranch
        ) {
          throw new ApplicationError(
            409,
            "delivery_completion_stale",
            "交付结果不再对应当前需求、仓库或设备租约",
          );
        }
        record.workflow.assertSpecIntegrity(record.spec);
        const existing = await transaction.findDeliveryRunResult(
          assignment.requirementKey,
          assignment.requirementRevision,
        );
        if (existing) {
          if (!this.#matchesCompletion(existing, completion)) {
            throw new ApplicationError(
              409,
              "delivery_completion_conflict",
              "这个需求版本已经提交了不同的交付结果，需要人工核对",
            );
          }
          return existing;
        }
        const result: DeliveryRunResult = {
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          repositoryKey: dispatch.repositoryKey,
          requirementKey: record.requirementKey,
          requirementRevision: record.workflow.currentRevision,
          assignmentKey: assignment.assignmentKey,
          fencingToken: assignment.fencingToken,
          gitHashAlgorithm: completion.gitHashAlgorithm,
          baseCommit: completion.baseCommit,
          commitSha: completion.commitSha,
          branchName: completion.branchName,
          summary: completion.summary,
          status: "completion_pending",
          submittedAt: this.#now().toISOString(),
          completedAt: null,
        };
        transaction.saveDeliveryRunResult(result);
        return structuredClone(result);
      },
    );
  }

  async finalizeExecutionResult(run: DeliveryRunResult): Promise<boolean> {
    const proof = {
      assignmentKey: run.assignmentKey,
      fencingToken: run.fencingToken,
      completionDigest: requirementCompletionDigest({
        schemaVersion: 1,
        assignmentKey: run.assignmentKey,
        fencingToken: run.fencingToken,
        projectKey: run.projectKey,
        repositoryKey: run.repositoryKey,
        requirementKey: run.requirementKey,
        requirementRevision: run.requirementRevision,
        gitHashAlgorithm: run.gitHashAlgorithm,
        baseCommit: run.baseCommit,
        commitSha: run.commitSha,
        branchName: run.branchName,
        summary: run.summary,
      }),
    };
    if (!(await this.#workers.isRequirementDeliveryCompleted(run, proof))) {
      return false;
    }
    return this.#requirementRepository.transaction(
      run.tenantKey,
      run.projectKey,
      async (transaction) => {
        const recordedAt = this.#now().toISOString();
        if (
          !(await transaction.markDeliveryRunCompleted(
            run.requirementKey,
            run.requirementRevision,
            proof,
            recordedAt,
          ))
        ) {
          return false;
        }
        transaction.appendAudit({
          eventKey: randomUUID(),
          tenantKey: run.tenantKey,
          projectKey: run.projectKey,
          requirementKey: run.requirementKey,
          action: "delivery.completed",
          actorKey: "00000000-0000-4000-8000-000000000001",
          actorName: "ForgeX 设备调度器",
          recordedAt,
        });
        return true;
      },
    );
  }

  async flushCompleted(tenantKey: string): Promise<number> {
    const pending =
      await this.#requirementRepository.listPendingDeliveryRunResults(
        tenantKey,
        100,
      );
    let completed = 0;
    for (const run of pending) {
      if (await this.finalizeExecutionResult(run)) completed += 1;
    }
    return completed;
  }

  async findExecutionResultByProof(
    tenantKey: string,
    proof: { assignmentKey: string; fencingToken: number },
  ): Promise<DeliveryRunResult | null> {
    return this.#requirementRepository.findDeliveryRunResultByProof(
      tenantKey,
      proof,
    );
  }

  async #markDispatched(dispatch: DeliveryDispatchRecord): Promise<void> {
    await this.#requirementRepository.transaction(
      dispatch.tenantKey,
      dispatch.projectKey,
      async (transaction) => {
        const recordedAt = this.#now().toISOString();
        if (
          !(await transaction.markDeliveryDispatched(
            dispatch.dispatchKey,
            recordedAt,
          ))
        ) {
          return;
        }
        transaction.appendAudit({
          eventKey: randomUUID(),
          tenantKey: dispatch.tenantKey,
          projectKey: dispatch.projectKey,
          requirementKey: dispatch.requirementKey,
          action: "delivery.dispatched",
          actorKey: "00000000-0000-4000-8000-000000000001",
          actorName: "ForgeX 调度器",
          recordedAt,
        });
      },
    );
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("服务端时间无效");
    }
    return new Date(value.getTime());
  }

  #matchesCompletion(
    run: DeliveryRunResult,
    completion: WorkerRequirementCompletionPayload,
  ): boolean {
    return (
      run.assignmentKey === completion.assignmentKey &&
      run.fencingToken === completion.fencingToken &&
      run.projectKey === completion.projectKey &&
      run.repositoryKey === completion.repositoryKey &&
      run.requirementKey === completion.requirementKey &&
      run.requirementRevision === completion.requirementRevision &&
      run.gitHashAlgorithm === completion.gitHashAlgorithm &&
      run.baseCommit === completion.baseCommit &&
      run.commitSha === completion.commitSha &&
      run.branchName === completion.branchName &&
      run.summary === completion.summary
    );
  }
}
