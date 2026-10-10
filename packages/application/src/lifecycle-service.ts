import { createPublicKey, randomUUID, verify } from "node:crypto";
import { z } from "zod";

import {
  canonicalLifecycleJson,
  LifecycleActionCommandSchema,
  LifecycleBugCreateCommandSchema,
  LifecycleBugRepairCommandSchema,
  LifecycleBugSchema,
  LifecycleCreateCommandSchema,
  LifecycleDecisionCommandSchema,
  LifecycleExecutorPrincipalSchema,
  LifecycleSignedCompletionSchema,
  LifecycleSnapshotSchema,
  lifecycleStageLabels,
  type LifecycleBug,
  type LifecycleExecutorPrincipal,
  type LifecycleJob,
  type LifecycleRole,
  type LifecycleSnapshot,
  type LifecycleStage,
  type LifecycleView,
} from "@forgex/contracts/lifecycle";
import {
  LifecycleWorkflow,
  lifecycleDigest,
  lifecycleRequiredRoles,
} from "@forgex/domain";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";

export const LifecycleStoreSchema = z
  .object({
    schemaVersion: z.literal(2),
    workflows: z.array(LifecycleSnapshotSchema).max(10_000),
    bugs: z.array(LifecycleBugSchema).max(20_000),
    requests: z
      .array(
        z
          .object({
            requestKey: z.string().uuid(),
            digest: z.string().regex(/^[a-f0-9]{64}$/u),
            entityKey: z.string().uuid(),
            kind: z.enum(["workflow", "bug"]),
          })
          .strict(),
      )
      .max(100_000),
    readNotifications: z
      .array(
        z
          .object({ actorKey: z.string().uuid(), eventKey: z.string().uuid() })
          .strict(),
      )
      .max(100_000),
    productionOwners: z
      .array(
        z
          .object({
            projectKey: z.string().uuid(),
            repositoryKey: z.string().uuid(),
            workflowKey: z.string().uuid(),
          })
          .strict(),
      )
      .max(10_000)
      .default([]),
  })
  .strict();
