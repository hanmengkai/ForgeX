import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  McpInvocationRequestSchema,
  type McpInvocationRequestPayload,
} from "@forgex/contracts";

import {
  McpHealthAuthority,
  type McpServerManifest,
  type McpToolDefinition,
} from "@forgex/extensions";

import type { AuthenticatedPrincipal, PlatformRole } from "./auth.js";
import { ApplicationError } from "./errors.js";
import {
  canonicalizeMcpArguments,
  projectMcpArgumentsForPeople,
  validateMcpToolArguments,
  type McpArgumentForPeople,
  type McpInputSchemaStore,
} from "./mcp-input-schema-store.js";
import type {
  McpInvocationRecord,
  McpInvocationRepository,
} from "./mcp-invocation-repository.js";
import type {
  McpInvocationDispatch,
  WorkerLeaseView,
} from "./worker-fleet-service.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const executionOutcomeUnknownReportSchema = z
  .object({
    projectKey: internalKey,
    invocationKey: internalKey,
    assignmentKey: internalKey,
    fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workerKey: internalKey,
    workerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export interface TrustedMcpToolDirectory {
  getEnabledToolForInvocation(
    tenantKey: string,
    serverKey: string,
    toolKey: string,
    projectKey?: string,
  ): Promise<{ manifest: McpServerManifest; tool: McpToolDefinition } | null>;
}

export interface McpInvocationWorkerDispatcher {
  enqueueMcpInvocation(dispatch: McpInvocationDispatch): Promise<unknown>;
  cancelPendingMcpInvocation(dispatch: McpInvocationDispatch): Promise<void>;
  isMcpInvocationCompleted(
    dispatch: McpInvocationDispatch,
    completion: {
      assignmentKey: string;
      fencingToken: number;
    },
  ): Promise<boolean>;
}

type PreparedDispatchResult =
  | { kind: "ready"; dispatch: McpInvocationDispatch }
  | { kind: "cancelled"; dispatch: McpInvocationDispatch }
  | {
      kind: "completed";
      dispatch: McpInvocationDispatch;
      completion: {
        projectKey: string;
        invocationKey: string;
        assignmentKey: string;
        fencingToken: number;
        leasedUntil: string;
      };
    }
  | { kind: "outcome_unknown"; dispatch: McpInvocationDispatch }
  | { kind: "skipped" };

type PreparedDispatchState =
  | PreparedDispatchResult
  | {
      kind: "validate";
      record: McpInvocationRecord;
      dispatch: McpInvocationDispatch;
    };

export interface McpExecutionEnvelope {
  connectionBindingKey: string;
  serviceName: string;
  toolName: string;
  technicalName: string;
  transport: "stdio" | "streamable_http";
  effect: "read" | "write" | "external_action";
  serverRevision: number;
  manifestHashAlgorithm: "sha256";
  manifestHash: string;
  inputSchemaHashAlgorithm: "sha256";
  inputSchemaHash: string;
  argumentsHashAlgorithm: "sha256";
  argumentsHash: string;
  arguments: Record<string, unknown>;
}

export interface McpInvocationApplicationServiceOptions {
  repository: McpInvocationRepository;
  schemaStore: McpInputSchemaStore;
  toolDirectory: TrustedMcpToolDirectory;
  projectKey: string;
  clock?: () => Date;
}

const executionResultHash = (result: {
  outcome: "succeeded" | "failed";
  summary: string;
  completedAt: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        completedAt: result.completedAt,
        outcome: result.outcome,
        summary: result.summary,
      }),
      "utf8",
    )
    .digest("hex");

export interface McpInvocationPeopleView {
  title: string;
  serviceName: string;
  status:
    | "等待产品确认"
    | "等待设备执行"
    | "正在执行"
    | "执行完成"
    | "执行未成功"
    | "已取消"
    | "结果待人工核对";
  requestedBy: string;
  requestedAt: string;
  detail: string;
  inputs: McpArgumentForPeople[];
}

export interface McpInvocationItemForPeople {
  invocationKey: string;
  view: McpInvocationPeopleView;
  allowedActions: Array<"approve" | "cancel">;
}

const approvalRoles = new Set<PlatformRole>(["product_owner", "administrator"]);
const MAX_OUTSTANDING_MCP_INVOCATIONS = 100;

const statusForPeople = (
  status: McpInvocationRecord["status"],
): McpInvocationPeopleView["status"] => {
  const labels = {
    awaiting_approval: "等待产品确认",
    queued: "等待设备执行",
    leased: "正在执行",
    completion_pending: "正在执行",
    succeeded: "执行完成",
    failed: "执行未成功",
    cancellation_pending: "已取消",
    cancelled: "已取消",
    outcome_unknown_pending_cleanup: "结果待人工核对",
    outcome_unknown: "结果待人工核对",
  } as const;
  return labels[status];
};

export class McpInvocationApplicationService {
  readonly #repository: McpInvocationRepository;
  readonly #schemaStore: McpInputSchemaStore;
  readonly #toolDirectory: TrustedMcpToolDirectory;
  readonly #projectKey: string;
  readonly #clock: () => Date;

  constructor(options: McpInvocationApplicationServiceOptions) {
    const projectKey = internalKey.safeParse(options.projectKey);
    if (!projectKey.success) throw new Error("项目标识格式不正确");
    this.#repository = options.repository;
    this.#schemaStore = options.schemaStore;
    this.#toolDirectory = options.toolDirectory;
    this.#projectKey = projectKey.data;
    this.#clock = options.clock ?? (() => new Date());
  }

  async request(
    principal: AuthenticatedPrincipal,
    input: McpInvocationRequestPayload,
  ): Promise<{
    invocationKey: string;
    title: string;
    status: McpInvocationPeopleView["status"];
  }> {
    const command = McpInvocationRequestSchema.safeParse(input);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "invalid_mcp_invocation",
        "MCP 调用信息需要调整",
      );
    }
    const canonicalArguments = canonicalizeMcpArguments(command.data.arguments);
    const existing = await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) =>
        transaction.findByRequest(principal.actorKey, command.data.requestKey),
    );
    if (existing) {
      if (
        existing.serverKey !== command.data.serverKey ||
        existing.toolKey !== command.data.toolKey ||
        existing.argumentsHash !== canonicalArguments.hash
      ) {
        throw new ApplicationError(
          409,
          "mcp_request_conflict",
          "这次请求已用于另一项 MCP 调用",
        );
      }
      return {
        invocationKey: existing.invocationKey,
        title: existing.toolDisplayName,
        status: statusForPeople(existing.status),
      };
    }
    const trusted = await this.#toolDirectory.getEnabledToolForInvocation(
      principal.tenantKey,
      command.data.serverKey,
      command.data.toolKey,
    );
    if (!trusted) {
      throw new ApplicationError(
        409,
        "mcp_tool_unavailable",
        "这项外部能力当前不可使用，请稍后重试",
      );
    }
    const tool = this.#trustedManifestTool(
      principal.tenantKey,
      this.#projectKey,
      command.data.serverKey,
      trusted.manifest,
      command.data.toolKey,
    );
    if (!tool) {
      throw new Error("可信 MCP 目录返回了错误的租户、项目或能力绑定");
    }
    const schema = await this.#schemaStore.get({
      tenantKey: principal.tenantKey,
      projectKey: this.#projectKey,
      hashAlgorithm: tool.inputSchemaHashAlgorithm,
      hash: tool.inputSchemaHash,
    });
    if (!schema) {
      throw new ApplicationError(
        409,
        "mcp_schema_unavailable",
        "这项外部能力的参数规则尚未就绪",
      );
    }
    const args = validateMcpToolArguments(schema, command.data.arguments);
    const argumentsHash = canonicalizeMcpArguments(args).hash;
    const manifestHash = McpHealthAuthority.manifestHash(trusted.manifest);
    const awaitingApproval =
      tool.effect !== "read" || tool.approval !== "automatic";
    if (awaitingApproval) {
      try {
        projectMcpArgumentsForPeople(schema, args, {
          requireExactValues: true,
        });
      } catch {
        throw new ApplicationError(
          422,
          "mcp_approval_summary_unsafe",
          "这项操作的参数暂时无法完整、清楚地展示给确认人",
        );
      }
    }

    const record = await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const existing = await transaction.findByRequest(
          principal.actorKey,
          command.data.requestKey,
        );
        if (existing) {
          if (
            existing.serverKey !== trusted.manifest.serverKey ||
            existing.toolKey !== tool.toolKey ||
            existing.argumentsHash !== argumentsHash
          ) {
            throw new ApplicationError(
              409,
              "mcp_request_conflict",
              "这次请求已用于另一项 MCP 调用",
            );
          }
          return existing;
        }
        if (
          (await transaction.countOutstandingAcrossTenant()) >=
          MAX_OUTSTANDING_MCP_INVOCATIONS
        ) {
          throw new ApplicationError(
            429,
            "mcp_invocation_capacity",
            "当前等待处理的外部操作较多，请完成或取消后再试",
          );
        }
        const requestedAt = this.#now();
        const created: McpInvocationRecord = {
          schemaVersion: 1,
          invocationKey: randomUUID(),
          requestKey: command.data.requestKey,
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
          serverKey: trusted.manifest.serverKey,
          serverRevision: trusted.manifest.revision,
          serverName: trusted.manifest.name,
          manifestHashAlgorithm: "sha256",
          manifestHash,
          toolKey: tool.toolKey,
          technicalName: tool.technicalName,
          toolDisplayName: tool.displayName,
          effect: tool.effect,
          approvalMode: tool.approval,
          connectionBindingKey: trusted.manifest.connectionBindingKey,
          inputSchemaHashAlgorithm: "sha256",
          inputSchemaHash: tool.inputSchemaHash,
          argumentsHashAlgorithm: "sha256",
          argumentsHash,
          arguments: args,
          requestedByKey: principal.actorKey,
          requestedByName: principal.actorName,
          requestedAt,
          status: awaitingApproval ? "awaiting_approval" : "queued",
          approval: null,
          executionLease: null,
          result: null,
          cancellationAuditRecorded: false,
          cancellationRequestedBy: null,
        };
        transaction.save(created);
        return created;
      },
    );
    return {
      invocationKey: record.invocationKey,
      title: record.toolDisplayName,
      status: statusForPeople(record.status),
    };
  }

  async approve(
    principal: AuthenticatedPrincipal,
    invocationKeyInput: string,
  ): Promise<void> {
    if (!principal.roles.some((role) => approvalRoles.has(role))) {
      throw new ApplicationError(
        403,
        "mcp_approval_required",
        "只有产品负责人或管理员可以确认这项外部操作",
      );
    }
    const invocationKey = internalKey.safeParse(invocationKeyInput);
    if (!invocationKey.success) {
      throw new ApplicationError(
        404,
        "mcp_invocation_not_found",
        "找不到这项调用",
      );
    }
    const pending = await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => transaction.find(invocationKey.data),
    );
    if (!pending) {
      throw new ApplicationError(
        404,
        "mcp_invocation_not_found",
        "找不到这项调用",
      );
    }
    if (pending.status === "queued" && pending.approval !== null) return;
    if (pending.status !== "awaiting_approval") {
      throw new ApplicationError(
        409,
        "mcp_invocation_state_conflict",
        "这项调用当前不能确认",
      );
    }
    const trusted = await this.#toolDirectory.getEnabledToolForInvocation(
      principal.tenantKey,
      pending.serverKey,
      pending.toolKey,
    );
    if (!trusted || !this.#isExactBinding(pending, trusted.manifest)) {
      throw new ApplicationError(
        409,
        "mcp_invocation_stale",
        "外部能力已经变化，请重新发起调用",
      );
    }
    const approvedAt = this.#now();
    await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const current = await transaction.find(invocationKey.data);
        if (!current) {
          throw new ApplicationError(
            404,
            "mcp_invocation_not_found",
            "找不到这项调用",
          );
        }
        if (current.status === "queued" && current.approval !== null) return;
        if (
          current.status !== "awaiting_approval" ||
          current.manifestHash !== pending.manifestHash ||
          current.argumentsHash !== pending.argumentsHash
        ) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "这项调用已经发生变化",
          );
        }
        const updated: McpInvocationRecord = {
          ...current,
          status: "queued",
          approval: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
            approvedAt,
          },
        };
        transaction.appendAudit({
          schemaVersion: 1,
          eventKey: randomUUID(),
          tenantKey: principal.tenantKey,
          projectKey: this.#projectKey,
          invocationKey: current.invocationKey,
          action: "approved",
          actorKey: principal.actorKey,
          actorName: principal.actorName,
          recordedAt: approvedAt,
          manifestHashAlgorithm: "sha256",
          manifestHash: current.manifestHash,
          argumentsHashAlgorithm: "sha256",
          argumentsHash: current.argumentsHash,
        });
        transaction.save(updated);
      },
    );
  }

  async requestCancellation(
    principal: AuthenticatedPrincipal,
    invocationKeyInput: string,
  ): Promise<McpInvocationDispatch | null> {
    const invocationKey = internalKey.safeParse(invocationKeyInput);
    if (!invocationKey.success) {
      throw new ApplicationError(
        404,
        "mcp_invocation_not_found",
        "找不到这项调用",
      );
    }
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(invocationKey.data);
        if (!record) {
          throw new ApplicationError(
            404,
            "mcp_invocation_not_found",
            "找不到这项调用",
          );
        }
        const canCancel =
          record.requestedByKey === principal.actorKey ||
          principal.roles.some((role) => approvalRoles.has(role));
        if (!canCancel) {
          throw new ApplicationError(
            403,
            "mcp_cancellation_required",
            "只有发起人、产品负责人或管理员可以取消这项操作",
          );
        }
        if (record.status === "cancelled") return null;
        const dispatch: McpInvocationDispatch = {
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          invocationKey: record.invocationKey,
          serverRevision: record.serverRevision,
          title: record.toolDisplayName,
          connectionBindingKey: record.connectionBindingKey,
        };
        if (record.status === "cancellation_pending") return dispatch;
        if (!["awaiting_approval", "queued"].includes(record.status)) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "这项操作已经开始执行或已经结束，当前不能取消",
          );
        }
        transaction.save({
          ...record,
          status: "cancellation_pending",
          executionLease: null,
          result: null,
          cancellationRequestedBy: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
            requestedAt: this.#now(),
          },
          cancellationAuditRecorded: false,
        });
        return dispatch;
      },
    );
  }

  async flushQueuedToWorkers(
    tenantKey: string,
    workers: McpInvocationWorkerDispatcher,
  ): Promise<number> {
    const records = await this.#repository.listDispatchableAcrossProjects(
      tenantKey,
      100,
    );
    let dispatched = 0;
    for (const record of records) {
      const prepared = await this.#prepareQueuedDispatch(record);
      if (prepared.kind === "skipped") continue;
      if (prepared.kind === "cancelled") {
        await workers.cancelPendingMcpInvocation(prepared.dispatch);
        await this.finalizeCancellation(
          prepared.dispatch.tenantKey,
          prepared.dispatch.projectKey,
          prepared.dispatch.invocationKey,
        );
        continue;
      }
      if (prepared.kind === "completed") {
        const committed = await workers.isMcpInvocationCompleted(
          prepared.dispatch,
          prepared.completion,
        );
        if (!committed) {
          if (
            Date.parse(prepared.completion.leasedUntil) >
            Date.parse(this.#now())
          ) {
            continue;
          }
          const reconciliation = await this.#reconcileUncommittedCompletion(
            prepared.dispatch,
            prepared.completion,
          );
          await workers.cancelPendingMcpInvocation(prepared.dispatch);
          if (reconciliation === "outcome_unknown") {
            await this.finalizeOutcomeUnknownCleanup(
              prepared.dispatch.tenantKey,
              prepared.dispatch.projectKey,
              prepared.dispatch.invocationKey,
            );
          }
          continue;
        }
        await workers.cancelPendingMcpInvocation(prepared.dispatch);
        await this.finalizeExecutionResult(
          prepared.dispatch.tenantKey,
          prepared.completion,
        );
        continue;
      }
      if (prepared.kind === "outcome_unknown") {
        await workers.cancelPendingMcpInvocation(prepared.dispatch);
        await this.finalizeOutcomeUnknownCleanup(
          prepared.dispatch.tenantKey,
          prepared.dispatch.projectKey,
          prepared.dispatch.invocationKey,
        );
        continue;
      }
      try {
        await workers.enqueueMcpInvocation(prepared.dispatch);
        const reconciliation = await this.#reconcileDispatchAfterEnqueue(
          prepared.dispatch,
        );
        if (reconciliation === "cleanup_pending") {
          await workers.cancelPendingMcpInvocation(prepared.dispatch);
          await this.finalizeCancellation(
            prepared.dispatch.tenantKey,
            prepared.dispatch.projectKey,
            prepared.dispatch.invocationKey,
          );
          continue;
        }
        if (reconciliation === "queued") dispatched += 1;
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "queue_full") {
          break;
        }
        throw error;
      }
    }
    return dispatched;
  }

  async #reconcileUncommittedCompletion(
    dispatch: McpInvocationDispatch,
    completion: { assignmentKey: string; fencingToken: number },
  ): Promise<"queued" | "outcome_unknown"> {
    return this.#repository.transaction(
      dispatch.tenantKey,
      dispatch.projectKey,
      async (transaction) => {
        const record = await transaction.find(dispatch.invocationKey);
        const sameLease =
          record?.executionLease?.assignmentKey === completion.assignmentKey &&
          record.executionLease.fencingToken === completion.fencingToken;
        if (
          !record ||
          record.status !== "completion_pending" ||
          !sameLease ||
          record.executionLease === null ||
          record.result === null
        ) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "MCP 执行准备记录已经发生变化",
          );
        }
        if (record.effect === "read") {
          transaction.save({
            ...record,
            status: "queued",
            executionLease: null,
            result: null,
          });
          return "queued";
        }
        transaction.appendAudit({
          schemaVersion: 1,
          eventKey: randomUUID(),
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          invocationKey: record.invocationKey,
          action: "outcome_unknown",
          workerKey: record.executionLease.workerKey,
          workerGeneration: record.executionLease.workerGeneration,
          workerFingerprintHash: record.executionLease.workerFingerprintHash,
          assignmentKey: record.executionLease.assignmentKey,
          fencingToken: record.executionLease.fencingToken,
          leasedUntil: record.executionLease.leasedUntil,
          recordedAt: this.#now(),
          manifestHashAlgorithm: record.manifestHashAlgorithm,
          manifestHash: record.manifestHash,
          argumentsHashAlgorithm: record.argumentsHashAlgorithm,
          argumentsHash: record.argumentsHash,
        });
        transaction.save({
          ...record,
          status: "outcome_unknown_pending_cleanup",
          result: null,
        });
        return "outcome_unknown";
      },
    );
  }

  async #reconcileDispatchAfterEnqueue(
    dispatch: McpInvocationDispatch,
  ): Promise<"queued" | "cleanup_pending" | "settled"> {
    return this.#repository.transaction(
      dispatch.tenantKey,
      dispatch.projectKey,
      async (transaction) => {
        const current = await transaction.find(dispatch.invocationKey);
        if (
          current?.status === "queued" &&
          current.serverRevision === dispatch.serverRevision &&
          current.connectionBindingKey === dispatch.connectionBindingKey
        ) {
          return "queued";
        }
        if (
          current?.status === "cancellation_pending" ||
          current?.status === "cancelled"
        ) {
          if (current.status === "cancelled") {
            transaction.save({
              ...current,
              status: "cancellation_pending",
            });
          }
          return "cleanup_pending";
        }
        return "settled";
      },
    );
  }

  async #prepareQueuedDispatch(
    record: McpInvocationRecord,
  ): Promise<PreparedDispatchResult> {
    const prepared = await this.#repository.transaction<PreparedDispatchState>(
      record.tenantKey,
      record.projectKey,
      async (transaction) => {
        const current = await transaction.find(record.invocationKey);
        if (!current) return { kind: "skipped" };
        const dispatch: McpInvocationDispatch = {
          tenantKey: current.tenantKey,
          projectKey: current.projectKey,
          invocationKey: current.invocationKey,
          serverRevision: current.serverRevision,
          title: current.toolDisplayName,
          connectionBindingKey: current.connectionBindingKey,
        };
        if (current.status === "cancellation_pending") {
          return { kind: "cancelled", dispatch };
        }
        if (current.status === "outcome_unknown_pending_cleanup") {
          return { kind: "outcome_unknown", dispatch };
        }
        if (current.status === "completion_pending") {
          if (current.executionLease === null) return { kind: "skipped" };
          return {
            kind: "completed",
            dispatch,
            completion: {
              projectKey: current.projectKey,
              invocationKey: current.invocationKey,
              assignmentKey: current.executionLease.assignmentKey,
              fencingToken: current.executionLease.fencingToken,
              leasedUntil: current.executionLease.leasedUntil,
            },
          };
        }
        if (
          current.status === "leased" &&
          current.effect !== "read" &&
          current.executionLease !== null &&
          Date.parse(current.executionLease.leasedUntil) <=
            Date.parse(this.#now())
        ) {
          transaction.appendAudit({
            schemaVersion: 1,
            eventKey: randomUUID(),
            tenantKey: current.tenantKey,
            projectKey: current.projectKey,
            invocationKey: current.invocationKey,
            action: "outcome_unknown",
            workerKey: current.executionLease.workerKey,
            workerGeneration: current.executionLease.workerGeneration,
            workerFingerprintHash: current.executionLease.workerFingerprintHash,
            assignmentKey: current.executionLease.assignmentKey,
            fencingToken: current.executionLease.fencingToken,
            leasedUntil: current.executionLease.leasedUntil,
            recordedAt: this.#now(),
            manifestHashAlgorithm: current.manifestHashAlgorithm,
            manifestHash: current.manifestHash,
            argumentsHashAlgorithm: current.argumentsHashAlgorithm,
            argumentsHash: current.argumentsHash,
          });
          transaction.save({
            ...current,
            status: "outcome_unknown_pending_cleanup",
          });
          return { kind: "outcome_unknown", dispatch };
        }
        if (current.status !== "queued") return { kind: "skipped" as const };
        return { kind: "validate" as const, record: current, dispatch };
      },
    );
    if (prepared.kind !== "validate") return prepared;

    const trusted = await this.#toolDirectory.getEnabledToolForInvocation(
      prepared.record.tenantKey,
      prepared.record.serverKey,
      prepared.record.toolKey,
      prepared.record.projectKey,
    );
    let valid =
      trusted !== null &&
      this.#isExactBinding(prepared.record, trusted.manifest);
    if (valid) {
      const schema = await this.#schemaStore.get({
        tenantKey: prepared.record.tenantKey,
        projectKey: prepared.record.projectKey,
        hashAlgorithm: prepared.record.inputSchemaHashAlgorithm,
        hash: prepared.record.inputSchemaHash,
      });
      if (!schema) throw new Error("MCP 调用缺少可信参数定义");
      const args = validateMcpToolArguments(schema, prepared.record.arguments);
      valid =
        canonicalizeMcpArguments(args).hash === prepared.record.argumentsHash;
      if (!valid) throw new Error("MCP 调用参数与审计摘要不一致");
    }

    return this.#repository.transaction(
      prepared.record.tenantKey,
      prepared.record.projectKey,
      async (transaction) => {
        const current = await transaction.find(prepared.record.invocationKey);
        if (
          !current ||
          !this.#sameValidationSnapshot(current, prepared.record)
        ) {
          return { kind: "skipped" as const };
        }
        if (!valid) {
          transaction.save({
            ...current,
            status: "cancellation_pending",
            executionLease: null,
            result: null,
          });
          return { kind: "cancelled" as const, dispatch: prepared.dispatch };
        }
        return { kind: "ready" as const, dispatch: prepared.dispatch };
      },
    );
  }

  async leaseForExecution(
    tenantKey: string,
    assignment: WorkerLeaseView,
  ): Promise<McpExecutionEnvelope> {
    if (assignment.workKind !== "mcp_invocation" || !assignment.invocationKey) {
      throw new ApplicationError(
        409,
        "invalid_work_kind",
        "当前租约不是 MCP 调用",
      );
    }
    const snapshot = await this.#repository.transaction(
      tenantKey,
      assignment.projectKey,
      (transaction) => transaction.find(assignment.invocationKey!),
    );
    if (!snapshot) {
      throw new ApplicationError(
        404,
        "mcp_invocation_not_found",
        "找不到这项调用",
      );
    }
    const trusted = await this.#toolDirectory.getEnabledToolForInvocation(
      tenantKey,
      snapshot.serverKey,
      snapshot.toolKey,
      snapshot.projectKey,
    );
    const bindingValid =
      trusted !== null && this.#isExactBinding(snapshot, trusted.manifest);
    let args: Record<string, unknown> = snapshot.arguments;
    if (bindingValid) {
      const schema = await this.#schemaStore.get({
        tenantKey: snapshot.tenantKey,
        projectKey: snapshot.projectKey,
        hashAlgorithm: snapshot.inputSchemaHashAlgorithm,
        hash: snapshot.inputSchemaHash,
      });
      if (!schema) throw new Error("MCP 调用缺少可信参数定义");
      args = validateMcpToolArguments(schema, snapshot.arguments);
      if (canonicalizeMcpArguments(args).hash !== snapshot.argumentsHash) {
        throw new Error("MCP 调用参数与审计摘要不一致");
      }
    }

    const outcome = await this.#repository.transaction(
      tenantKey,
      assignment.projectKey,
      async (transaction) => {
        const record = await transaction.find(assignment.invocationKey!);
        if (!record || !this.#sameValidationSnapshot(record, snapshot)) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "这项调用已经发生变化，请重新领取",
          );
        }
        const sameLease =
          record.executionLease?.assignmentKey === assignment.assignmentKey &&
          record.executionLease.fencingToken === assignment.fencingToken;
        const oldLeaseExpired =
          record.status === "leased" &&
          record.executionLease !== null &&
          Date.parse(record.executionLease.leasedUntil) <=
            Date.parse(this.#now());
        const sameDeviceReconnected =
          record.status === "leased" &&
          record.executionLease !== null &&
          record.executionLease.workerKey === assignment.workerKey &&
          record.executionLease.workerFingerprintHash ===
            assignment.workerFingerprintHash &&
          assignment.generation > record.executionLease.workerGeneration;
        const isHigherFencingReplacement =
          record.status === "leased" &&
          record.executionLease !== null &&
          !sameLease &&
          assignment.fencingToken > record.executionLease.fencingToken;
        const canReplaceReadLease =
          record.effect === "read" &&
          isHigherFencingReplacement &&
          (oldLeaseExpired || sameDeviceReconnected);
        if (
          record.effect !== "read" &&
          record.executionLease !== null &&
          isHigherFencingReplacement &&
          (oldLeaseExpired || sameDeviceReconnected)
        ) {
          transaction.appendAudit({
            schemaVersion: 1,
            eventKey: randomUUID(),
            tenantKey: record.tenantKey,
            projectKey: record.projectKey,
            invocationKey: record.invocationKey,
            action: "outcome_unknown",
            workerKey: record.executionLease.workerKey,
            workerGeneration: record.executionLease.workerGeneration,
            workerFingerprintHash: record.executionLease.workerFingerprintHash,
            assignmentKey: record.executionLease.assignmentKey,
            fencingToken: record.executionLease.fencingToken,
            leasedUntil: record.executionLease.leasedUntil,
            recordedAt: this.#now(),
            manifestHashAlgorithm: record.manifestHashAlgorithm,
            manifestHash: record.manifestHash,
            argumentsHashAlgorithm: record.argumentsHashAlgorithm,
            argumentsHash: record.argumentsHash,
          });
          transaction.save({
            ...record,
            status: "outcome_unknown_pending_cleanup",
          });
          return { kind: "outcome_unknown" as const };
        }
        if (
          record.status !== "queued" &&
          !(record.status === "leased" && (sameLease || canReplaceReadLease))
        ) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "这项调用当前不能执行",
          );
        }
        if (!bindingValid) {
          transaction.save({
            ...record,
            status: "cancellation_pending",
            executionLease: null,
            result: null,
          });
          return { kind: "cancelled" as const };
        }
        if (Date.parse(assignment.leasedUntil) <= Date.parse(this.#now())) {
          if (
            record.status === "leased" &&
            record.effect !== "read" &&
            record.executionLease !== null
          ) {
            transaction.appendAudit({
              schemaVersion: 1,
              eventKey: randomUUID(),
              tenantKey: record.tenantKey,
              projectKey: record.projectKey,
              invocationKey: record.invocationKey,
              action: "outcome_unknown",
              workerKey: record.executionLease.workerKey,
              workerGeneration: record.executionLease.workerGeneration,
              workerFingerprintHash:
                record.executionLease.workerFingerprintHash,
              assignmentKey: record.executionLease.assignmentKey,
              fencingToken: record.executionLease.fencingToken,
              leasedUntil: record.executionLease.leasedUntil,
              recordedAt: this.#now(),
              manifestHashAlgorithm: record.manifestHashAlgorithm,
              manifestHash: record.manifestHash,
              argumentsHashAlgorithm: record.argumentsHashAlgorithm,
              argumentsHash: record.argumentsHash,
            });
            transaction.save({
              ...record,
              status: "outcome_unknown_pending_cleanup",
            });
            return { kind: "outcome_unknown" as const };
          }
          transaction.save({
            ...record,
            status: "queued",
            executionLease: null,
            result: null,
          });
          return { kind: "retry" as const };
        }
        const leaseChanged =
          !sameLease ||
          (record.executionLease !== null &&
            assignment.leasedUntil > record.executionLease.leasedUntil);
        if (leaseChanged) {
          transaction.save({
            ...record,
            status: "leased",
            executionLease: {
              assignmentKey: assignment.assignmentKey,
              fencingToken: assignment.fencingToken,
              workerKey: assignment.workerKey,
              workerGeneration: assignment.generation,
              workerFingerprintHash: assignment.workerFingerprintHash,
              leasedUntil: assignment.leasedUntil,
            },
            result: null,
          });
        }
        if (!sameLease) {
          transaction.appendAudit({
            schemaVersion: 1,
            eventKey: randomUUID(),
            tenantKey: record.tenantKey,
            projectKey: record.projectKey,
            invocationKey: record.invocationKey,
            action: "leased",
            workerKey: assignment.workerKey,
            workerGeneration: assignment.generation,
            workerFingerprintHash: assignment.workerFingerprintHash,
            assignmentKey: assignment.assignmentKey,
            fencingToken: assignment.fencingToken,
            leasedUntil: assignment.leasedUntil,
            recordedAt: this.#now(),
            manifestHashAlgorithm: record.manifestHashAlgorithm,
            manifestHash: record.manifestHash,
            argumentsHashAlgorithm: record.argumentsHashAlgorithm,
            argumentsHash: record.argumentsHash,
          });
        }
        return {
          kind: "ready" as const,
          envelope: {
            connectionBindingKey: record.connectionBindingKey,
            serviceName: record.serverName,
            toolName: record.toolDisplayName,
            technicalName: record.technicalName,
            transport: trusted!.manifest.transport,
            effect: record.effect,
            serverRevision: record.serverRevision,
            manifestHashAlgorithm: record.manifestHashAlgorithm,
            manifestHash: record.manifestHash,
            inputSchemaHashAlgorithm: record.inputSchemaHashAlgorithm,
            inputSchemaHash: record.inputSchemaHash,
            argumentsHashAlgorithm: record.argumentsHashAlgorithm,
            argumentsHash: record.argumentsHash,
            arguments: args,
          },
        };
      },
    );
    if (outcome.kind === "cancelled") {
      throw new ApplicationError(
        409,
        "mcp_invocation_stale",
        "外部能力已经变化，这项调用已安全取消",
      );
    }
    if (outcome.kind === "outcome_unknown") {
      throw new ApplicationError(
        409,
        "mcp_outcome_unknown",
        "上一次外部操作是否生效尚不明确，已停止自动重试并等待人工核对",
      );
    }
    if (outcome.kind === "retry") {
      throw new ApplicationError(
        409,
        "expired_lease",
        "MCP 调用租约已经过期，请重新领取",
      );
    }
    return outcome.envelope;
  }

  async finalizeCancellation(
    tenantKey: string,
    projectKey: string,
    invocationKey: string,
  ): Promise<void> {
    await this.#repository.transaction(
      tenantKey,
      projectKey,
      async (transaction) => {
        const record = await transaction.find(invocationKey);
        if (!record || record.status === "cancelled") return;
        if (record.status !== "cancellation_pending") {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "这项调用当前不能取消",
          );
        }
        if (!record.cancellationAuditRecorded) {
          transaction.appendAudit({
            schemaVersion: 1,
            eventKey: randomUUID(),
            tenantKey: record.tenantKey,
            projectKey: record.projectKey,
            invocationKey: record.invocationKey,
            action: "cancelled",
            source: record.cancellationRequestedBy ? "user" : "system",
            actorKey: record.cancellationRequestedBy?.actorKey ?? null,
            actorName: record.cancellationRequestedBy?.actorName ?? null,
            recordedAt: this.#now(),
            manifestHashAlgorithm: record.manifestHashAlgorithm,
            manifestHash: record.manifestHash,
            argumentsHashAlgorithm: record.argumentsHashAlgorithm,
            argumentsHash: record.argumentsHash,
          });
        }
        transaction.save({
          ...record,
          status: "cancelled",
          executionLease: null,
          result: null,
          cancellationAuditRecorded: true,
        });
      },
    );
  }

  async completeExecution(
    tenantKey: string,
    assignment: WorkerLeaseView,
    result: { outcome: "succeeded" | "failed"; summary: string },
  ): Promise<void> {
    if (assignment.workKind !== "mcp_invocation" || !assignment.invocationKey) {
      throw new ApplicationError(
        409,
        "invalid_work_kind",
        "当前租约不是 MCP 调用",
      );
    }
    const summary = result.summary.trim();
    if (summary.length < 2 || summary.length > 500) {
      throw new ApplicationError(
        422,
        "invalid_mcp_result",
        "执行结果说明需要使用简短、可理解的业务语言",
      );
    }
    const outcome = await this.#repository.transaction(
      tenantKey,
      assignment.projectKey,
      async (transaction) => {
        const record = await transaction.find(assignment.invocationKey!);
        if (!record) {
          throw new ApplicationError(
            404,
            "mcp_invocation_not_found",
            "找不到这项调用",
          );
        }
        const sameLease =
          record.executionLease?.assignmentKey === assignment.assignmentKey &&
          record.executionLease.fencingToken === assignment.fencingToken;
        if (
          ["completion_pending", "succeeded", "failed"].includes(
            record.status,
          ) &&
          sameLease &&
          record.result?.outcome === result.outcome &&
          record.result.summary === summary
        ) {
          return;
        }
        if (record.status !== "leased" || !sameLease) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "执行结果与当前设备租约不匹配",
          );
        }
        if (
          Date.parse(record.executionLease!.leasedUntil) <=
          Date.parse(this.#now())
        ) {
          throw new ApplicationError(
            409,
            "expired_lease",
            "MCP 调用租约已经过期，请重新领取",
          );
        }
        const completedAt = this.#now();
        transaction.save({
          ...record,
          status: "completion_pending",
          result: { ...result, summary, completedAt },
        });
      },
    );
  }

  async reportExecutionOutcomeUnknown(
    tenantKey: string,
    input: z.input<typeof executionOutcomeUnknownReportSchema>,
  ): Promise<"pending_cleanup" | "settled"> {
    const report = executionOutcomeUnknownReportSchema.parse(input);
    return this.#repository.transaction(
      tenantKey,
      report.projectKey,
      async (transaction) => {
        const record = await transaction.find(report.invocationKey);
        if (!record) {
          throw new ApplicationError(
            404,
            "mcp_invocation_not_found",
            "找不到这项调用",
          );
        }
        const lease = record.executionLease;
        const sameExecution =
          lease?.assignmentKey === report.assignmentKey &&
          lease.fencingToken === report.fencingToken &&
          lease.workerKey === report.workerKey &&
          lease.workerGeneration <= report.workerGeneration;
        if (!sameExecution) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "结果待核对报告与原设备租约不匹配",
          );
        }
        if (record.status === "outcome_unknown") return "settled";
        if (record.status === "outcome_unknown_pending_cleanup") {
          return "pending_cleanup";
        }
        if (record.effect === "read" || record.status !== "leased" || !lease) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "这项调用当前不能标记为结果待核对",
          );
        }
        transaction.appendAudit({
          schemaVersion: 1,
          eventKey: randomUUID(),
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          invocationKey: record.invocationKey,
          action: "outcome_unknown",
          workerKey: lease.workerKey,
          workerGeneration: lease.workerGeneration,
          workerFingerprintHash: lease.workerFingerprintHash,
          assignmentKey: lease.assignmentKey,
          fencingToken: lease.fencingToken,
          leasedUntil: lease.leasedUntil,
          recordedAt: this.#now(),
          manifestHashAlgorithm: record.manifestHashAlgorithm,
          manifestHash: record.manifestHash,
          argumentsHashAlgorithm: record.argumentsHashAlgorithm,
          argumentsHash: record.argumentsHash,
        });
        transaction.save({
          ...record,
          status: "outcome_unknown_pending_cleanup",
        });
        return "pending_cleanup";
      },
    );
  }

  async finalizeOutcomeUnknownCleanup(
    tenantKey: string,
    projectKey: string,
    invocationKey: string,
  ): Promise<void> {
    await this.#repository.transaction(
      tenantKey,
      projectKey,
      async (transaction) => {
        const record = await transaction.find(invocationKey);
        if (!record || record.status === "outcome_unknown") return;
        if (record.status !== "outcome_unknown_pending_cleanup") {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "这项调用当前不处于结果核对流程",
          );
        }
        transaction.save({
          ...record,
          status: "outcome_unknown",
        });
      },
    );
  }

  async finalizeExecutionResult(
    tenantKey: string,
    input: {
      projectKey: string;
      invocationKey: string;
      assignmentKey: string;
      fencingToken: number;
    },
  ): Promise<void> {
    await this.#repository.transaction(
      tenantKey,
      input.projectKey,
      async (transaction) => {
        const record = await transaction.find(input.invocationKey);
        const sameLease =
          record?.executionLease?.assignmentKey === input.assignmentKey &&
          record.executionLease.fencingToken === input.fencingToken;
        if (
          record &&
          ["succeeded", "failed"].includes(record.status) &&
          sameLease
        ) {
          return;
        }
        if (
          !record ||
          record.status !== "completion_pending" ||
          !sameLease ||
          record.result === null
        ) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "MCP 执行结果与已完成的设备租约不匹配",
          );
        }
        const executionLease = record.executionLease;
        const executionResult = record.result;
        if (executionLease === null || executionResult === null) {
          throw new Error("MCP 执行完成记录缺少可信租约或结果");
        }
        transaction.appendAudit({
          schemaVersion: 1,
          eventKey: randomUUID(),
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          invocationKey: record.invocationKey,
          action: "completed",
          workerKey: executionLease.workerKey,
          workerGeneration: executionLease.workerGeneration,
          workerFingerprintHash: executionLease.workerFingerprintHash,
          assignmentKey: executionLease.assignmentKey,
          fencingToken: executionLease.fencingToken,
          outcome: executionResult.outcome,
          resultHashAlgorithm: "sha256",
          resultHash: executionResultHash(executionResult),
          recordedAt: this.#now(),
          manifestHashAlgorithm: record.manifestHashAlgorithm,
          manifestHash: record.manifestHash,
          argumentsHashAlgorithm: record.argumentsHashAlgorithm,
          argumentsHash: record.argumentsHash,
        });
        transaction.save({
          ...record,
          status: executionResult.outcome,
        });
      },
    );
  }

  async renewExecutionLease(
    tenantKey: string,
    assignment: WorkerLeaseView,
  ): Promise<void> {
    if (assignment.workKind !== "mcp_invocation" || !assignment.invocationKey) {
      return;
    }
    const outcome = await this.#repository.transaction(
      tenantKey,
      assignment.projectKey,
      async (transaction) => {
        const record = await transaction.find(assignment.invocationKey!);
        if (
          !record ||
          record.status !== "leased" ||
          record.executionLease?.assignmentKey !== assignment.assignmentKey ||
          record.executionLease.fencingToken !== assignment.fencingToken
        ) {
          throw new ApplicationError(
            409,
            "mcp_invocation_state_conflict",
            "MCP 调用与当前设备租约不匹配",
          );
        }
        const now = Date.parse(this.#now());
        const invocationLeaseExpired =
          Date.parse(record.executionLease.leasedUntil) <= now;
        const workerLeaseExpired = Date.parse(assignment.leasedUntil) <= now;
        if (
          record.effect !== "read" &&
          (invocationLeaseExpired || workerLeaseExpired)
        ) {
          transaction.appendAudit({
            schemaVersion: 1,
            eventKey: randomUUID(),
            tenantKey: record.tenantKey,
            projectKey: record.projectKey,
            invocationKey: record.invocationKey,
            action: "outcome_unknown",
            workerKey: record.executionLease.workerKey,
            workerGeneration: record.executionLease.workerGeneration,
            workerFingerprintHash: record.executionLease.workerFingerprintHash,
            assignmentKey: record.executionLease.assignmentKey,
            fencingToken: record.executionLease.fencingToken,
            leasedUntil: record.executionLease.leasedUntil,
            recordedAt: this.#now(),
            manifestHashAlgorithm: record.manifestHashAlgorithm,
            manifestHash: record.manifestHash,
            argumentsHashAlgorithm: record.argumentsHashAlgorithm,
            argumentsHash: record.argumentsHash,
          });
          transaction.save({
            ...record,
            status: "outcome_unknown_pending_cleanup",
          });
          return "outcome_unknown" as const;
        }
        if (workerLeaseExpired) {
          transaction.save({
            ...record,
            status: "queued",
            executionLease: null,
            result: null,
          });
          return "retry" as const;
        }
        if (assignment.leasedUntil > record.executionLease.leasedUntil) {
          transaction.save({
            ...record,
            executionLease: {
              ...record.executionLease,
              leasedUntil: assignment.leasedUntil,
            },
          });
        }
        return "renewed" as const;
      },
    );
    if (outcome === "outcome_unknown") {
      throw new ApplicationError(
        409,
        "mcp_outcome_unknown",
        "外部操作在续租中断期间是否生效尚不明确，已停止自动执行并等待人工核对",
      );
    }
    if (outcome === "retry") {
      throw new ApplicationError(
        409,
        "expired_lease",
        "MCP 调用租约已经过期，请重新领取",
      );
    }
  }

  async listForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<McpInvocationPeopleView[]> {
    return (await this.listItemsForPeople(principal)).map((item) => item.view);
  }

  async listItemsForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<McpInvocationItemForPeople[]> {
    const records = await this.#repository.list(
      principal.tenantKey,
      this.#projectKey,
    );
    const canApprove = principal.roles.some((role) => approvalRoles.has(role));
    const schemas = new Map<string, Promise<Record<string, unknown> | null>>();
    return Promise.all(
      records.map((record) => {
        let schema = schemas.get(record.inputSchemaHash);
        if (!schema) {
          schema = this.#schemaStore.get({
            tenantKey: record.tenantKey,
            projectKey: record.projectKey,
            hashAlgorithm: record.inputSchemaHashAlgorithm,
            hash: record.inputSchemaHash,
          });
          schemas.set(record.inputSchemaHash, schema);
        }
        return this.#itemForPeople(
          record,
          canApprove,
          canApprove || record.requestedByKey === principal.actorKey,
          schema,
        );
      }),
    );
  }

  async getItemForPeople(
    principal: AuthenticatedPrincipal,
    invocationKeyInput: string,
  ): Promise<McpInvocationItemForPeople> {
    const invocationKey = internalKey.safeParse(invocationKeyInput);
    if (!invocationKey.success) {
      throw new ApplicationError(
        404,
        "mcp_invocation_not_found",
        "找不到这项调用",
      );
    }
    const record = await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => transaction.find(invocationKey.data),
    );
    if (!record) {
      throw new ApplicationError(
        404,
        "mcp_invocation_not_found",
        "找不到这项调用",
      );
    }
    return this.#itemForPeople(
      record,
      principal.roles.some((role) => approvalRoles.has(role)),
      record.requestedByKey === principal.actorKey ||
        principal.roles.some((role) => approvalRoles.has(role)),
    );
  }

  async #itemForPeople(
    record: McpInvocationRecord,
    canApprove: boolean,
    canCancel: boolean,
    schemaPromise?: Promise<Record<string, unknown> | null>,
  ): Promise<McpInvocationItemForPeople> {
    const schema = await (schemaPromise ??
      this.#schemaStore.get({
        tenantKey: record.tenantKey,
        projectKey: record.projectKey,
        hashAlgorithm: record.inputSchemaHashAlgorithm,
        hash: record.inputSchemaHash,
      }));
    if (!schema) throw new Error("MCP 调用缺少可信参数定义");
    const inputs = projectMcpArgumentsForPeople(schema, record.arguments, {
      requireExactValues: record.approvalMode === "review_required",
    });
    return {
      invocationKey: record.invocationKey,
      view: {
        title: record.toolDisplayName,
        serviceName: record.serverName,
        status: statusForPeople(record.status),
        requestedBy: record.requestedByName,
        requestedAt: record.requestedAt,
        inputs,
        detail: ["outcome_unknown_pending_cleanup", "outcome_unknown"].includes(
          record.status,
        )
          ? "设备未能确认外部操作是否生效，请先核对目标系统，不要重复执行"
          : record.effect === "read" && record.approvalMode === "automatic"
            ? "只读操作，已通过安全规则自动确认"
            : record.approval
              ? `已由${record.approval.actorName}确认`
              : "涉及写入或外部动作，需要产品负责人确认",
      },
      allowedActions: [
        ...(canApprove && record.status === "awaiting_approval"
          ? (["approve"] as const)
          : []),
        ...(canCancel &&
        ["awaiting_approval", "queued", "cancellation_pending"].includes(
          record.status,
        )
          ? (["cancel"] as const)
          : []),
      ],
    };
  }

  #trustedManifestTool(
    tenantKey: string,
    projectKey: string,
    serverKey: string,
    manifest: McpServerManifest,
    toolKey: string,
  ): McpToolDefinition | null {
    if (
      manifest.tenantKey !== tenantKey.toLowerCase() ||
      manifest.projectKey !== projectKey.toLowerCase() ||
      manifest.serverKey !== serverKey.toLowerCase()
    ) {
      return null;
    }
    return (
      manifest.tools.find((candidate) => candidate.toolKey === toolKey) ?? null
    );
  }

  #sameValidationSnapshot(
    current: McpInvocationRecord,
    expected: McpInvocationRecord,
  ): boolean {
    return JSON.stringify(current) === JSON.stringify(expected);
  }

  #isExactBinding(
    record: McpInvocationRecord,
    manifest: McpServerManifest,
  ): boolean {
    const tool = this.#trustedManifestTool(
      record.tenantKey,
      record.projectKey,
      record.serverKey,
      manifest,
      record.toolKey,
    );
    if (!tool) return false;
    return (
      manifest.tenantKey === record.tenantKey &&
      manifest.projectKey === record.projectKey &&
      manifest.serverKey === record.serverKey &&
      manifest.revision === record.serverRevision &&
      manifest.name === record.serverName &&
      McpHealthAuthority.manifestHash(manifest) === record.manifestHash &&
      manifest.connectionBindingKey === record.connectionBindingKey &&
      tool.toolKey === record.toolKey &&
      tool.technicalName === record.technicalName &&
      tool.displayName === record.toolDisplayName &&
      tool.inputSchemaHash === record.inputSchemaHash &&
      tool.effect === record.effect &&
      tool.approval === record.approvalMode
    );
  }

  #now(): string {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("系统时间无效");
    return now.toISOString();
  }
}
