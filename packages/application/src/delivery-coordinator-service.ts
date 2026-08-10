import { randomUUID } from "node:crypto";

import {
  RequirementExecutionEnvelopeSchema,
  WorkerRequirementCompletionSchema,
  type RequirementExecutionEnvelope,
  type StartDeliveryCommandPayload,
  type WorkerRequirementCompletionPayload,
} from "@forgex/contracts";

import type { AuthenticatedPrincipal } from "./auth.js";
import { requirementCompletionDigest } from "./delivery-completion.js";
import { ApplicationError } from "./errors.js";
import type {
  DeliveryDispatchRecord,
  DeliveryRunResult,
  RequirementRepository,
} from "./requirement-repository.js";
import type { RequirementApplicationService } from "./requirement-service.js";
import type { WorkerFleetService } from "./worker-fleet-service.js";

export interface DeliveryCoordinatorServiceOptions {
  requirements: RequirementApplicationService;
  requirementRepository: RequirementRepository;
  workers: WorkerFleetService;
  clock?: () => Date;
}

export class DeliveryCoordinatorService {
  readonly #requirements: RequirementApplicationService;
  readonly #requirementRepository: RequirementRepository;
  readonly #workers: WorkerFleetService;
  readonly #clock: () => Date;

  constructor(options: DeliveryCoordinatorServiceOptions) {
    this.#requirements = options.requirements;
    this.#requirementRepository = options.requirementRepository;
    this.#workers = options.workers;
    this.#clock = options.clock ?? (() => new Date());
  }

  async requestDelivery(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    command: StartDeliveryCommandPayload,
  ): Promise<{
    title: string;
    requirementRevision: number;
    status: "等待空闲设备" | "已经完成";
  }> {
    const dispatch = await this.#requirements.requestDelivery(
      principal,
      requirementKey,
      command,
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
        return RequirementExecutionEnvelopeSchema.parse({
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
        });
      },
    );
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