export type LifecycleStore = z.infer<typeof LifecycleStoreSchema>;
export const emptyLifecycleStore = (): LifecycleStore => ({
  schemaVersion: 2,
  workflows: [],
  bugs: [],
  requests: [],
  readNotifications: [],
  productionOwners: [],
});
export interface LifecycleRepository {
  transaction<T>(
    tenantKey: string,
    operation: (state: LifecycleStore) => Promise<T> | T,
  ): Promise<T>;
}
export class InMemoryLifecycleRepository implements LifecycleRepository {
  readonly #states = new Map<string, LifecycleStore>();
  readonly #tails = new Map<string, Promise<void>>();
  async transaction<T>(
    tenantKey: string,
    operation: (state: LifecycleStore) => Promise<T> | T,
  ): Promise<T> {
    let release!: () => void;
    const previous = this.#tails.get(tenantKey) ?? Promise.resolve();
    const tail = new Promise<void>((r) => {
      release = r;
    });
    this.#tails.set(tenantKey, tail);
    await previous;
    try {
      const state = structuredClone(
        this.#states.get(tenantKey) ?? emptyLifecycleStore(),
      );
      const result = await operation(state);
      this.#states.set(tenantKey, LifecycleStoreSchema.parse(state));
      return result;
    } finally {
      release();
      if (this.#tails.get(tenantKey) === tail) this.#tails.delete(tenantKey);
    }
  }
}
export type { LifecycleView } from "@forgex/contracts/lifecycle";
const internalRoles: LifecycleRole[] = [
  "product_owner",
  "requirement_analyst",
  "developer",
  "tester",
  "test_ops",
  "production_ops",
  "administrator",
];
const notFound = () =>
  new ApplicationError(404, "lifecycle_not_found", "未找到可访问的交付需求");
const retryRoles = (stage: LifecycleStage): LifecycleRole[] =>
  stage === "requirements_ai"
    ? ["product_owner", "requirement_analyst"]
    : stage === "testing"
      ? ["tester"]
      : stage === "staging_deploy"
        ? ["test_ops"]
        : ["production_deploy", "production_rollback"].includes(stage)
          ? ["production_ops"]
          : ["developer"];

export class LifecycleService {
  constructor(
    readonly repository: LifecycleRepository,
    readonly options: {
      projectKey: string;
      repositoryKey: string;
      clock?: () => Date;
      assertScope?: (
        principal: AuthenticatedPrincipal,
        projectKey: string,
        repositoryKey: string,
      ) => Promise<void>;
    },
  ) {}
  async create(
    principal: AuthenticatedPrincipal,
    input: unknown,
  ): Promise<LifecycleView> {
    const command = this.#parse(LifecycleCreateCommandSchema, input);
    if (
      !principal.roles.some((r) =>
        ["requester", "product_owner", "requirement_analyst"].includes(r),
      )
    )
      throw new ApplicationError(
        403,
        "lifecycle_forbidden",
        "只有需求方或产品需求人员可以提交需求",
      );
    if (
      !principal.roles.some(
        (r) => r === "product_owner" || r === "requirement_analyst",
      ) &&
      command.requesterKey !== principal.actorKey
    )
      throw new ApplicationError(
        403,
        "lifecycle_forbidden",
        "需求方只能为自己创建需求",
      );
    await this.#assertScope(
      principal,
      command.projectKey,
      command.repositoryKey,
    );
    return this.repository.transaction(principal.tenantKey, (state) => {
      const duplicate = this.#request(state, principal, command, "create");
      if (duplicate)
        return this.#view(
          this.#flow(state, principal, duplicate.entityKey),
          principal,
        );
      const flow = LifecycleWorkflow.create(
        {
          ...command,
          tenantKey: principal.tenantKey,
          createdBy: principal.actorKey,
        },
        this.#clockOptions(),
      );
      state.workflows.push(flow.toSnapshot());
      this.#remember(
        state,
        principal,
        command,
        "create",
        flow.toSnapshot().workflowKey,
        "workflow",
      );
      return this.#view(flow, principal);
    });
  }
  async list(
    principal: AuthenticatedPrincipal,
    projectKey?: string,
  ): Promise<LifecycleView[]> {
    return this.repository.transaction(principal.tenantKey, (state) =>
      state.workflows
        .filter(
          (s) =>
            this.#canRead(principal, s) &&
            (!projectKey || s.projectKey === projectKey),
        )
        .slice(-200)
        .reverse()
        .map((s) =>
          this.#view(
            LifecycleWorkflow.restore(s, this.#clockOptions()),
            principal,
          ),
        ),
    );
  }
  async get(
    principal: AuthenticatedPrincipal,
    workflowKey: string,
  ): Promise<LifecycleView> {
    return this.repository.transaction(principal.tenantKey, (state) =>
      this.#view(this.#flow(state, principal, workflowKey), principal),
    );
  }
  async decide(
    principal: AuthenticatedPrincipal,
    workflowKey: string,
    input: unknown,
  ): Promise<LifecycleView> {
    const command = this.#parse(LifecycleDecisionCommandSchema, input);
    return this.#mutate(principal, workflowKey, command, "decide", (flow) =>
      flow.decide({ actor: principal, ...command }),
    );
  }
  async action(
    principal: AuthenticatedPrincipal,
    workflowKey: string,
    input: unknown,
  ): Promise<LifecycleView> {
    const command = this.#parse(LifecycleActionCommandSchema, input);
    return this.#mutate(principal, workflowKey, command, "action", (flow) => {
      if (command.action === "retry")
        flow.retry({ actor: principal, reason: command.reason });
      else if (command.action === "request_recovery")
        flow.requestRecovery({ actor: principal, reason: command.reason });
      else {
        if (!command.objectionKey)
          throw new ApplicationError(
            422,
            "validation_error",
            "请选择需要处理的异议",
          );
        flow.resolveObjection({
          actor: principal,
          objectionKey: command.objectionKey,
          reason: command.reason,
        });
      }
    });
  }
  async claim(
    executorInput: LifecycleExecutorPrincipal,
  ): Promise<LifecycleJob | null> {
    const executor = this.#parse(
      LifecycleExecutorPrincipalSchema,
      executorInput,
    );
    return this.repository.transaction(executor.tenantKey, (state) => {
      for (let i = 0; i < state.workflows.length; i++) {
        const snapshot = state.workflows[i]!;
        if (!this.#executorScope(executor, snapshot)) continue;
        const flow = LifecycleWorkflow.restore(snapshot, this.#clockOptions());
        if (
          ["production_deploy", "production_rollback"].includes(
            snapshot.stage,
          ) &&
          state.productionOwners.some(
            (owner) =>
              owner.projectKey === snapshot.projectKey &&
              owner.repositoryKey === snapshot.repositoryKey &&
              owner.workflowKey !== snapshot.workflowKey,
          )
        )
          continue;
        const job = flow.claim({
          executorKey: executor.executorKey,
          capabilities: executor.capabilities,
          leaseMs: 5 * 60_000,
        });
        state.workflows[i] = flow.toSnapshot();
        if (job) {
          if (
            job.stage === "production_deploy" &&
            !state.productionOwners.some(
              (owner) => owner.workflowKey === snapshot.workflowKey,
            )
          )
            state.productionOwners.push({
              projectKey: snapshot.projectKey,
              repositoryKey: snapshot.repositoryKey,
              workflowKey: snapshot.workflowKey,
            });
          return job;
        }
      }
      return null;
    });
  }
  async renew(
    executor: LifecycleExecutorPrincipal,
    jobKey: string,
    input: unknown,
  ): Promise<LifecycleJob> {
    const command = this.#parse(
      z
        .object({
          schemaVersion: z.literal(2),
          fencingToken: z.string().uuid(),
        })
        .strict(),
      input,
    );
    return this.repository.transaction(executor.tenantKey, (state) => {
      const index = state.workflows.findIndex(
        (s) =>
          this.#executorScope(executor, s) &&
          s.jobs.some((j) => j.jobKey === jobKey),
      );
      if (index < 0) throw notFound();
      const flow = LifecycleWorkflow.restore(
        state.workflows[index],
        this.#clockOptions(),
      );
      try {
        const result = flow.renew({
          executorKey: executor.executorKey,
          jobKey,
          fencingToken: command.fencingToken,
          leaseMs: 5 * 60_000,
        });
        state.workflows[index] = flow.toSnapshot();
        return result;
      } catch (error) {
        throw this.#conflict(error);
      }
    });
  }
  async complete(
    executorInput: LifecycleExecutorPrincipal,
    input: unknown,
  ): Promise<{ workflowKey: string; stage: LifecycleStage; version: number }> {
    const executor = this.#parse(
      LifecycleExecutorPrincipalSchema,
      executorInput,
    );
    const command = this.#parse(LifecycleSignedCompletionSchema, input);
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(executor.publicKeyBase64, "base64"),
        format: "der",
        type: "spki",
      });
      if (
        publicKey.asymmetricKeyType !== "ed25519" ||
        !verify(
          null,
          Buffer.from(canonicalLifecycleJson(command.payload)),
          publicKey,
          Buffer.from(command.signatureBase64, "base64"),
        )
      )
        throw new Error();
    } catch {
      throw new ApplicationError(
        403,
        "invalid_lifecycle_signature",
        "自动任务结果签名无效",
      );
    }
    return this.repository.transaction(executor.tenantKey, (state) => {
      const index = state.workflows.findIndex(
        (s) =>
          this.#executorScope(executor, s) &&
          s.jobs.some((j) => j.jobKey === command.payload.jobKey),
      );
      if (index < 0) throw notFound();
      const flow = LifecycleWorkflow.restore(
        state.workflows[index],
        this.#clockOptions(),
      );
      const job = flow
        .toSnapshot()
        .jobs.find((j) => j.jobKey === command.payload.jobKey)!;
      if (!executor.capabilities.includes(job.stage))
        throw new ApplicationError(
          403,
          "lifecycle_capability_denied",
          "执行器没有这个阶段的能力",
        );
      try {
        flow.complete({
          ...command.payload,
          executorKey: executor.executorKey,
        });
        state.workflows[index] = flow.toSnapshot();
        const snapshot = flow.toSnapshot();
        if (
          job.stage === "production_rollback" &&
          snapshot.stage === "development"
        )
          state.productionOwners = state.productionOwners.filter(
            (owner) => owner.workflowKey !== snapshot.workflowKey,
          );
        return {
          workflowKey: snapshot.workflowKey,
          stage: snapshot.stage,
          version: snapshot.version,
        };
      } catch (error) {
        throw this.#conflict(error);
      }
    });
  }
  async reportBug(
    principal: AuthenticatedPrincipal,
    workflowKey: string,
    input: unknown,
  ): Promise<LifecycleBug> {
    const command = this.#parse(LifecycleBugCreateCommandSchema, input);
    return this.repository.transaction(principal.tenantKey, (state) => {
      const flow = this.#flow(state, principal, workflowKey);
      if (flow.toSnapshot().stage !== "closed")
        throw new ApplicationError(
          409,
          "lifecycle_not_closed",
          "需求尚未关闭，请使用本轮异议或驳回处理问题",
        );
      const duplicate = this.#request(
        state,
        principal,
        command,
        `bug:${workflowKey}`,
      );
      if (duplicate)
        return structuredClone(
          state.bugs.find((b) => b.bugKey === duplicate.entityKey)!,
        );
      const snapshot = flow.toSnapshot();
      const bug: LifecycleBug = {
        schemaVersion: 2,
        bugKey: randomUUID(),
        tenantKey: principal.tenantKey,
        projectKey: snapshot.projectKey,
        workflowKey,
        reportedBy: principal.actorKey,
        title: command.title,
        description: command.description,
        severity: command.severity,
        status: "open",
        repairWorkflowKey: null,
        createdAt: this.#now(),
        resolvedAt: null,
      };
      state.bugs.push(bug);
      flow.recordBug(command.title);
      state.workflows[
        state.workflows.findIndex((s) => s.workflowKey === workflowKey)
      ] = flow.toSnapshot();
      this.#remember(
        state,
        principal,
        command,
        `bug:${workflowKey}`,
        bug.bugKey,
        "bug",
      );
      return structuredClone(bug);
    });
  }
  async listBugs(
    principal: AuthenticatedPrincipal,
    workflowKey: string,
  ): Promise<LifecycleBug[]> {
    return this.repository.transaction(principal.tenantKey, (state) => {
      this.#flow(state, principal, workflowKey);
      return structuredClone(
        state.bugs.filter((b) => b.workflowKey === workflowKey),
      );
    });
  }
  async repairBug(
    principal: AuthenticatedPrincipal,
    bugKey: string,
    input: unknown,
  ): Promise<LifecycleBug> {
    const command = this.#parse(LifecycleBugRepairCommandSchema, input);
    return this.repository.transaction(principal.tenantKey, (state) => {
      const bug = state.bugs.find((b) => b.bugKey === bugKey);
      if (!bug) throw notFound();
      const original = this.#flow(
        state,
        principal,
        bug.workflowKey,
      ).toSnapshot();
      const duplicate = this.#request(
        state,
        principal,
        command,
        `repair:${bugKey}`,
      );
      if (duplicate) return structuredClone(bug);
      if (command.action === "start_repair") {
        if (
          !principal.roles.some((r) =>
            ["product_owner", "developer"].includes(r),
          )
        )
          throw new ApplicationError(
            403,
            "lifecycle_forbidden",
            "只有产品或研发负责人可以安排修复",
          );
        if (bug.status !== "open")
          throw new ApplicationError(
            409,
            "bug_conflict",
            "这个 Bug 已经安排修复",
          );
        const repair = LifecycleWorkflow.create(
          {
            tenantKey: principal.tenantKey,
            projectKey: original.projectKey,
            repositoryKey: original.repositoryKey,
            requesterKey: original.requesterKey,
            title: `修复：${bug.title}`.slice(0, 500),
            brief: `原需求：${original.title}\n缺陷：${bug.description}\n原交付：${original.workflowKey}`,
            createdBy: principal.actorKey,
            sourceBugKey: bug.bugKey,
          },
          this.#clockOptions(),
        );
        state.workflows.push(repair.toSnapshot());
        bug.repairWorkflowKey = repair.toSnapshot().workflowKey;
        bug.status = "repairing";
      } else {
        if (
          !principal.roles.includes("tester") &&
          !(
            principal.roles.includes("requester") &&
            principal.actorKey === original.requesterKey
          )
        )
          throw new ApplicationError(
            403,
            "lifecycle_forbidden",
            "只有测试负责人或本需求方可以确认修复",
          );
        if (
          bug.status !== "repairing" ||
          !bug.repairWorkflowKey ||
          state.workflows.find((s) => s.workflowKey === bug.repairWorkflowKey)
            ?.stage !== "closed"
        )
          throw new ApplicationError(
            409,
            "repair_not_accepted",
            "关联修复需求尚未完成线上验收",
          );
        bug.status = "resolved";
        bug.resolvedAt = this.#now();
      }
      this.#remember(
        state,
        principal,
        command,
        `repair:${bugKey}`,
        bug.bugKey,
        "bug",
      );
      return structuredClone(bug);
    });
  }
  async notifications(principal: AuthenticatedPrincipal) {
    return this.repository.transaction(principal.tenantKey, (state) =>
      state.workflows
        .filter((s) => this.#canRead(principal, s))
        .flatMap((s) =>
          s.events
            .filter(
              (e) =>
                e.roles.some((r) => principal.roles.includes(r)) &&
                (!e.roles.includes("requester") ||
                  principal.actorKey === s.requesterKey ||
                  principal.roles.some((r) => r !== "requester")),
            )
            .map((e) => ({
              notificationKey: e.eventKey,
              workflowKey: s.workflowKey,
              title: s.title,
              detail: e.detail,
              at: e.at,
              read: state.readNotifications.some(
                (r) =>
                  r.actorKey === principal.actorKey &&
                  r.eventKey === e.eventKey,
              ),
            })),
        )
        .slice(-200)
        .reverse(),
    );
  }
  async acknowledge(principal: AuthenticatedPrincipal, eventKey: string) {
    return this.repository.transaction(principal.tenantKey, (state) => {
      if (
        !state.workflows.some(
          (s) =>
            this.#canRead(principal, s) &&
            s.events.some((e) => e.eventKey === eventKey),
        )
      )
        throw notFound();
      if (
        !state.readNotifications.some(
          (r) => r.actorKey === principal.actorKey && r.eventKey === eventKey,
        )
      )
        state.readNotifications.push({
          actorKey: principal.actorKey,
          eventKey,
        });
    });
  }
  #mutate(
    principal: AuthenticatedPrincipal,
    workflowKey: string,
    command: { requestKey: string; expectedVersion: number },
    kind: string,
    operation: (flow: LifecycleWorkflow) => void,
  ): Promise<LifecycleView> {
    return this.repository.transaction(principal.tenantKey, (state) => {
      const flow = this.#flow(state, principal, workflowKey);
      const duplicate = this.#request(
        state,
        principal,
        command,
        `${kind}:${workflowKey}`,
      );
      if (duplicate) return this.#view(flow, principal);
      if (flow.toSnapshot().version !== command.expectedVersion)
        throw new ApplicationError(
          409,
          "lifecycle_version_conflict",
          "交付内容已经更新，请刷新后审核当前版本",
        );
      try {
        operation(flow);
      } catch (error) {
        throw this.#conflict(error);
      }
      const index = state.workflows.findIndex(
        (s) => s.workflowKey === workflowKey,
      );
      state.workflows[index] = flow.toSnapshot();
      if (flow.toSnapshot().stage === "closed")
        state.productionOwners = state.productionOwners.filter(
          (owner) => owner.workflowKey !== workflowKey,
        );
      this.#remember(
        state,
        principal,
        command,
        `${kind}:${workflowKey}`,
        workflowKey,
        "workflow",
      );
      return this.#view(flow, principal);
    });
  }
  #flow(
    state: LifecycleStore,
    principal: AuthenticatedPrincipal,
    key: string,
  ): LifecycleWorkflow {
    const index = state.workflows.findIndex(
      (s) => s.workflowKey === key && this.#canRead(principal, s),
    );
    if (index < 0) throw notFound();
    const flow = LifecycleWorkflow.restore(
      state.workflows[index],
      this.#clockOptions(),
    );
    if (flow.expireLease()) state.workflows[index] = flow.toSnapshot();
    return flow;
  }
  #canRead(principal: AuthenticatedPrincipal, s: LifecycleSnapshot): boolean {
    return (
      s.tenantKey === principal.tenantKey &&
      (principal.roles.some((r) => internalRoles.includes(r)) ||
        (principal.roles.includes("requester") &&
          s.requesterKey === principal.actorKey))
    );
  }
  #executorScope(e: LifecycleExecutorPrincipal, s: LifecycleSnapshot): boolean {
    return (
      e.tenantKey === s.tenantKey &&
      e.projectKey === s.projectKey &&
      e.repositoryKey === s.repositoryKey
    );
  }
  #request(
    state: LifecycleStore,
    principal: AuthenticatedPrincipal,
    command: { requestKey: string },
    kind: string,
  ) {
    const found = state.requests.find(
      (r) => r.requestKey === command.requestKey,
    );
    if (
      found &&
      found.digest !==
        lifecycleDigest({ actorKey: principal.actorKey, kind, command })
    )
      throw new ApplicationError(
        409,
        "idempotency_conflict",
        "幂等请求标识已经用于不同内容",
      );
    return found;
  }
  #remember(
    state: LifecycleStore,
    principal: AuthenticatedPrincipal,
    command: { requestKey: string },
    operation: string,
    entityKey: string,
    kind: "workflow" | "bug",
  ) {
    state.requests.push({
      requestKey: command.requestKey,
      digest: lifecycleDigest({
        actorKey: principal.actorKey,
        kind: operation,
        command,
      }),
      entityKey,
      kind,
    });
  }
  #view(
    flow: LifecycleWorkflow,
    principal: AuthenticatedPrincipal,
  ): LifecycleView {
    const s = flow.toSnapshot();
    const customerOnly = !principal.roles.some((r) =>
      internalRoles.includes(r),
    );
    const approvals = flow.activeApprovals();
    const allowedRoles = lifecycleRequiredRoles(s.stage).filter(
      (role) =>
        principal.roles.includes(role) &&
        (role !== "requester" || s.requesterKey === principal.actorKey) &&
        !approvals.some(
          (a) => a.role === role || a.actorKey === principal.actorKey,
        ),
    );
    const artifacts = Object.values(s.current)
      .flatMap((key) => s.artifacts.filter((a) => a.artifactKey === key))
      .filter(
        (a) =>
          !customerOnly ||
          ["requirements", "tests", "deployment"].includes(a.output.kind),
      )
      .map((a) => {
        const o = a.output;
        let content: string | null = null;
        if (o.kind === "requirements")
          content = `目标：${o.spec.goal}\n\n用户故事：\n${o.spec.userStories.map((story) => `${story.role}需要${story.need}，以便${story.value}`).join("\n")}\n\n验收条件：\n${o.spec.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion.title}：${criterion.description}`).join("\n")}\n\n待澄清：\n${o.spec.openQuestions.length ? o.spec.openQuestions.join("\n") : "无"}`;
        if (o.kind === "design")
          content = `${o.architecture}\n\n接口：\n${o.interfaces.join("\n")}\n\n数据变更：\n${o.migrations.join("\n")}\n\n测试策略：\n${o.testStrategy.join("\n")}\n\n发布计划：\n${o.rolloutPlan}`;
        const checks =
          o.kind === "tests"
            ? o.checks.map((c) => ({ title: c.name, passed: c.passed }))
            : o.kind === "code"
              ? o.selfTests.map((c) => ({ title: c.name, passed: c.passed }))
              : [];
        const technical =
          !customerOnly && "commitSha" in o
            ? { commitSha: o.commitSha, artifactDigest: o.artifactDigest }
            : null;
        return {
          kind: o.kind,
          summary: o.summary,
          content,
          url: o.kind === "deployment" ? o.url : null,
          checks,
          technical,
        };
      });
    const lastJob = s.jobs.find((j) => j.round === s.round);
    const allowedActions: LifecycleView["allowedActions"] = [];
    if (
      s.blockedReason &&
      principal.roles.some((r) => retryRoles(s.stage).includes(r))
    )
      allowedActions.push("retry");
    if (
      allowedRoles.length &&
      s.objections.some((o) => o.round === s.round && !o.resolution)
    )
      allowedActions.push("resolve_objection");
    if (
      principal.roles.includes("production_ops") &&
      ["production_deploy", "online_acceptance"].includes(s.stage) &&
      !s.jobs.some(
        (job) => job.stage === "production_deploy" && job.status === "running",
      )
    )
      allowedActions.push("request_recovery");
    return {
      schemaVersion: 2,
      workflowKey: s.workflowKey,
      projectKey: s.projectKey,
      repositoryKey: s.repositoryKey,
      requesterKey: s.requesterKey,
      title: s.title,
      brief: s.brief,
      version: s.version,
      requirementVersion: s.requirementVersion,
      designVersion: s.designVersion,
      stage: s.stage,
      stageLabel: lifecycleStageLabels[s.stage],
      blockedReason: s.blockedReason,
      updatedAt: s.updatedAt,
      sourceBugKey: s.sourceBugKey,
      approvals: approvals.map(({ actorName, role, reason, at }) => ({
        actorName,
        role,
        reason,
        at,
      })),
      objections: s.objections.filter((o) => o.round === s.round),
      artifacts,
      events: s.events
        .slice(-100)
        .map(({ title, detail, at }) => ({ title, detail, at })),
      currentJob: lastJob
        ? {
            status: lastJob.status,
            stageLabel: lifecycleStageLabels[lastJob.stage],
            attempt: s.jobs.filter((j) => j.stage === lastJob.stage).length,
          }
        : null,
      allowedRoles,
      allowedActions,
      canReportBug: s.stage === "closed",
    };
  }
  async #assertScope(
    p: AuthenticatedPrincipal,
    projectKey: string,
    repositoryKey: string,
  ): Promise<void> {
    if (this.options.assertScope)
      return this.options.assertScope(p, projectKey, repositoryKey);
    if (
      projectKey !== this.options.projectKey ||
      repositoryKey !== this.options.repositoryKey
    )
      throw notFound();
  }
  #parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new ApplicationError(
        422,
        "validation_error",
        "生命周期请求格式不正确，请核对输入",
      );
    return parsed.data;
  }
  #conflict(error: unknown): ApplicationError {
    return error instanceof ApplicationError
      ? error
      : new ApplicationError(
          409,
          "lifecycle_state_conflict",
          error instanceof Error ? error.message : "当前交付状态不允许这个操作",
        );
  }
  #clockOptions() {
    return this.options.clock ? { clock: this.options.clock } : {};
  }
  #now(): string {
    return (this.options.clock ?? (() => new Date()))().toISOString();
  }
}
