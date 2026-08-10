import {
  McpInvocationAuditEventSchema,
  McpInvocationRecordSchema,
  type McpInvocationAuditEvent,
  type McpInvocationRecord,
  type McpInvocationRepository,
  type McpInvocationTransaction,
} from "@forgex/application";

import type { PostgresPool } from "./postgres-worker-fleet-repository.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeKey = (value: string, label: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!internalKeyPattern.test(normalized)) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonState = (row: unknown, label: string): unknown => {
  if (!isRecord(row) || !("state" in row)) {
    throw new Error(`数据库中的 MCP ${label}格式无效`);
  }
  return typeof row.state === "string"
    ? (JSON.parse(row.state) as unknown)
    : row.state;
};

const recordFromRow = (
  row: unknown,
  tenantKey: string,
  projectKey: string,
): McpInvocationRecord => {
  const parsed = McpInvocationRecordSchema.safeParse(
    jsonState(row, "调用记录"),
  );
  if (!parsed.success) throw new Error("数据库中的 MCP 调用记录格式无效");
  if (
    parsed.data.tenantKey !== tenantKey ||
    parsed.data.projectKey !== projectKey
  ) {
    throw new Error("数据库中的 MCP 调用不属于查询范围");
  }
  return parsed.data;
};

const auditFromRow = (
  row: unknown,
  tenantKey: string,
  projectKey: string,
): McpInvocationAuditEvent => {
  const parsed = McpInvocationAuditEventSchema.safeParse(
    jsonState(row, "调用审计"),
  );
  if (!parsed.success) throw new Error("数据库中的 MCP 调用审计格式无效");
  if (
    parsed.data.tenantKey !== tenantKey ||
    parsed.data.projectKey !== projectKey
  ) {
    throw new Error("数据库中的 MCP 调用审计不属于查询范围");
  }
  return parsed.data;
};

