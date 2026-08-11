import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export type WorkerDomainErrorCode =
  | "account_limit"
  | "invalid_registration"
  | "invalid_session"
  | "worker_busy"
  | "invalid_work"
  | "duplicate_work"
  | "already_completed"
  | "queue_full"
  | "invalid_lease"
  | "expired_lease";

export class WorkerDomainError extends Error {
  constructor(
    readonly code: WorkerDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkerDomainError";
  }
}

export interface WorkerRegistration {
  deviceName: string;
  accountName: string;
  accountFingerprint: string;
  capabilities: string[];
}

export interface WorkerSession {
  tenantKey: string;
  workerKey: string;
  sessionKey: string;
  generation: number;
}

export interface WorkerNodeSnapshot extends WorkerRegistration {
  tenantKey: string;
  workerKey: string;
  sessionKeyDigest: string;
  generation: number;
  lastHeartbeatAtMs: number;
  activeAssignmentKey: string | null;
  enrollmentKey?: string;
}

type WorkerNode = WorkerNodeSnapshot;

export interface WorkerRegistrySnapshot {
  schemaVersion: 1;
  tenantKey: string;
  maxAccounts: number;
  offlineAfterMs: number;
  nextFencingToken: number;
  workers: WorkerNodeSnapshot[];
  workTitles: Array<[string, string]>;
}

export interface WorkerRegistryOptions {
  tenantKey: string;
  maxAccounts: number;
  offlineAfterMs?: number;
}

export interface WorkerPeopleView {
  deviceName: string;
  accountName: string;
  status: "空闲" | "正在工作" | "离线";
  currentWork: string | null;
}

interface WorkerSelection extends WorkerSession {
  nextFencingToken: number;
}

const fingerprintPattern = /^[a-f0-9]{64}$/;
const capabilityPattern = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const createSessionKey = (): string => randomBytes(32).toString("base64url");
const digestSessionKey = (sessionKey: string): string =>
  createHash("sha256").update(sessionKey, "utf8").digest("hex");

