import { randomUUID } from "node:crypto";

export interface WorkerRegistration {
  deviceName: string;
  accountName: string;
  accountFingerprint: string;
  capabilities: string[];
}

interface WorkerLease {
  assignmentKey: string;
  workKey: string;
  workTitle: string;
  expiresAt: Date;
}

interface WorkerNode extends WorkerRegistration {
  key: string;
  lastHeartbeatAt: Date;
  lease: WorkerLease | null;
}

export interface WorkerRegistryOptions {
  maxAccounts: number;
  offlineAfterMs?: number;
}

export interface WorkerPeopleView {
  deviceName: string;
  accountName: string;
  status: "空闲" | "正在工作" | "离线";
  currentWork: string | null;
}

export class WorkerRegistry {
  readonly #maxAccounts: number;
  readonly #offlineAfterMs: number;
  readonly #workers = new Map<string, WorkerNode>();

  constructor(options: WorkerRegistryOptions) {
    if (!Number.isInteger(options.maxAccounts) || options.maxAccounts < 1) {
      throw new Error("Codex 账户上限必须是正整数");
    }

    this.#maxAccounts = options.maxAccounts;
    this.#offlineAfterMs = options.offlineAfterMs ?? 30_000;
  }

  register(registration: WorkerRegistration, now: Date): string {
    this.#validateRegistration(registration);

    const existing = [...this.#workers.values()].find(
      (item) => item.accountFingerprint === registration.accountFingerprint
    );
    if (existing) {
      existing.deviceName = registration.deviceName.trim();
      existing.accountName = registration.accountName.trim();
      existing.capabilities = [...new Set(registration.capabilities)];
      existing.lastHeartbeatAt = now;
      return existing.key;
    }

    if (this.#workers.size >= this.#maxAccounts) {
      throw new Error(`最多可连接 ${this.#maxAccounts} 个 Codex 账户`);
    }

    const key = randomUUID();
    this.#workers.set(key, {
      ...registration,
      deviceName: registration.deviceName.trim(),
      accountName: registration.accountName.trim(),
      capabilities: [...new Set(registration.capabilities)],
      key,
      lastHeartbeatAt: now,
      lease: null
    });
    return key;
  }

  heartbeat(workerKey: string, now: Date): void {
    this.#get(workerKey).lastHeartbeatAt = now;
  }

  listForPeople(now: Date): WorkerPeopleView[] {
    return [...this.#workers.values()].map((worker) => {
      const online = this.#isOnline(worker, now);
      return {
        deviceName: worker.deviceName,
        accountName: worker.accountName,
        status: online ? (worker.lease ? "正在工作" : "空闲") : "离线",
        currentWork: online && worker.lease ? worker.lease.workTitle : null
      };
    });
  }

  findAvailable(requiredCapabilities: string[], now: Date): string | null {
    const worker = [...this.#workers.values()].find(
      (candidate) =>
        this.#isOnline(candidate, now) &&
        candidate.lease === null &&
        requiredCapabilities.every((capability) =>
          candidate.capabilities.includes(capability)
        )
    );
    return worker?.key ?? null;
  }

  assign(workerKey: string, lease: WorkerLease): void {
    const worker = this.#get(workerKey);
    if (worker.lease) {
      throw new Error(`${worker.accountName}正在处理其他需求`);
    }
    worker.lease = lease;
  }

  release(workerKey: string, assignmentKey: string): void {
    const worker = this.#get(workerKey);
    if (worker.lease?.assignmentKey === assignmentKey) {
      worker.lease = null;
    }
  }

  #isOnline(worker: WorkerNode, now: Date): boolean {
    return now.getTime() - worker.lastHeartbeatAt.getTime() <= this.#offlineAfterMs;
  }

  #get(workerKey: string): WorkerNode {
    const worker = this.#workers.get(workerKey);
    if (!worker) {
      throw new Error("找不到对应的 Codex 设备");
    }
    return worker;
  }

  #validateRegistration(registration: WorkerRegistration): void {
    if (!registration.deviceName.trim()) {
      throw new Error("请为设备填写容易识别的名称");
    }
    if (!registration.accountName.trim()) {
      throw new Error("请为 Codex 账户填写昵称");
    }
    if (!registration.accountFingerprint.trim()) {
      throw new Error("账户指纹不能为空");
    }
  }
}

