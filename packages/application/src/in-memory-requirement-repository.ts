import type {
  DeliveryDispatchRecord,
  RequirementAuditEvent,
  RequirementRecord,
  RequirementRepository,
  RequirementTransaction,
  RequirementListOptions,
  RequirementListPage,
} from "./requirement-repository.js";
import {
  DeliveryRunResultSchema,
  type DeliveryRunResult,
} from "./requirement-repository.js";

const scopedKey = (
  tenantKey: string,
  projectKey: string,
  requirementKey: string,
): string => `${tenantKey}:${projectKey}:${requirementKey}`;

const deliveryRunKey = (
  tenantKey: string,
  projectKey: string,
  requirementKey: string,
  requirementRevision: number,
): string =>
  `${tenantKey}:${projectKey}:${requirementKey}:${requirementRevision}`;

export class InMemoryRequirementRepository implements RequirementRepository {
  readonly #records = new Map<string, RequirementRecord>();
  readonly #positions = new Map<string, number>();
  readonly #auditEvents: RequirementAuditEvent[] = [];
  readonly #deliveryDispatches = new Map<string, DeliveryDispatchRecord>();
  readonly #deliveryRunResults = new Map<string, DeliveryRunResult>();
  readonly #scopeTails = new Map<string, Promise<void>>();
  #nextPosition = 0;

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    const normalizedTenantKey = tenantKey.toLowerCase();
    const normalizedProjectKey = projectKey.toLowerCase();
    const transactionScope = `${normalizedTenantKey}:${normalizedProjectKey}`;
    const previous =
      this.#scopeTails.get(transactionScope) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#scopeTails.set(transactionScope, current);
    await previous;

