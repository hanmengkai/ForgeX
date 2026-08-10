import type {
  DeliveryQueueSnapshot,
  DeliveryWorkKind,
  WorkerRegistrySnapshot,
} from "@forgex/domain";

export interface WorkerFleetSnapshot {
  schemaVersion: 1;
  registry: WorkerRegistrySnapshot;
  queue: DeliveryQueueSnapshot;
}

export interface WorkerCompletionProof {
  assignmentKey: string;
  fencingToken: number;
  completionDigest?: string;
}

export interface WorkerFleetTransaction {
  load(): WorkerFleetSnapshot | null;
  save(snapshot: WorkerFleetSnapshot): void;
  hasCompletedWork(
    projectKey: string,
    workKey: string,
    requirementRevision: number,
    workKind?: DeliveryWorkKind,
    proof?: WorkerCompletionProof,
  ): Promise<boolean>;
  markCompletedWork(
    projectKey: string,
    workKey: string,
    requirementRevision: number,
    workKind?: DeliveryWorkKind,
    proof?: WorkerCompletionProof,
  ): Promise<void>;
}

export interface WorkerFleetRepository {
  transaction<T>(
    tenantKey: string,
    operation: (transaction: WorkerFleetTransaction) => Promise<T> | T,
  ): Promise<T>;
}

const copySnapshot = (snapshot: WorkerFleetSnapshot): WorkerFleetSnapshot =>
  structuredClone(snapshot);

const completedWorkKey = (
  projectKey: string,
  workKey: string,
  requirementRevision: number,
  workKind: DeliveryWorkKind = "requirement_delivery",
): string =>
  `${workKind}:${projectKey.toLowerCase()}:${workKey.toLowerCase()}:${requirementRevision}`;

export class InMemoryWorkerFleetRepository implements WorkerFleetRepository {
  readonly #snapshots = new Map<string, WorkerFleetSnapshot>();
  readonly #completedWorkKeys = new Map<
    string,
    Map<string, WorkerCompletionProof | null>
  >();
  readonly #tenantTails = new Map<string, Promise<void>>();

  async transaction<T>(
    tenantKey: string,
    operation: (transaction: WorkerFleetTransaction) => Promise<T> | T,
  ): Promise<T> {
    const normalizedTenantKey = tenantKey.toLowerCase();
    const previous =
      this.#tenantTails.get(normalizedTenantKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tenantTails.set(normalizedTenantKey, current);
    await previous;

    const stored = this.#snapshots.get(normalizedTenantKey);
    let pending = stored ? copySnapshot(stored) : null;
    const pendingCompletedWorkKeys = new Map(
      this.#completedWorkKeys.get(normalizedTenantKey) ?? [],
    );
    let changed = false;
    let completedWorkChanged = false;
    const transaction: WorkerFleetTransaction = {
      load: () => (pending ? copySnapshot(pending) : null),
      save: (snapshot) => {
        if (snapshot.registry.tenantKey.toLowerCase() !== normalizedTenantKey) {
          throw new Error("Worker 舰队事务不能写入其他租户");
        }
        pending = copySnapshot(snapshot);
        changed = true;
      },
      hasCompletedWork: async (
        projectKey,
        workKey,
        requirementRevision,
        workKind,
        proof,
      ) => {
        const stored = pendingCompletedWorkKeys.get(
          completedWorkKey(projectKey, workKey, requirementRevision, workKind),
        );
        if (stored === undefined) return false;
        return proof
          ? stored?.assignmentKey === proof.assignmentKey &&
              stored.fencingToken === proof.fencingToken &&
              (proof.completionDigest === undefined ||
                stored.completionDigest === proof.completionDigest)
          : true;
      },
      markCompletedWork: async (
        projectKey,
        workKey,
        requirementRevision,
        workKind,
        proof,
      ) => {
        const key = completedWorkKey(
          projectKey,
          workKey,
          requirementRevision,
          workKind,
        );
        if (!pendingCompletedWorkKeys.has(key)) {
          pendingCompletedWorkKeys.set(key, proof ? { ...proof } : null);
          completedWorkChanged = true;
        }
      },
    };

    try {
      const result = await operation(transaction);
      if (changed && pending) {
        this.#snapshots.set(normalizedTenantKey, copySnapshot(pending));
      }
      if (completedWorkChanged) {
        this.#completedWorkKeys.set(
          normalizedTenantKey,
          new Map(pendingCompletedWorkKeys),
        );
      }
      return result;
    } finally {
      release();
      if (this.#tenantTails.get(normalizedTenantKey) === current) {
        this.#tenantTails.delete(normalizedTenantKey);
      }
    }
  }
}
