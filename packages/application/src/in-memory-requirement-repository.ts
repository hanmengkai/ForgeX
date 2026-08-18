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
  DeliveryExecutionEventRecordSchema,
  DeliveryRunResultSchema,
  VerificationEvidenceRecordSchema,
  VerificationFailureRecordSchema,
  type DeliveryRunResult,
  type DeliveryExecutionEventRecord,
  type VerificationEvidenceRecord,
  type VerificationFailureRecord,
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
  readonly #deliveryExecutionEvents = new Map<
    string,
    DeliveryExecutionEventRecord
  >();
  readonly #verificationEvidence = new Map<
    string,
    VerificationEvidenceRecord
  >();
  readonly #verificationFailures = new Map<string, VerificationFailureRecord>();
  readonly #scopeTails = new Map<string, Promise<void>>();
  #nextPosition = 0;

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    const normalizedTenantKey = tenantKey.toLowerCase();
    const normalizedProjectKey = projectKey.toLowerCase();
    // evidenceKey 在租户内唯一，内存实现也必须与 PostgreSQL 的唯一约束保持同一原子边界。
    const transactionScope = normalizedTenantKey;
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
    const pendingDeletedRecords = new Set<string>();
    const pendingAuditEvents: RequirementAuditEvent[] = [];
    const pendingDeliveryDispatches = new Map<string, DeliveryDispatchRecord>();
    const pendingDeliveryRunResults = new Map<string, DeliveryRunResult>();
    const clearedTerminatedDeliveryResults = new Set<string>();
    const pendingDeliveryExecutionEvents = new Map<
      string,
      DeliveryExecutionEventRecord
    >();
    const pendingVerificationEvidence = new Map<
      string,
      VerificationEvidenceRecord
    >();
    const pendingVerificationFailures = new Map<
      string,
      VerificationFailureRecord
    >();
    const transaction: RequirementTransaction = {
      find: async (requirementKey) => {
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          requirementKey,
        );
        if (pendingDeletedRecords.has(key)) return null;
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
        record.workflow.restoreCurrentSpec(record.spec);
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
      softDelete: (requirementKey, deletedAt) => {
        if (!Number.isFinite(Date.parse(deletedAt))) {
          throw new Error("需求删除时间无效");
        }
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          requirementKey.toLowerCase(),
        );
        pendingDeletedRecords.add(key);
        pendingRecords.delete(key);
        loadedRecords.delete(key);
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
      appendDeliveryExecutionEvent: async (record) => {
        const parsed = DeliveryExecutionEventRecordSchema.parse(record);
        if (
          parsed.tenantKey !== normalizedTenantKey ||
          parsed.projectKey !== normalizedProjectKey
        ) {
          throw new Error("事务不能写入其他范围的 Codex 过程事件");
        }
        const eventKey = `${normalizedTenantKey}:${parsed.eventKey}`;
        const existing =
          pendingDeliveryExecutionEvents.get(eventKey) ??
          this.#deliveryExecutionEvents.get(eventKey);
        if (existing) {
          const { sequence: _existingSequence, ...existingComparable } =
            existing;
          const { sequence: _parsedSequence, ...parsedComparable } = parsed;
          if (
            JSON.stringify(existingComparable) ===
            JSON.stringify(parsedComparable)
          ) {
            return false;
          }
          throw new Error("同一过程事件标识不能绑定不同内容");
        }
        const assignmentEvents = [
          ...this.#deliveryExecutionEvents.values(),
          ...pendingDeliveryExecutionEvents.values(),
        ].filter(
          (item) =>
            item.tenantKey === normalizedTenantKey &&
            item.assignmentKey === parsed.assignmentKey,
        );
        const nextSequence =
          assignmentEvents.reduce(
            (maximum, item) => Math.max(maximum, item.sequence),
            0,
          ) + 1;
        pendingDeliveryExecutionEvents.set(eventKey, {
          ...structuredClone(parsed),
          sequence: nextSequence,
        });
        return true;
      },
      listDeliveryExecutionEvents: async (
        requirementKey,
        requirementRevision,
        limit,
      ) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          throw new Error("Codex 过程事件查询上限无效");
        }
        return [
          ...this.#deliveryExecutionEvents.values(),
          ...pendingDeliveryExecutionEvents.values(),
        ]
          .filter(
            (event) =>
              event.tenantKey === normalizedTenantKey &&
              event.projectKey === normalizedProjectKey &&
              event.requirementKey === requirementKey.toLowerCase() &&
              event.requirementRevision === requirementRevision,
          )
          .sort(
            (left, right) =>
              left.occurredAt.localeCompare(right.occurredAt) ||
              left.sequence - right.sequence,
          )
          .slice(-limit)
          .map((event) => structuredClone(event));
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
      markDeliveryCancelled: async (dispatchKey, cancelledAt) => {
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          dispatchKey,
        );
        const current =
          pendingDeliveryDispatches.get(key) ??
          this.#deliveryDispatches.get(key);
        if (!current) {
          throw new Error("没有找到待终止的交付记录");
        }
        if (current.cancelledAt) return false;
        pendingDeliveryDispatches.set(key, {
          ...this.#copyDeliveryDispatch(current),
          cancelledAt,
        });
        return true;
      },
      markDeliveryCancellationCompleted: async (dispatchKey, completedAt) => {
        const key = scopedKey(
          normalizedTenantKey,
          normalizedProjectKey,
          dispatchKey,
        );
        const current =
          pendingDeliveryDispatches.get(key) ??
          this.#deliveryDispatches.get(key);
        if (!current?.cancelledAt) {
          throw new Error("交付尚未登记终止，不能确认设备撤销");
        }
        if (current.cancellationCompletedAt) return false;
        pendingDeliveryDispatches.set(key, {
          ...this.#copyDeliveryDispatch(current),
          cancellationCompletedAt: completedAt,
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
        if (clearedTerminatedDeliveryResults.has(key)) return null;
        const result =
          pendingDeliveryRunResults.get(key) ??
          this.#deliveryRunResults.get(key);
        return result ? structuredClone(result) : null;
      },
      clearTerminatedDeliveryResult: async (
        requirementKey,
        requirementRevision,
      ) => {
        const key = deliveryRunKey(
          normalizedTenantKey,
          normalizedProjectKey,
          requirementKey.toLowerCase(),
          requirementRevision,
        );
        clearedTerminatedDeliveryResults.add(key);
        pendingDeliveryRunResults.delete(key);
        pendingVerificationFailures.delete(key);
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
      appendVerificationEvidence: (record) => {
        const parsed = VerificationEvidenceRecordSchema.parse(record);
        if (
          parsed.tenantKey !== normalizedTenantKey ||
          parsed.projectKey !== normalizedProjectKey
        ) {
          throw new Error("事务不能写入其他范围的验证证据");
        }
        const requirement =
          pendingRecords.get(
            scopedKey(
              normalizedTenantKey,
              normalizedProjectKey,
              parsed.requirementKey,
            ),
          ) ??
          this.#records.get(
            scopedKey(
              normalizedTenantKey,
              normalizedProjectKey,
              parsed.requirementKey,
            ),
          );
        const deliveryRun =
          pendingDeliveryRunResults.get(
            deliveryRunKey(
              normalizedTenantKey,
              normalizedProjectKey,
              parsed.requirementKey,
              parsed.requirementRevision,
            ),
          ) ??
          this.#deliveryRunResults.get(
            deliveryRunKey(
              normalizedTenantKey,
              normalizedProjectKey,
              parsed.requirementKey,
              parsed.requirementRevision,
            ),
          );
        if (
          !requirement ||
          requirement.workflow.currentRevision !== parsed.requirementRevision ||
          deliveryRun?.status !== "completed"
        ) {
          throw new Error("验证证据必须绑定已完成的当前需求交付版本");
        }
        const key = `${normalizedTenantKey}:${parsed.evidenceKey}`;
        const existing =
          pendingVerificationEvidence.get(key) ??
          this.#verificationEvidence.get(key);
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(parsed)) return;
          throw new Error("同一验证证据标识不能绑定不同的需求或内容");
        }
        pendingVerificationEvidence.set(key, structuredClone(parsed));
      },
      findVerificationFailure: async (requirementKey, requirementRevision) => {
        const key = deliveryRunKey(
          normalizedTenantKey,
          normalizedProjectKey,
          requirementKey.toLowerCase(),
          requirementRevision,
        );
        if (clearedTerminatedDeliveryResults.has(key)) return null;
        const record =
          pendingVerificationFailures.get(key) ??
          this.#verificationFailures.get(key);
        return record ? structuredClone(record) : null;
      },
      saveVerificationFailure: (record) => {
        const parsed = VerificationFailureRecordSchema.parse(record);
        if (
          parsed.tenantKey !== normalizedTenantKey ||
          parsed.projectKey !== normalizedProjectKey
        ) {
          throw new Error("事务不能写入其他范围的验证失败记录");
        }
        const key = deliveryRunKey(
          normalizedTenantKey,
          normalizedProjectKey,
          parsed.requirementKey,
          parsed.requirementRevision,
        );
        const existing =
          pendingVerificationFailures.get(key) ??
          this.#verificationFailures.get(key);
        if (existing) {
          if (JSON.stringify(existing) === JSON.stringify(parsed)) return;
          throw new Error("同一交付版本不能覆盖已经记录的验证失败结果");
        }
        pendingVerificationFailures.set(key, structuredClone(parsed));
      },
    };

    try {
      const result = await operation(transaction);
      for (const [key, record] of pendingRecords) {
        if (pendingDeletedRecords.has(key)) continue;
        if (!this.#records.has(key)) {
          this.#nextPosition += 1;
          this.#positions.set(key, this.#nextPosition);
        }
        this.#records.set(key, this.#copyRecord(record));
      }
      for (const key of pendingDeletedRecords) {
        this.#records.delete(key);
        this.#positions.delete(key);
      }
      this.#auditEvents.push(...pendingAuditEvents);
      for (const [key, dispatch] of pendingDeliveryDispatches) {
        this.#deliveryDispatches.set(key, this.#copyDeliveryDispatch(dispatch));
      }
      for (const [key, run] of pendingDeliveryRunResults) {
        this.#deliveryRunResults.set(key, structuredClone(run));
      }
      for (const key of clearedTerminatedDeliveryResults) {
        this.#deliveryRunResults.delete(key);
        this.#verificationFailures.delete(key);
        for (const [evidenceKey, evidence] of this.#verificationEvidence) {
          if (
            evidence.tenantKey === normalizedTenantKey &&
            evidence.projectKey === normalizedProjectKey &&
            deliveryRunKey(
              evidence.tenantKey,
              evidence.projectKey,
              evidence.requirementKey,
              evidence.requirementRevision,
            ) === key
          ) {
            this.#verificationEvidence.delete(evidenceKey);
          }
        }
      }
      for (const [key, event] of pendingDeliveryExecutionEvents) {
        this.#deliveryExecutionEvents.set(key, structuredClone(event));
      }
      for (const [key, evidence] of pendingVerificationEvidence) {
        this.#verificationEvidence.set(key, structuredClone(evidence));
      }
      for (const [key, failure] of pendingVerificationFailures) {
        this.#verificationFailures.set(key, structuredClone(failure));
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
        repositoryKey: record.repositoryKey ?? null,
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
          record.dispatchedAt === null &&
          !record.cancelledAt,
      )
      .sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) ||
          left.dispatchKey.localeCompare(right.dispatchKey),
      )
      .slice(0, limit)
      .map((record) => this.#copyDeliveryDispatch(record));
  }

  async listPendingDeliveryCancellations(
    tenantKey: string,
    limit: number,
  ): Promise<DeliveryDispatchRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待撤销记录查询上限必须在 1 到 100 之间");
    }
    const normalizedTenantKey = tenantKey.toLowerCase();
    return [...this.#deliveryDispatches.values()]
      .filter(
        (record) =>
          record.tenantKey === normalizedTenantKey &&
          Boolean(record.cancelledAt) &&
          !record.cancellationCompletedAt,
      )
      .sort(
        (left, right) =>
          left.cancelledAt!.localeCompare(right.cancelledAt!) ||
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

  async listDeliveryRunsAwaitingVerification(
    tenantKey: string,
    projectKey: string,
    repositoryKey: string,
    limit: number,
  ): Promise<DeliveryRunResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待验证交付查询上限必须在 1 到 100 之间");
    }
    const tenant = tenantKey.toLowerCase();
    const project = projectKey.toLowerCase();
    const repository = repositoryKey.toLowerCase();
    return [...this.#deliveryRunResults.values()]
      .filter((run) => {
        if (
          run.tenantKey !== tenant ||
          run.projectKey !== project ||
          run.repositoryKey !== repository ||
          run.status !== "completed"
        ) {
          return false;
        }
        const record = this.#records.get(
          scopedKey(tenant, project, run.requirementKey),
        );
        const snapshot = record?.workflow.toSnapshot();
        const failureKey = deliveryRunKey(
          tenant,
          project,
          run.requirementKey,
          run.requirementRevision,
        );
        return (
          snapshot?.status === "inDelivery" &&
          snapshot.evidence === null &&
          !this.#verificationFailures.has(failureKey)
        );
      })
      .sort(
        (left, right) =>
          left.completedAt!.localeCompare(right.completedAt!) ||
          left.requirementKey.localeCompare(right.requirementKey),
      )
      .slice(0, limit)
      .map((run) => structuredClone(DeliveryRunResultSchema.parse(run)));
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
      cancelledAt: record.cancelledAt ?? null,
      cancellationCompletedAt: record.cancellationCompletedAt ?? null,
      retryOfDispatchKey: record.retryOfDispatchKey ?? null,
      requiredCapabilities: [...record.requiredCapabilities],
      skills: record.skills.map((skill) => ({ ...skill })),
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