const toTimestamp = (value: Date, fieldName: string): number => {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${fieldName}无效`);
  }
  return timestamp;
};

export class WorkerRegistry {
  readonly #tenantKey: string;
  readonly #maxAccounts: number;
  readonly #offlineAfterMs: number;
  readonly #workers = new Map<string, WorkerNode>();
  readonly #workTitles = new Map<string, string>();
  #nextFencingToken = 1;

  constructor(options: WorkerRegistryOptions) {
    if (!options.tenantKey?.trim()) {
      throw new Error("租户范围不能为空");
    }
    if (!Number.isInteger(options.maxAccounts) || options.maxAccounts < 1) {
      throw new Error("Codex 账户上限必须是正整数");
    }
    if (!Number.isSafeInteger(options.maxAccounts)) {
      throw new Error("Codex 账户上限必须是安全整数");
    }

    this.#tenantKey = options.tenantKey.trim();
    this.#maxAccounts = options.maxAccounts;
    const offlineAfterMs = options.offlineAfterMs ?? 30_000;
    if (!Number.isFinite(offlineAfterMs) || offlineAfterMs < 1) {
      throw new Error("设备离线时间必须大于零");
    }
    this.#offlineAfterMs = offlineAfterMs;
  }

  get tenantKey(): string {
    return this.#tenantKey;
  }

  accountFingerprintForWorker(workerKey: string): string {
    const worker = this.#workers.get(workerKey);
    if (!worker) {
      throw new WorkerDomainError("invalid_session", "找不到对应的 Codex 设备");
    }
    return worker.accountFingerprint;
  }

  register(
    registration: WorkerRegistration,
    now: Date,
    enrollment?: { enrollmentKey: string; sessionKey: string },
  ): WorkerSession {
    const normalized = this.#normalizeRegistration(registration);
    const timestamp = toTimestamp(now, "设备连接时间");
    if (
      enrollment &&
      (!fingerprintPattern.test(enrollment.enrollmentKey) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(enrollment.sessionKey))
    ) {
      throw new WorkerDomainError(
        "invalid_registration",
        "设备接入幂等信息格式不正确",
      );
    }
    const existing = [...this.#workers.values()].find(
      (item) => item.accountFingerprint === normalized.accountFingerprint,
    );

    if (existing) {
      existing.deviceName = normalized.deviceName;
      existing.accountName = normalized.accountName;
      existing.capabilities = normalized.capabilities;
      existing.lastHeartbeatAtMs = timestamp;
      if (
        enrollment &&
        existing.enrollmentKey === enrollment.enrollmentKey &&
        existing.sessionKeyDigest === digestSessionKey(enrollment.sessionKey)
      ) {
        return this.#sessionOf(existing, enrollment.sessionKey);
      }
      existing.generation += 1;
      const sessionKey = enrollment?.sessionKey ?? createSessionKey();
      existing.sessionKeyDigest = digestSessionKey(sessionKey);
      if (enrollment) existing.enrollmentKey = enrollment.enrollmentKey;
      else delete existing.enrollmentKey;
      return this.#sessionOf(existing, sessionKey);
    }

    if (this.#workers.size >= this.#maxAccounts) {
      throw new WorkerDomainError(
        "account_limit",
        `最多可连接 ${this.#maxAccounts} 个 Codex 账户`,
      );
    }

    const workerKey = randomUUID();
    const sessionKey = enrollment?.sessionKey ?? createSessionKey();
    const worker: WorkerNode = {
      ...normalized,
      tenantKey: this.#tenantKey,
      workerKey,
      sessionKeyDigest: digestSessionKey(sessionKey),
      generation: 1,
      lastHeartbeatAtMs: timestamp,
      activeAssignmentKey: null,
      ...(enrollment ? { enrollmentKey: enrollment.enrollmentKey } : {}),
    };
    this.#workers.set(workerKey, worker);
    return this.#sessionOf(worker, sessionKey);
  }

  heartbeat(session: WorkerSession, now: Date): void {
    const worker = this.#assertCurrentSession(session);
    worker.lastHeartbeatAtMs = toTimestamp(now, "心跳时间");
  }

  listForPeople(now: Date): WorkerPeopleView[] {
    const timestamp = toTimestamp(now, "查看时间");
    return [...this.#workers.values()].map((worker) => {
      const online = this.#isOnline(worker, timestamp);
      const currentWork = worker.activeAssignmentKey
        ? (this.#workTitles.get(worker.activeAssignmentKey) ?? null)
        : null;
      return {
        deviceName: worker.deviceName,
        accountName: worker.accountName,
        status: online
          ? worker.activeAssignmentKey
            ? "正在工作"
            : "空闲"
          : "离线",
        currentWork: online ? currentWork : null,
      };
    });
  }

  selectForWorker(
    session: WorkerSession,
    requiredCapabilities: string[],
    now: Date,
  ): WorkerSelection | null {
    const worker = this.#assertCurrentSession(session);
    const timestamp = toTimestamp(now, "派发时间");
    if (
      !this.#isOnline(worker, timestamp) ||
      worker.activeAssignmentKey !== null ||
      !requiredCapabilities.every((capability) =>
        worker.capabilities.includes(capability),
      )
    ) {
      return null;
    }
    return {
      ...session,
      nextFencingToken: this.#nextFencingToken++,
    };
  }

  assign(
    selection: WorkerSelection,
    assignmentKey: string,
    workTitle: string,
  ): void {
    const worker = this.#assertCurrentSession(selection);
    if (worker.activeAssignmentKey) {
      throw new WorkerDomainError(
        "worker_busy",
        `${worker.accountName}正在处理其他需求`,
      );
    }
    worker.activeAssignmentKey = assignmentKey;
    this.#workTitles.set(assignmentKey, workTitle);
  }

  release(assignment: { workerKey: string; assignmentKey: string }): void {
    const worker = this.#workers.get(assignment.workerKey);
    if (!worker || worker.activeAssignmentKey !== assignment.assignmentKey) {
      return;
    }
    worker.activeAssignmentKey = null;
    this.#workTitles.delete(assignment.assignmentKey);
  }

  assertSession(session: WorkerSession): void {
    this.#assertCurrentSession(session);
  }

  toSnapshot(): WorkerRegistrySnapshot {
    return {
      schemaVersion: 1,
      tenantKey: this.#tenantKey,
      maxAccounts: this.#maxAccounts,
      offlineAfterMs: this.#offlineAfterMs,
      nextFencingToken: this.#nextFencingToken,
      workers: [...this.#workers.values()].map((worker) => ({
        ...worker,
        capabilities: [...worker.capabilities],
      })),
      workTitles: [...this.#workTitles.entries()],
    };
  }

  static fromSnapshot(snapshot: WorkerRegistrySnapshot): WorkerRegistry {
    if (
      snapshot.schemaVersion !== 1 ||
      !Number.isSafeInteger(snapshot.nextFencingToken) ||
      snapshot.nextFencingToken < 1 ||
      !Array.isArray(snapshot.workers) ||
      !Array.isArray(snapshot.workTitles)
    ) {
      throw new Error("Worker 注册表快照无效");
    }
    const registry = new WorkerRegistry({
      tenantKey: snapshot.tenantKey,
      maxAccounts: snapshot.maxAccounts,
      offlineAfterMs: snapshot.offlineAfterMs,
    });
    if (snapshot.workers.length > snapshot.maxAccounts) {
      throw new Error("Worker 注册表快照超过账户上限");
    }
    const fingerprints = new Set<string>();
    const sessionDigests = new Set<string>();
    for (const worker of snapshot.workers) {
      if (
        worker.tenantKey !== snapshot.tenantKey ||
        !worker.workerKey ||
        !worker.deviceName?.trim() ||
        !worker.accountName?.trim() ||
        !fingerprintPattern.test(worker.accountFingerprint) ||
        !fingerprintPattern.test(worker.sessionKeyDigest) ||
        (worker.enrollmentKey !== undefined &&
          !fingerprintPattern.test(worker.enrollmentKey)) ||
        !Array.isArray(worker.capabilities) ||
        worker.capabilities.length > 50 ||
        worker.capabilities.some(
          (capability) => !capabilityPattern.test(capability),
        ) ||
        new Set(worker.capabilities).size !== worker.capabilities.length ||
        !Number.isSafeInteger(worker.generation) ||
        worker.generation < 1 ||
        !Number.isFinite(worker.lastHeartbeatAtMs) ||
        (worker.activeAssignmentKey !== null && !worker.activeAssignmentKey) ||
        fingerprints.has(worker.accountFingerprint) ||
        sessionDigests.has(worker.sessionKeyDigest) ||
        registry.#workers.has(worker.workerKey)
      ) {
        throw new Error("Worker 注册表快照包含无效设备");
      }
      fingerprints.add(worker.accountFingerprint);
      sessionDigests.add(worker.sessionKeyDigest);
      registry.#workers.set(worker.workerKey, {
        ...worker,
        capabilities: [...worker.capabilities],
      });
    }
    for (const entry of snapshot.workTitles) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error("Worker 注册表快照包含无效任务标题");
      }
      const [assignmentKey, title] = entry;
      if (!assignmentKey || !title || registry.#workTitles.has(assignmentKey)) {
        throw new Error("Worker 注册表快照包含无效任务标题");
      }
      registry.#workTitles.set(assignmentKey, title);
    }
    registry.#nextFencingToken = snapshot.nextFencingToken;
    return registry;
  }

  #assertCurrentSession(session: WorkerSession): WorkerNode {
    const worker = this.#workers.get(session.workerKey);
    if (!worker) {
      throw new WorkerDomainError("invalid_session", "找不到对应的 Codex 设备");
    }
    if (
      session.tenantKey !== this.#tenantKey ||
      !timingSafeEqual(
        Buffer.from(digestSessionKey(session.sessionKey), "hex"),
        Buffer.from(worker.sessionKeyDigest, "hex"),
      ) ||
      session.generation !== worker.generation
    ) {
      throw new WorkerDomainError(
        "invalid_session",
        "设备连接已经失效，请重新连接",
      );
    }
    return worker;
  }

  #isOnline(worker: WorkerNode, nowMs: number): boolean {
    return nowMs - worker.lastHeartbeatAtMs <= this.#offlineAfterMs;
  }

  #sessionOf(worker: WorkerNode, sessionKey: string): WorkerSession {
    return {
      tenantKey: worker.tenantKey,
      workerKey: worker.workerKey,
      sessionKey,
      generation: worker.generation,
    };
  }

  #normalizeRegistration(registration: WorkerRegistration): WorkerRegistration {
    const deviceName = registration.deviceName.trim();
    const accountName = registration.accountName.trim();
    const accountFingerprint = registration.accountFingerprint
      .trim()
      .toLowerCase();
    if (!deviceName) {
      throw new WorkerDomainError(
        "invalid_registration",
        "请为设备填写容易识别的名称",
      );
    }
    if (!accountName) {
      throw new WorkerDomainError(
        "invalid_registration",
        "请为 Codex 账户填写昵称",
      );
    }
    if (!accountFingerprint) {
      throw new WorkerDomainError("invalid_registration", "账户指纹不能为空");
    }
    if (!fingerprintPattern.test(accountFingerprint)) {
      throw new WorkerDomainError(
        "invalid_registration",
        "账户指纹必须是本地生成的 SHA-256 摘要",
      );
    }
    const capabilities = registration.capabilities.map((capability) =>
      capability.trim().toLowerCase(),
    );
    if (
      capabilities.length > 50 ||
      capabilities.some((capability) => !capabilityPattern.test(capability))
    ) {
      throw new WorkerDomainError("invalid_registration", "设备能力格式不正确");
    }
    return {
      deviceName,
      accountName,
      accountFingerprint,
      capabilities: [...new Set(capabilities)],
    };
  }
}

