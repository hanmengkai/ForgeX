import {
  WorkerConnectionCredentialSchema,
  WorkerLeaseCommandSchema,
  WorkerRegistrationSchema,
  type WorkerConnectionCredentialPayload,
  type WorkerLeaseCommandPayload,
  type WorkerRegistrationPayload,
} from "@forgex/contracts";
import {
  DeliveryQueue,
  WorkerDomainError,
  WorkerRegistry,
  type WorkerPeopleView,
  type WorkerSession,
} from "@forgex/domain";

import type { AuthenticatedPrincipal, PlatformRole } from "./auth.js";
import { ApplicationError } from "./errors.js";
import type {
  DeliveryDispatchRecord,
  DeliveryRunResult,
} from "./requirement-repository.js";
import type {
  WorkerFleetRepository,
  WorkerFleetSnapshot,
  WorkerFleetTransaction,
} from "./worker-fleet-repository.js";

export interface WorkerFleetServiceOptions {
  repository: WorkerFleetRepository;
  clock?: () => Date;
  maxAccounts?: number;
  offlineAfterMs?: number;
  leaseDurationMs?: number;
  maxPendingWork?: number;
  maxMcpPendingWork?: number;
  completionRetentionMs?: number;
  maxCompletionTombstones?: number;
}

export interface WorkerConnectionResult {
  device: {
    deviceName: string;
    accountName: string;
    status: "已连接";
  };
  connection: WorkerConnectionCredentialPayload;
}

export interface WorkerLeaseView {
  workKind: "requirement_delivery" | "mcp_invocation";
  assignmentKey: string;
  fencingToken: number;
  workerKey: string;
  generation: number;
  workerFingerprintHash: string;
  projectKey: string;
  requirementRevision: number;
  requirementKey: string;
  invocationKey?: string;
  title: string;
  leasedUntil: string;
}

export interface McpInvocationDispatch {
  tenantKey: string;
  projectKey: string;
  invocationKey: string;
  serverRevision: number;
  title: string;
  connectionBindingKey: string;
}

export interface McpWorkerCompletionResult {
  alreadyCompleted: boolean;
  completion: {
    projectKey: string;
    invocationKey: string;
    assignmentKey: string;
    fencingToken: number;
  };
}

export interface WorkerPollResult {
  assignment: WorkerLeaseView | null;
}

export interface WorkerFleetPeopleOverview {
  workers: WorkerPeopleView[];
  capacity: {
    connectedAccounts: number;
    unlimited: true;
  };
}

interface FleetAggregate {
  registry: WorkerRegistry;
  queue: DeliveryQueue;
}

type WorkerManagementAction = "connect";

const rolesByAction = {
  connect: new Set<PlatformRole>(["administrator"]),
} satisfies Record<WorkerManagementAction, ReadonlySet<PlatformRole>>;

export const canConnectWorker = (principal: AuthenticatedPrincipal): boolean =>
  principal.roles.some((role) => rolesByAction.connect.has(role));

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNLIMITED_ACCOUNTS = Number.MAX_SAFE_INTEGER;

export class WorkerFleetService {
  readonly #repository: WorkerFleetRepository;
  readonly #clock: () => Date;
  readonly #maxAccounts: number;
  readonly #offlineAfterMs: number;
  readonly #leaseDurationMs: number;
  readonly #maxPendingWork: number;
  readonly #maxMcpPendingWork: number;
  readonly #completionRetentionMs: number;
  readonly #maxCompletionTombstones: number;

