import { randomUUID } from "node:crypto";

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

interface WorkerNode extends WorkerRegistration {
  tenantKey: string;
  workerKey: string;
  sessionKey: string;
  generation: number;
  lastHeartbeatAtMs: number;
  activeAssignmentKey: string | null;
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

    this.#tenantKey = options.tenantKey.trim();
    this.#maxAccounts = options.maxAccounts;
    this.#offlineAfterMs = options.offlineAfterMs ?? 30_000;
  }

  get tenantKey(): string {
    return this.#tenantKey;
  }

  register(registration: WorkerRegistration, now: Date): WorkerSession {
    const normalized = this.#normalizeRegistration(registration);
    const timestamp = toTimestamp(now, "设备连接时间");
    const existing = [...this.#workers.values()].find(
      (item) => item.accountFingerprint === normalized.accountFingerprint,
    );

    if (existing) {
      existing.deviceName = normalized.deviceName;
      existing.accountName = normalized.accountName;
      existing.capabilities = normalized.capabilities;
      existing.lastHeartbeatAtMs = timestamp;
      existing.generation += 1;
      existing.sessionKey = randomUUID();
      return this.#sessionOf(existing);
    }

    if (this.#workers.size >= this.#maxAccounts) {
      throw new Error(`最多可连接 ${this.#maxAccounts} 个 Codex 账户`);
    }

    const workerKey = randomUUID();
    const worker: WorkerNode = {
      ...normalized,
      tenantKey: this.#tenantKey,
      workerKey,
      sessionKey: randomUUID(),
      generation: 1,
      lastHeartbeatAtMs: timestamp,
      activeAssignmentKey: null,
    };
    this.#workers.set(workerKey, worker);
    return this.#sessionOf(worker);
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

  findAvailable(
    requiredCapabilities: string[],
    now: Date,
  ): WorkerSelection | null {
    const timestamp = toTimestamp(now, "派发时间");
    const worker = [...this.#workers.values()].find(
      (candidate) =>
        this.#isOnline(candidate, timestamp) &&
        candidate.activeAssignmentKey === null &&
        requiredCapabilities.every((capability) =>
          candidate.capabilities.includes(capability),
        ),
    );
    if (!worker) {
      return null;
    }
    return {
      ...this.#sessionOf(worker),
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
      throw new Error(`${worker.accountName}正在处理其他需求`);
    }
    worker.activeAssignmentKey = assignmentKey;
    this.#workTitles.set(assignmentKey, workTitle);
  }

  release(assignment: {
    workerKey: string;
    sessionKey: string;
    generation: number;
    assignmentKey: string;
  }): void {
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

  #assertCurrentSession(session: WorkerSession): WorkerNode {
    const worker = this.#workers.get(session.workerKey);
    if (!worker) {
      throw new Error("找不到对应的 Codex 设备");
    }
    if (
      session.tenantKey !== this.#tenantKey ||
      session.sessionKey !== worker.sessionKey ||
      session.generation !== worker.generation
    ) {
      throw new Error("设备连接已经失效，请重新连接");
    }
    return worker;
  }

  #isOnline(worker: WorkerNode, nowMs: number): boolean {
    return nowMs - worker.lastHeartbeatAtMs <= this.#offlineAfterMs;
  }

  #sessionOf(worker: WorkerNode): WorkerSession {
    return {
      tenantKey: worker.tenantKey,
      workerKey: worker.workerKey,
      sessionKey: worker.sessionKey,
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
      throw new Error("请为设备填写容易识别的名称");
    }
    if (!accountName) {
      throw new Error("请为 Codex 账户填写昵称");
    }
    if (!accountFingerprint) {
      throw new Error("账户指纹不能为空");
    }
    if (!fingerprintPattern.test(accountFingerprint)) {
      throw new Error("账户指纹必须是本地生成的 SHA-256 摘要");
    }
    return {
      deviceName,
      accountName,
      accountFingerprint,
      capabilities: [...new Set(registration.capabilities)],
    };
  }
}

export interface DeliveryWork {
  key: string;
  title: string;
  requiredCapabilities: string[];
}

export interface DeliveryAssignment extends WorkerSession {
  assignmentKey: string;
  workKey: string;
  workTitle: string;
  fencingToken: number;
  leasedUntil: string;
}

interface ActiveAssignment {
  tenantKey: string;
  assignmentKey: string;
  workKey: string;
  workTitle: string;
  workerKey: string;
  sessionKey: string;
  generation: number;
  fencingToken: number;
  leasedUntilMs: number;
  requiredCapabilities: string[];
}

interface CompletedAssignment {
  tenantKey: string;
  assignmentKey: string;
  workerKey: string;
  sessionKey: string;
  generation: number;
  fencingToken: number;
}

