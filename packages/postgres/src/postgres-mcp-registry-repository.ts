import type {
  McpEnableAuditEvent,
  McpRegistryRepository,
  McpRegistryTransaction,
} from "@forgex/application";
import {
  McpEnableRecordSchema,
  McpServerRegistrySnapshotSchema,
  type McpServerRegistrySnapshot,
} from "@forgex/extensions";

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

const snapshotFromRow = (
  row: unknown,
  tenantKey: string,
  projectKey: string,
): McpServerRegistrySnapshot => {
  if (!isRecord(row) || !("state" in row)) {
    throw new Error("数据库中的 MCP 仓储记录格式无效");
  }
  const value =
    typeof row.state === "string"
      ? (JSON.parse(row.state) as unknown)
      : row.state;
  const parsed = McpServerRegistrySnapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error("数据库中的 MCP 快照格式无效");
  if (
    parsed.data.tenantKey !== tenantKey ||
    parsed.data.projectKey !== projectKey
  ) {
    throw new Error("数据库中的 MCP 快照不属于查询范围");
  }
  return structuredClone(parsed.data);
};

const auditFromRow = (
  row: unknown,
  tenantKey: string,
  projectKey: string,
): McpEnableAuditEvent => {
  if (!isRecord(row)) throw new Error("数据库中的 MCP 审计格式无效");
  const eventKey = normalizeKey(String(row.eventKey ?? ""), "审计标识");
  const rowTenantKey = normalizeKey(String(row.tenantKey ?? ""), "租户标识");
  const rowProjectKey = normalizeKey(String(row.projectKey ?? ""), "项目标识");
  const record = McpEnableRecordSchema.safeParse({
    action: row.action,
    actorKey: row.actorKey,
    actorName: row.actorName,
    serverKey: row.serverKey,
    revision: Number(row.revision),
    attestationKey: row.attestationKey,
    recordedAt:
      row.recordedAt instanceof Date
        ? row.recordedAt.toISOString()
        : row.recordedAt,
  });
  if (!record.success) throw new Error("数据库中的 MCP 审计格式无效");
  if (rowTenantKey !== tenantKey || rowProjectKey !== projectKey) {
    throw new Error("数据库中的 MCP 审计不属于查询范围");
  }
  return {
    eventKey,
    tenantKey: rowTenantKey,
    projectKey: rowProjectKey,
    ...record.data,
  };
};

export class PostgresMcpRegistryRepository implements McpRegistryRepository {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: McpRegistryTransaction) => Promise<T> | T,
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
        [`${tenant}:${project}:mcp-registry`],
      );
      const stored = await client.query(
        "SELECT state FROM forgex_mcp_registries WHERE tenant_key = $1 AND project_key = $2",
        [tenant, project],
      );
      let pendingSnapshot = stored.rows[0]
        ? snapshotFromRow(stored.rows[0], tenant, project)
        : null;
      let snapshotChanged = false;
      const pendingAudit: McpEnableAuditEvent[] = [];
      const transaction: McpRegistryTransaction = {
        load: () => (pendingSnapshot ? structuredClone(pendingSnapshot) : null),
        save: (input) => {
          const snapshot = McpServerRegistrySnapshotSchema.parse(input);
          if (
            snapshot.tenantKey !== tenant ||
            snapshot.projectKey !== project
          ) {
            throw new Error("MCP 仓储事务不能写入其他租户或项目");
          }
          pendingSnapshot = structuredClone(snapshot);
          snapshotChanged = true;
        },
        appendAudit: (input) => {
          const eventKey = normalizeKey(input.eventKey, "审计标识");
          const eventTenant = normalizeKey(input.tenantKey, "租户标识");
          const eventProject = normalizeKey(input.projectKey, "项目标识");
          const record = McpEnableRecordSchema.parse({
            action: input.action,
            actorKey: input.actorKey,
            actorName: input.actorName,
            serverKey: input.serverKey,
            revision: input.revision,
            attestationKey: input.attestationKey,
            recordedAt: input.recordedAt,
          });
          if (eventTenant !== tenant || eventProject !== project) {
            throw new Error("MCP 仓储事务不能写入其他范围的审计");
          }
          if (pendingAudit.some((event) => event.eventKey === eventKey)) {
            throw new Error("MCP 审计标识不能重复");
          }
          pendingAudit.push({
            eventKey,
            tenantKey: eventTenant,
            projectKey: eventProject,
            ...record,
          });
        },
      };

      const result = await operation(transaction);
      if (snapshotChanged && pendingSnapshot) {
        await client.query(
          "INSERT INTO forgex_mcp_registries (tenant_key, project_key, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant_key, project_key) DO UPDATE SET state = EXCLUDED.state, revision = forgex_mcp_registries.revision + 1, updated_at = now()",
          [tenant, project, JSON.stringify(pendingSnapshot)],
        );
      }
      for (const event of pendingAudit) {
        await client.query(
          "INSERT INTO forgex_mcp_enable_audit (event_key, tenant_key, project_key, server_key, server_revision, attestation_key, action, actor_key, actor_name, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [
            event.eventKey,
            event.tenantKey,
            event.projectKey,
            event.serverKey,
            event.revision,
            event.attestationKey,
            event.action,
            event.actorKey,
            event.actorName,
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
            "MCP 仓储事务失败且回滚未完成",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listAudit(
    tenantKey: string,
    projectKey: string,
    limit = 100,
  ): Promise<McpEnableAuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MCP 审计查询条数必须在 1 到 100 之间");
    }
    const tenant = normalizeKey(tenantKey, "租户标识");
    const project = normalizeKey(projectKey, "项目标识");
    const client = await this.#pool.connect();
    try {
      const result = await client.query(
        'SELECT event_key::text AS "eventKey", tenant_key::text AS "tenantKey", project_key::text AS "projectKey", server_key::text AS "serverKey", server_revision AS revision, attestation_key::text AS "attestationKey", action, actor_key::text AS "actorKey", actor_name AS "actorName", recorded_at AS "recordedAt" FROM forgex_mcp_enable_audit WHERE tenant_key = $1 AND project_key = $2 ORDER BY recorded_at DESC, event_key DESC LIMIT $3',
        [tenant, project, limit],
      );
      return result.rows.map((row) => auditFromRow(row, tenant, project));
    } finally {
      client.release();
    }
  }
}
