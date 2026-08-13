import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type CodexProcessEventPayload,
  WORKER_MCP_FAILED_SUMMARY,
  WORKER_MCP_SUCCEEDED_SUMMARY,
  WORKER_MCP_UNKNOWN_SUMMARY,
  WORKER_REQUIREMENT_COMPLETION_SUMMARY,
} from "@forgex/contracts";

import {
  ControlPlaneClientError,
  type McpWorkerAssignment,
  type RequirementWorkerAssignment,
  type WorkerAssignment,
  type WorkerControlPlaneClient,
} from "./control-plane-client.js";
import type {
  CodexRequirementAdapter,
  CodexRequirementResult,
} from "./codex-adapter.js";
import type {
  PendingRequirementCommit,
  PendingRequirementCompletion,
  PendingMcpCompletion,
  PendingMcpExecutionIntent,
  PendingWorkerCompletion,
  WorkerCompletionJournal,
} from "./completion-journal.js";
import type { DeviceWorkerConfig } from "./config.js";
import type {
  CompletedWorkspace,
  RequirementWorkspaceProvider,
} from "./workspace.js";

export interface LocalMcpExecutionAdapter {
  execute(input: {
    assignment: McpWorkerAssignment;
    signal?: AbortSignal;
  }): Promise<{ outcome: "succeeded" | "failed"; summary: string }>;
}

export interface DeviceWorkerRunResult {
  kind: "idle" | "requirement_completed" | "mcp_completed";
  title?: string;
  codex?: CodexRequirementResult;
  workspace?: CompletedWorkspace;
}