export type DeliveryWorkKind = "requirement_delivery" | "mcp_invocation";

const isDeliveryWorkKind = (
  value: unknown,
): value is DeliveryWorkKind | undefined =>
  value === undefined ||
  value === "requirement_delivery" ||
  value === "mcp_invocation";

export interface DeliveryWork {
  workKind?: DeliveryWorkKind;
  projectKey: string;
  requirementRevision: number;
  key: string;
  title: string;
  requiredCapabilities: string[];
}

export interface DeliveryAssignment extends WorkerSession {
  workKind: DeliveryWorkKind;
  assignmentKey: string;
  projectKey: string;
  requirementRevision: number;
  workKey: string;
  workTitle: string;
  fencingToken: number;
  leasedUntil: string;
}

export interface WorkerLeaseReference {
  assignmentKey: string;
  fencingToken: number;
}

export interface DeliveryActiveAssignmentSnapshot {
  workKind?: DeliveryWorkKind;
  tenantKey: string;
  assignmentKey: string;
  projectKey: string;
  requirementRevision: number;
  workKey: string;
  workTitle: string;
  workerKey: string;
  generation: number;
  fencingToken: number;
  leasedUntilMs: number;
  requiredCapabilities: string[];
}

export interface DeliveryCompletionSnapshot {
  workKind?: DeliveryWorkKind;
  tenantKey: string;
  assignmentKey: string;
  projectKey: string;
  requirementRevision: number;
  workerKey: string;
  generation: number;
  fencingToken: number;
  workKey: string;
  completedAtMs: number;
}

