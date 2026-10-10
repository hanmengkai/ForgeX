import { createHash, randomUUID } from "node:crypto";

import {
  canonicalLifecycleJson,
  LifecycleSnapshotSchema,
  LifecycleTaskResultSchema,
  lifecycleStageLabels,
  type LifecycleActor,
  type LifecycleArtifact,
  type LifecycleCapability,
  type LifecycleJob,
  type LifecycleOutput,
  type LifecycleRole,
  type LifecycleSnapshot,
  type LifecycleStage,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";

export const lifecycleDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalLifecycleJson(value)).digest("hex");
const automatic = new Set<LifecycleStage>([
  "requirements_ai",
  "design_ai",
  "development",
  "testing",
  "staging_deploy",
  "production_deploy",
  "production_rollback",
]);
const nextStage: Partial<Record<LifecycleStage, LifecycleStage>> = {
  requirements_ai: "requirements_review",
  requirements_review: "requester_confirmation",
  requester_confirmation: "design_ai",
  design_ai: "design_review",
  design_review: "development",
  development: "code_review",
  code_review: "testing",
  testing: "test_review",
  test_review: "staging_deploy",
  staging_deploy: "staging_acceptance",
  staging_acceptance: "release_approval",
  release_approval: "production_deploy",
  production_deploy: "online_acceptance",
  online_acceptance: "closed",
  recovery_approval: "production_rollback",
  production_rollback: "development",
};
const joint: LifecycleRole[] = ["developer", "production_ops", "requester"];
export const lifecycleRequiredRoles = (
  stage: LifecycleStage,
): LifecycleRole[] => {
  switch (stage) {
    case "requirements_review":
      return ["product_owner"];
    case "requester_confirmation":
    case "staging_acceptance":
      return ["requester"];
    case "design_review":
    case "code_review":
      return ["developer"];
    case "test_review":
      return ["tester"];
    case "release_approval":
    case "online_acceptance":
    case "recovery_approval":
      return [...joint];
    default:
      return [];
  }
};
const currentSlot: Record<
  LifecycleOutput["kind"],
  keyof LifecycleSnapshot["current"]
> = {
  requirements: "requirements",
  design: "design",
  code: "code",
  tests: "tests",
  deployment: "staging",
  rollback: "rollback",
};

