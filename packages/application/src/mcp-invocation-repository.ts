import { z } from "zod";

import { canonicalizeMcpArguments } from "./mcp-input-schema-store.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const sha256Hash = z.string().regex(/^[0-9a-f]{64}$/);
const actorName = z.string().trim().min(2).max(100);

const McpInvocationApprovalSchema = z
  .object({
    actorKey: internalKey,
    actorName,
    approvedAt: z.iso.datetime(),
  })
  .strict();

const McpInvocationCancellationActorSchema = z
  .object({
    actorKey: internalKey,
    actorName,
    requestedAt: z.iso.datetime(),
  })
  .strict();

const McpInvocationExecutionLeaseSchema = z
  .object({
    assignmentKey: internalKey,
    fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workerKey: internalKey,
    workerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workerFingerprintHash: sha256Hash,
    leasedUntil: z.iso.datetime(),
  })
  .strict();

const McpInvocationResultSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
    summary: z.string().trim().min(2).max(500),
    completedAt: z.iso.datetime(),
  })
  .strict();

export const McpInvocationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationKey: internalKey,
    requestKey: internalKey,
    tenantKey: internalKey,
    projectKey: internalKey,
    serverKey: internalKey,
    serverRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    serverName: z.string().trim().min(2).max(100),
    manifestHashAlgorithm: z.literal("sha256"),
    manifestHash: sha256Hash,
    toolKey: internalKey,
    technicalName: z.string().trim().min(1).max(128),
    toolDisplayName: z.string().trim().min(2).max(100),
    effect: z.enum(["read", "write", "external_action"]),
    approvalMode: z.enum(["automatic", "review_required"]),
    connectionBindingKey: internalKey,
    inputSchemaHashAlgorithm: z.literal("sha256"),
    inputSchemaHash: sha256Hash,
    argumentsHashAlgorithm: z.literal("sha256"),
    argumentsHash: sha256Hash,
    arguments: z.record(z.string(), z.unknown()),
    requestedByKey: internalKey,
    requestedByName: actorName,
    requestedAt: z.iso.datetime(),
    status: z.enum([
      "awaiting_approval",
      "queued",
      "leased",
      "completion_pending",
      "succeeded",
      "failed",
      "cancellation_pending",
      "cancelled",
      "outcome_unknown_pending_cleanup",
      "outcome_unknown",
    ]),
    approval: McpInvocationApprovalSchema.nullable(),
    executionLease: McpInvocationExecutionLeaseSchema.nullable(),
    result: McpInvocationResultSchema.nullable(),
    cancellationRequestedBy:
      McpInvocationCancellationActorSchema.nullable().optional(),
    cancellationAuditRecorded: z.boolean().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    try {
      if (
        canonicalizeMcpArguments(record.arguments).hash !== record.argumentsHash
      ) {
        context.addIssue({
          code: "custom",
          path: ["argumentsHash"],
          message: "调用参数与审计摘要不一致",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        path: ["arguments"],
        message: "调用参数无法安全规范化",
      });
    }
    if (record.effect !== "read" && record.approvalMode !== "review_required") {
      context.addIssue({
        code: "custom",
        path: ["approvalMode"],
        message: "写入或外部动作必须经过人工确认",
      });
    }
    if (
      ["leased", "completion_pending"].includes(record.status) &&
      record.executionLease === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionLease"],
        message: "执行中的调用必须绑定设备租约",
      });
    }
    if (
      ["awaiting_approval", "queued"].includes(record.status) &&
      record.executionLease !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionLease"],
        message: "尚未执行的调用不能提前绑定设备租约",
      });
    }
    if (
      ["completion_pending", "succeeded", "failed"].includes(record.status) &&
      (record.executionLease === null || record.result === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "已结束的调用必须保留租约与执行结果",
      });
    }
    if (
      (record.status === "succeeded" || record.status === "failed") &&
      record.result !== null &&
      record.result.outcome !== record.status
    ) {
      context.addIssue({
        code: "custom",
        path: ["result", "outcome"],
        message: "执行结果与调用状态不一致",
      });
    }
    if (
      ["cancellation_pending", "cancelled"].includes(record.status) &&
      (record.executionLease !== null || record.result !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionLease"],
        message: "已取消的调用不能保留可执行租约或结果",
      });
    }
    if (
      ["outcome_unknown_pending_cleanup", "outcome_unknown"].includes(
        record.status,
      ) &&
      (record.effect === "read" ||
        record.executionLease === null ||
        record.result !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "结果待核对的调用必须保留非只读执行租约且不能伪造结果",
      });
    }
    if (
      !["completion_pending", "succeeded", "failed"].includes(record.status) &&
      record.result !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "未结束的调用不能提前写入执行结果",
      });
    }
    if (record.status === "awaiting_approval" && record.approval !== null) {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message: "等待确认的调用不能已有确认记录",
      });
    }
    if (
      [
        "queued",
        "leased",
        "completion_pending",
        "succeeded",
        "failed",
        "outcome_unknown_pending_cleanup",
        "outcome_unknown",
      ].includes(record.status) &&
      record.approvalMode === "review_required" &&
      record.approval === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval"],
        message: "需要人工确认的调用必须保留确认记录",
      });
    }
    if (
      record.cancellationRequestedBy != null &&
      !["cancellation_pending", "cancelled"].includes(record.status)
    ) {
      context.addIssue({
        code: "custom",
        path: ["cancellationRequestedBy"],
        message: "取消发起人只能绑定到正在取消或已取消的调用",
      });
    }
  });