type ActiveAssignment = DeliveryActiveAssignmentSnapshot;
type CompletedAssignment = DeliveryCompletionSnapshot;

const scopedWorkKey = (
  workKind: DeliveryWorkKind | undefined,
  projectKey: string,
  workKey: string,
  requirementRevision: number,
): string =>
  `${workKind ?? "requirement_delivery"}:${projectKey}:${workKey}:${requirementRevision}`;

export interface DeliveryQueueSnapshot {
  schemaVersion: 1;
  leaseDurationMs: number;
  maxPendingWork: number;
  maxMcpPendingWork?: number;
  completionRetentionMs: number;
  maxCompletionTombstones: number;
  pending: DeliveryWork[];
  active: DeliveryActiveAssignmentSnapshot[];
  completed: DeliveryCompletionSnapshot[];
}

export class DeliveryQueue {
  readonly #pending: DeliveryWork[] = [];
  readonly #active = new Map<string, ActiveAssignment>();
  readonly #completed = new Map<string, CompletedAssignment>();
  readonly #completedWorkKeys = new Set<string>();
  readonly #registry: WorkerRegistry;
  readonly #leaseDurationMs: number;
  readonly #maxPendingWork: number;
  readonly #maxMcpPendingWork: number;
  readonly #completionRetentionMs: number;
  readonly #maxCompletionTombstones: number;

  constructor(
    registry: WorkerRegistry,
    options: {
      leaseDurationMs: number;
      maxPendingWork?: number;
      maxMcpPendingWork?: number;
      completionRetentionMs?: number;
      maxCompletionTombstones?: number;
    },
  ) {
    if (
      !Number.isFinite(options.leaseDurationMs) ||
      options.leaseDurationMs < 1
    ) {
      throw new Error("任务租约时间必须大于零");
    }
    const maxPendingWork = options.maxPendingWork ?? 500;
    if (!Number.isSafeInteger(maxPendingWork) || maxPendingWork < 1) {
      throw new Error("等待队列上限必须是正整数");
    }
    const maxMcpPendingWork =
      options.maxMcpPendingWork ?? Math.min(100, maxPendingWork);
    if (
      !Number.isSafeInteger(maxMcpPendingWork) ||
      maxMcpPendingWork < 1 ||
      maxMcpPendingWork > maxPendingWork
    ) {
      throw new Error("MCP 等待队列上限必须是总队列范围内的正整数");
    }
    const completionRetentionMs = options.completionRetentionMs ?? 86_400_000;
    if (!Number.isFinite(completionRetentionMs) || completionRetentionMs < 1) {
      throw new Error("完成幂等窗口必须大于零");
    }
    const maxCompletionTombstones = options.maxCompletionTombstones ?? 1_000;
    if (
      !Number.isSafeInteger(maxCompletionTombstones) ||
      maxCompletionTombstones < 1
    ) {
      throw new Error("完成幂等记录上限必须是正整数");
    }
    this.#registry = registry;
    this.#leaseDurationMs = options.leaseDurationMs;
    this.#maxPendingWork = maxPendingWork;
    this.#maxMcpPendingWork = maxMcpPendingWork;
    this.#completionRetentionMs = completionRetentionMs;
    this.#maxCompletionTombstones = maxCompletionTombstones;
  }