    const pendingRecords = new Map<string, RequirementRecord>();
    const loadedRecords = new Map<string, RequirementRecord>();
    const pendingAuditEvents: RequirementAuditEvent[] = [];
    const pendingDeliveryDispatches = new Map<string, DeliveryDispatchRecord>();
    const pendingDeliveryRunResults = new Map<string, DeliveryRunResult>();
    const transaction: RequirementTransaction = {
      find: async (requirementKey) => {
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          requirementKey,
        );
        const pending = pendingRecords.get(key);
        if (pending) {
          return this.#copyRecord(pending);
        }
        const loaded = loadedRecords.get(key);
        if (loaded) {
          return loaded;
        }
        const stored = this.#records.get(key);
        if (!stored) {
          return null;
        }
        const transactionalCopy = this.#copyRecord(stored);
        loadedRecords.set(key, transactionalCopy);
        return transactionalCopy;
      },
      save: (record) => {
        if (record.tenantKey.toLowerCase() !== normalizedTenantKey) {
          throw new Error("事务不能写入其他租户的需求");
        }
        if (record.projectKey.toLowerCase() !== normalizedProjectKey) {
          throw new Error("事务不能写入其他项目的需求");
        }
        record.workflow.assertPersistenceIdentity({
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          requirementKey: record.requirementKey,
        });
        record.workflow.assertSpecIntegrity(record.spec);
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          record.requirementKey,
        );
        const detached = this.#copyRecord(record);
        loadedRecords.set(key, detached);
        pendingRecords.set(key, detached);
      },
      appendAudit: (event) => {
        if (event.tenantKey.toLowerCase() !== normalizedTenantKey) {
          throw new Error("事务不能写入其他租户的审计事件");
        }
        if (event.projectKey.toLowerCase() !== normalizedProjectKey) {
          throw new Error("事务不能写入其他项目的审计事件");
        }
        pendingAuditEvents.push({ ...event });
      },
      appendDeliveryDispatch: (record) => {
        this.#assertDeliveryScope(
          record,
          normalizedTenantKey,
          normalizedProjectKey,
        );
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          record.dispatchKey,
        );
        if (
          pendingDeliveryDispatches.has(key) ||
          this.#deliveryDispatches.has(key)
        ) {
          throw new Error("交付派发记录不能重复");
        }
        pendingDeliveryDispatches.set(key, this.#copyDeliveryDispatch(record));
      },
      markDeliveryDispatched: async (dispatchKey, dispatchedAt) => {
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          dispatchKey,
        );
        const current =
          pendingDeliveryDispatches.get(key) ??
          this.#deliveryDispatches.get(key);
        if (!current) {
          throw new Error("没有找到待派发的交付记录");
        }
        if (current.dispatchedAt !== null) {
          return false;
        }
        pendingDeliveryDispatches.set(key, {
          ...this.#copyDeliveryDispatch(current),
          dispatchedAt,
        });
        return true;
      },
      findDeliveryDispatch: async (requirementKey, requirementRevision) => {
        const matches = [
          ...this.#deliveryDispatches.values(),
          ...pendingDeliveryDispatches.values(),
        ].filter(
          (record) =>
            record.tenantKey === normalizedTenantKey &&
            record.projectKey === normalizedProjectKey &&
            record.requirementKey === requirementKey.toLowerCase() &&
            record.requirementRevision === requirementRevision,
        );
        const latest = matches.at(-1);
        return latest ? this.#copyDeliveryDispatch(latest) : null;
      },
      findDeliveryRunResult: async (requirementKey, requirementRevision) => {
        const key = deliveryRunKey(
          normalizedTenantKey,
          normalizedProjectKey,
          requirementKey.toLowerCase(),
          requirementRevision,
        );
        const result =
          pendingDeliveryRunResults.get(key) ??
          this.#deliveryRunResults.get(key);
        return result ? structuredClone(result) : null;
      },
      saveDeliveryRunResult: (run) => {
        const parsed = DeliveryRunResultSchema.parse(run);
        this.#assertDeliveryRunScope(
          parsed,
          normalizedTenantKey,
          normalizedProjectKey,
        );
        const key = deliveryRunKey(
          normalizedTenantKey,
          normalizedProjectKey,
          parsed.requirementKey,
          parsed.requirementRevision,
        );
        const existing =
          pendingDeliveryRunResults.get(key) ??
          this.#deliveryRunResults.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new Error("同一需求版本不能覆盖已经提交的交付运行结果");
        }
        pendingDeliveryRunResults.set(key, structuredClone(parsed));
      },
      markDeliveryRunCompleted: async (
        requirementKey,
        requirementRevision,
        proof,
        completedAt,
      ) => {
        const key = deliveryRunKey(
          normalizedTenantKey,
          normalizedProjectKey,
          requirementKey.toLowerCase(),
          requirementRevision,
        );
        const current =
          pendingDeliveryRunResults.get(key) ??
          this.#deliveryRunResults.get(key);
        if (!current) throw new Error("没有找到待完成的交付运行记录");
        if (
          current.assignmentKey !== proof.assignmentKey.toLowerCase() ||
          current.fencingToken !== proof.fencingToken
        ) {
          throw new Error("交付运行完成凭据不匹配");
        }
        if (current.status === "completed") return false;
        pendingDeliveryRunResults.set(
          key,
          DeliveryRunResultSchema.parse({
            ...structuredClone(current),
            status: "completed",
            completedAt,
          }),
        );
        return true;
      },
    };

    try {
      const result = await operation(transaction);
      for (const [key, record] of pendingRecords) {
        if (!this.#records.has(key)) {
          this.#nextPosition += 1;
          this.#positions.set(key, this.#nextPosition);
        }
        this.#records.set(key, this.#copyRecord(record));
      }
      this.#auditEvents.push(...pendingAuditEvents);
      for (const [key, dispatch] of pendingDeliveryDispatches) {
        this.#deliveryDispatches.set(key, this.#copyDeliveryDispatch(dispatch));
      }
      for (const [key, run] of pendingDeliveryRunResults) {
        this.#deliveryRunResults.set(key, structuredClone(run));
      }
      return result;
    } finally {
      release();
      if (this.#scopeTails.get(transactionScope) === current) {
        this.#scopeTails.delete(transactionScope);
      }
    }
  }

  async listForPeople(
    tenantKey: string,
    projectKey: string,
    options: RequirementListOptions,
  ): Promise<RequirementListPage> {
    const normalizedTenantKey = tenantKey.toLowerCase();
    const normalizedProjectKey = projectKey.toLowerCase();
    const matches = [...this.#records.entries()]
      .map(([key, record]) => ({
        record,
        position: this.#positions.get(key),
      }))
      .filter(
        (item): item is { record: RequirementRecord; position: number } =>
          item.position !== undefined &&
          item.record.tenantKey === normalizedTenantKey &&
          item.record.projectKey === normalizedProjectKey &&
          (options.afterPosition === undefined ||
            item.position > options.afterPosition),
      )
      .sort((left, right) => left.position - right.position)
      .slice(0, options.limit + 1);
    const hasNext = matches.length > options.limit;
    const pageItems = matches.slice(0, options.limit);
    return {
      items: pageItems.map(({ record }) => ({
        requirementKey: record.requirementKey,
        view: record.workflow.toPeopleView(),
        allowedActions: record.workflow.listAllowedActions(),
      })),
      nextPosition: hasNext ? (pageItems.at(-1)?.position ?? null) : null,
    };
  }

  async listAuditEvents(
    tenantKey: string,
    projectKey: string,
  ): Promise<RequirementAuditEvent[]> {
    const normalizedTenantKey = tenantKey.toLowerCase();
    const normalizedProjectKey = projectKey.toLowerCase();
    return this.#auditEvents
      .filter(
        (event) =>
          event.tenantKey === normalizedTenantKey &&
          event.projectKey === normalizedProjectKey,
      )
      .map((event) => ({ ...event }));
  }

  async listPendingDeliveryDispatches(
    tenantKey: string,
    projectKey: string | null,
    limit: number,
  ): Promise<DeliveryDispatchRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待派发记录查询上限必须在 1 到 100 之间");
    }
    const normalizedTenantKey = tenantKey.toLowerCase();
    const normalizedProjectKey = projectKey?.toLowerCase() ?? null;
    return [...this.#deliveryDispatches.values()]
      .filter(
        (record) =>
          record.tenantKey === normalizedTenantKey &&
          (normalizedProjectKey === null ||
            record.projectKey === normalizedProjectKey) &&
          record.dispatchedAt === null,
      )
      .sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) ||
          left.dispatchKey.localeCompare(right.dispatchKey),
      )
      .slice(0, limit)
      .map((record) => this.#copyDeliveryDispatch(record));
  }

  async listPendingDeliveryRunResults(
    tenantKey: string,
    limit: number,
  ): Promise<DeliveryRunResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待收敛交付结果查询上限必须在 1 到 100 之间");
    }
    const normalizedTenantKey = tenantKey.toLowerCase();
    return [...this.#deliveryRunResults.values()]
      .filter(
        (run) =>
          run.tenantKey === normalizedTenantKey &&
          run.status === "completion_pending",
      )
      .sort(
        (left, right) =>
          left.submittedAt.localeCompare(right.submittedAt) ||
          left.assignmentKey.localeCompare(right.assignmentKey),
      )
      .slice(0, limit)
      .map((run) => structuredClone(DeliveryRunResultSchema.parse(run)));
  }

  async findDeliveryRunResultByProof(
    tenantKey: string,
    proof: { assignmentKey: string; fencingToken: number },
  ): Promise<DeliveryRunResult | null> {
    const normalizedTenantKey = tenantKey.toLowerCase();
    const result = [...this.#deliveryRunResults.values()].find(
      (run) =>
        run.tenantKey === normalizedTenantKey &&
        run.assignmentKey === proof.assignmentKey.toLowerCase() &&
        run.fencingToken === proof.fencingToken,
    );
    return result
      ? structuredClone(DeliveryRunResultSchema.parse(result))
      : null;
  }

  #copyRecord(record: RequirementRecord): RequirementRecord {
    return {
      ...record,
      spec: structuredClone(record.spec),
      workflow: record.workflow.copyForTransaction(),
    };
  }

  #copyDeliveryDispatch(
    record: DeliveryDispatchRecord,
  ): DeliveryDispatchRecord {
    return {
      ...record,
      requiredCapabilities: [...record.requiredCapabilities],
    };
  }

  #assertDeliveryScope(
    record: DeliveryDispatchRecord,
    tenantKey: string,
    projectKey: string,
  ): void {
    if (
      record.tenantKey.toLowerCase() !== tenantKey ||
      record.projectKey.toLowerCase() !== projectKey
    ) {
      throw new Error("事务不能写入其他范围的交付记录");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        record.repositoryKey,
      )
    ) {
      throw new Error("交付派发记录缺少有效的仓库范围");
    }
  }

  #assertDeliveryRunScope(
    run: DeliveryRunResult,
    tenantKey: string,
    projectKey: string,
  ): void {
    if (
      run.tenantKey.toLowerCase() !== tenantKey ||
      run.projectKey.toLowerCase() !== projectKey ||
      DeliveryRunResultSchema.safeParse(run).success === false
    ) {
      throw new Error("事务不能写入无效或跨范围的交付运行结果");
    }
  }
}