const McpInvocationAuditScope = {
  schemaVersion: z.literal(1),
  eventKey: internalKey,
  tenantKey: internalKey,
  projectKey: internalKey,
  invocationKey: internalKey,
  recordedAt: z.iso.datetime(),
  manifestHashAlgorithm: z.literal("sha256"),
  manifestHash: sha256Hash,
  argumentsHashAlgorithm: z.literal("sha256"),
  argumentsHash: sha256Hash,
} as const;

export const McpInvocationAuditEventSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        ...McpInvocationAuditScope,
        action: z.literal("approved"),
        actorKey: internalKey,
        actorName,
      })
      .strict(),
    z
      .object({
        ...McpInvocationAuditScope,
        action: z.literal("leased"),
        workerKey: internalKey,
        workerGeneration: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        workerFingerprintHash: sha256Hash,
        assignmentKey: internalKey,
        fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        leasedUntil: z.iso.datetime(),
      })
      .strict(),
    z
      .object({
        ...McpInvocationAuditScope,
        action: z.literal("completed"),
        workerKey: internalKey,
        workerGeneration: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        workerFingerprintHash: sha256Hash,
        assignmentKey: internalKey,
        fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        outcome: z.enum(["succeeded", "failed"]),
        resultHashAlgorithm: z.literal("sha256"),
        resultHash: sha256Hash,
      })
      .strict(),
    z
      .object({
        ...McpInvocationAuditScope,
        action: z.literal("cancelled"),
        source: z.enum(["user", "system"]),
        actorKey: internalKey.nullable(),
        actorName: actorName.nullable(),
      })
      .strict(),
    z
      .object({
        ...McpInvocationAuditScope,
        action: z.literal("outcome_unknown"),
        workerKey: internalKey,
        workerGeneration: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
        workerFingerprintHash: sha256Hash,
        assignmentKey: internalKey,
        fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        leasedUntil: z.iso.datetime(),
      })
      .strict(),
  ])
  .superRefine((event, context) => {
    if (event.action !== "cancelled") return;
    const hasActor = event.actorKey !== null && event.actorName !== null;
    if (
      (event.source === "user" && !hasActor) ||
      (event.source === "system" && hasActor)
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "取消审计来源与操作人不一致",
      });
    }
  });