  enqueue(work: DeliveryWork): void {
    if (!work.title.trim()) {
      throw new WorkerDomainError("invalid_work", "需求标题不能为空");
    }
    if (
      !work.projectKey?.trim() ||
      !Number.isSafeInteger(work.requirementRevision) ||
      work.requirementRevision < 1
    ) {
      throw new WorkerDomainError("invalid_work", "交付任务范围不完整");
    }
    if (
      this.#pending.some(
        (item) =>
          item.projectKey === work.projectKey &&
          (item.workKind ?? "requirement_delivery") ===
            (work.workKind ?? "requirement_delivery") &&
          item.key === work.key &&
          item.requirementRevision === work.requirementRevision,
      ) ||
      [...this.#active.values()].some(
        (item) =>
          item.projectKey === work.projectKey &&
          (item.workKind ?? "requirement_delivery") ===
            (work.workKind ?? "requirement_delivery") &&
          item.workKey === work.key &&
          item.requirementRevision === work.requirementRevision,
      )
    ) {
      throw new WorkerDomainError("duplicate_work", "这个需求已经在交付队列中");
    }
    if (
      this.#completedWorkKeys.has(
        scopedWorkKey(
          work.workKind,
          work.projectKey,
          work.key,
          work.requirementRevision,
        ),
      )
    ) {
      throw new WorkerDomainError("already_completed", "这个需求已经完成交付");
    }
    if (this.#pending.length + this.#active.size >= this.#maxPendingWork) {
      throw new WorkerDomainError(
        "queue_full",
        "等待交付的需求过多，请稍后再试",
      );
    }
    if (
      (work.workKind ?? "requirement_delivery") === "mcp_invocation" &&
      this.#pending.filter(
        (item) =>
          (item.workKind ?? "requirement_delivery") === "mcp_invocation",
      ).length +
        [...this.#active.values()].filter(
          (item) =>
            (item.workKind ?? "requirement_delivery") === "mcp_invocation",
        ).length >=
        this.#maxMcpPendingWork
    ) {
      throw new WorkerDomainError(
        "queue_full",
        "等待执行的外部操作过多，请稍后再试",
      );
    }
    this.#pending.push({
      ...work,
      workKind: work.workKind ?? "requirement_delivery",
      projectKey: work.projectKey.trim().toLowerCase(),
      title: work.title.trim(),
      requiredCapabilities: [...new Set(work.requiredCapabilities)],
    });
  }

  cancelPendingWork(input: {
    workKind: DeliveryWorkKind;
    projectKey: string;
    workKey: string;
    workRevision: number;
  }): boolean {
    const index = this.#pending.findIndex(
      (work) =>
        (work.workKind ?? "requirement_delivery") === input.workKind &&
        work.projectKey === input.projectKey &&
        work.key === input.workKey &&
        work.requirementRevision === input.workRevision,
    );
    if (index < 0) return false;
    this.#pending.splice(index, 1);
    return true;
  }

  cancelWork(input: {
    workKind: DeliveryWorkKind;
    projectKey: string;
    workKey: string;
    workRevision: number;
  }): boolean {
    if (this.cancelPendingWork(input)) return true;
    const active = [...this.#active.values()].find(
      (assignment) =>
        (assignment.workKind ?? "requirement_delivery") === input.workKind &&
        assignment.projectKey === input.projectKey &&
        assignment.workKey === input.workKey &&
        assignment.requirementRevision === input.workRevision,
    );
    if (!active) return false;
    this.#registry.release(active);
    this.#active.delete(active.assignmentKey);
    return true;
  }

  dispatchForWorker(
    session: WorkerSession,
    now: Date,
  ): DeliveryAssignment | null {
    const nowMs = toTimestamp(now, "派发时间");
    for (let index = 0; index < this.#pending.length; index += 1) {
      const work = this.#pending[index];
      if (!work) {
        continue;
      }
      const selection = this.#registry.selectForWorker(
        session,
        work.requiredCapabilities,
        now,
      );
      if (!selection) {
        continue;
      }
      const assignment = this.#createAssignment(selection, work, nowMs);
      this.#pending.splice(index, 1);
      return assignment;
    }
    return null;
  }

  currentAssignmentForWorker(
    session: WorkerSession,
  ): DeliveryAssignment | null {
    this.#registry.assertSession(session);
    const active = [...this.#active.values()].find(
      (assignment) =>
        assignment.workerKey === session.workerKey &&
        assignment.generation === session.generation,
    );
    return active ? this.#publicAssignment(active, session.sessionKey) : null;
  }

  renewLease(input: {
    assignment: DeliveryAssignment;
    renewedAt: Date;
  }): string {
    return this.renewLeaseForWorker(
      input.assignment,
      input.assignment,
      input.renewedAt,
    );
  }

  renewLeaseForWorker(
    session: WorkerSession,
    reference: WorkerLeaseReference,
    renewedAt: Date,
  ): string {
    const nowMs = toTimestamp(renewedAt, "续租时间");
    this.#registry.assertSession(session);
    const active = this.#assertActiveForWorker(session, reference);
    if (active.leasedUntilMs <= nowMs) {
      throw new WorkerDomainError(
        "expired_lease",
        "任务租约已经过期，请重新领取",
      );
    }
    active.leasedUntilMs = nowMs + this.#leaseDurationMs;
    return new Date(active.leasedUntilMs).toISOString();
  }

  completeLease(input: { assignment: DeliveryAssignment; completedAt: Date }): {
    alreadyCompleted: boolean;
  } {
    return this.completeLeaseForWorker(
      input.assignment,
      input.assignment,
      input.completedAt,
    );
  }

  completeLeaseForWorker(
    session: WorkerSession,
    reference: WorkerLeaseReference,
    completedAt: Date,
  ): { alreadyCompleted: boolean } {
    const nowMs = toTimestamp(completedAt, "完成时间");
    this.#registry.assertSession(session);
    this.#pruneCompleted(nowMs);
    const completed = this.#completed.get(reference.assignmentKey);
    if (completed) {
      this.#assertCompletedLease(completed, session, reference);
      return { alreadyCompleted: true };
    }

    const active = this.#assertActiveForWorker(session, reference);
    if (active.leasedUntilMs <= nowMs) {
      throw new WorkerDomainError(
        "expired_lease",
        "任务租约已经过期，请重新领取",
      );
    }
    this.#registry.release(active);
    this.#active.delete(active.assignmentKey);
    this.#rememberCompleted({
      tenantKey: active.tenantKey,
      workKind: active.workKind ?? "requirement_delivery",
      assignmentKey: active.assignmentKey,
      projectKey: active.projectKey,
      requirementRevision: active.requirementRevision,
      workerKey: active.workerKey,
      generation: active.generation,
      fencingToken: active.fencingToken,
      workKey: active.workKey,
      completedAtMs: nowMs,
    });
    return { alreadyCompleted: false };
  }

  completedWorkForWorker(
    session: WorkerSession,
    reference: WorkerLeaseReference,
  ): DeliveryCompletionSnapshot | null {
    this.#registry.assertSession(session);
    const completed = this.#completed.get(reference.assignmentKey);
    if (!completed) return null;
    this.#assertCompletedLease(completed, session, reference);
    return { ...completed };
  }

  abandonLease(assignment: DeliveryAssignment): void {
    const active = this.#assertActive(assignment);
    this.#registry.release(active);
    this.#active.delete(active.assignmentKey);
    this.#pending.unshift({
      key: active.workKey,
      workKind: active.workKind ?? "requirement_delivery",
      projectKey: active.projectKey,
      requirementRevision: active.requirementRevision,
      title: active.workTitle,
      requiredCapabilities: [...active.requiredCapabilities],
    });
  }

  cancelLeaseForWorker(
    session: WorkerSession,
    reference: WorkerLeaseReference,
  ): void {
    this.#registry.assertSession(session);
    const active = this.#assertActiveForWorker(session, reference);
    this.#registry.release(active);
    this.#active.delete(active.assignmentKey);
  }

  abandonWorker(workerKey: string): void {
    const active = [...this.#active.values()].find(
      (assignment) => assignment.workerKey === workerKey,
    );
    if (!active) {
      return;
    }
    this.#registry.release(active);
    this.#active.delete(active.assignmentKey);
    this.#pending.unshift({
      key: active.workKey,
      workKind: active.workKind ?? "requirement_delivery",
      projectKey: active.projectKey,
      requirementRevision: active.requirementRevision,
      title: active.workTitle,
      requiredCapabilities: [...active.requiredCapabilities],
    });
  }

  reclaimExpired(now: Date): string[] {
    const nowMs = toTimestamp(now, "租约回收时间");
    const reclaimed: string[] = [];
    for (const assignment of [...this.#active.values()]) {
      if (assignment.leasedUntilMs > nowMs) {
        continue;
      }
      this.#registry.release(assignment);
      this.#active.delete(assignment.assignmentKey);
      this.#pending.push({
        key: assignment.workKey,
        workKind: assignment.workKind ?? "requirement_delivery",
        projectKey: assignment.projectKey,
        requirementRevision: assignment.requirementRevision,
        title: assignment.workTitle,
        requiredCapabilities: [...assignment.requiredCapabilities],
      });
      reclaimed.push(assignment.workTitle);
    }
    return reclaimed;
  }

  listForPeople(): Array<{
    title: string;
    status: "等待空闲设备" | "正在交付";
  }> {
    return [
      ...this.#pending.map((work) => ({
        title: work.title,
        status: "等待空闲设备" as const,
      })),
      ...[...this.#active.values()].map((assignment) => ({
        title: assignment.workTitle,
        status: "正在交付" as const,
      })),
    ];
  }

  toSnapshot(): DeliveryQueueSnapshot {
    return {
      schemaVersion: 1,
      leaseDurationMs: this.#leaseDurationMs,
      maxPendingWork: this.#maxPendingWork,
      maxMcpPendingWork: this.#maxMcpPendingWork,
      completionRetentionMs: this.#completionRetentionMs,
      maxCompletionTombstones: this.#maxCompletionTombstones,
      pending: this.#pending.map((work) => ({
        ...work,
        requiredCapabilities: [...work.requiredCapabilities],
      })),
      active: [...this.#active.values()].map((assignment) => ({
        ...assignment,
        requiredCapabilities: [...assignment.requiredCapabilities],
      })),
      completed: [...this.#completed.values()].map((completed) => ({
        ...completed,
      })),
    };
  }

  static fromSnapshot(
    registry: WorkerRegistry,
    snapshot: DeliveryQueueSnapshot,
  ): DeliveryQueue {
    if (
      snapshot.schemaVersion !== 1 ||
      !Array.isArray(snapshot.pending) ||
      !Array.isArray(snapshot.active) ||
      !Array.isArray(snapshot.completed)
    ) {
      throw new Error("交付队列快照无效");
    }
    const queue = new DeliveryQueue(registry, {
      leaseDurationMs: snapshot.leaseDurationMs,
      maxPendingWork: snapshot.maxPendingWork,
      maxMcpPendingWork:
        snapshot.maxMcpPendingWork ?? Math.min(100, snapshot.maxPendingWork),
      completionRetentionMs: snapshot.completionRetentionMs,
      maxCompletionTombstones: snapshot.maxCompletionTombstones,
    });
    if (
      snapshot.pending.length + snapshot.active.length >
        snapshot.maxPendingWork ||
      [...snapshot.pending, ...snapshot.active].filter(
        (item) =>
          (item.workKind ?? "requirement_delivery") === "mcp_invocation",
      ).length > queue.#maxMcpPendingWork ||
      snapshot.completed.length > snapshot.maxCompletionTombstones
    ) {
      throw new Error("交付队列快照超过容量上限");
    }
    const registrySnapshot = registry.toSnapshot();
    const workers = new Map(
      registrySnapshot.workers.map((worker) => [worker.workerKey, worker]),
    );
    const workTitles = new Map(registrySnapshot.workTitles);
    const scopedKeys = new Set<string>();
    let greatestFencingToken = 0;
    for (const work of snapshot.pending) {
      const key = scopedWorkKey(
        work.workKind,
        work.projectKey,
        work.key,
        work.requirementRevision,
      );
      if (
        !isDeliveryWorkKind(work.workKind) ||
        !work.projectKey?.trim() ||
        !work.key ||
        !work.title?.trim() ||
        !Number.isSafeInteger(work.requirementRevision) ||
        work.requirementRevision < 1 ||
        !Array.isArray(work.requiredCapabilities) ||
        work.requiredCapabilities.some(
          (capability) => !capabilityPattern.test(capability),
        ) ||
        scopedKeys.has(key)
      ) {
        throw new Error("交付队列快照包含无效等待任务");
      }
      scopedKeys.add(key);
      queue.#pending.push({
        ...work,
        workKind: work.workKind ?? "requirement_delivery",
        requiredCapabilities: [...work.requiredCapabilities],
      });
    }
    for (const active of snapshot.active) {
      const worker = workers.get(active.workerKey);
      const key = scopedWorkKey(
        active.workKind,
        active.projectKey,
        active.workKey,
        active.requirementRevision,
      );
      if (
        !isDeliveryWorkKind(active.workKind) ||
        active.tenantKey !== registrySnapshot.tenantKey ||
        !active.projectKey?.trim() ||
        !active.assignmentKey ||
        !active.workerKey ||
        !active.workKey ||
        !Number.isSafeInteger(active.generation) ||
        active.generation < 1 ||
        !Number.isSafeInteger(active.fencingToken) ||
        active.fencingToken < 1 ||
        !Number.isSafeInteger(active.requirementRevision) ||
        active.requirementRevision < 1 ||
        !Number.isFinite(active.leasedUntilMs) ||
        !Array.isArray(active.requiredCapabilities) ||
        active.requiredCapabilities.some(
          (capability) => !capabilityPattern.test(capability),
        ) ||
        !worker ||
        worker.generation !== active.generation ||
        worker.activeAssignmentKey !== active.assignmentKey ||
        workTitles.get(active.assignmentKey) !== active.workTitle ||
        scopedKeys.has(key) ||
        queue.#active.has(active.assignmentKey)
      ) {
        throw new Error("交付队列快照包含无效活跃租约");
      }
      scopedKeys.add(key);
      greatestFencingToken = Math.max(
        greatestFencingToken,
        active.fencingToken,
      );
      queue.#active.set(active.assignmentKey, {
        ...active,
        workKind: active.workKind ?? "requirement_delivery",
        requiredCapabilities: [...active.requiredCapabilities],
      });
    }
    if (
      registrySnapshot.workers.some(
        (worker) =>
          worker.activeAssignmentKey !== null &&
          !queue.#active.has(worker.activeAssignmentKey),
      ) ||
      workTitles.size !== queue.#active.size
    ) {
      throw new Error("Worker 注册表与交付队列的活跃租约不一致");
    }
    for (const completed of snapshot.completed) {
      const key = scopedWorkKey(
        completed.workKind,
        completed.projectKey,
        completed.workKey,
        completed.requirementRevision,
      );
      if (
        !isDeliveryWorkKind(completed.workKind) ||
        completed.tenantKey !== registrySnapshot.tenantKey ||
        !completed.projectKey?.trim() ||
        !completed.assignmentKey ||
        !completed.workerKey ||
        !completed.workKey ||
        !Number.isSafeInteger(completed.generation) ||
        completed.generation < 1 ||
        !Number.isSafeInteger(completed.fencingToken) ||
        completed.fencingToken < 1 ||
        !Number.isSafeInteger(completed.requirementRevision) ||
        completed.requirementRevision < 1 ||
        !Number.isFinite(completed.completedAtMs) ||
        scopedKeys.has(key) ||
        queue.#completed.has(completed.assignmentKey)
      ) {
        throw new Error("交付队列快照包含无效完成记录");
      }
      scopedKeys.add(key);
      greatestFencingToken = Math.max(
        greatestFencingToken,
        completed.fencingToken,
      );
      queue.#completed.set(completed.assignmentKey, {
        ...completed,
        workKind: completed.workKind ?? "requirement_delivery",
      });
      queue.#completedWorkKeys.add(
        scopedWorkKey(
          completed.workKind,
          completed.projectKey,
          completed.workKey,
          completed.requirementRevision,
        ),
      );
    }
    if (registrySnapshot.nextFencingToken <= greatestFencingToken) {
      throw new Error("Worker 注册表的 fencing token 不是单调值");
    }
    return queue;
  }

  #assertActive(input: DeliveryAssignment): ActiveAssignment {
    const active = this.#active.get(input.assignmentKey);
    if (!active) {
      throw new WorkerDomainError(
        "invalid_lease",
        "任务租约已经失效，请重新领取",
      );
    }
    this.#assertSameLease(active, input);
    return active;
  }

  #assertActiveForWorker(
    session: WorkerSession,
    reference: WorkerLeaseReference,
  ): ActiveAssignment {
    const active = this.#active.get(reference.assignmentKey);
    if (!active) {
      throw new WorkerDomainError(
        "invalid_lease",
        "任务租约已经失效，请重新领取",
      );
    }
    if (
      active.tenantKey !== session.tenantKey ||
      active.workerKey !== session.workerKey ||
      active.generation !== session.generation ||
      active.fencingToken !== reference.fencingToken
    ) {
      throw new WorkerDomainError(
        "invalid_lease",
        "任务租约不匹配，已拒绝本次操作",
      );
    }
    return active;
  }

  #createAssignment(
    selection: WorkerSelection,
    work: DeliveryWork,
    nowMs: number,
  ): DeliveryAssignment {
    const assignmentKey = randomUUID();
    const active: ActiveAssignment = {
      tenantKey: selection.tenantKey,
      workKind: work.workKind ?? "requirement_delivery",
      workerKey: selection.workerKey,
      generation: selection.generation,
      assignmentKey,
      projectKey: work.projectKey,
      requirementRevision: work.requirementRevision,
      workKey: work.key,
      workTitle: work.title,
      fencingToken: selection.nextFencingToken,
      leasedUntilMs: nowMs + this.#leaseDurationMs,
      requiredCapabilities: [...work.requiredCapabilities],
    };
    this.#registry.assign(selection, assignmentKey, work.title);
    this.#active.set(assignmentKey, active);
    return this.#publicAssignment(active, selection.sessionKey);
  }

  #assertSameLease(stored: ActiveAssignment, input: DeliveryAssignment): void {
    if (
      stored.tenantKey !== input.tenantKey ||
      stored.workerKey !== input.workerKey ||
      stored.generation !== input.generation ||
      stored.fencingToken !== input.fencingToken
    ) {
      throw new WorkerDomainError(
        "invalid_lease",
        "任务租约不匹配，已拒绝本次操作",
      );
    }
  }

  #assertCompletedLease(
    stored: CompletedAssignment,
    session: WorkerSession,
    reference: WorkerLeaseReference,
  ): void {
    if (
      stored.tenantKey !== session.tenantKey ||
      stored.workerKey !== session.workerKey ||
      stored.generation !== session.generation ||
      stored.fencingToken !== reference.fencingToken
    ) {
      throw new WorkerDomainError(
        "invalid_lease",
        "任务租约不匹配，已拒绝本次操作",
      );
    }
  }

  #rememberCompleted(completed: CompletedAssignment): void {
    while (this.#completed.size >= this.#maxCompletionTombstones) {
      const oldestKey = this.#completed.keys().next().value as
        string | undefined;
      if (!oldestKey) {
        break;
      }
      this.#removeCompleted(oldestKey);
    }
    this.#completed.set(completed.assignmentKey, completed);
    this.#completedWorkKeys.add(
      scopedWorkKey(
        completed.workKind,
        completed.projectKey,
        completed.workKey,
        completed.requirementRevision,
      ),
    );
  }

  #pruneCompleted(nowMs: number): void {
    for (const [assignmentKey, completed] of this.#completed) {
      if (nowMs - completed.completedAtMs >= this.#completionRetentionMs) {
        this.#removeCompleted(assignmentKey);
      }
    }
  }

  #removeCompleted(assignmentKey: string): void {
    const completed = this.#completed.get(assignmentKey);
    if (!completed) {
      return;
    }
    this.#completed.delete(assignmentKey);
    this.#completedWorkKeys.delete(
      scopedWorkKey(
        completed.workKind,
        completed.projectKey,
        completed.workKey,
        completed.requirementRevision,
      ),
    );
  }

  #publicAssignment(
    assignment: ActiveAssignment,
    sessionKey: string,
  ): DeliveryAssignment {
    return {
      tenantKey: assignment.tenantKey,
      workKind: assignment.workKind ?? "requirement_delivery",
      assignmentKey: assignment.assignmentKey,
      projectKey: assignment.projectKey,
      requirementRevision: assignment.requirementRevision,
      workKey: assignment.workKey,
      workTitle: assignment.workTitle,
      workerKey: assignment.workerKey,
      sessionKey,
      generation: assignment.generation,
      fencingToken: assignment.fencingToken,
      leasedUntil: new Date(assignment.leasedUntilMs).toISOString(),
    };
  }
}