export class DeliveryQueue {
  readonly #pending: DeliveryWork[] = [];
  readonly #active = new Map<string, ActiveAssignment>();
  readonly #completed = new Map<string, CompletedAssignment>();
  readonly #registry: WorkerRegistry;
  readonly #leaseDurationMs: number;

  constructor(registry: WorkerRegistry, options: { leaseDurationMs: number }) {
    if (options.leaseDurationMs < 1) {
      throw new Error("任务租约时间必须大于零");
    }
    this.#registry = registry;
    this.#leaseDurationMs = options.leaseDurationMs;
  }

  enqueue(work: DeliveryWork): void {
    if (!work.title.trim()) {
      throw new Error("需求标题不能为空");
    }
    if (
      this.#pending.some((item) => item.key === work.key) ||
      [...this.#active.values()].some((item) => item.workKey === work.key)
    ) {
      throw new Error("这个需求已经在交付队列中");
    }
    this.#pending.push({
      ...work,
      title: work.title.trim(),
      requiredCapabilities: [...new Set(work.requiredCapabilities)],
    });
  }

  dispatch(now: Date): DeliveryAssignment[] {
    const nowMs = toTimestamp(now, "派发时间");
    const assignments: DeliveryAssignment[] = [];
    for (let index = 0; index < this.#pending.length;) {
      const work = this.#pending[index];
      if (!work) {
        break;
      }
      const selection = this.#registry.findAvailable(
        work.requiredCapabilities,
        now,
      );
      if (!selection) {
        index += 1;
        continue;
      }

      const assignmentKey = randomUUID();
      const active: ActiveAssignment = {
        ...selection,
        assignmentKey,
        workKey: work.key,
        workTitle: work.title,
        fencingToken: selection.nextFencingToken,
        leasedUntilMs: nowMs + this.#leaseDurationMs,
        requiredCapabilities: [...work.requiredCapabilities],
      };
      this.#registry.assign(selection, assignmentKey, work.title);
      this.#active.set(assignmentKey, active);
      this.#pending.splice(index, 1);
      assignments.push(this.#publicAssignment(active));
    }
    return assignments;
  }

  renewLease(input: {
    assignment: DeliveryAssignment;
    renewedAt: Date;
  }): string {
    const nowMs = toTimestamp(input.renewedAt, "续租时间");
    const active = this.#assertActive(input.assignment);
    if (active.leasedUntilMs <= nowMs) {
      throw new Error("任务租约已经过期，请重新领取");
    }
    this.#registry.assertSession(input.assignment);
    active.leasedUntilMs = nowMs + this.#leaseDurationMs;
    return new Date(active.leasedUntilMs).toISOString();
  }

  completeLease(input: { assignment: DeliveryAssignment; completedAt: Date }): {
    alreadyCompleted: boolean;
  } {
    const completed = this.#completed.get(input.assignment.assignmentKey);
    if (completed) {
      this.#assertSameLease(completed, input.assignment);
      return { alreadyCompleted: true };
    }

    const nowMs = toTimestamp(input.completedAt, "完成时间");
    const active = this.#assertActive(input.assignment);
    if (active.leasedUntilMs <= nowMs) {
      throw new Error("任务租约已经过期，请重新领取");
    }
    this.#registry.assertSession(input.assignment);
    this.#registry.release(active);
    this.#active.delete(active.assignmentKey);
    this.#completed.set(active.assignmentKey, {
      tenantKey: active.tenantKey,
      assignmentKey: active.assignmentKey,
      workerKey: active.workerKey,
      sessionKey: active.sessionKey,
      generation: active.generation,
      fencingToken: active.fencingToken,
    });
    return { alreadyCompleted: false };
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

  #assertActive(input: DeliveryAssignment): ActiveAssignment {
    const active = this.#active.get(input.assignmentKey);
    if (!active) {
      throw new Error("任务租约已经失效，请重新领取");
    }
    this.#assertSameLease(active, input);
    return active;
  }

  #assertSameLease(
    stored: CompletedAssignment | ActiveAssignment,
    input: DeliveryAssignment,
  ): void {
    if (
      stored.tenantKey !== input.tenantKey ||
      stored.workerKey !== input.workerKey ||
      stored.sessionKey !== input.sessionKey ||
      stored.generation !== input.generation ||
      stored.fencingToken !== input.fencingToken
    ) {
      throw new Error("任务租约不匹配，已拒绝本次操作");
    }
  }

  #publicAssignment(assignment: ActiveAssignment): DeliveryAssignment {
    return {
      tenantKey: assignment.tenantKey,
      assignmentKey: assignment.assignmentKey,
      workKey: assignment.workKey,
      workTitle: assignment.workTitle,
      workerKey: assignment.workerKey,
      sessionKey: assignment.sessionKey,
      generation: assignment.generation,
      fencingToken: assignment.fencingToken,
      leasedUntil: new Date(assignment.leasedUntilMs).toISOString(),
    };
  }
}