  constructor(options: WorkerFleetServiceOptions) {
    this.#repository = options.repository;
    this.#clock = options.clock ?? (() => new Date());
    this.#maxAccounts = options.maxAccounts ?? UNLIMITED_ACCOUNTS;
    this.#offlineAfterMs = options.offlineAfterMs ?? 30_000;
    this.#leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.#maxPendingWork = options.maxPendingWork ?? 500;
    this.#maxMcpPendingWork =
      options.maxMcpPendingWork ?? Math.min(100, this.#maxPendingWork);
    this.#completionRetentionMs = options.completionRetentionMs ?? 86_400_000;
    this.#maxCompletionTombstones = options.maxCompletionTombstones ?? 1_000;
    if (!Number.isSafeInteger(this.#maxAccounts) || this.#maxAccounts < 1) {
      throw new Error("Codex 账户上限必须是正安全整数");
    }
    if (!Number.isFinite(this.#offlineAfterMs) || this.#offlineAfterMs < 1) {
      throw new Error("设备离线时间必须大于零");
    }
    if (!Number.isFinite(this.#leaseDurationMs) || this.#leaseDurationMs < 1) {
      throw new Error("任务租约时间必须大于零");
    }
    if (
      !Number.isSafeInteger(this.#maxPendingWork) ||
      this.#maxPendingWork < 1
    ) {
      throw new Error("等待队列上限必须是正整数");
    }
    if (
      !Number.isSafeInteger(this.#maxMcpPendingWork) ||
      this.#maxMcpPendingWork < 1 ||
      this.#maxMcpPendingWork > this.#maxPendingWork
    ) {
      throw new Error("MCP 等待队列上限必须在总队列范围内");
    }
    if (
      !Number.isFinite(this.#completionRetentionMs) ||
      this.#completionRetentionMs < 1
    ) {
      throw new Error("完成幂等窗口必须大于零");
    }
    if (
      !Number.isSafeInteger(this.#maxCompletionTombstones) ||
      this.#maxCompletionTombstones < 1
    ) {
      throw new Error("完成幂等记录上限必须是正整数");
    }
  }

  async connect(
    principal: AuthenticatedPrincipal,
    input: WorkerRegistrationPayload,
    enrollment?: { enrollmentKey: string; sessionKey: string },
  ): Promise<WorkerConnectionResult> {
    this.#requireAction(principal, "connect");
    const registration = WorkerRegistrationSchema.safeParse(input);
    if (!registration.success) {
      throw new ApplicationError(
        422,
        "invalid_worker_registration",
        "设备连接信息需要调整",
      );
    }
    return this.#repository.transaction(principal.tenantKey, (transaction) => {
      const fleet = this.#loadFleet(transaction, principal.tenantKey);
      const previousGeneration = fleet.registry
        .toSnapshot()
        .workers.find(
          (worker) =>
            worker.accountFingerprint ===
            registration.data.accountFingerprint.toLowerCase(),
        )?.generation;
      const session = this.#runDomain(() =>
        fleet.registry.register(
          {
            deviceName: registration.data.deviceName,
            accountName: registration.data.accountName,
            accountFingerprint: registration.data.accountFingerprint,
            capabilities: registration.data.capabilities,
          },
          this.#now(),
          enrollment,
        ),
      );
      if (
        previousGeneration !== undefined &&
        session.generation > previousGeneration
      ) {
        fleet.queue.abandonWorker(session.workerKey);
      }
      this.#saveFleet(transaction, fleet);
      return {
        device: {
          deviceName: registration.data.deviceName,
          accountName: registration.data.accountName,
          status: "已连接" as const,
        },
        connection: WorkerConnectionCredentialSchema.parse({
          schemaVersion: 1,
          tenantKey: session.tenantKey,
          workerKey: session.workerKey,
          sessionKey: session.sessionKey,
          generation: session.generation,
        }),
      };
    });
  }

  async listForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkerPeopleView[]> {
    return (await this.overviewForPeople(principal)).workers;
  }

  async overviewForPeople(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkerFleetPeopleOverview> {
    return this.#repository.transaction(principal.tenantKey, (transaction) => {
      const snapshot = transaction.load();
      const workers = snapshot
        ? this.#restoreFleet(
            snapshot,
            principal.tenantKey,
          ).registry.listForPeople(this.#now())
        : [];
      return {
        workers,
        capacity: {
          connectedAccounts: workers.length,
          unlimited: true,
        },
      };
    });
  }

  async enqueueDispatch(
    dispatch: DeliveryDispatchRecord,
  ): Promise<{ title: string; status: "等待空闲设备" | "已经完成" }> {
    if (
      !internalKeyPattern.test(dispatch.tenantKey) ||
      !internalKeyPattern.test(dispatch.projectKey) ||
      !internalKeyPattern.test(dispatch.requirementKey) ||
      !Number.isSafeInteger(dispatch.requirementRevision) ||
      dispatch.requirementRevision < 1
    ) {
      throw new Error("交付派发记录范围无效");
    }
    return this.#repository.transaction(
      dispatch.tenantKey,
      async (transaction) => {
        const fleet = this.#loadFleet(transaction, dispatch.tenantKey);
        if (
          await transaction.hasCompletedWork(
            dispatch.projectKey,
            dispatch.requirementKey,
            dispatch.requirementRevision,
          )
        ) {
          return { title: dispatch.title, status: "已经完成" as const };
        }
        try {
          this.#runDomain(() =>
            fleet.queue.enqueue({
              projectKey: dispatch.projectKey,
              requirementRevision: dispatch.requirementRevision,
              key: dispatch.requirementKey,
              title: dispatch.title,
              requiredCapabilities: dispatch.requiredCapabilities,
            }),
          );
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            error.code !== "duplicate_work"
          ) {
            throw error;
          }
        }
        this.#saveFleet(transaction, fleet);
        return { title: dispatch.title, status: "等待空闲设备" as const };
      },
    );
  }

  async enqueueMcpInvocation(
    dispatch: McpInvocationDispatch,
  ): Promise<{ title: string; status: "等待空闲设备" | "已经完成" }> {
    if (
      !internalKeyPattern.test(dispatch.tenantKey) ||
      !internalKeyPattern.test(dispatch.projectKey) ||
      !internalKeyPattern.test(dispatch.invocationKey) ||
      !internalKeyPattern.test(dispatch.connectionBindingKey) ||
      !Number.isSafeInteger(dispatch.serverRevision) ||
      dispatch.serverRevision < 1 ||
      !dispatch.title.trim()
    ) {
      throw new Error("MCP 调用派发记录范围无效");
    }
    return this.#repository.transaction(
      dispatch.tenantKey,
      async (transaction) => {
        const fleet = this.#loadFleet(transaction, dispatch.tenantKey);
        if (
          await transaction.hasCompletedWork(
            dispatch.projectKey,
            dispatch.invocationKey,
            dispatch.serverRevision,
            "mcp_invocation",
          )
        ) {
          return { title: dispatch.title, status: "已经完成" as const };
        }
        try {
          this.#runDomain(() =>
            fleet.queue.enqueue({
              workKind: "mcp_invocation",
              projectKey: dispatch.projectKey,
              requirementRevision: dispatch.serverRevision,
              key: dispatch.invocationKey,
              title: dispatch.title,
              requiredCapabilities: [dispatch.connectionBindingKey],
            }),
          );
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            error.code !== "duplicate_work"
          ) {
            throw error;
          }
        }
        this.#saveFleet(transaction, fleet);
        return { title: dispatch.title, status: "等待空闲设备" as const };
      },
    );
  }

  async cancelPendingMcpInvocation(
    dispatch: McpInvocationDispatch,
  ): Promise<void> {
    await this.#repository.transaction(dispatch.tenantKey, (transaction) => {
      const fleet = this.#loadFleet(transaction, dispatch.tenantKey);
      if (
        fleet.queue.cancelWork({
          workKind: "mcp_invocation",
          projectKey: dispatch.projectKey,
          workKey: dispatch.invocationKey,
          workRevision: dispatch.serverRevision,
        })
      ) {
        this.#saveFleet(transaction, fleet);
      }
    });
  }

  async isMcpInvocationCompleted(
    dispatch: McpInvocationDispatch,
    completion: { assignmentKey: string; fencingToken: number },
  ): Promise<boolean> {
    if (
      !internalKeyPattern.test(completion.assignmentKey) ||
      !Number.isSafeInteger(completion.fencingToken) ||
      completion.fencingToken < 1
    ) {
      throw new Error("MCP 完成凭据格式无效");
    }
    return this.#repository.transaction(dispatch.tenantKey, (transaction) =>
      transaction.hasCompletedWork(
        dispatch.projectKey,
        dispatch.invocationKey,
        dispatch.serverRevision,
        "mcp_invocation",
        completion,
      ),
    );
  }

  async isRequirementDeliveryCompleted(
    run: Pick<
      DeliveryRunResult,
      "tenantKey" | "projectKey" | "requirementKey" | "requirementRevision"
    >,
    completion: {
      assignmentKey: string;
      fencingToken: number;
      completionDigest: string;
    },
  ): Promise<boolean> {
    if (
      !internalKeyPattern.test(completion.assignmentKey) ||
      !Number.isSafeInteger(completion.fencingToken) ||
      completion.fencingToken < 1
    ) {
      throw new Error("交付完成凭据格式无效");
    }
    if (!/^[a-f0-9]{64}$/u.test(completion.completionDigest)) {
      throw new Error("交付完成内容摘要格式无效");
    }
    return this.#repository.transaction(run.tenantKey, (transaction) =>
      transaction.hasCompletedWork(
        run.projectKey,
        run.requirementKey,
        run.requirementRevision,
        "requirement_delivery",
        completion,
      ),
    );
  }

  async heartbeat(
    input: WorkerConnectionCredentialPayload,
  ): Promise<{ status: "在线" }> {
    const credential = this.#parseConnection(input);
    return this.#repository.transaction(
      credential.tenantKey,
      async (transaction) => {
        const fleet = this.#requireFleet(transaction, credential.tenantKey);
        const session = this.#sessionOf(credential);
        this.#runDomain(() => fleet.registry.heartbeat(session, this.#now()));
        this.#saveFleet(transaction, fleet);
        return { status: "在线" as const };
      },
    );
  }

  async assertConnection(
    input: WorkerConnectionCredentialPayload,
  ): Promise<void> {
    const credential = this.#parseConnection(input);
    await this.#repository.transaction(credential.tenantKey, (transaction) => {
      const fleet = this.#requireFleet(transaction, credential.tenantKey);
      this.#runDomain(() =>
        fleet.registry.assertSession(this.#sessionOf(credential)),
      );
    });
  }

  async poll(
    input: WorkerConnectionCredentialPayload,
  ): Promise<WorkerPollResult> {
    const credential = this.#parseConnection(input);
    return this.#repository.transaction(credential.tenantKey, (transaction) => {
      const fleet = this.#requireFleet(transaction, credential.tenantKey);
      const session = this.#sessionOf(credential);
      const now = this.#now();
      this.#runDomain(() => fleet.registry.heartbeat(session, now));
      this.#runDomain(() => fleet.queue.reclaimExpired(now));
      const current = this.#runDomain(() =>
        fleet.queue.currentAssignmentForWorker(session),
      );
      const assignment =
        current ??
        this.#runDomain(() => fleet.queue.dispatchForWorker(session, now));
      this.#saveFleet(transaction, fleet);
      return {
        assignment: assignment
          ? this.#toLeaseView(assignment, fleet.registry)
          : null,
      };
    });
  }

  async renew(
    connection: WorkerConnectionCredentialPayload,
    input: WorkerLeaseCommandPayload,
  ): Promise<{ leasedUntil: string }> {
    const credential = this.#parseConnection(connection);
    const command = this.#parseLeaseCommand(input);
    return this.#repository.transaction(credential.tenantKey, (transaction) => {
      const fleet = this.#requireFleet(transaction, credential.tenantKey);
      const leasedUntil = this.#runDomain(() =>
        fleet.queue.renewLeaseForWorker(
          this.#sessionOf(credential),
          command,
          this.#now(),
        ),
      );
      this.#saveFleet(transaction, fleet);
      return { leasedUntil };
    });
  }

  async complete(
    connection: WorkerConnectionCredentialPayload,
    input: WorkerLeaseCommandPayload,
    completionDigest: string,
  ): Promise<{ alreadyCompleted: boolean }> {
    const credential = this.#parseConnection(connection);
    const command = this.#parseLeaseCommand(input);
    if (!/^[a-f0-9]{64}$/u.test(completionDigest)) {
      throw new Error("交付完成内容摘要格式无效");
    }
    return this.#repository.transaction(
      credential.tenantKey,
      async (transaction) => {
        const fleet = this.#requireFleet(transaction, credential.tenantKey);
        const session = this.#sessionOf(credential);
        const current = this.#runDomain(() =>
          fleet.queue.currentAssignmentForWorker(session),
        );
        const result = this.#runDomain(() =>
          fleet.queue.completeLeaseForWorker(session, command, this.#now()),
        );
        if (!result.alreadyCompleted && current) {
          if (
            (current.workKind ?? "requirement_delivery") !==
            "requirement_delivery"
          ) {
            throw new ApplicationError(
              409,
              "mcp_completion_required",
              "MCP 调用必须通过受控结果入口完成",
            );
          }
          await transaction.markCompletedWork(
            current.projectKey,
            current.workKey,
            current.requirementRevision,
            "requirement_delivery",
            {
              assignmentKey: current.assignmentKey,
              fencingToken: current.fencingToken,
              completionDigest,
            },
          );
        }
        this.#saveFleet(transaction, fleet);
        return result;
      },
    );
  }

  async completeMcp(
    connection: WorkerConnectionCredentialPayload,
    input: WorkerLeaseCommandPayload,
  ): Promise<McpWorkerCompletionResult> {
    const credential = this.#parseConnection(connection);
    const command = this.#parseLeaseCommand(input);
    return this.#repository.transaction(
      credential.tenantKey,
      async (transaction) => {
        const fleet = this.#requireFleet(transaction, credential.tenantKey);
        const session = this.#sessionOf(credential);
        const current = this.#runDomain(() =>
          fleet.queue.currentAssignmentForWorker(session),
        );
        if (
          current &&
          (current.workKind ?? "requirement_delivery") !== "mcp_invocation"
        ) {
          throw new ApplicationError(
            409,
            "invalid_work_kind",
            "当前租约不是 MCP 调用",
          );
        }
        const result = this.#runDomain(() =>
          fleet.queue.completeLeaseForWorker(session, command, this.#now()),
        );
        if (!result.alreadyCompleted && current) {
          await transaction.markCompletedWork(
            current.projectKey,
            current.workKey,
            current.requirementRevision,
            "mcp_invocation",
            {
              assignmentKey: current.assignmentKey,
              fencingToken: current.fencingToken,
            },
          );
        }
        const completed =
          current ??
          this.#runDomain(() =>
            fleet.queue.completedWorkForWorker(session, command),
          );
        if (
          !completed ||
          (completed.workKind ?? "requirement_delivery") !== "mcp_invocation"
        ) {
          throw new ApplicationError(
            409,
            "invalid_work_kind",
            "当前完成记录不是 MCP 调用",
          );
        }
        this.#saveFleet(transaction, fleet);
        return {
          ...result,
          completion: {
            projectKey: completed.projectKey,
            invocationKey: completed.workKey,
            assignmentKey: completed.assignmentKey,
            fencingToken: completed.fencingToken,
          },
        };
      },
    );
  }

  async getMcpLease(
    connection: WorkerConnectionCredentialPayload,
    input: WorkerLeaseCommandPayload,
  ): Promise<WorkerLeaseView> {
    const credential = this.#parseConnection(connection);
    const command = this.#parseLeaseCommand(input);
    return this.#repository.transaction(credential.tenantKey, (transaction) => {
      const fleet = this.#requireFleet(transaction, credential.tenantKey);
      const current = this.#runDomain(() =>
        fleet.queue.currentAssignmentForWorker(this.#sessionOf(credential)),
      );
      if (
        !current ||
        current.workKind !== "mcp_invocation" ||
        current.assignmentKey !== command.assignmentKey ||
        current.fencingToken !== command.fencingToken ||
        Date.parse(current.leasedUntil) <= this.#now().getTime()
      ) {
        throw new ApplicationError(
          409,
          "invalid_lease",
          "MCP 调用租约已经失效，请重新领取",
        );
      }
      return this.#toLeaseView(current, fleet.registry);
    });
  }

  async getRequirementLease(
    connection: WorkerConnectionCredentialPayload,
    input: WorkerLeaseCommandPayload,
  ): Promise<WorkerLeaseView> {
    const credential = this.#parseConnection(connection);
    const command = this.#parseLeaseCommand(input);
    return this.#repository.transaction(credential.tenantKey, (transaction) => {
      const fleet = this.#requireFleet(transaction, credential.tenantKey);
      const current = this.#runDomain(() =>
        fleet.queue.currentAssignmentForWorker(this.#sessionOf(credential)),
      );
      if (
        !current ||
        (current.workKind ?? "requirement_delivery") !==
          "requirement_delivery" ||
        current.assignmentKey !== command.assignmentKey ||
        current.fencingToken !== command.fencingToken ||
        Date.parse(current.leasedUntil) <= this.#now().getTime()
      ) {
        throw new ApplicationError(
          409,
          "invalid_lease",
          "交付任务租约已经失效，请重新领取",
        );
      }
      return this.#toLeaseView(current, fleet.registry);
    });
  }

  async getCurrentLease(
    connection: WorkerConnectionCredentialPayload,
    input: WorkerLeaseCommandPayload,
  ): Promise<WorkerLeaseView> {
    const credential = this.#parseConnection(connection);
    const command = this.#parseLeaseCommand(input);
    return this.#repository.transaction(credential.tenantKey, (transaction) => {
      const fleet = this.#requireFleet(transaction, credential.tenantKey);
      const current = this.#runDomain(() =>
        fleet.queue.currentAssignmentForWorker(this.#sessionOf(credential)),
      );
      if (
        !current ||
        current.assignmentKey !== command.assignmentKey ||
        current.fencingToken !== command.fencingToken ||
        Date.parse(current.leasedUntil) <= this.#now().getTime()
      ) {
        throw new ApplicationError(
          409,
          "invalid_lease",
          "任务租约已经失效，请重新领取",
        );
      }
      return this.#toLeaseView(current, fleet.registry);
    });
  }

  async cancelMcpLease(
    connection: WorkerConnectionCredentialPayload,
    input: WorkerLeaseCommandPayload,
  ): Promise<void> {
    const credential = this.#parseConnection(connection);
    const command = this.#parseLeaseCommand(input);
    await this.#repository.transaction(credential.tenantKey, (transaction) => {
      const fleet = this.#requireFleet(transaction, credential.tenantKey);
      const session = this.#sessionOf(credential);
      const current = this.#runDomain(() =>
        fleet.queue.currentAssignmentForWorker(session),
      );
      if (!current) return;
      if (current.workKind !== "mcp_invocation") {
        throw new ApplicationError(
          409,
          "invalid_work_kind",
          "当前租约不是 MCP 调用",
        );
      }
      this.#runDomain(() => fleet.queue.cancelLeaseForWorker(session, command));
      this.#saveFleet(transaction, fleet);
    });
  }

  #loadFleet(
    transaction: WorkerFleetTransaction,
    tenantKey: string,
  ): FleetAggregate {
    const snapshot = transaction.load();
    if (snapshot) {
      return this.#restoreFleet(snapshot, tenantKey);
    }
    const registry = new WorkerRegistry({
      tenantKey: tenantKey.toLowerCase(),
      maxAccounts: this.#maxAccounts,
      offlineAfterMs: this.#offlineAfterMs,
    });
    return {
      registry,
      queue: new DeliveryQueue(registry, {
        leaseDurationMs: this.#leaseDurationMs,
        maxPendingWork: this.#maxPendingWork,
        maxMcpPendingWork: this.#maxMcpPendingWork,
        completionRetentionMs: this.#completionRetentionMs,
        maxCompletionTombstones: this.#maxCompletionTombstones,
      }),
    };
  }

  #requireFleet(
    transaction: WorkerFleetTransaction,
    tenantKey: string,
  ): FleetAggregate {
    const snapshot = transaction.load();
    if (!snapshot) {
      throw new ApplicationError(
        401,
        "invalid_worker_session",
        "设备连接已经失效，请重新连接",
      );
    }
    return this.#restoreFleet(snapshot, tenantKey);
  }

  #restoreFleet(
    snapshot: WorkerFleetSnapshot,
    tenantKey: string,
  ): FleetAggregate {
    if (
      snapshot.registry.tenantKey !== tenantKey.toLowerCase() ||
      (snapshot.registry.maxAccounts !== this.#maxAccounts &&
        !(
          this.#maxAccounts === UNLIMITED_ACCOUNTS &&
          snapshot.registry.maxAccounts <= 5
        )) ||
      snapshot.registry.offlineAfterMs !== this.#offlineAfterMs ||
      snapshot.queue.leaseDurationMs !== this.#leaseDurationMs ||
      snapshot.queue.maxPendingWork !== this.#maxPendingWork ||
      (snapshot.queue.maxMcpPendingWork ??
        Math.min(100, snapshot.queue.maxPendingWork)) !==
        this.#maxMcpPendingWork ||
      snapshot.queue.completionRetentionMs !== this.#completionRetentionMs ||
      snapshot.queue.maxCompletionTombstones !== this.#maxCompletionTombstones
    ) {
      throw new Error("Worker 舰队运行参数与持久化配置不一致");
    }
    const registry = WorkerRegistry.fromSnapshot({
      ...snapshot.registry,
      maxAccounts: this.#maxAccounts,
    });
    return {
      registry,
      queue: DeliveryQueue.fromSnapshot(registry, snapshot.queue),
    };
  }

  #saveFleet(transaction: WorkerFleetTransaction, fleet: FleetAggregate): void {
    transaction.save({
      schemaVersion: 1,
      registry: fleet.registry.toSnapshot(),
      queue: fleet.queue.toSnapshot(),
    });
  }

  #parseConnection(
    input: WorkerConnectionCredentialPayload,
  ): WorkerConnectionCredentialPayload {
    const credential = WorkerConnectionCredentialSchema.safeParse(input);
    if (!credential.success) {
      throw new ApplicationError(
        401,
        "invalid_worker_session",
        "设备连接已经失效，请重新连接",
      );
    }
    return credential.data;
  }

  #sessionOf(credential: WorkerConnectionCredentialPayload): WorkerSession {
    return {
      tenantKey: credential.tenantKey,
      workerKey: credential.workerKey,
      sessionKey: credential.sessionKey,
      generation: credential.generation,
    };
  }

  #parseLeaseCommand(
    input: WorkerLeaseCommandPayload,
  ): WorkerLeaseCommandPayload {
    const command = WorkerLeaseCommandSchema.safeParse(input);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "invalid_lease_command",
        "任务租约信息需要调整",
      );
    }
    return command.data;
  }

  #toLeaseView(
    assignment: {
      workKind: "requirement_delivery" | "mcp_invocation";
      assignmentKey: string;
      fencingToken: number;
      projectKey: string;
      requirementRevision: number;
      workKey: string;
      workTitle: string;
      workerKey: string;
      generation: number;
      leasedUntil: string;
    },
    registry: WorkerRegistry,
  ): WorkerLeaseView {
    return {
      workKind: assignment.workKind,
      assignmentKey: assignment.assignmentKey,
      fencingToken: assignment.fencingToken,
      workerKey: assignment.workerKey,
      generation: assignment.generation,
      workerFingerprintHash: registry.accountFingerprintForWorker(
        assignment.workerKey,
      ),
      projectKey: assignment.projectKey,
      requirementRevision: assignment.requirementRevision,
      requirementKey: assignment.workKey,
      ...(assignment.workKind === "mcp_invocation"
        ? { invocationKey: assignment.workKey }
        : {}),
      title: assignment.workTitle,
      leasedUntil: assignment.leasedUntil,
    };
  }

  #requireAction(
    principal: AuthenticatedPrincipal,
    action: WorkerManagementAction,
  ): void {
    if (action === "connect" && !canConnectWorker(principal)) {
      throw new ApplicationError(
        403,
        "permission_denied",
        "当前账号没有执行此操作的权限",
      );
    }
  }

  #runDomain<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!(error instanceof WorkerDomainError)) {
        throw error;
      }
      switch (error.code) {
        case "invalid_session":
          throw new ApplicationError(
            401,
            "invalid_worker_session",
            error.message,
          );
        case "invalid_registration":
        case "invalid_work":
          throw new ApplicationError(422, error.code, error.message);
        case "account_limit":
        case "worker_busy":
        case "duplicate_work":
        case "already_completed":
        case "invalid_lease":
        case "expired_lease":
          throw new ApplicationError(409, error.code, error.message);
        case "queue_full":
          throw new ApplicationError(429, error.code, error.message);
      }
    }
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("服务端时间无效");
    }
    return new Date(value.getTime());
  }
}