export class PostgresMcpInvocationRepository implements McpInvocationRepository {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: McpInvocationTransaction) => Promise<T> | T,
  ): Promise<T> {
    const tenant = normalizeKey(tenantKey, "租户标识");
    const project = normalizeKey(projectKey, "项目标识");
    const client = await this.#pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenant}:mcp-invocations`],
      );
      const changed = new Map<string, McpInvocationRecord>();
      const pendingAudit: McpInvocationAuditEvent[] = [];
      const transaction: McpInvocationTransaction = {
        countOutstandingAcrossTenant: async () => {
          const result = await client.query(
            "SELECT count(*)::text AS count FROM forgex_mcp_invocations WHERE tenant_key = $1 AND status IN ('awaiting_approval', 'queued', 'leased', 'completion_pending', 'cancellation_pending', 'outcome_unknown_pending_cleanup')",
            [tenant],
          );
          const count = Number(
            isRecord(result.rows[0]) ? result.rows[0].count : Number.NaN,
          );
          if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error("数据库中的 MCP 未完成调用数量无效");
          }
          return count;
        },
        find: async (invocationKey) => {
          const normalized = normalizeKey(invocationKey, "MCP 调用标识");
          const pending = changed.get(normalized);
          if (pending) return structuredClone(pending);
          const result = await client.query(
            "SELECT state FROM forgex_mcp_invocations WHERE tenant_key = $1 AND project_key = $2 AND invocation_key = $3",
            [tenant, project, normalized],
          );
          return result.rows[0]
            ? recordFromRow(result.rows[0], tenant, project)
            : null;
        },
        findByRequest: async (requestedByKey, requestKey) => {
          const actor = normalizeKey(requestedByKey, "发起人标识");
          const request = normalizeKey(requestKey, "请求标识");
          const pending = [...changed.values()].find(
            (candidate) =>
              candidate.requestedByKey === actor &&
              candidate.requestKey === request,
          );
          if (pending) return structuredClone(pending);
          const result = await client.query(
            "SELECT state FROM forgex_mcp_invocations WHERE tenant_key = $1 AND project_key = $2 AND requested_by_key = $3 AND request_key = $4",
            [tenant, project, actor, request],
          );
          return result.rows[0]
            ? recordFromRow(result.rows[0], tenant, project)
            : null;
        },
        save: (input) => {
          const record = McpInvocationRecordSchema.parse(input);
          if (record.tenantKey !== tenant || record.projectKey !== project) {
            throw new Error("MCP 调用事务不能写入其他租户或项目");
          }
          const duplicateRequest = [...changed.values()].find(
            (candidate) =>
              candidate.invocationKey !== record.invocationKey &&
              candidate.requestedByKey === record.requestedByKey &&
              candidate.requestKey === record.requestKey,
          );
          if (duplicateRequest) throw new Error("MCP 请求标识不能重复");
          const clone = structuredClone(record);
          changed.set(record.invocationKey, clone);
        },
        appendAudit: (input) => {
          const event = McpInvocationAuditEventSchema.parse(input);
          if (event.tenantKey !== tenant || event.projectKey !== project) {
            throw new Error("MCP 调用事务不能写入其他范围的审计");
          }
          if (
            pendingAudit.some(
              (candidate) => candidate.eventKey === event.eventKey,
            )
          ) {
            throw new Error("MCP 调用审计标识不能重复");
          }
          pendingAudit.push(structuredClone(event));
        },
      };

      const result = await operation(transaction);
      for (const record of changed.values()) {
        await client.query(
          "INSERT INTO forgex_mcp_invocations (tenant_key, project_key, invocation_key, request_key, state, requested_by_key, manifest_hash, status, requested_at, input_schema_hash) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10) ON CONFLICT (tenant_key, project_key, invocation_key) DO UPDATE SET state = EXCLUDED.state, manifest_hash = EXCLUDED.manifest_hash, input_schema_hash = EXCLUDED.input_schema_hash, status = EXCLUDED.status, updated_at = now()",
          [
            record.tenantKey,
            record.projectKey,
            record.invocationKey,
            record.requestKey,
            JSON.stringify(record),
            record.requestedByKey,
            record.manifestHash,
            record.status,
            record.requestedAt,
            record.inputSchemaHash,
          ],
        );
      }
      for (const event of pendingAudit) {
        await client.query(
          "INSERT INTO forgex_mcp_invocation_audit (tenant_key, project_key, event_key, invocation_key, state, action, recorded_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)",
          [
            event.tenantKey,
            event.projectKey,
            event.eventKey,
            event.invocationKey,
            JSON.stringify(event),
            event.action,
            event.recordedAt,
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
            "MCP 调用事务失败且回滚未完成",
          );
        }
      }
      throw error;
    } finally {
      client.release();
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
    const tenant = normalizeKey(tenantKey, "租户标识");
    const project = normalizeKey(projectKey, "项目标识");
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        "SELECT state FROM forgex_mcp_invocations WHERE tenant_key = $1 AND project_key = $2 ORDER BY requested_at DESC, invocation_key DESC LIMIT $3",
        [tenant, project, limit],
      );
      return result.rows
        .map((row) => recordFromRow(row, tenant, project))
        .reverse();
    } finally {
      client.release();
    }
  }

  async listAudit(
    tenantKey: string,
    projectKey: string,
    limit = 100,
  ): Promise<McpInvocationAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MCP 调用审计查询条数必须在 1 到 100 之间");
    }
    const tenant = normalizeKey(tenantKey, "租户标识");
    const project = normalizeKey(projectKey, "项目标识");
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        "SELECT state FROM forgex_mcp_invocation_audit WHERE tenant_key = $1 AND project_key = $2 ORDER BY recorded_at DESC, event_key DESC LIMIT $3",
        [tenant, project, limit],
      );
      return result.rows.map((row) => auditFromRow(row, tenant, project));
    } finally {
      client.release();
    }
  }

  async listDispatchableAcrossProjects(
    tenantKey: string,
    limit = 100,
  ): Promise<McpInvocationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MCP 调用列表条数必须在 1 到 100 之间");
    }
    const tenant = normalizeKey(tenantKey, "租户标识");
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        "SELECT project_key, state FROM forgex_mcp_invocations WHERE tenant_key = $1 AND status IN ('queued', 'leased', 'cancellation_pending', 'completion_pending', 'outcome_unknown_pending_cleanup') ORDER BY CASE WHEN status IN ('cancellation_pending', 'outcome_unknown_pending_cleanup') THEN 0 WHEN status = 'completion_pending' THEN 1 WHEN status = 'leased' THEN 2 ELSE 3 END, requested_at ASC, invocation_key ASC LIMIT $2",
        [tenant, limit],
      );
      return result.rows.map((row) => {
        if (!isRecord(row) || typeof row.project_key !== "string") {
          throw new Error("数据库中的 MCP 调用项目范围无效");
        }
        return recordFromRow(
          row,
          tenant,
          normalizeKey(row.project_key, "项目标识"),
        );
      });
    } finally {
      client.release();
    }
  }
}