interface ControlPlanePort {
  heartbeat(signal?: AbortSignal): Promise<void>;
  poll(signal?: AbortSignal): Promise<WorkerAssignment | null>;
  renew(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken">,
    signal?: AbortSignal,
  ): Promise<string>;
  completeRequirement(
    assignment: PendingRequirementCompletion["assignment"],
    result: PendingRequirementCompletion["result"],
    signal?: AbortSignal,
  ): Promise<boolean>;
  completeMcp(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken"> &
      Partial<Pick<McpWorkerAssignment, "projectKey" | "invocationKey">>,
    result: {
      outcome: "succeeded" | "failed" | "unknown";
      summary: string;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
  reportRequirementProgress?(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken">,
    progress: {
      eventKey: string;
      sequence: number;
      occurredAt: string;
      event: CodexProcessEventPayload;
    },
    signal?: AbortSignal,
  ): Promise<boolean>;
}

const sameConfiguredPath = (left: string, right: string): boolean => {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

export class DeviceWorkerRuntime {
  readonly #config: DeviceWorkerConfig;
  readonly #controlPlane: ControlPlanePort;
  readonly #workspaces: RequirementWorkspaceProvider;
  readonly #codex: CodexRequirementAdapter;
  readonly #mcp: LocalMcpExecutionAdapter | null;
  readonly #completionJournal: WorkerCompletionJournal;

  constructor(options: {
    config: DeviceWorkerConfig;
    controlPlane: WorkerControlPlaneClient | ControlPlanePort;
    workspaces: RequirementWorkspaceProvider;
    codex: CodexRequirementAdapter;
    completionJournal: WorkerCompletionJournal;
    mcp?: LocalMcpExecutionAdapter;
  }) {
    this.#config = options.config;
    this.#controlPlane = options.controlPlane;
    this.#workspaces = options.workspaces;
    this.#codex = options.codex;
    this.#mcp = options.mcp ?? null;
    this.#completionJournal = options.completionJournal;
  }

  async runOnce(signal?: AbortSignal): Promise<DeviceWorkerRunResult> {
    await this.#controlPlane.heartbeat(signal);
    const recovered = await this.#retryPendingCompletion(signal);
    if (recovered) return recovered;
    const assignment = await this.#controlPlane.poll(signal);
    if (!assignment) return { kind: "idle" };
    const result = await this.#withLeaseRenewal(
      assignment,
      async (executionSignal) => {
        const executionResult =
          assignment.workKind === "requirement_delivery"
            ? await this.#runRequirement(assignment, executionSignal)
            : await this.#runMcp(assignment, executionSignal);
        const pending = this.#pendingCompletion(assignment, executionResult);
        await this.#completionJournal.save(pending);
        return executionResult;
      },
      signal,
    );
    const journalEntry = await this.#completionJournal.load();
    if (!journalEntry) {
      throw new Error("设备完成日志没有保留刚刚形成的执行结果");
    }
    if (journalEntry.kind === "mcp_invocation_started") {
      throw new Error("MCP 执行完成后没有形成可提交的持久结果");
    }
    const pending =
      journalEntry.kind === "requirement_commit_pending"
        ? await this.#recoverRequirementCommit(journalEntry)
        : journalEntry;
    await this.#completePendingWithFreshLease(pending, signal);
    const { mcpResult: _mcpResult, ...publicResult } = result;
    return publicResult;
  }

  #pendingCompletion(
    assignment: WorkerAssignment,
    result: DeviceWorkerRunResult & {
      mcpResult?: { outcome: "succeeded" | "failed"; summary: string };
    },
  ): PendingWorkerCompletion {
    if (assignment.workKind === "requirement_delivery") {
      if (!result.codex || !result.workspace) {
        throw new Error("需求交付没有形成可持久化的本地提交结果");
      }
      return {
        schemaVersion: 1,
        kind: "requirement_delivery",
        assignment: {
          assignmentKey: assignment.assignmentKey,
          fencingToken: assignment.fencingToken,
          title: assignment.title,
          projectKey: assignment.projectKey,
          repositoryKey: assignment.execution.repositoryKey,
          requirementKey: assignment.requirementKey,
          requirementRevision: assignment.requirementRevision,
        },
        result: {
          summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
          branchName: result.workspace.branchName,
          baseCommit: result.workspace.baseCommit,
          commitSha: result.workspace.commitSha,
          gitHashAlgorithm: result.workspace.gitHashAlgorithm,
        },
      };
    }
    if (!result.mcpResult) {
      throw new Error("MCP 调用没有形成可持久化的执行结果");
    }
    return this.#mcpCompletion(assignment, result.mcpResult.outcome);
  }

  async #submitPendingCompletion(
    pending: PendingWorkerCompletion,
    signal?: AbortSignal,
  ): Promise<void> {
    if (pending.kind === "requirement_delivery") {
      await this.#controlPlane.completeRequirement(
        pending.assignment,
        pending.result,
        signal,
      );
      return;
    }
    await this.#controlPlane.completeMcp(
      pending.assignment,
      pending.result,
      signal,
    );
  }

  async #retryPendingCompletion(
    signal?: AbortSignal,
  ): Promise<DeviceWorkerRunResult | null> {
    const entry = await this.#completionJournal.load();
    if (!entry) return null;
    let pending: PendingWorkerCompletion;
    if (entry.kind === "requirement_commit_pending") {
      pending = await this.#withLeaseRenewal(
        entry.assignment,
        async () => this.#recoverRequirementCommit(entry),
        signal,
      );
    } else if (entry.kind === "mcp_invocation_started") {
      pending = await this.#recoverMcpExecution(entry, signal);
    } else {
      pending = entry;
    }
    await this.#completePendingWithFreshLease(pending, signal);
    if (pending.kind === "requirement_delivery") {
      await this.#completionJournal.clear();
      return {
        kind: "requirement_completed",
        title: pending.assignment.title,
      };
    }
    await this.#completionJournal.clear();
    return { kind: "mcp_completed", title: pending.assignment.title };
  }

  async #recoverMcpExecution(
    intent: PendingMcpExecutionIntent,
    signal?: AbortSignal,
  ): Promise<PendingMcpCompletion> {
    if (intent.assignment.execution.effect !== "read") {
      const pending = this.#mcpCompletion(intent.assignment, "unknown");
      await this.#completionJournal.save(pending);
      return pending;
    }
    try {
      return await this.#withLeaseRenewal(
        intent.assignment,
        async (executionSignal) => {
          const result = await this.#executeMcp(
            intent.assignment,
            executionSignal,
          );
          const pending = this.#mcpCompletion(
            intent.assignment,
            result.outcome,
          );
          await this.#completionJournal.save(pending);
          return pending;
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof ControlPlaneClientError &&
        ["invalid_lease", "expired_lease"].includes(error.code)
      ) {
        await this.#completionJournal.clear();
      }
      throw error;
    }
  }

  async #recoverRequirementCommit(
    intent: PendingRequirementCommit,
  ): Promise<PendingRequirementCompletion> {
    const project = this.#config.projects.find(
      (item) => item.projectKey === intent.assignment.projectKey,
    );
    if (!project || project.repositoryKey !== intent.assignment.repositoryKey) {
      throw new Error("设备提交意图不属于当前配置的项目仓库");
    }
    const worktreeRoot = path.resolve(project.worktreeRoot);
    const expectedPath = path.resolve(
      worktreeRoot,
      intent.assignment.assignmentKey,
    );
    const relativePath = path.relative(worktreeRoot, expectedPath);
    const expectedBranch = `forgex/${intent.assignment.projectKey.slice(0, 8)}/${intent.assignment.assignmentKey}`;
    if (
      relativePath === "" ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      !sameConfiguredPath(intent.workspace.path, expectedPath) ||
      intent.workspace.branchName !== expectedBranch
    ) {
      throw new Error("设备提交意图中的工作树范围与权威项目配置不一致");
    }
    const trustedWorkspace = {
      path: expectedPath,
      branchName: expectedBranch,
      baseCommit: intent.workspace.baseCommit,
    };
    let workspace: CompletedWorkspace;
    try {
      workspace = await this.#workspaces.recoverCompleted(trustedWorkspace);
    } catch {
      workspace = await this.#workspaces.commitCompleted(trustedWorkspace);
    }
    const completion: PendingRequirementCompletion = {
      schemaVersion: 1,
      kind: "requirement_delivery",
      assignment: { ...intent.assignment },
      result: {
        summary: intent.summary,
        branchName: workspace.branchName,
        baseCommit: workspace.baseCommit,
        commitSha: workspace.commitSha,
        gitHashAlgorithm: workspace.gitHashAlgorithm,
      },
    };
    await this.#completionJournal.save(completion);
    return completion;
  }

  async #completePendingWithFreshLease(
    pending: PendingWorkerCompletion,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.#controlPlane.renew(pending.assignment, signal);
    } catch {
      // 已落下永久完成证明时租约会消失；仍须调用幂等完成入口收敛结果。
    }
    try {
      await this.#submitPendingCompletion(pending, signal);
      await this.#completionJournal.clear();
    } catch (error) {
      if (
        error instanceof ControlPlaneClientError &&
        [
          "invalid_lease",
          "expired_lease",
          "delivery_completion_stale",
          "delivery_completion_mismatch",
          "mcp_invocation_stale",
          "mcp_outcome_unknown",
        ].includes(error.code)
      ) {
        await this.#completionJournal.quarantine(pending, {
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  }

  async #runRequirement(
    assignment: RequirementWorkerAssignment,
    signal: AbortSignal,
  ): Promise<DeviceWorkerRunResult & { mcpResult?: never }> {
    const project = this.#config.projects.find(
      (item) => item.projectKey === assignment.projectKey,
    );
    if (!project) {
      throw new Error("设备没有配置这项交付所属项目的本地工作区");
    }
    if (project.repositoryKey !== assignment.execution.repositoryKey) {
      throw new Error("设备项目配置的仓库与权威交付任务不一致");
    }
    const workspace = await this.#workspaces.prepare(project, assignment);
    let progressSequence = 0;
    let progressReportingFailed = false;
    let progressQueue = Promise.resolve();
    const onProgress = (event: CodexProcessEventPayload): void => {
      if (
        !this.#controlPlane.reportRequirementProgress ||
        progressSequence >= 200 ||
        progressReportingFailed
      ) {
        return;
      }
      progressSequence += 1;
      const progress = {
        eventKey: randomUUID(),
        sequence: progressSequence,
        occurredAt: new Date().toISOString(),
        event: structuredClone(event),
      };
      progressQueue = progressQueue.then(async () => {
        if (progressReportingFailed) return;
        try {
          await this.#controlPlane.reportRequirementProgress!(
            assignment,
            progress,
            signal,
          );
        } catch {
          progressReportingFailed = true;
        }
      });
    };
    const codex = await this.#codex.execute({
      project,
      assignment,
      workspacePath: workspace.path,
      signal,
      onProgress,
    });
    await progressQueue;
    const commitIntent: PendingRequirementCommit = {
      schemaVersion: 1,
      kind: "requirement_commit_pending",
      assignment: {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
        title: assignment.title,
        projectKey: assignment.projectKey,
        repositoryKey: assignment.execution.repositoryKey,
        requirementKey: assignment.requirementKey,
        requirementRevision: assignment.requirementRevision,
      },
      workspace: { ...workspace },
      summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
    };
    await this.#completionJournal.saveCommitIntent(commitIntent);
    const completedWorkspace =
      await this.#workspaces.commitCompleted(workspace);
    await this.#completionJournal.save({
      schemaVersion: 1,
      kind: "requirement_delivery",
      assignment: { ...commitIntent.assignment },
      result: {
        summary: commitIntent.summary,
        branchName: completedWorkspace.branchName,
        baseCommit: completedWorkspace.baseCommit,
        commitSha: completedWorkspace.commitSha,
        gitHashAlgorithm: completedWorkspace.gitHashAlgorithm,
      },
    });
    return {
      kind: "requirement_completed",
      title: assignment.title,
      codex,
      workspace: completedWorkspace,
    };
  }

  async #runMcp(
    assignment: McpWorkerAssignment,
    signal: AbortSignal,
  ): Promise<
    DeviceWorkerRunResult & {
      mcpResult: { outcome: "succeeded" | "failed"; summary: string };
    }
  > {
    if (!this.#mcp) {
      throw new Error("设备没有配置 MCP 本地执行适配器");
    }
    const intent: PendingMcpExecutionIntent = {
      schemaVersion: 1,
      kind: "mcp_invocation_started",
      assignment: structuredClone(assignment),
    };
    await this.#completionJournal.saveMcpIntent(intent);
    const result = await this.#executeMcp(assignment, signal);
    const executionResult = {
      kind: "mcp_completed",
      title: assignment.title,
      mcpResult: {
        outcome: result.outcome,
        summary:
          result.outcome === "succeeded"
            ? WORKER_MCP_SUCCEEDED_SUMMARY
            : WORKER_MCP_FAILED_SUMMARY,
      },
    } as const;
    await this.#completionJournal.save(
      this.#mcpCompletion(assignment, result.outcome),
    );
    return executionResult;
  }

  async #executeMcp(
    assignment: McpWorkerAssignment,
    signal: AbortSignal,
  ): Promise<{ outcome: "succeeded" | "failed" }> {
    if (!this.#mcp) {
      throw new Error("设备没有配置 MCP 本地执行适配器");
    }
    return this.#mcp.execute({ assignment, signal });
  }

  #mcpCompletion(
    assignment: McpWorkerAssignment,
    outcome: "succeeded" | "failed" | "unknown",
  ): PendingMcpCompletion {
    return {
      schemaVersion: 1,
      kind: "mcp_invocation",
      assignment: {
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
        title: assignment.title,
        projectKey: assignment.projectKey,
        invocationKey: assignment.invocationKey,
      },
      result:
        outcome === "succeeded"
          ? { outcome, summary: WORKER_MCP_SUCCEEDED_SUMMARY }
          : outcome === "failed"
            ? { outcome, summary: WORKER_MCP_FAILED_SUMMARY }
            : { outcome, summary: WORKER_MCP_UNKNOWN_SUMMARY },
    };
  }

  async #withLeaseRenewal<T>(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken">,
    operation: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abortFromOuter = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) abortFromOuter();
    outerSignal?.addEventListener("abort", abortFromOuter, { once: true });

    let renewalFailure: unknown = null;
    let renewing = false;
    let renewal: Promise<void> | null = null;
    const renew = (): void => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      renewal = this.#controlPlane
        .renew(assignment, controller.signal)
        .then(() => undefined)
        .catch((error: unknown) => {
          renewalFailure = error;
          controller.abort(error);
        })
        .finally(() => {
          renewing = false;
        });
    };
    await this.#controlPlane.renew(assignment, controller.signal);
    const timer = setInterval(() => {
      renew();
    }, this.#config.renewIntervalMs);

    try {
      const result = await operation(controller.signal);
      if (renewal) await renewal;
      if (renewalFailure) throw renewalFailure;
      return result;
    } finally {
      clearInterval(timer);
      if (renewal) await renewal;
      outerSignal?.removeEventListener("abort", abortFromOuter);
    }
  }
}

export const runDeviceWorkerLoop = async (options: {
  runtime: DeviceWorkerRuntime;
  idlePollIntervalMs: number;
  signal: AbortSignal;
  onResult?: (result: DeviceWorkerRunResult) => void;
  onError?: (error: unknown) => void;
}): Promise<void> => {
  while (!options.signal.aborted) {
    try {
      const result = await options.runtime.runOnce(options.signal);
      options.onResult?.(result);
      if (result.kind !== "idle") continue;
    } catch (error) {
      if (options.signal.aborted) return;
      options.onError?.(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.idlePollIntervalMs);
      options.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
};