export class LifecycleWorkflow {
  #state: LifecycleSnapshot;
  readonly #clock: () => Date;
  private constructor(
    state: LifecycleSnapshot,
    options: { clock?: () => Date } = {},
  ) {
    this.#state = state;
    this.#clock = options.clock ?? (() => new Date());
  }
  static create(
    input: {
      tenantKey: string;
      projectKey: string;
      repositoryKey: string;
      requesterKey: string;
      title: string;
      brief: string;
      createdBy: string;
      workflowKey?: string;
      sourceBugKey?: string;
    },
    options: { clock?: () => Date } = {},
  ): LifecycleWorkflow {
    const now = (options.clock ?? (() => new Date()))().toISOString();
    const flow = new LifecycleWorkflow(
      LifecycleSnapshotSchema.parse({
        schemaVersion: 2,
        workflowKey: input.workflowKey ?? randomUUID(),
        tenantKey: input.tenantKey,
        projectKey: input.projectKey,
        repositoryKey: input.repositoryKey,
        requesterKey: input.requesterKey,
        createdBy: input.createdBy,
        title: input.title,
        brief: input.brief,
        version: 1,
        requirementVersion: 1,
        designVersion: 1,
        round: 1,
        stage: "requirements_ai",
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
        current: {},
        artifacts: [],
        jobs: [],
        approvals: [],
        objections: [],
        events: [],
        commands: [],
        sourceBugKey: input.sourceBugKey ?? null,
      }),
      options,
    );
    flow.#queue();
    flow.#event("需求已提交", "等待需求 Agent 整理方案", [
      "product_owner",
      "requester",
    ]);
    return flow;
  }
  static restore(
    snapshot: unknown,
    options: { clock?: () => Date } = {},
  ): LifecycleWorkflow {
    return new LifecycleWorkflow(
      LifecycleSnapshotSchema.parse(structuredClone(snapshot)),
      options,
    );
  }
  toSnapshot(): LifecycleSnapshot {
    return LifecycleSnapshotSchema.parse(structuredClone(this.#state));
  }
  currentArtifact(
    slot: keyof LifecycleSnapshot["current"],
  ): LifecycleArtifact | null {
    return (
      this.#state.artifacts.find(
        (a) => a.artifactKey === this.#state.current[slot],
      ) ?? null
    );
  }
  activeApprovals() {
    return this.#state.approvals.filter(
      (a) =>
        a.stage === this.#state.stage &&
        a.round === this.#state.round &&
        a.subjectDigest === this.subjectDigest(),
    );
  }
  subjectDigest(): string {
    return lifecycleDigest({
      stage: this.#state.stage,
      round: this.#state.round,
      requirementVersion: this.#state.requirementVersion,
      designVersion: this.#state.designVersion,
      current: this.#state.current,
    });
  }
  claim(input: {
    executorKey: string;
    capabilities: LifecycleCapability[];
    leaseMs: number;
  }): LifecycleJob | null {
    if (
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 60 * 60_000
    )
      throw new Error("任务租约必须在 30 秒到 60 分钟之间");
    this.expireLease();
    if (
      this.#state.blockedReason ||
      !automatic.has(this.#state.stage) ||
      !input.capabilities.includes(this.#state.stage as LifecycleCapability)
    )
      return null;
    if (
      this.#state.stage === "testing" &&
      this.currentArtifact("code")?.executorKey === input.executorKey
    )
      return null;
    const job = this.#state.jobs.find(
      (j) => j.round === this.#state.round && j.status === "queued",
    );
    if (!job) return null;
    job.status = "running";
    job.executorKey = input.executorKey;
    job.fencingToken = randomUUID();
    job.leaseUntil = new Date(
      this.#clock().getTime() + input.leaseMs,
    ).toISOString();
    this.#touch();
    return structuredClone(job);
  }
  renew(input: {
    jobKey: string;
    executorKey: string;
    fencingToken: string;
    leaseMs: number;
  }): LifecycleJob {
    if (
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 30_000 ||
      input.leaseMs > 60 * 60_000
    )
      throw new Error("任务租约超出范围");
    const job = this.#runningJob(input);
    job.leaseUntil = new Date(
      this.#clock().getTime() + input.leaseMs,
    ).toISOString();
    this.#touch();
    return structuredClone(job);
  }
  expireLease(): boolean {
    const job = this.#state.jobs.find(
      (j) => j.status === "running" && j.round === this.#state.round,
    );
    if (
      !job?.leaseUntil ||
      new Date(job.leaseUntil).getTime() > this.#clock().getTime()
    )
      return false;
    job.status = "blocked";
    this.#state.blockedReason = "执行租约已过期，请核对执行器日志后恢复";
    this.#event("自动任务中断", this.#state.blockedReason, this.#retryRoles());
    return true;
  }
  complete(input: {
    jobKey: string;
    executorKey: string;
    fencingToken: string;
    inputDigest: string;
    result: LifecycleTaskResult;
  }): void {
    const result = LifecycleTaskResultSchema.parse(input.result);
    const resultDigest = lifecycleDigest({ ...input, result });
    const found = this.#state.jobs.find((j) => j.jobKey === input.jobKey);
    if (found?.resultDigest) {
      if (found.resultDigest === resultDigest) return;
      throw new Error("任务完成回调内容冲突");
    }
    const job = this.#runningJob(input);
    if (job.inputDigest !== input.inputDigest)
      throw new Error("任务输入摘要不一致");
    if (result.status !== "succeeded") {
      job.status = result.status;
      job.result = result;
      job.resultDigest = resultDigest;
      this.#state.blockedReason = result.reason;
      this.#event("自动执行阻塞", result.reason, this.#retryRoles());
      return;
    }
    this.#validateOutput(job, result.output);
    const artifact: LifecycleArtifact = {
      artifactKey: randomUUID(),
      jobKey: job.jobKey,
      executorKey: input.executorKey,
      createdAt: this.#clock().toISOString(),
      contentDigest: lifecycleDigest(result.output),
      output: result.output,
    };
    this.#state.artifacts.push(artifact);
    const slot =
      result.output.kind === "deployment"
        ? result.output.environment
        : currentSlot[result.output.kind];
    this.#state.current[slot] = artifact.artifactKey;
    job.status = "succeeded";
    job.result = result;
    job.resultDigest = resultDigest;
    this.#event("自动任务完成", result.output.summary, []);
    if (job.stage === "production_rollback") this.#clearFrom("code");
    this.#move(nextStage[job.stage]!);
  }
  decide(input: {
    actor: LifecycleActor;
    role: string;
    decision: "approve" | "reject" | "object";
    reason: string;
    rework?:
      | "requirements"
      | "design"
      | "implementation"
      | "verification"
      | "deployment"
      | undefined;
  }): void {
    const role = input.role as LifecycleRole;
    this.#assertReviewer(input.actor, role);
    if (input.reason.trim().length < 2) throw new Error("请填写审核意见");
    if (input.decision === "object") {
      const previousRound = this.#state.round;
      this.#state.round++;
      for (const objection of this.#state.objections.filter(
        (o) => o.round === previousRound && !o.resolution,
      ))
        objection.round = this.#state.round;
      this.#state.objections.push({
        objectionKey: randomUUID(),
        stage: this.#state.stage,
        round: this.#state.round,
        actorKey: input.actor.actorKey,
        actorName: input.actor.actorName,
        reason: input.reason,
        resolution: null,
        resolvedBy: null,
      });
      this.#event(
        "提出异议",
        `${input.actor.actorName}：${input.reason}`,
        lifecycleRequiredRoles(this.#state.stage),
      );
      return;
    }
    if (input.decision === "reject") {
      const allowed: Partial<Record<LifecycleStage, string[]>> = {
        requirements_review: ["requirements"],
        requester_confirmation: ["requirements"],
        design_review: ["requirements", "design"],
        code_review: ["requirements", "design", "implementation"],
        test_review: [
          "requirements",
          "design",
          "implementation",
          "verification",
        ],
        staging_acceptance: [
          "requirements",
          "design",
          "implementation",
          "verification",
          "deployment",
        ],
        release_approval: [
          "requirements",
          "design",
          "implementation",
          "verification",
          "deployment",
        ],
      };
      if (input.rework && !allowed[this.#state.stage]?.includes(input.rework))
        throw new Error("这个阶段不能退回所选返工环节");
      this.#event(
        "审核驳回",
        `${input.actor.actorName}：${input.reason}`,
        lifecycleRequiredRoles(this.#state.stage),
      );
      for (const objection of this.#state.objections.filter(
        (o) => o.round === this.#state.round && !o.resolution,
      )) {
        objection.resolution = "本轮已驳回，随返工重新审核";
        objection.resolvedBy = input.actor.actorKey;
      }
      if (
        this.#state.stage === "online_acceptance" ||
        this.#state.stage === "recovery_approval"
      ) {
        this.#move("recovery_approval");
        return;
      }
      const target =
        input.rework ??
        (
          {
            requirements_review: "requirements",
            requester_confirmation: "requirements",
            design_review: "design",
            code_review: "implementation",
            test_review: "verification",
            staging_acceptance: "implementation",
            release_approval: "implementation",
          } as const
        )[this.#state.stage as "requirements_review"] ??
        "implementation";
      this.#rewind(target);
      return;
    }
    if (
      this.#state.objections.some(
        (o) => o.round === this.#state.round && !o.resolution,
      )
    )
      throw new Error("本轮仍有未处理异议，不能通过审核");
    if (this.#state.stage === "requirements_review") {
      const requirements = this.currentArtifact("requirements")?.output;
      if (
        requirements?.kind !== "requirements" ||
        requirements.spec.openQuestions.length > 0
      )
        throw new Error("需求仍有待澄清问题，请驳回并补充说明");
    }
    const approvals = this.activeApprovals();
    if (approvals.some((a) => a.role === role))
      throw new Error("这个岗位已经批准本轮内容");
    if (
      lifecycleRequiredRoles(this.#state.stage).length > 1 &&
      approvals.some((a) => a.actorKey === input.actor.actorKey)
    )
      throw new Error("联合审批必须由不同自然人分别确认");
    this.#state.approvals.push({
      actorKey: input.actor.actorKey,
      actorName: input.actor.actorName,
      role,
      stage: this.#state.stage,
      round: this.#state.round,
      subjectDigest: this.subjectDigest(),
      reason: input.reason,
      at: this.#clock().toISOString(),
    });
    this.#event(
      "人工审核通过",
      `${input.actor.actorName}：${input.reason}`,
      [],
    );
    if (
      lifecycleRequiredRoles(this.#state.stage).every((required) =>
        this.activeApprovals().some((a) => a.role === required),
      )
    )
      this.#move(nextStage[this.#state.stage]!);
  }
  resolveObjection(input: {
    actor: LifecycleActor;
    objectionKey: string;
    reason: string;
  }): void {
    if (
      !lifecycleRequiredRoles(this.#state.stage).some((role) =>
        input.actor.roles.includes(role),
      )
    )
      throw new Error("当前身份不能处理本轮异议");
    const objection = this.#state.objections.find(
      (o) =>
        o.objectionKey === input.objectionKey &&
        o.round === this.#state.round &&
        !o.resolution,
    );
    if (!objection) throw new Error("未找到本轮待处理异议");
    if (input.reason.trim().length < 2) throw new Error("请记录异议处理结论");
    if (
      input.actor.roles.includes("requester") &&
      !input.actor.roles.some((r) => r !== "requester") &&
      input.actor.actorKey !== this.#state.requesterKey
    )
      throw new Error("无权处理其他需求方的异议");
    objection.resolution = input.reason;
    objection.resolvedBy = input.actor.actorKey;
    this.#event(
      "异议已处理",
      input.reason,
      lifecycleRequiredRoles(this.#state.stage),
    );
  }
  retry(input: { actor: LifecycleActor; reason: string }): void {
    if (!this.#state.blockedReason || !automatic.has(this.#state.stage))
      throw new Error("当前没有可恢复的自动任务");
    if (!input.actor.roles.some((r) => this.#retryRoles().includes(r)))
      throw new Error("当前身份无权恢复这个阶段");
    this.#event("恢复自动执行", input.reason, []);
    this.#move(
      this.#state.stage === "production_deploy"
        ? "release_approval"
        : this.#state.stage === "production_rollback"
          ? "recovery_approval"
          : this.#state.stage,
    );
  }
  requestRecovery(input: { actor: LifecycleActor; reason: string }): void {
    if (
      !input.actor.roles.includes("production_ops") ||
      !["production_deploy", "online_acceptance"].includes(this.#state.stage)
    )
      throw new Error("只有生产运维能在生产发布阶段申请恢复");
    this.expireLease();
    if (
      this.#state.jobs.some(
        (job) => job.status === "running" && job.stage === "production_deploy",
      )
    )
      throw new Error("生产发布仍在执行中，请先等待结果或核对中断状态");
    this.#event("申请生产恢复", input.reason, joint);
    this.#move("recovery_approval");
  }
  recordBug(title: string): void {
    if (this.#state.stage !== "closed") throw new Error("需求尚未关闭");
    this.#event("收到关联 Bug", title, [
      "product_owner",
      "developer",
      "tester",
    ]);
  }
  #runningJob(input: {
    jobKey: string;
    executorKey: string;
    fencingToken: string;
  }): LifecycleJob {
    const job = this.#state.jobs.find((j) => j.jobKey === input.jobKey);
    if (
      !job ||
      job.round !== this.#state.round ||
      job.status !== "running" ||
      job.executorKey !== input.executorKey ||
      job.fencingToken !== input.fencingToken
    )
      throw new Error("任务令牌已经失效，请重新读取当前状态");
    if (
      !job.leaseUntil ||
      new Date(job.leaseUntil).getTime() <= this.#clock().getTime()
    )
      throw new Error("任务租约已经过期，结果不能写入");
    return job;
  }
  #assertReviewer(actor: LifecycleActor, role: LifecycleRole): void {
    if (
      this.#state.blockedReason ||
      !lifecycleRequiredRoles(this.#state.stage).includes(role) ||
      !actor.roles.includes(role)
    )
      throw new Error("当前身份不能审核这个阶段");
    if (role === "requester" && actor.actorKey !== this.#state.requesterKey)
      throw new Error("只能由本需求的需求方确认");
  }
  #validateOutput(job: LifecycleJob, output: LifecycleOutput): void {
    const expected: Record<LifecycleCapability, LifecycleOutput["kind"]> = {
      requirements_ai: "requirements",
      design_ai: "design",
      development: "code",
      testing: "tests",
      staging_deploy: "deployment",
      production_deploy: "deployment",
      production_rollback: "rollback",
    };
    if (output.kind !== expected[job.stage])
      throw new Error("阶段执行结果类型不正确");
    if (output.kind === "code" && output.selfTests.some((t) => !t.passed))
      throw new Error("开发自测尚未全部通过");
    if (output.kind === "tests" || output.kind === "deployment") {
      const code = this.currentArtifact("code")?.output;
      if (
        code?.kind !== "code" ||
        code.commitSha !== output.commitSha ||
        code.artifactDigest !== output.artifactDigest
      )
        throw new Error("测试或部署的代码提交与制品不一致");
    }
    if (output.kind === "tests") {
      const requirement = this.currentArtifact("requirements")?.output;
      if (
        requirement?.kind !== "requirements" ||
        output.checks.some((t) => !t.passed) ||
        requirement.spec.acceptanceCriteria.some(
          (_c, i) =>
            !output.checks.some((t) => t.criterionIndex === i && t.passed),
        )
      )
        throw new Error("独立测试失败或缺少验收条件覆盖");
      if (
        output.checks.some(
          (t) => t.criterionIndex >= requirement.spec.acceptanceCriteria.length,
        )
      )
        throw new Error("测试报告引用了不存在的验收条件");
    }
    if (
      output.kind === "deployment" &&
      (!output.healthy ||
        output.environment !==
          (job.stage === "staging_deploy" ? "staging" : "production"))
    )
      throw new Error("部署环境不一致或健康检查未通过");
    if (
      output.kind === "rollback" &&
      (!output.healthy ||
        output.productionJobKey !== job.input.productionJobKey)
    )
      throw new Error("生产恢复未对应原发布任务或健康检查失败");
  }
  #rewind(
    target:
      | "requirements"
      | "design"
      | "implementation"
      | "verification"
      | "deployment",
  ): void {
    if (target === "requirements") {
      this.#state.requirementVersion++;
      this.#state.designVersion++;
      this.#clearFrom("requirements");
      this.#move("requirements_ai");
    } else if (target === "design") {
      this.#state.designVersion++;
      this.#clearFrom("design");
      this.#move("design_ai");
    } else if (target === "implementation") {
      this.#clearFrom("code");
      this.#move("development");
    } else if (target === "verification") {
      this.#clearFrom("tests");
      this.#move("testing");
    } else {
      this.#clearFrom("staging");
      this.#move("staging_deploy");
    }
  }
  #clearFrom(slot: keyof LifecycleSnapshot["current"]): void {
    const slots: Array<keyof LifecycleSnapshot["current"]> = [
      "requirements",
      "design",
      "code",
      "tests",
      "staging",
      "production",
      "rollback",
    ];
    for (const s of slots.slice(slots.indexOf(slot)))
      delete this.#state.current[s];
  }
  #move(stage: LifecycleStage): void {
    for (const job of this.#state.jobs.filter(
      (j) => j.status === "running" || j.status === "queued",
    ))
      job.status = "cancelled";
    this.#state.stage = stage;
    this.#state.round++;
    this.#state.blockedReason = null;
    this.#event(
      "流程进入下一阶段",
      lifecycleStageLabels[stage],
      stage === "closed" ? joint : lifecycleRequiredRoles(stage),
    );
    if (automatic.has(stage)) this.#queue();
  }
  #queue(): void {
    if (this.#state.jobs.length >= 250)
      throw new Error("本需求执行次数已达到上限，请人工核对后创建关联变更需求");
    const releaseRound = Math.max(
      0,
      ...this.#state.approvals
        .filter((a) => a.stage === "release_approval")
        .map((a) => a.round),
    );
    const input = {
      schemaVersion: 2 as const,
      workflowKey: this.#state.workflowKey,
      tenantKey: this.#state.tenantKey,
      projectKey: this.#state.projectKey,
      repositoryKey: this.#state.repositoryKey,
      stage: this.#state.stage as LifecycleCapability,
      title: this.#state.title,
      brief: this.#state.brief,
      requirementVersion: this.#state.requirementVersion,
      designVersion: this.#state.designVersion,
      round: this.#state.round,
      artifacts: Object.values(this.#state.current).flatMap((key) =>
        this.#state.artifacts.filter((a) => a.artifactKey === key),
      ),
      feedback: this.#state.events
        .filter((e) => ["审核驳回", "申请生产恢复"].includes(e.title))
        .slice(-20)
        .map((e) => e.detail),
      releaseApprovals:
        this.#state.stage === "production_deploy"
          ? this.#state.approvals.filter(
              (a) => a.stage === "release_approval" && a.round === releaseRound,
            )
          : [],
      productionJobKey:
        [...this.#state.jobs]
          .reverse()
          .find((j) => j.stage === "production_deploy")?.jobKey ?? null,
    };
    this.#state.jobs.push({
      jobKey: randomUUID(),
      stage: input.stage,
      round: this.#state.round,
      status: "queued",
      input,
      inputDigest: lifecycleDigest(input),
      executorKey: null,
      fencingToken: null,
      leaseUntil: null,
      resultDigest: null,
      result: null,
    });
    this.#touch();
  }
  #retryRoles(): LifecycleRole[] {
    switch (this.#state.stage) {
      case "requirements_ai":
        return ["product_owner", "requirement_analyst"];
      case "testing":
        return ["tester"];
      case "staging_deploy":
        return ["test_ops"];
      case "production_deploy":
      case "production_rollback":
        return ["production_ops"];
      default:
        return ["developer"];
    }
  }
  #event(title: string, detail: string, roles: LifecycleRole[]): void {
    if (this.#state.events.length >= 2_000)
      throw new Error("需求审计记录已达到上限");
    this.#state.events.push({
      eventKey: randomUUID(),
      title,
      detail: detail.slice(0, 500),
      roles,
      at: this.#clock().toISOString(),
    });
    this.#touch();
  }
  #touch(): void {
    this.#state.version++;
    this.#state.updatedAt = this.#clock().toISOString();
  }
}