export type McpInvocationRecord = z.infer<typeof McpInvocationRecordSchema>;
export type McpInvocationAuditEvent = z.infer<
  typeof McpInvocationAuditEventSchema
>;

export interface McpInvocationTransaction {
  countOutstandingAcrossTenant(): Promise<number>;
  find(invocationKey: string): Promise<McpInvocationRecord | null>;
  findByRequest(
    requestedByKey: string,
    requestKey: string,
  ): Promise<McpInvocationRecord | null>;
  save(record: McpInvocationRecord): void;
  appendAudit(event: McpInvocationAuditEvent): void;
}

export interface McpInvocationRepository {
  transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: McpInvocationTransaction) => Promise<T> | T,
  ): Promise<T>;
  list(
    tenantKey: string,
    projectKey: string,
    limit?: number,
  ): Promise<McpInvocationRecord[]>;
  listDispatchableAcrossProjects(
    tenantKey: string,
    limit?: number,
  ): Promise<McpInvocationRecord[]>;
  listAudit(
    tenantKey: string,
    projectKey: string,
    limit?: number,
  ): Promise<McpInvocationAuditEvent[]>;
}

const normalizeKey = (value: string, label: string): string => {
  const result = internalKey.safeParse(value);
  if (!result.success) throw new Error(`${label}格式不正确`);
  return result.data;
};

const scopeKey = (tenantKey: string, projectKey: string): string =>
  `${normalizeKey(tenantKey, "租户标识")}:${normalizeKey(projectKey, "项目标识")}`;

const dispatchPriority = (status: McpInvocationRecord["status"]): number =>
  status === "cancellation_pending" ||
  status === "outcome_unknown_pending_cleanup"
    ? 0
    : status === "completion_pending"
      ? 1
      : status === "leased"
        ? 2
        : 3;

