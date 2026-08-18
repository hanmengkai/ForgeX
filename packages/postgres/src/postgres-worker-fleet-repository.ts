import type {
  WorkerCompletionProof,
  WorkerFleetRepository,
  WorkerFleetSnapshot,
  WorkerFleetTransaction,
} from "@forgex/application";
import type { Pool } from "pg";

export interface PostgresQueryResult {
  rows: unknown[];
}

export interface PostgresClient {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
  release(): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const copySnapshot = (snapshot: WorkerFleetSnapshot): WorkerFleetSnapshot =>
  structuredClone(snapshot);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSnapshot = (value: unknown): WorkerFleetSnapshot => {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !isRecord(parsed.registry) ||
    !isRecord(parsed.queue)
  ) {
    throw new Error("数据库中的 Worker 舰队快照格式无效");
  }
  return copySnapshot(parsed as unknown as WorkerFleetSnapshot);
};

const stateFromRow = (row: unknown): WorkerFleetSnapshot => {
  if (!isRecord(row) || !("state" in row)) {
    throw new Error("数据库中的 Worker 舰队记录格式无效");
  }
  return parseSnapshot(row.state);
};

const assertInternalKey = (value: string, label: string): string => {
  const normalized = value.toLowerCase();
  if (!internalKeyPattern.test(normalized)) {
    throw new Error(`${label}格式不正确`);
  }
  return normalized;
};

const hasMatchingCompletionProof = (
  row: unknown,
  proof: WorkerCompletionProof,
): boolean =>
  isRecord(row) &&
  row.completion_assignment_key === proof.assignmentKey.toLowerCase() &&
  Number(row.completion_fencing_token) === proof.fencingToken &&
  (proof.completionDigest === undefined ||
    row.completion_digest === proof.completionDigest);

export class PostgresWorkerFleetRepository implements WorkerFleetRepository {
  readonly #pool: PostgresPool;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async transaction<T>(
    tenantKey: string,
    operation: (transaction: WorkerFleetTransaction) => Promise<T> | T,
  ): Promise<T> {
    const normalizedTenantKey = assertInternalKey(tenantKey, "租户标识");
    const client = await this.#pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [normalizedTenantKey],
      );
      const stored = await client.query(
        "SELECT state FROM forgex_worker_fleets WHERE tenant_key = $1",
        [normalizedTenantKey],
      );
      let pending = stored.rows[0] ? stateFromRow(stored.rows[0]) : null;
      let changed = false;
      const transaction: WorkerFleetTransaction = {
        load: () => (pending ? copySnapshot(pending) : null),
        save: (snapshot) => {
          if (
            snapshot.registry.tenantKey.toLowerCase() !== normalizedTenantKey
          ) {
            throw new Error("Worker 舰队事务不能写入其他租户");
          }
          pending = copySnapshot(snapshot);
          changed = true;
        },
        hasCompletedWork: async (
          projectKey,
          workKey,
          requirementRevision,
          workKind = "requirement_delivery",
          proof,
        ) => {
          const normalizedProjectKey = assertInternalKey(
            projectKey,
            "项目标识",
          );
          const normalizedWorkKey = assertInternalKey(workKey, "需求标识");
          const result = await client.query(
            "SELECT completion_assignment_key, completion_fencing_token, completion_digest FROM forgex_completed_delivery_work WHERE tenant_key = $1 AND project_key = $2 AND work_key = $3 AND requirement_revision = $4 AND work_kind = $5",
            [
              normalizedTenantKey,
              normalizedProjectKey,
              normalizedWorkKey,
              requirementRevision,
              workKind,
            ],
          );
          const row = result.rows[0];
          return (
            row !== undefined &&
            (!proof || hasMatchingCompletionProof(row, proof))
          );
        },
        markCompletedWork: async (
          projectKey,
          workKey,
          requirementRevision,
          workKind = "requirement_delivery",
          proof,
        ) => {
          const normalizedProjectKey = assertInternalKey(
            projectKey,
            "项目标识",
          );
          const normalizedWorkKey = assertInternalKey(workKey, "需求标识");
          const normalizedAssignmentKey = proof
            ? assertInternalKey(proof.assignmentKey, "任务租约标识")
            : null;
          if (
            proof &&
            (!Number.isSafeInteger(proof.fencingToken) ||
              proof.fencingToken < 1)
          ) {
            throw new Error("任务隔离令牌格式不正确");
          }
          if (
            proof?.completionDigest !== undefined &&
            !/^[a-f0-9]{64}$/u.test(proof.completionDigest)
          ) {
            throw new Error("任务完成内容摘要格式不正确");
          }
          await client.query(
            "INSERT INTO forgex_completed_delivery_work (tenant_key, project_key, work_key, requirement_revision, work_kind, completion_assignment_key, completion_fencing_token, completion_digest) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_key, project_key, work_key, requirement_revision, work_kind) DO NOTHING",
            [
              normalizedTenantKey,
              normalizedProjectKey,
              normalizedWorkKey,
              requirementRevision,
              workKind,
              normalizedAssignmentKey,
              proof?.fencingToken ?? null,
              proof?.completionDigest ?? null,
            ],
          );
        },
        prepareRetry: async (
          dispatchKey,
          projectKey,
          workKey,
          requirementRevision,
        ) => {
          const normalizedDispatchKey = assertInternalKey(
            dispatchKey,
            "派发标识",
          );
          const normalizedProjectKey = assertInternalKey(
            projectKey,
            "项目标识",
          );
          const normalizedWorkKey = assertInternalKey(workKey, "需求标识");
          const inserted = await client.query(
            "INSERT INTO forgex_delivery_retry_preparations (dispatch_key, tenant_key, project_key, requirement_key, requirement_revision) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (dispatch_key) DO NOTHING RETURNING dispatch_key",
            [
              normalizedDispatchKey,
              normalizedTenantKey,
              normalizedProjectKey,
              normalizedWorkKey,
              requirementRevision,
            ],
          );
          if (inserted.rows.length === 0) return false;
          await client.query(
            "DELETE FROM forgex_completed_delivery_work WHERE tenant_key = $1 AND project_key = $2 AND work_key = $3 AND requirement_revision = $4 AND work_kind = 'requirement_delivery'",
            [
              normalizedTenantKey,
              normalizedProjectKey,
              normalizedWorkKey,
              requirementRevision,
            ],
          );
          return true;
        },
      };

      const result = await operation(transaction);
      if (changed && pending) {
        await client.query(
          "INSERT INTO forgex_worker_fleets (tenant_key, state) VALUES ($1, $2::jsonb) ON CONFLICT (tenant_key) DO UPDATE SET state = EXCLUDED.state, revision = forgex_worker_fleets.revision + 1, updated_at = now()",
          [normalizedTenantKey, JSON.stringify(pending)],
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
            "Worker 舰队事务失败且回滚未完成",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export const createPostgresWorkerFleetRepository = (
  pool: Pool,
): PostgresWorkerFleetRepository => new PostgresWorkerFleetRepository(pool);
