import {
  RequirementSpecSchema,
  StartDeliveryCommandSchema,
  type RequirementSpec,
} from "@forgex/contracts";
import {
  RequirementWorkflow,
  type EvidenceAuthority,
  type RequirementWorkflowSnapshot,
} from "@forgex/domain";
import type {
  DeliveryDispatchRecord,
  RequirementAuditAction,
  RequirementAuditEvent,
  RequirementListOptions,
  RequirementListPage,
  RequirementRecord,
  RequirementRepository,
  RequirementTransaction,
} from "@forgex/application";

import type {
  PostgresClient,
  PostgresPool,
} from "./postgres-worker-fleet-repository.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const auditActions = new Set<RequirementAuditAction>([
  "requirement.created",
  "requirement.confirmation_submitted",
  "requirement.confirmed",
  "requirement.accepted",
  "delivery.requested",
  "delivery.dispatched",
]);

export interface PostgresRequirementRepositoryOptions {
  clock?: () => Date;
  evidenceAuthority?: EvidenceAuthority;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseInternalKey = (value: string, label: string): string => {
  const normalized = value.toLowerCase();
  if (!internalKeyPattern.test(normalized)) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
};

const parseIsoDate = (value: unknown, label: string): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label}无效`);
  }
  return date.toISOString();
};

const parseSafePosition = (value: unknown): number => {
  const position = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new Error("需求分页位置无效");
  }
  return position;
};

export class PostgresRequirementRepository implements RequirementRepository {
  readonly #pool: PostgresPool;
  readonly #clock: () => Date;
  readonly #evidenceAuthority: EvidenceAuthority | undefined;

  constructor(
    pool: PostgresPool,
    options: PostgresRequirementRepositoryOptions = {},
  ) {
    this.#pool = pool;
    this.#clock = options.clock ?? (() => new Date());
    this.#evidenceAuthority = options.evidenceAuthority;
  }

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    const project = parseInternalKey(projectKey, "项目标识");
    const client = await this.#pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenant}:${project}`],
      );
      const loaded = new Map<string, RequirementRecord>();
      const pendingRecords = new Map<string, RequirementRecord>();
      const pendingAudit: RequirementAuditEvent[] = [];
      const pendingDispatches = new Map<string, DeliveryDispatchRecord>();
      const transaction: RequirementTransaction = {
        find: async (requirementKey) => {
          const key = parseInternalKey(requirementKey, "需求标识");
          const pending = pendingRecords.get(key);
          if (pending) {
            return this.#copyRecord(pending);
          }
          const cached = loaded.get(key);
          if (cached) {
            return this.#copyRecord(cached);
          }
          const result = await client.query(
            "SELECT created_at, spec, workflow FROM forgex_requirements WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3",
            [tenant, project, key],
          );
          const row = result.rows[0];
          if (!row) {
            return null;
          }
          const record = this.#recordFromRow(row, tenant, project, key);
          loaded.set(key, record);
          return this.#copyRecord(record);
        },
        save: (record) => {
          this.#assertRecordScope(record, tenant, project);
          const detached = this.#copyRecord(record);
          pendingRecords.set(detached.requirementKey, detached);
          loaded.set(detached.requirementKey, detached);
        },
        appendAudit: (event) => {
          this.#assertAuditScope(event, tenant, project);
          pendingAudit.push({ ...event });
        },
        appendDeliveryDispatch: (dispatch) => {
          this.#assertDispatchScope(dispatch, tenant, project);
          if (pendingDispatches.has(dispatch.dispatchKey)) {
            throw new Error("交付派发记录不能重复");
          }
          pendingDispatches.set(
            dispatch.dispatchKey,
            this.#copyDispatch(dispatch),
          );
        },
        markDeliveryDispatched: async (dispatchKey, dispatchedAt) => {
          const key = parseInternalKey(dispatchKey, "派发标识");
          const pending = pendingDispatches.get(key);
          if (pending) {
            if (pending.dispatchedAt !== null) {
              return false;
            }
            pendingDispatches.set(key, {
              ...pending,
              dispatchedAt: parseIsoDate(dispatchedAt, "派发时间"),
            });
            return true;
          }
          const updated = await client.query(
            "UPDATE forgex_delivery_outbox SET dispatched_at = $4 WHERE tenant_key = $1 AND project_key = $2 AND dispatch_key = $3 AND dispatched_at IS NULL RETURNING dispatch_key",
            [tenant, project, key, parseIsoDate(dispatchedAt, "派发时间")],
          );
          return updated.rows.length > 0;
        },
      };

      const result = await operation(transaction);
      for (const record of pendingRecords.values()) {
        await client.query(
          "INSERT INTO forgex_requirements (tenant_key, project_key, requirement_key, created_at, spec, workflow) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) ON CONFLICT (tenant_key, project_key, requirement_key) DO UPDATE SET spec = EXCLUDED.spec, workflow = EXCLUDED.workflow, updated_at = now()",
          [
            tenant,
            project,
            record.requirementKey,
            record.createdAt,
            JSON.stringify(record.spec),
            JSON.stringify(record.workflow.toSnapshot()),
          ],
        );
      }
      for (const event of pendingAudit) {
        await client.query(
          "INSERT INTO forgex_requirement_audit (event_key, tenant_key, project_key, requirement_key, action, actor_key, actor_name, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            event.eventKey,
            tenant,
            project,
            event.requirementKey,
            event.action,
            event.actorKey,
            event.actorName,
            event.recordedAt,
          ],
        );
      }
      for (const dispatch of pendingDispatches.values()) {
        await client.query(
          "INSERT INTO forgex_delivery_outbox (dispatch_key, tenant_key, project_key, requirement_key, requirement_revision, title, required_capabilities, requested_at, dispatched_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
          [
            dispatch.dispatchKey,
            tenant,
            project,
            dispatch.requirementKey,
            dispatch.requirementRevision,
            dispatch.title,
            JSON.stringify(dispatch.requiredCapabilities),
            dispatch.requestedAt,
            dispatch.dispatchedAt,
          ],
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "需求事务失败且回滚未完成",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listForPeople(
    tenantKey: string,
    projectKey: string,
    options: RequirementListOptions,
  ): Promise<RequirementListPage> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    const project = parseInternalKey(projectKey, "项目标识");
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    ) {
      throw new Error("需求分页数量必须在 1 到 100 之间");
    }
    const after = options.afterPosition ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("需求分页位置无效");
    }
    return this.#withClient(async (client) => {
      const result = await client.query(
        "SELECT requirement_key, workflow, position FROM forgex_requirements WHERE tenant_key = $1 AND project_key = $2 AND position > $3 ORDER BY position ASC LIMIT $4",
        [tenant, project, after, options.limit + 1],
      );
      const parsed = result.rows.map((row) => {
        if (!isRecord(row)) {
          throw new Error("数据库中的需求列表记录格式无效");
        }
        const requirementKey = parseInternalKey(
          String(row.requirement_key),
          "需求标识",
        );
        const workflow = this.#workflowFromValue(row.workflow);
        workflow.assertPersistenceIdentity({
          tenantKey: tenant,
          projectKey: project,
          requirementKey,
        });
        return {
          requirementKey,
          workflow,
          position: parseSafePosition(row.position),
        };
      });
      const hasNext = parsed.length > options.limit;
      const page = parsed.slice(0, options.limit);
      return {
        items: page.map((item) => ({
          requirementKey: item.requirementKey,
          view: item.workflow.toPeopleView(),
          allowedActions: item.workflow.listAllowedActions(),
        })),
        nextPosition: hasNext ? (page.at(-1)?.position ?? null) : null,
      };
    });
  }

  async listAuditEvents(
    tenantKey: string,
    projectKey: string,
  ): Promise<RequirementAuditEvent[]> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    const project = parseInternalKey(projectKey, "项目标识");
    return this.#withClient(async (client) => {
      const result = await client.query(
        "SELECT event_key, requirement_key, action, actor_key, actor_name, recorded_at FROM forgex_requirement_audit WHERE tenant_key = $1 AND project_key = $2 ORDER BY recorded_at ASC, event_key ASC",
        [tenant, project],
      );
      return result.rows.map((row) => {
        if (
          !isRecord(row) ||
          !auditActions.has(row.action as RequirementAuditAction)
        ) {
          throw new Error("数据库中的需求审计记录格式无效");
        }
        return {
          eventKey: parseInternalKey(String(row.event_key), "审计事件标识"),
          tenantKey: tenant,
          projectKey: project,
          requirementKey: parseInternalKey(
            String(row.requirement_key),
            "需求标识",
          ),
          action: row.action as RequirementAuditAction,
          actorKey: parseInternalKey(String(row.actor_key), "操作人标识"),
          actorName: this.#parseActorName(row.actor_name),
          recordedAt: parseIsoDate(row.recorded_at, "审计时间"),
        };
      });
    });
  }

  async listPendingDeliveryDispatches(
    tenantKey: string,
    projectKey: string | null,
    limit: number,
  ): Promise<DeliveryDispatchRecord[]> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    const project = projectKey
      ? parseInternalKey(projectKey, "项目标识")
      : null;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待派发记录查询上限必须在 1 到 100 之间");
    }
    return this.#withClient(async (client) => {
      const result = project
        ? await client.query(
            "SELECT dispatch_key, project_key, requirement_key, requirement_revision, title, required_capabilities, requested_at, dispatched_at FROM forgex_delivery_outbox WHERE tenant_key = $1 AND project_key = $2 AND dispatched_at IS NULL ORDER BY requested_at ASC, dispatch_key ASC LIMIT $3",
            [tenant, project, limit],
          )
        : await client.query(
            "SELECT dispatch_key, project_key, requirement_key, requirement_revision, title, required_capabilities, requested_at, dispatched_at FROM forgex_delivery_outbox WHERE tenant_key = $1 AND dispatched_at IS NULL ORDER BY requested_at ASC, dispatch_key ASC LIMIT $2",
            [tenant, limit],
          );
      return result.rows.map((row) => this.#dispatchFromRow(row, tenant));
    });
  }

  async #withClient<T>(
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  #recordFromRow(
    row: unknown,
    tenantKey: string,
    projectKey: string,
    requirementKey: string,
  ): RequirementRecord {
    if (!isRecord(row)) {
      throw new Error("数据库中的需求记录格式无效");
    }
    const spec = RequirementSpecSchema.parse(row.spec);
    const workflow = this.#workflowFromValue(row.workflow);
    workflow.assertPersistenceIdentity({
      tenantKey,
      projectKey,
      requirementKey,
    });
    workflow.assertSpecIntegrity(spec);
    return {
      tenantKey,
      projectKey,
      requirementKey,
      createdAt: parseIsoDate(row.created_at, "需求创建时间"),
      spec,
      workflow,
    };
  }

  #workflowFromValue(value: unknown): RequirementWorkflow {
    const parsed =
      typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return RequirementWorkflow.fromSnapshot(
      parsed as RequirementWorkflowSnapshot,
      {
        clock: this.#clock,
        ...(this.#evidenceAuthority
          ? { evidenceAuthority: this.#evidenceAuthority }
          : {}),
      },
    );
  }

  #copyRecord(record: RequirementRecord): RequirementRecord {
    return {
      ...record,
      spec: structuredClone(record.spec),
      workflow: record.workflow.copyForTransaction(),
    };
  }

  #copyDispatch(dispatch: DeliveryDispatchRecord): DeliveryDispatchRecord {
    return {
      ...dispatch,
      requiredCapabilities: [...dispatch.requiredCapabilities],
    };
  }

  #assertRecordScope(
    record: RequirementRecord,
    tenantKey: string,
    projectKey: string,
  ): void {
    if (
      record.tenantKey.toLowerCase() !== tenantKey ||
      record.projectKey.toLowerCase() !== projectKey
    ) {
      throw new Error("需求事务不能写入其他租户或项目");
    }
    record.workflow.assertPersistenceIdentity({
      tenantKey,
      projectKey,
      requirementKey: record.requirementKey,
    });
    RequirementSpecSchema.parse(record.spec);
    record.workflow.assertSpecIntegrity(record.spec);
    parseIsoDate(record.createdAt, "需求创建时间");
  }

  #assertAuditScope(
    event: RequirementAuditEvent,
    tenantKey: string,
    projectKey: string,
  ): void {
    if (
      event.tenantKey.toLowerCase() !== tenantKey ||
      event.projectKey.toLowerCase() !== projectKey ||
      !auditActions.has(event.action)
    ) {
      throw new Error("需求事务不能写入其他范围的审计事件");
    }
    parseInternalKey(event.eventKey, "审计事件标识");
    parseInternalKey(event.requirementKey, "需求标识");
    parseInternalKey(event.actorKey, "操作人标识");
    this.#parseActorName(event.actorName);
    parseIsoDate(event.recordedAt, "审计时间");
  }

  #assertDispatchScope(
    dispatch: DeliveryDispatchRecord,
    tenantKey: string,
    projectKey: string,
  ): void {
    if (
      dispatch.tenantKey.toLowerCase() !== tenantKey ||
      dispatch.projectKey.toLowerCase() !== projectKey ||
      !Number.isSafeInteger(dispatch.requirementRevision) ||
      dispatch.requirementRevision < 1 ||
      typeof dispatch.title !== "string" ||
      dispatch.title.trim().length < 2 ||
      dispatch.title.trim().length > 150
    ) {
      throw new Error("需求事务不能写入无效的交付派发记录");
    }
    parseInternalKey(dispatch.dispatchKey, "派发标识");
    parseInternalKey(dispatch.requirementKey, "需求标识");
    const requestedAt = parseIsoDate(dispatch.requestedAt, "交付请求时间");
    const capabilities = StartDeliveryCommandSchema.safeParse({
      schemaVersion: 1,
      requiredCapabilities: dispatch.requiredCapabilities,
    });
    if (!capabilities.success) {
      throw new Error("需求事务不能写入无效的设备能力要求");
    }
    if (dispatch.dispatchedAt !== null) {
      const dispatchedAt = parseIsoDate(dispatch.dispatchedAt, "派发时间");
      if (Date.parse(dispatchedAt) < Date.parse(requestedAt)) {
        throw new Error("派发时间不能早于交付请求时间");
      }
    }
  }

  #dispatchFromRow(row: unknown, tenantKey: string): DeliveryDispatchRecord {
    if (!isRecord(row)) {
      throw new Error("数据库中的交付派发记录格式无效");
    }
    const revision = Number(row.requirement_revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("数据库中的交付派发版本无效");
    }
    const capabilities = StartDeliveryCommandSchema.safeParse({
      schemaVersion: 1,
      requiredCapabilities: row.required_capabilities,
    });
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!capabilities.success || title.length < 2 || title.length > 150) {
      throw new Error("数据库中的交付派发记录格式无效");
    }
    const requestedAt = parseIsoDate(row.requested_at, "交付请求时间");
    const dispatchedAt =
      row.dispatched_at === null
        ? null
        : parseIsoDate(row.dispatched_at, "派发时间");
    if (
      dispatchedAt !== null &&
      Date.parse(dispatchedAt) < Date.parse(requestedAt)
    ) {
      throw new Error("数据库中的交付派发时间无效");
    }
    return {
      dispatchKey: parseInternalKey(String(row.dispatch_key), "派发标识"),
      tenantKey,
      projectKey: parseInternalKey(String(row.project_key), "项目标识"),
      requirementKey: parseInternalKey(String(row.requirement_key), "需求标识"),
      requirementRevision: revision,
      title,
      requiredCapabilities: [...capabilities.data.requiredCapabilities],
      requestedAt,
      dispatchedAt,
    };
  }

  #parseActorName(value: unknown): string {
    if (typeof value !== "string") {
      throw new Error("操作人名称无效");
    }
    const name = value.trim();
    if (name.length < 2 || name.length > 100) {
      throw new Error("操作人名称无效");
    }
    return name;
  }
}