export class InMemoryMcpInvocationRepository implements McpInvocationRepository {
  readonly #recordsByScope = new Map<
    string,
    Map<string, McpInvocationRecord>
  >();
  readonly #auditByScope = new Map<string, McpInvocationAuditEvent[]>();
  readonly #scopeTails = new Map<string, Promise<void>>();

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: McpInvocationTransaction) => Promise<T> | T,
  ): Promise<T> {
    const key = scopeKey(tenantKey, projectKey);
    const tenantLockKey = normalizeKey(tenantKey, "租户标识");
    const previous = this.#scopeTails.get(tenantLockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#scopeTails.set(tenantLockKey, current);
    await previous;

    const records = new Map(
      [...(this.#recordsByScope.get(key) ?? new Map()).entries()].map(
        ([recordKey, record]) => [recordKey, structuredClone(record)],
      ),
    );
    const audit = structuredClone(this.#auditByScope.get(key) ?? []);
    let changed = false;
    let auditChanged = false;
    const transaction: McpInvocationTransaction = {
      countOutstandingAcrossTenant: async () => {
        const prefix = `${tenantLockKey}:`;
        const otherScopeCount = [...this.#recordsByScope.entries()]
          .filter(([scope]) => scope.startsWith(prefix) && scope !== key)
          .flatMap(([, scopedRecords]) => [...scopedRecords.values()])
          .filter((record) =>
            [
              "awaiting_approval",
              "queued",
              "leased",
              "completion_pending",
              "cancellation_pending",
              "outcome_unknown_pending_cleanup",
            ].includes(record.status),
          ).length;
        const currentScopeCount = [...records.values()].filter((record) =>
          [
            "awaiting_approval",
            "queued",
            "leased",
            "completion_pending",
            "cancellation_pending",
            "outcome_unknown_pending_cleanup",
          ].includes(record.status),
        ).length;
        return otherScopeCount + currentScopeCount;
      },
      find: async (invocationKey) => {
        const record = records.get(normalizeKey(invocationKey, "MCP 调用标识"));
        return record ? structuredClone(record) : null;
      },
      findByRequest: async (requestedByKey, requestKey) => {
        const actor = normalizeKey(requestedByKey, "发起人标识");
        const request = normalizeKey(requestKey, "请求标识");
        const record = [...records.values()].find(
          (candidate) =>
            candidate.requestedByKey === actor &&
            candidate.requestKey === request,
        );
        return record ? structuredClone(record) : null;
      },
      save: (input) => {
        const record = McpInvocationRecordSchema.parse(input);
        if (scopeKey(record.tenantKey, record.projectKey) !== key) {
          throw new Error("MCP 调用事务不能写入其他租户或项目");
        }
        const duplicateRequest = [...records.values()].find(
          (candidate) =>
            candidate.invocationKey !== record.invocationKey &&
            candidate.requestedByKey === record.requestedByKey &&
            candidate.requestKey === record.requestKey,
        );
        if (duplicateRequest) throw new Error("MCP 请求标识不能重复");
        records.set(record.invocationKey, structuredClone(record));
        changed = true;
      },
      appendAudit: (input) => {
        const event = McpInvocationAuditEventSchema.parse(input);
        if (scopeKey(event.tenantKey, event.projectKey) !== key) {
          throw new Error("MCP 调用事务不能写入其他范围的审计");
        }
        if (audit.some((candidate) => candidate.eventKey === event.eventKey)) {
          throw new Error("MCP 调用审计标识不能重复");
        }
        audit.push(structuredClone(event));
        auditChanged = true;
      },
    };

    try {
      const result = await operation(transaction);
      if (changed) this.#recordsByScope.set(key, records);
      if (auditChanged) this.#auditByScope.set(key, audit);
      return result;
    } finally {
      release();
      if (this.#scopeTails.get(tenantLockKey) === current) {
        this.#scopeTails.delete(tenantLockKey);
      }
    }
  }

  async list(
    tenantKey: string,
    projectKey: string,
    limit = 100,
  ): Promise<McpInvocationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MCP 调用列表条数必须在 1 到 100 之间");
    }
    const key = scopeKey(tenantKey, projectKey);
    await this.#scopeTails.get(normalizeKey(tenantKey, "租户标识"));
    return [...(this.#recordsByScope.get(key) ?? new Map()).values()]
      .sort((left, right) =>
        left.requestedAt === right.requestedAt
          ? left.invocationKey < right.invocationKey
            ? -1
            : 1
          : left.requestedAt < right.requestedAt
            ? -1
            : 1,
      )
      .slice(-limit)
      .map((record) => structuredClone(record));
  }

  async listAudit(
    tenantKey: string,
    projectKey: string,
    limit = 100,
  ): Promise<McpInvocationAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MCP 调用审计查询条数必须在 1 到 100 之间");
    }
    const key = scopeKey(tenantKey, projectKey);
    await this.#scopeTails.get(normalizeKey(tenantKey, "租户标识"));
    return structuredClone(
      (this.#auditByScope.get(key) ?? []).slice(-limit).reverse(),
    );
  }

  async listDispatchableAcrossProjects(
    tenantKey: string,
    limit = 100,
  ): Promise<McpInvocationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MCP 调用列表条数必须在 1 到 100 之间");
    }
    const tenant = normalizeKey(tenantKey, "租户标识");
    const prefix = `${tenant}:`;
    await this.#scopeTails.get(tenant);
    return [...this.#recordsByScope.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, records]) => [...records.values()])
      .filter((record) =>
        [
          "queued",
          "cancellation_pending",
          "completion_pending",
          "outcome_unknown_pending_cleanup",
          "leased",
        ].includes(record.status),
      )
      .sort((left, right) => {
        const priority =
          dispatchPriority(left.status) - dispatchPriority(right.status);
        if (priority !== 0) return priority;
        return left.requestedAt === right.requestedAt
          ? left.invocationKey < right.invocationKey
            ? -1
            : 1
          : left.requestedAt < right.requestedAt
            ? -1
            : 1;
      })
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}