export interface DeliveryWork {
  key: string;
  title: string;
  requiredCapabilities: string[];
}

export interface DeliveryAssignment {
  assignmentKey: string;
  workKey: string;
  workTitle: string;
  workerKey: string;
  leasedUntil: Date;
}

interface ActiveAssignment extends DeliveryAssignment {
  requiredCapabilities: string[];
}

export class DeliveryQueue {
  readonly #pending: DeliveryWork[] = [];
  readonly #active = new Map<string, ActiveAssignment>();
  readonly #registry: WorkerRegistry;
  readonly #leaseDurationMs: number;

  constructor(
    registry: WorkerRegistry,
    options: { leaseDurationMs: number }
  ) {
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
      requiredCapabilities: [...new Set(work.requiredCapabilities)]
    });
  }

  dispatch(now: Date): DeliveryAssignment[] {
    const assignments: DeliveryAssignment[] = [];

    for (let index = 0; index < this.#pending.length; ) {
      const work = this.#pending[index];
      if (!work) {
        break;
      }
      const workerKey = this.#registry.findAvailable(
        work.requiredCapabilities,
        now
      );
      if (!workerKey) {
        index += 1;
        continue;
      }

      const assignmentKey = randomUUID();
      const leasedUntil = new Date(now.getTime() + this.#leaseDurationMs);
      const active: ActiveAssignment = {
        assignmentKey,
        workKey: work.key,
        workTitle: work.title,
        workerKey,
        leasedUntil,
        requiredCapabilities: work.requiredCapabilities
      };

      this.#registry.assign(workerKey, {
        assignmentKey,
        workKey: work.key,
        workTitle: work.title,
        expiresAt: leasedUntil
      });
      this.#active.set(assignmentKey, active);
      this.#pending.splice(index, 1);
      assignments.push(this.#publicAssignment(active));
    }

    return assignments;
  }

  complete(assignmentKey: string): void {
    const assignment = this.#active.get(assignmentKey);
    if (!assignment) {
      throw new Error("找不到正在执行的交付任务");
    }
    this.#registry.release(assignment.workerKey, assignment.assignmentKey);
    this.#active.delete(assignmentKey);
  }

  renew(assignmentKey: string, now: Date): Date {
    const assignment = this.#active.get(assignmentKey);
    if (!assignment) {
      throw new Error("任务租约已经失效，请重新领取");
    }
    assignment.leasedUntil = new Date(now.getTime() + this.#leaseDurationMs);
    return assignment.leasedUntil;
  }

  reclaimExpired(now: Date): string[] {
    const reclaimed: string[] = [];
    for (const assignment of [...this.#active.values()]) {
      if (assignment.leasedUntil.getTime() > now.getTime()) {
        continue;
      }

      this.#registry.release(assignment.workerKey, assignment.assignmentKey);
      this.#active.delete(assignment.assignmentKey);
      this.#pending.push({
        key: assignment.workKey,
        title: assignment.workTitle,
        requiredCapabilities: assignment.requiredCapabilities
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
        status: "等待空闲设备" as const
      })),
      ...[...this.#active.values()].map((assignment) => ({
        title: assignment.workTitle,
        status: "正在交付" as const
      }))
    ];
  }

  #publicAssignment(assignment: ActiveAssignment): DeliveryAssignment {
    return {
      assignmentKey: assignment.assignmentKey,
      workKey: assignment.workKey,
      workTitle: assignment.workTitle,
      workerKey: assignment.workerKey,
      leasedUntil: assignment.leasedUntil
    };
  }
}

