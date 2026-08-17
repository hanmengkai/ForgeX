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
import {
  DeliverySkillBindingsSchema,
  DeliveryExecutionEventRecordSchema,
  DeliveryRunResultSchema,
  VerificationEvidenceRecordSchema,
  VerificationFailureRecordSchema,
  type DeliveryDispatchRecord,
  type DeliveryExecutionEventRecord,
  type DeliveryRunResult,
  type RequirementAuditAction,
  type RequirementAuditEvent,
  type RequirementListOptions,
  type RequirementListPage,
  type RequirementRecord,
  type RequirementRepository,
  type RequirementTransaction,
  type VerificationEvidenceRecord,
  type VerificationFailureRecord,
} from "@forgex/application";

import type {
  PostgresClient,
  PostgresPool,
} from "./postgres-worker-fleet-repository.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const auditActions = new Set<RequirementAuditAction>([
  "requirement.created",
  "requirement.revised",
  "requirement.confirmation_submitted",
  "requirement.confirmed",
  "requirement.deleted",
  "requirement.accepted",
  "delivery.requested",
  "delivery.dispatched",
  "delivery.terminated",
  "delivery.completed",
  "verification.preview_recorded",
  "verification.failed",
  "verification.completed",
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
      const pendingDeletedRecords = new Map<string, string>();
      const pendingAudit: RequirementAuditEvent[] = [];
      const pendingDispatches = new Map<string, DeliveryDispatchRecord>();
      const pendingDeliveryRuns = new Map<string, DeliveryRunResult>();
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
          const key = parseInternalKey(requirementKey, "需求标识");
          if (pendingDeletedRecords.has(key)) return null;
          const pending = pendingRecords.get(key);
          if (pending) {
            return this.#copyRecord(pending);
          }
          const cached = loaded.get(key);
          if (cached) {
            return this.#copyRecord(cached);
          }
          const result = await client.query(
            "SELECT created_at, repository_key, spec, workflow FROM forgex_requirements WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND deleted_at IS NULL",
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
        softDelete: (requirementKey, deletedAt) => {
          const key = parseInternalKey(requirementKey, "需求标识");
          pendingDeletedRecords.set(
            key,
            parseIsoDate(deletedAt, "需求删除时间"),
          );
          pendingRecords.delete(key);
          loaded.delete(key);
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
        appendDeliveryExecutionEvent: async (event) => {
          const parsed = DeliveryExecutionEventRecordSchema.parse(event);
          if (parsed.tenantKey !== tenant || parsed.projectKey !== project) {
            throw new Error("事务不能写入其他范围的 Codex 过程事件");
          }
          const inserted = await client.query(
            "INSERT INTO forgex_requirement_execution_events (event_key, tenant_key, project_key, requirement_key, requirement_revision, assignment_key, sequence, occurred_at, event) VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM forgex_requirement_execution_events WHERE tenant_key = $2 AND assignment_key = $6), $7, $8::jsonb) ON CONFLICT DO NOTHING RETURNING event_key",
            [
              parsed.eventKey,
              tenant,
              project,
              parsed.requirementKey,
              parsed.requirementRevision,
              parsed.assignmentKey,
              parsed.occurredAt,
              JSON.stringify(parsed.event),
            ],
          );
          if (inserted.rows.length > 0) return true;
          const existing = await client.query(
            "SELECT event_key, requirement_key, requirement_revision, assignment_key, sequence, occurred_at, event FROM forgex_requirement_execution_events WHERE tenant_key = $1 AND event_key = $2",
            [tenant, parsed.eventKey],
          );
          const row = existing.rows[0];
          if (!row) throw new Error("Codex 过程事件写入冲突");
          const stored = this.#deliveryExecutionEventFromRow(
            row,
            tenant,
            project,
          );
          const { sequence: _storedSequence, ...storedComparable } = stored;
          const { sequence: _parsedSequence, ...parsedComparable } = parsed;
          if (
            JSON.stringify(storedComparable) !==
            JSON.stringify(parsedComparable)
          ) {
            throw new Error("同一 Codex 过程事件不能绑定不同内容");
          }
          return false;
        },
        listDeliveryExecutionEvents: async (
          requirementKey,
          requirementRevision,
          limit,
        ) => {
          const requirement = parseInternalKey(requirementKey, "需求标识");
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
            throw new Error("Codex 过程事件查询上限无效");
          }
          const result = await client.query(
            "SELECT event_key, requirement_key, requirement_revision, assignment_key, sequence, occurred_at, event FROM forgex_requirement_execution_events WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4 ORDER BY occurred_at DESC, sequence DESC LIMIT $5",
            [tenant, project, requirement, requirementRevision, limit],
          );
          return result.rows
            .map((row) =>
              this.#deliveryExecutionEventFromRow(row, tenant, project),
            )
            .reverse();
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
            "UPDATE forgex_delivery_outbox SET dispatched_at = $4 WHERE tenant_key = $1 AND project_key = $2 AND dispatch_key = $3 AND dispatched_at IS NULL AND cancelled_at IS NULL RETURNING dispatch_key",
            [tenant, project, key, parseIsoDate(dispatchedAt, "派发时间")],
          );
          return updated.rows.length > 0;
        },
        markDeliveryCancelled: async (dispatchKey, cancelledAt) => {
          const key = parseInternalKey(dispatchKey, "派发标识");
          const cancelled = parseIsoDate(cancelledAt, "终止时间");
          const pending = pendingDispatches.get(key);
          if (pending) {
            if (pending.cancelledAt) return false;
            pendingDispatches.set(key, { ...pending, cancelledAt: cancelled });
            return true;
          }
          const updated = await client.query(
            "UPDATE forgex_delivery_outbox SET cancelled_at = $4 WHERE tenant_key = $1 AND project_key = $2 AND dispatch_key = $3 AND cancelled_at IS NULL RETURNING dispatch_key",
            [tenant, project, key, cancelled],
          );
          return updated.rows.length > 0;
        },
        markDeliveryCancellationCompleted: async (dispatchKey, completedAt) => {
          const key = parseInternalKey(dispatchKey, "派发标识");
          const completed = parseIsoDate(completedAt, "设备撤销完成时间");
          const pending = pendingDispatches.get(key);
          if (pending) {
            if (!pending.cancelledAt) {
              throw new Error("交付尚未登记终止，不能确认设备撤销");
            }
            if (pending.cancellationCompletedAt) return false;
            pendingDispatches.set(key, {
              ...pending,
              cancellationCompletedAt: completed,
            });
            return true;
          }
          const updated = await client.query(
            "UPDATE forgex_delivery_outbox SET cancellation_completed_at = $4 WHERE tenant_key = $1 AND project_key = $2 AND dispatch_key = $3 AND cancelled_at IS NOT NULL AND cancellation_completed_at IS NULL RETURNING dispatch_key",
            [tenant, project, key, completed],
          );
          return updated.rows.length > 0;
        },
        findDeliveryDispatch: async (requirementKey, requirementRevision) => {
          const requirement = parseInternalKey(requirementKey, "需求标识");
          const pending = [...pendingDispatches.values()].find(
            (dispatch) =>
              dispatch.requirementKey === requirement &&
              dispatch.requirementRevision === requirementRevision,
          );
          if (pending) return this.#copyDispatch(pending);
          const result = await client.query(
            "SELECT dispatch_key, project_key, repository_key, requirement_key, requirement_revision, title, required_capabilities, skills, requested_at, dispatched_at, cancelled_at, cancellation_completed_at FROM forgex_delivery_outbox WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4 ORDER BY requested_at DESC, dispatch_key DESC LIMIT 1",
            [tenant, project, requirement, requirementRevision],
          );
          const row = result.rows[0];
          return row ? this.#dispatchFromRow(row, tenant) : null;
        },
        findDeliveryRunResult: async (requirementKey, requirementRevision) => {
          const requirement = parseInternalKey(requirementKey, "需求标识");
          const key = `${requirement}:${requirementRevision}`;
          const pending = pendingDeliveryRuns.get(key);
          if (pending) return structuredClone(pending);
          const result = await client.query(
            "SELECT repository_key, requirement_key, requirement_revision, assignment_key, fencing_token, git_hash_algorithm, base_commit, commit_sha, branch_name, summary, status, submitted_at, completed_at FROM forgex_delivery_runs WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4",
            [tenant, project, requirement, requirementRevision],
          );
          const row = result.rows[0];
          return row ? this.#deliveryRunFromRow(row, tenant, project) : null;
        },
        saveDeliveryRunResult: (run) => {
          const parsed = DeliveryRunResultSchema.parse(run);
          this.#assertDeliveryRunScope(parsed, tenant, project);
          pendingDeliveryRuns.set(
            `${parsed.requirementKey}:${parsed.requirementRevision}`,
            structuredClone(parsed),
          );
        },
        markDeliveryRunCompleted: async (
          requirementKey,
          requirementRevision,
          proof,
          completedAt,
        ) => {
          const requirement = parseInternalKey(requirementKey, "需求标识");
          const assignment = parseInternalKey(
            proof.assignmentKey,
            "任务租约标识",
          );
          if (
            !Number.isSafeInteger(proof.fencingToken) ||
            proof.fencingToken < 1
          ) {
            throw new Error("任务租约 fencing 无效");
          }
          const key = `${requirement}:${requirementRevision}`;
          const pending = pendingDeliveryRuns.get(key);
          if (pending) {
            if (
              pending.assignmentKey !== assignment ||
              pending.fencingToken !== proof.fencingToken
            ) {
              throw new Error("交付运行完成凭据不匹配");
            }
            if (pending.status === "completed") return false;
            pendingDeliveryRuns.set(
              key,
              DeliveryRunResultSchema.parse({
                ...pending,
                status: "completed",
                completedAt,
              }),
            );
            return true;
          }
          const updated = await client.query(
            "UPDATE forgex_delivery_runs SET status = 'completed', completed_at = $7 WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4 AND assignment_key = $5 AND fencing_token = $6 AND status = 'completion_pending' RETURNING requirement_key",
            [
              tenant,
              project,
              requirement,
              requirementRevision,
              assignment,
              proof.fencingToken,
              parseIsoDate(completedAt, "交付完成时间"),
            ],
          );
          if (updated.rows.length > 0) return true;
          const existing = await client.query(
            "SELECT assignment_key, fencing_token, status FROM forgex_delivery_runs WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4",
            [tenant, project, requirement, requirementRevision],
          );
          const row = existing.rows[0];
          if (
            isRecord(row) &&
            row.assignment_key === assignment &&
            Number(row.fencing_token) === proof.fencingToken &&
            row.status === "completed"
          ) {
            return false;
          }
          throw new Error("没有找到与完成凭据匹配的交付运行记录");
        },
        appendVerificationEvidence: (evidence) => {
          const parsed = VerificationEvidenceRecordSchema.parse(evidence);
          if (parsed.tenantKey !== tenant || parsed.projectKey !== project) {
            throw new Error("事务不能写入其他范围的验证证据");
          }
          const pending = pendingVerificationEvidence.get(parsed.evidenceKey);
          if (pending) {
            if (JSON.stringify(pending) === JSON.stringify(parsed)) return;
            throw new Error("同一验证证据标识不能绑定不同内容");
          }
          pendingVerificationEvidence.set(
            parsed.evidenceKey,
            structuredClone(parsed),
          );
        },
        findVerificationFailure: async (
          requirementKey,
          requirementRevision,
        ) => {
          const requirement = parseInternalKey(requirementKey, "需求标识");
          const key = `${requirement}:${requirementRevision}`;
          const pending = pendingVerificationFailures.get(key);
          if (pending) return structuredClone(pending);
          const result = await client.query(
            "SELECT repository_key, failure_digest, runner_key, key_id, verification_completed_at, checks, recorded_at FROM forgex_verification_failures WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4",
            [tenant, project, requirement, requirementRevision],
          );
          const row = result.rows[0];
          if (!isRecord(row)) return null;
          return VerificationFailureRecordSchema.parse({
            tenantKey: tenant,
            projectKey: project,
            repositoryKey: String(row.repository_key),
            requirementKey: requirement,
            requirementRevision,
            failureDigest: row.failure_digest,
            runnerKey: String(row.runner_key),
            keyId: String(row.key_id),
            verificationCompletedAt: parseIsoDate(
              row.verification_completed_at,
              "独立验证失败完成时间",
            ),
            checks: row.checks,
            recordedAt: parseIsoDate(row.recorded_at, "验证失败记录时间"),
          });
        },
        saveVerificationFailure: (failure) => {
          const parsed = VerificationFailureRecordSchema.parse(failure);
          if (parsed.tenantKey !== tenant || parsed.projectKey !== project) {
            throw new Error("事务不能写入其他范围的验证失败记录");
          }
          pendingVerificationFailures.set(
            `${parsed.requirementKey}:${parsed.requirementRevision}`,
            structuredClone(parsed),
          );
        },
      };

      const result = await operation(transaction);
      for (const record of pendingRecords.values()) {
        await client.query(
          "INSERT INTO forgex_requirements (tenant_key, project_key, repository_key, requirement_key, created_at, spec, workflow) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) ON CONFLICT (tenant_key, project_key, requirement_key) DO UPDATE SET repository_key = COALESCE(forgex_requirements.repository_key, EXCLUDED.repository_key), spec = EXCLUDED.spec, workflow = EXCLUDED.workflow, updated_at = now()",
          [
            tenant,
            project,
            record.repositoryKey ?? null,
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
      for (const [requirementKey, deletedAt] of pendingDeletedRecords) {
        const deleted = await client.query(
          "UPDATE forgex_requirements SET deleted_at = $4, updated_at = now() WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND deleted_at IS NULL RETURNING requirement_key",
          [tenant, project, requirementKey, deletedAt],
        );
        if (deleted.rows.length !== 1) {
          throw new Error("需求已被删除，请刷新后重试");
        }
      }
      for (const dispatch of pendingDispatches.values()) {
        await client.query(
          "INSERT INTO forgex_delivery_outbox (dispatch_key, tenant_key, project_key, repository_key, requirement_key, requirement_revision, title, required_capabilities, skills, requested_at, dispatched_at, cancelled_at, cancellation_completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)",
          [
            dispatch.dispatchKey,
            tenant,
            project,
            dispatch.repositoryKey,
            dispatch.requirementKey,
            dispatch.requirementRevision,
            dispatch.title,
            JSON.stringify(dispatch.requiredCapabilities),
            JSON.stringify(dispatch.skills),
            dispatch.requestedAt,
            dispatch.dispatchedAt,
            dispatch.cancelledAt ?? null,
            dispatch.cancellationCompletedAt ?? null,
          ],
        );
      }
      for (const run of pendingDeliveryRuns.values()) {
        await client.query(
          "INSERT INTO forgex_delivery_runs (tenant_key, project_key, repository_key, requirement_key, requirement_revision, assignment_key, fencing_token, git_hash_algorithm, base_commit, commit_sha, branch_name, summary, status, submitted_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
          [
            tenant,
            project,
            run.repositoryKey,
            run.requirementKey,
            run.requirementRevision,
            run.assignmentKey,
            run.fencingToken,
            run.gitHashAlgorithm,
            run.baseCommit,
            run.commitSha,
            run.branchName,
            run.summary,
            run.status,
            run.submittedAt,
            run.completedAt,
          ],
        );
      }
      for (const evidence of pendingVerificationEvidence.values()) {
        const inserted = await client.query(
          "INSERT INTO forgex_requirement_evidence (tenant_key, project_key, requirement_key, requirement_revision, evidence_key, evidence_digest, runner_key, key_id, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_key, evidence_key) DO NOTHING RETURNING evidence_key",
          [
            tenant,
            project,
            evidence.requirementKey,
            evidence.requirementRevision,
            evidence.evidenceKey,
            evidence.evidenceDigest,
            evidence.runnerKey,
            evidence.keyId,
            evidence.recordedAt,
          ],
        );
        if (inserted.rows.length === 0) {
          const existing = await client.query(
            "SELECT project_key, requirement_key, requirement_revision, evidence_digest, runner_key, key_id, recorded_at FROM forgex_requirement_evidence WHERE tenant_key = $1 AND evidence_key = $2",
            [tenant, evidence.evidenceKey],
          );
          const row = existing.rows[0];
          if (
            !isRecord(row) ||
            String(row.project_key).toLowerCase() !== project ||
            String(row.requirement_key).toLowerCase() !==
              evidence.requirementKey ||
            Number(row.requirement_revision) !== evidence.requirementRevision ||
            row.evidence_digest !== evidence.evidenceDigest ||
            String(row.runner_key).toLowerCase() !== evidence.runnerKey ||
            String(row.key_id).toLowerCase() !== evidence.keyId ||
            parseIsoDate(row.recorded_at, "证据记录时间") !==
              evidence.recordedAt
          ) {
            throw new Error("同一验证证据标识已经绑定其他需求或内容");
          }
        }
      }
      for (const failure of pendingVerificationFailures.values()) {
        const inserted = await client.query(
          "INSERT INTO forgex_verification_failures (tenant_key, project_key, repository_key, requirement_key, requirement_revision, failure_digest, runner_key, key_id, verification_completed_at, checks, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) ON CONFLICT (tenant_key, project_key, requirement_key, requirement_revision) DO NOTHING RETURNING requirement_key",
          [
            tenant,
            project,
            failure.repositoryKey,
            failure.requirementKey,
            failure.requirementRevision,
            failure.failureDigest,
            failure.runnerKey,
            failure.keyId,
            failure.verificationCompletedAt,
            JSON.stringify(failure.checks),
            failure.recordedAt,
          ],
        );
        if (inserted.rows.length === 0) {
          const existing = await client.query(
            "SELECT repository_key, failure_digest, runner_key, key_id, verification_completed_at, checks FROM forgex_verification_failures WHERE tenant_key = $1 AND project_key = $2 AND requirement_key = $3 AND requirement_revision = $4",
            [
              tenant,
              project,
              failure.requirementKey,
              failure.requirementRevision,
            ],
          );
          const row = existing.rows[0];
          if (
            !isRecord(row) ||
            String(row.repository_key).toLowerCase() !==
              failure.repositoryKey ||
            row.failure_digest !== failure.failureDigest ||
            String(row.runner_key).toLowerCase() !== failure.runnerKey ||
            String(row.key_id).toLowerCase() !== failure.keyId ||
            parseIsoDate(
              row.verification_completed_at,
              "独立验证失败完成时间",
            ) !== failure.verificationCompletedAt ||
            JSON.stringify(row.checks) !== JSON.stringify(failure.checks)
          ) {
            throw new Error("同一交付版本已经记录不同的验证失败结果");
          }
        }
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
        "SELECT requirement_key, repository_key, workflow, position FROM forgex_requirements WHERE tenant_key = $1 AND project_key = $2 AND deleted_at IS NULL AND position > $3 ORDER BY position ASC LIMIT $4",
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
          repositoryKey:
            row.repository_key === null || row.repository_key === undefined
              ? null
              : parseInternalKey(String(row.repository_key), "仓库标识"),
          workflow,
          position: parseSafePosition(row.position),
        };
      });
      const hasNext = parsed.length > options.limit;
      const page = parsed.slice(0, options.limit);
      return {
        items: page.map((item) => ({
          requirementKey: item.requirementKey,
          repositoryKey: item.repositoryKey,
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
            "SELECT dispatch_key, project_key, repository_key, requirement_key, requirement_revision, title, required_capabilities, skills, requested_at, dispatched_at, cancelled_at, cancellation_completed_at FROM forgex_delivery_outbox WHERE tenant_key = $1 AND project_key = $2 AND dispatched_at IS NULL AND cancelled_at IS NULL ORDER BY requested_at ASC, dispatch_key ASC LIMIT $3",
            [tenant, project, limit],
          )
        : await client.query(
            "SELECT dispatch_key, project_key, repository_key, requirement_key, requirement_revision, title, required_capabilities, skills, requested_at, dispatched_at, cancelled_at, cancellation_completed_at FROM forgex_delivery_outbox WHERE tenant_key = $1 AND dispatched_at IS NULL AND cancelled_at IS NULL ORDER BY requested_at ASC, dispatch_key ASC LIMIT $2",
            [tenant, limit],
          );
      return result.rows.map((row) => this.#dispatchFromRow(row, tenant));
    });
  }

  async listPendingDeliveryCancellations(
    tenantKey: string,
    limit: number,
  ): Promise<DeliveryDispatchRecord[]> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待撤销记录查询上限必须在 1 到 100 之间");
    }
    return this.#withClient(async (client) => {
      const result = await client.query(
        "SELECT dispatch_key, project_key, repository_key, requirement_key, requirement_revision, title, required_capabilities, skills, requested_at, dispatched_at, cancelled_at, cancellation_completed_at FROM forgex_delivery_outbox WHERE tenant_key = $1 AND cancelled_at IS NOT NULL AND cancellation_completed_at IS NULL ORDER BY cancelled_at ASC, dispatch_key ASC LIMIT $2",
        [tenant, limit],
      );
      return result.rows.map((row) => this.#dispatchFromRow(row, tenant));
    });
  }

  async listPendingDeliveryRunResults(
    tenantKey: string,
    limit: number,
  ): Promise<DeliveryRunResult[]> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待收敛交付结果查询上限必须在 1 到 100 之间");
    }
    return this.#withClient(async (client) => {
      const result = await client.query(
        "SELECT project_key, repository_key, requirement_key, requirement_revision, assignment_key, fencing_token, git_hash_algorithm, base_commit, commit_sha, branch_name, summary, status, submitted_at, completed_at FROM forgex_delivery_runs WHERE tenant_key = $1 AND status = 'completion_pending' ORDER BY submitted_at ASC, assignment_key ASC LIMIT $2",
        [tenant, limit],
      );
      return result.rows.map((row) => {
        if (!isRecord(row)) {
          throw new Error("数据库中的交付运行记录格式无效");
        }
        return this.#deliveryRunFromRow(
          row,
          tenant,
          parseInternalKey(String(row.project_key), "项目标识"),
        );
      });
    });
  }

  async findDeliveryRunResultByProof(
    tenantKey: string,
    proof: { assignmentKey: string; fencingToken: number },
  ): Promise<DeliveryRunResult | null> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    const assignment = parseInternalKey(proof.assignmentKey, "任务租约标识");
    if (!Number.isSafeInteger(proof.fencingToken) || proof.fencingToken < 1) {
      throw new Error("任务租约 fencing 无效");
    }
    return this.#withClient(async (client) => {
      const result = await client.query(
        "SELECT project_key, repository_key, requirement_key, requirement_revision, assignment_key, fencing_token, git_hash_algorithm, base_commit, commit_sha, branch_name, summary, status, submitted_at, completed_at FROM forgex_delivery_runs WHERE tenant_key = $1 AND assignment_key = $2 AND fencing_token = $3",
        [tenant, assignment, proof.fencingToken],
      );
      const row = result.rows[0];
      if (!row || !isRecord(row)) return null;
      return this.#deliveryRunFromRow(
        row,
        tenant,
        parseInternalKey(String(row.project_key), "项目标识"),
      );
    });
  }

  async listDeliveryRunsAwaitingVerification(
    tenantKey: string,
    projectKey: string,
    repositoryKey: string,
    limit: number,
  ): Promise<DeliveryRunResult[]> {
    const tenant = parseInternalKey(tenantKey, "租户标识");
    const project = parseInternalKey(projectKey, "项目标识");
    const repository = parseInternalKey(repositoryKey, "仓库标识");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("待验证交付查询上限必须在 1 到 100 之间");
    }
    return this.#withClient(async (client) => {
      const result = await client.query(
        "SELECT run.repository_key, run.requirement_key, run.requirement_revision, run.assignment_key, run.fencing_token, run.git_hash_algorithm, run.base_commit, run.commit_sha, run.branch_name, run.summary, run.status, run.submitted_at, run.completed_at FROM forgex_delivery_runs AS run INNER JOIN forgex_requirements AS requirement ON requirement.tenant_key = run.tenant_key AND requirement.project_key = run.project_key AND requirement.requirement_key = run.requirement_key WHERE run.tenant_key = $1 AND run.project_key = $2 AND run.repository_key = $3 AND run.status = 'completed' AND run.requirement_revision = jsonb_array_length(requirement.workflow -> 'revisions') AND requirement.workflow ->> 'status' = 'inDelivery' AND requirement.workflow -> 'evidence' = 'null'::jsonb AND NOT EXISTS (SELECT 1 FROM forgex_verification_failures AS failure WHERE failure.tenant_key = run.tenant_key AND failure.project_key = run.project_key AND failure.requirement_key = run.requirement_key AND failure.requirement_revision = run.requirement_revision) ORDER BY run.completed_at ASC, run.requirement_key ASC LIMIT $4",
        [tenant, project, repository, limit],
      );
      return result.rows.map((row) =>
        this.#deliveryRunFromRow(row, tenant, project),
      );
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
    workflow.restoreCurrentSpec(spec);
    workflow.assertSpecIntegrity(spec);
    return {
      tenantKey,
      projectKey,
      repositoryKey:
        row.repository_key === null || row.repository_key === undefined
          ? null
          : parseInternalKey(String(row.repository_key), "仓库标识"),
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
      cancelledAt: dispatch.cancelledAt ?? null,
      cancellationCompletedAt: dispatch.cancellationCompletedAt ?? null,
      requiredCapabilities: [...dispatch.requiredCapabilities],
      skills: dispatch.skills.map((skill) => ({ ...skill })),
    };
  }

  #deliveryExecutionEventFromRow(
    row: unknown,
    tenantKey: string,
    projectKey: string,
  ): DeliveryExecutionEventRecord {
    if (!isRecord(row)) {
      throw new Error("数据库中的 Codex 过程事件格式无效");
    }
    const event =
      typeof row.event === "string"
        ? (JSON.parse(row.event) as unknown)
        : row.event;
    return DeliveryExecutionEventRecordSchema.parse({
      eventKey: parseInternalKey(String(row.event_key), "过程事件标识"),
      tenantKey,
      projectKey,
      requirementKey: parseInternalKey(String(row.requirement_key), "需求标识"),
      requirementRevision: Number(row.requirement_revision),
      assignmentKey: parseInternalKey(
        String(row.assignment_key),
        "任务租约标识",
      ),
      sequence: Number(row.sequence),
      occurredAt: parseIsoDate(row.occurred_at, "过程事件时间"),
      event,
    });
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
    if (record.repositoryKey !== null && record.repositoryKey !== undefined) {
      parseInternalKey(record.repositoryKey, "仓库标识");
    }
    record.workflow.assertPersistenceIdentity({
      tenantKey,
      projectKey,
      requirementKey: record.requirementKey,
    });
    RequirementSpecSchema.parse(record.spec);
    record.workflow.restoreCurrentSpec(record.spec);
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
    parseInternalKey(dispatch.repositoryKey, "仓库标识");
    parseInternalKey(dispatch.requirementKey, "需求标识");
    const requestedAt = parseIsoDate(dispatch.requestedAt, "交付请求时间");
    const capabilities = StartDeliveryCommandSchema.safeParse({
      schemaVersion: 1,
      requiredCapabilities: dispatch.requiredCapabilities,
      skillKeys: dispatch.skills.map((skill) => skill.skillKey),
    });
    if (
      !capabilities.success ||
      !DeliverySkillBindingsSchema.safeParse(dispatch.skills).success
    ) {
      throw new Error("需求事务不能写入无效的设备能力要求");
    }
    if (dispatch.dispatchedAt !== null) {
      const dispatchedAt = parseIsoDate(dispatch.dispatchedAt, "派发时间");
      if (Date.parse(dispatchedAt) < Date.parse(requestedAt)) {
        throw new Error("派发时间不能早于交付请求时间");
      }
    }
    if (dispatch.cancelledAt) {
      const cancelledAt = parseIsoDate(dispatch.cancelledAt, "终止时间");
      if (Date.parse(cancelledAt) < Date.parse(requestedAt)) {
        throw new Error("终止时间不能早于交付请求时间");
      }
      if (
        dispatch.cancellationCompletedAt &&
        Date.parse(
          parseIsoDate(dispatch.cancellationCompletedAt, "设备撤销完成时间"),
        ) < Date.parse(cancelledAt)
      ) {
        throw new Error("设备撤销完成时间不能早于终止时间");
      }
    } else if (dispatch.cancellationCompletedAt) {
      throw new Error("设备撤销完成时间必须绑定终止记录");
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
    const skills = DeliverySkillBindingsSchema.safeParse(row.skills);
    const capabilities = StartDeliveryCommandSchema.safeParse({
      schemaVersion: 1,
      requiredCapabilities: row.required_capabilities,
      skillKeys: skills.success
        ? skills.data.map((skill) => skill.skillKey)
        : undefined,
    });
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (
      !skills.success ||
      !capabilities.success ||
      title.length < 2 ||
      title.length > 150
    ) {
      throw new Error("数据库中的交付派发记录格式无效");
    }
    const requestedAt = parseIsoDate(row.requested_at, "交付请求时间");
    const dispatchedAt =
      row.dispatched_at === null
        ? null
        : parseIsoDate(row.dispatched_at, "派发时间");
    const cancelledAt =
      row.cancelled_at === null || row.cancelled_at === undefined
        ? null
        : parseIsoDate(row.cancelled_at, "终止时间");
    const cancellationCompletedAt =
      row.cancellation_completed_at === null ||
      row.cancellation_completed_at === undefined
        ? null
        : parseIsoDate(row.cancellation_completed_at, "设备撤销完成时间");
    if (
      dispatchedAt !== null &&
      Date.parse(dispatchedAt) < Date.parse(requestedAt)
    ) {
      throw new Error("数据库中的交付派发时间无效");
    }
    if (
      cancelledAt !== null &&
      Date.parse(cancelledAt) < Date.parse(requestedAt)
    ) {
      throw new Error("数据库中的交付终止时间无效");
    }
    if (
      cancellationCompletedAt !== null &&
      (cancelledAt === null ||
        Date.parse(cancellationCompletedAt) < Date.parse(cancelledAt))
    ) {
      throw new Error("数据库中的设备撤销完成时间无效");
    }
    return {
      dispatchKey: parseInternalKey(String(row.dispatch_key), "派发标识"),
      tenantKey,
      projectKey: parseInternalKey(String(row.project_key), "项目标识"),
      repositoryKey: parseInternalKey(String(row.repository_key), "仓库标识"),
      requirementKey: parseInternalKey(String(row.requirement_key), "需求标识"),
      requirementRevision: revision,
      title,
      requiredCapabilities: [...capabilities.data.requiredCapabilities],
      skills: skills.data.map((skill) => ({ ...skill })),
      requestedAt,
      dispatchedAt,
      cancelledAt,
      cancellationCompletedAt,
    };
  }

  #assertDeliveryRunScope(
    run: DeliveryRunResult,
    tenantKey: string,
    projectKey: string,
  ): void {
    const parsed = DeliveryRunResultSchema.parse(run);
    if (parsed.tenantKey !== tenantKey || parsed.projectKey !== projectKey) {
      throw new Error("需求事务不能写入其他范围的交付运行结果");
    }
  }

  #deliveryRunFromRow(
    row: unknown,
    tenantKey: string,
    projectKey: string,
  ): DeliveryRunResult {
    if (!isRecord(row)) {
      throw new Error("数据库中的交付运行记录格式无效");
    }
    return DeliveryRunResultSchema.parse({
      tenantKey,
      projectKey,
      repositoryKey: row.repository_key,
      requirementKey: row.requirement_key,
      requirementRevision: Number(row.requirement_revision),
      assignmentKey: row.assignment_key,
      fencingToken: Number(row.fencing_token),
      gitHashAlgorithm: row.git_hash_algorithm,
      baseCommit: row.base_commit,
      commitSha: row.commit_sha,
      branchName: row.branch_name,
      summary: row.summary,
      status: row.status,
      submittedAt: parseIsoDate(row.submitted_at, "交付结果提交时间"),
      completedAt:
        row.completed_at === null
          ? null
          : parseIsoDate(row.completed_at, "交付完成时间"),
    });
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
