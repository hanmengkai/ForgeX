import { createHash, randomUUID } from "node:crypto";

import {
  DeliveryReferenceSchema,
  RequirementSpecSchema,
  type DeliveryReference,
  type EvidenceCheck,
  type EvidencePayload,
  type RequirementSpec,
} from "@forgex/contracts";

import { EvidenceAuthority, VerifiedEvidenceReceipt } from "./evidence.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;
const MAX_REQUIREMENT_REVISIONS = 100;

export class RequirementStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementStateConflictError";
  }
}

export type RequirementStatus =
  | "draft"
  | "awaitingConfirmation"
  | "confirmed"
  | "needsReconfirmation"
  | "inDelivery"
  | "terminated"
  | "awaitingAcceptance"
  | "completed"
  | "verificationFailedAtLimit";

interface RequirementRevision {
  version: number;
  title: string;
  summary: string;
  acceptanceCriteria: Array<{
    criterionKey: string;
    title: string;
  }>;
  changedBy: string;
  specHash: string | null;
  spec?: RequirementSpec;
}

export interface RequirementRevisionSnapshot {
  version: number;
  title: string;
  summary: string;
  acceptanceCriteria: Array<{
    criterionKey: string;
    title: string;
  }>;
  changedBy: string;
  specHash: string | null;
  /** v1 旧快照可能没有完整规格；v2 用 contentState 显式标出迁移状态。 */
  spec?: RequirementSpec;
  contentState?: "complete" | "legacy_summary";
}

export interface RequirementRevisionInput {
  spec: RequirementSpec;
  changedBy: string;
}

export interface RequirementRevisionPeopleView {
  revision: number;
  version: string;
  changedBy: string;
  current: boolean;
  confirmed: boolean;
  changes: string[];
  contentState: "完整规格" | "仅保留摘要";
  spec: RequirementSpec;
}

export interface ApprovalActor {
  actorKey: string;
  actorName: string;
}

interface ApprovalRecordBase {
  actorKey: string;
  actorName: string;
  requirementKey: string;
  revision: number;
  recordedAt: string;
}

export type ApprovalRecord =
  | (ApprovalRecordBase & { action: "确认需求" })
  | (ApprovalRecordBase & {
      action: "验收结果";
      evidence: RequirementEvidenceSnapshot;
    });

export interface RequirementEvidenceSnapshot {
  evidenceKey: string;
  tenantKey: string;
  projectKey: string;
  repositoryKey: string;
  requirementKey: string;
  requirementRevision: number;
  gitHashAlgorithm: "sha1" | "sha256";
  commitSha: string;
  runnerKey: string;
  keyId: string;
  runnerName: string;
  producedAt: string;
  artifactHashAlgorithm: "sha256";
  artifactHash: string;
  checks: EvidenceCheck[];
  manualCriterionKeys?: string[];
  signature: string;
}

export interface RequirementVerificationBlocker {
  code: "trusted_plan_missing";
  runnerKey: string;
  keyId: string;
  reportedAt: string;
}

export interface RequirementWorkflowSnapshot {
  schemaVersion: 1 | 2;
  requirementKey: string;
  tenantKey: string;
  projectKey: string;
  status: RequirementStatus;
  confirmedVersion: number | null;
  revisions: RequirementRevisionSnapshot[];
  approvalRecords: ApprovalRecord[];
  deliveryCandidate: DeliveryReference | null;
  deliveryCandidateRecordedAtMs: number | null;
  evidence: RequirementEvidenceSnapshot | null;
  verificationBlocker?: RequirementVerificationBlocker | null;
}

export interface RequirementWorkflowOptions {
  tenantKey: string;
  projectKey: string;
  clock?: () => Date;
}

export type DeliveryCandidate = Omit<
  DeliveryReference,
  "tenantKey" | "projectKey"
>;

export interface VerificationTarget extends DeliveryReference {
  requirementKey: string;
  revision: number;
  acceptanceCriteria: Array<{
    criterionKey: string;
    title: string;
  }>;
}

export interface RequirementPeopleView {
  title: string;
  summary: string;
  version: string;
  status:
    | "正在整理"
    | "等待负责人确认"
    | "已确认，等待交付"
    | "内容已更新，等待重新确认"
    | "AI 正在实现"
    | "已强制终止"
    | "等待产品验收"
    | "已完成"
    | "验证失败，版本已封存";
  nextStep: string;
  acceptanceProgress: string;
}

export interface RequirementAcceptanceView {
  verifiedBy: string;
  verifiedAt: string;
  checks: Array<{
    title: string;
    status: "已通过" | "待产品验收" | "产品已验收";
  }>;
}

export interface RequirementPreviewArtifactReference {
  requirementRevision: number;
  artifactHashAlgorithm: "sha256";
  artifactHash: string;
}

export type RequirementAllowedAction =
  | "revise"
  | "submitForConfirmation"
  | "confirm"
  | "startDelivery"
  | "terminateDelivery"
  | "accept"
  | "delete";

export class RequirementWorkflow {
  readonly #key: string;
  readonly #tenantKey: string;
  readonly #projectKey: string;
  readonly #clock: () => Date;
  readonly #revisions: RequirementRevision[];
  readonly #approvalRecords: ApprovalRecord[] = [];
  #status: RequirementStatus = "draft";
  #confirmedVersion: number | null = null;
  #deliveryCandidate: DeliveryReference | null = null;
  #deliveryCandidateRecordedAtMs: number | null = null;
  #evidence: Readonly<RequirementEvidenceSnapshot> | null = null;
  #verifiedEvidenceReceipt: VerifiedEvidenceReceipt | null = null;
  #verificationBlocker: Readonly<RequirementVerificationBlocker> | null = null;

  private constructor(
    initialRevision: RequirementRevision,
    options: RequirementWorkflowOptions,
    requirementKey: string = randomUUID(),
  ) {
    if (
      !internalKeyPattern.test(options.tenantKey.trim()) ||
      !internalKeyPattern.test(options.projectKey.trim())
    ) {
      throw new Error("需求必须绑定租户和项目范围");
    }
    this.#key = requirementKey;
    this.#tenantKey = options.tenantKey.trim().toLowerCase();
    this.#projectKey = options.projectKey.trim().toLowerCase();
    this.#clock = options.clock ?? (() => new Date());
    this.#revisions = [initialRevision];
  }

  static create(
    input: {
      title: string;
      summary: string;
      acceptanceCriteria: string[];
    },
    options: RequirementWorkflowOptions,
  ): RequirementWorkflow {
    RequirementWorkflow.#validateContent(input);
    return RequirementWorkflow.createFromSpec(
      {
        schemaVersion: 1,
        title: input.title.trim(),
        goal: input.summary.trim(),
        userStories: [],
        acceptanceCriteria: input.acceptanceCriteria.map((title) => ({
          title: title.trim(),
          description: `验收时确认：${title.trim()}`,
          priority: "must",
        })),
        openQuestions: [],
      },
      options,
    );
  }

  static createFromSpec(
    spec: RequirementSpec,
    options: RequirementWorkflowOptions,
  ): RequirementWorkflow {
    const parsed = RequirementSpecSchema.parse(spec);
    return new RequirementWorkflow(
      {
        version: 1,
        title: parsed.title,
        summary: parsed.goal,
        acceptanceCriteria: RequirementWorkflow.#createCriteria(
          parsed.acceptanceCriteria.map((criterion) => criterion.title),
        ),
        changedBy: "创建者",
        specHash: RequirementWorkflow.#hashSpec(parsed),
        spec: RequirementWorkflow.#copySpec(parsed),
      },
      options,
    );
  }

  submitForConfirmation(): void {
    if (this.#status !== "draft" && this.#status !== "needsReconfirmation") {
      throw new RequirementStateConflictError("当前状态不能重复提交确认");
    }
    this.#status = "awaitingConfirmation";
  }

  confirm(input: { actor: ApprovalActor }): void {
    if (this.#status !== "awaitingConfirmation") {
      throw new RequirementStateConflictError("请先提交需求确认");
    }
    const actor = RequirementWorkflow.#validateActor(input.actor, "确认人");
    const recordedAt = this.#nowIso("确认时间");

    this.#confirmedVersion = this.#current.version;
    this.#approvalRecords.push({
      action: "确认需求",
      ...actor,
      requirementKey: this.#key,
      revision: this.#current.version,
      recordedAt,
    });
    this.#status = "confirmed";
  }

  revise(input: RequirementRevisionInput): void {
    if (this.#status === "inDelivery" || this.#status === "completed") {
      throw new Error("需求已经进入交付，请创建新的变更需求");
    }
    if (!input.changedBy.trim()) {
      throw new Error("请记录修改人");
    }
    this.#assertCanAppendRevision();

    const parsedSpec = RequirementSpecSchema.parse(input.spec);
    const next = {
      title: parsedSpec.title,
      summary: parsedSpec.goal,
      acceptanceCriteria: parsedSpec.acceptanceCriteria.map(
        (criterion) => criterion.title,
      ),
    };
    RequirementWorkflow.#validateContent(next);

    this.#revisions.push({
      version: this.#current.version + 1,
      title: next.title.trim(),
      summary: next.summary.trim(),
      acceptanceCriteria: RequirementWorkflow.#createCriteria(
        next.acceptanceCriteria,
      ),
      changedBy: input.changedBy.trim(),
      specHash: RequirementWorkflow.#hashSpec(parsedSpec),
      spec: RequirementWorkflow.#copySpec(parsedSpec),
    });
    this.#confirmedVersion = null;
    this.#deliveryCandidate = null;
    this.#deliveryCandidateRecordedAtMs = null;
    this.#evidence = null;
    this.#verifiedEvidenceReceipt = null;
    this.#verificationBlocker = null;
    this.#status = "needsReconfirmation";
  }

  startDelivery(): void {
    if (
      (this.#status !== "confirmed" && this.#status !== "terminated") ||
      this.#confirmedVersion !== this.#current.version
    ) {
      throw new RequirementStateConflictError(
        "需求需要先由负责人确认，才能开始交付",
      );
    }
    this.#status = "inDelivery";
    this.#verificationBlocker = null;
  }

  recordVerificationBlocker(input: RequirementVerificationBlocker): void {
    if (this.#status !== "inDelivery") {
      throw new RequirementStateConflictError(
        "当前需求版本已经不能记录验证计划阻塞",
      );
    }
    if (
      input.code !== "trusted_plan_missing" ||
      !internalKeyPattern.test(input.runnerKey) ||
      !internalKeyPattern.test(input.keyId) ||
      !Number.isFinite(Date.parse(input.reportedAt))
    ) {
      throw new Error("验证计划阻塞记录格式不正确");
    }
    this.#verificationBlocker = Object.freeze({
      code: input.code,
      runnerKey: input.runnerKey.toLowerCase(),
      keyId: input.keyId.toLowerCase(),
      reportedAt: input.reportedAt,
    });
  }

  terminateDelivery(): void {
    if (this.#status !== "inDelivery") {
      throw new RequirementStateConflictError("只有正在执行的交付可以强制终止");
    }
    this.#deliveryCandidate = null;
    this.#deliveryCandidateRecordedAtMs = null;
    this.#evidence = null;
    this.#verifiedEvidenceReceipt = null;
    this.#verificationBlocker = null;
    this.#status = "terminated";
  }

  recordDeliveryCandidate(candidate: DeliveryCandidate): void {
    if (this.#status !== "inDelivery") {
      throw new Error("需求进入交付后才能记录交付候选");
    }
    const recordedAtMs = this.#clockTimestamp("交付候选记录时间");
    const parsed = DeliveryReferenceSchema.safeParse({
      repositoryKey: candidate.repositoryKey,
      gitHashAlgorithm: candidate.gitHashAlgorithm,
      commitSha: candidate.commitSha,
      artifactHashAlgorithm: candidate.artifactHashAlgorithm,
      artifactHash: candidate.artifactHash,
      tenantKey: this.#tenantKey,
      projectKey: this.#projectKey,
    });
    if (!parsed.success) {
      throw new Error("交付候选必须绑定代码仓库、完整提交和产物摘要");
    }
    this.#deliveryCandidate = Object.freeze({ ...parsed.data });
    this.#deliveryCandidateRecordedAtMs = recordedAtMs;
  }

  getVerificationTarget(): VerificationTarget {
    if (this.#status !== "inDelivery") {
      throw new Error("需求进入交付后才能创建验证目标");
    }
    if (!this.#deliveryCandidate) {
      throw new Error("请先记录代码提交和交付产物，再创建验证目标");
    }
    return {
      ...this.#deliveryCandidate,
      requirementKey: this.#key,
      revision: this.#current.version,
      acceptanceCriteria: this.#current.acceptanceCriteria.map((criterion) => ({
        ...criterion,
      })),
    };
  }

  submitForAcceptance(evidence: VerifiedEvidenceReceipt): void {
    if (this.#status !== "inDelivery") {
      throw new Error("需求尚未进入交付，不能提交验收");
    }
    try {
      VerifiedEvidenceReceipt.assertAuthentic(evidence);
    } catch {
      throw new Error("验证证据必须经过受信任的独立 Runner 验签");
    }
    VerifiedEvidenceReceipt.assertUsableAt(evidence, this.#clock());
    if (
      evidence.requirementKey !== this.#key ||
      evidence.requirementRevision !== this.#current.version
    ) {
      throw new Error("验证证据与当前需求版本不匹配");
    }
    if (
      !this.#deliveryCandidate ||
      evidence.tenantKey !== this.#deliveryCandidate.tenantKey ||
      evidence.projectKey !== this.#deliveryCandidate.projectKey ||
      evidence.repositoryKey !== this.#deliveryCandidate.repositoryKey ||
      evidence.gitHashAlgorithm !== this.#deliveryCandidate.gitHashAlgorithm ||
      evidence.commitSha !== this.#deliveryCandidate.commitSha ||
      evidence.artifactHashAlgorithm !==
        this.#deliveryCandidate.artifactHashAlgorithm ||
      evidence.artifactHash !== this.#deliveryCandidate.artifactHash
    ) {
      throw new Error("验证证据与当前交付候选不匹配");
    }
    if (
      this.#deliveryCandidateRecordedAtMs === null ||
      Date.parse(evidence.producedAt) < this.#deliveryCandidateRecordedAtMs
    ) {
      throw new Error("验证证据早于当前交付候选，不能用于验收");
    }
    if (evidence.checks.some((check) => check.status !== "passed")) {
      throw new Error("所有验收条件通过后才能提交产品验收");
    }
    const expected = new Set(
      this.#current.acceptanceCriteria.map((item) => item.criterionKey),
    );
    const actual = new Set(evidence.checks.map((item) => item.criterionKey));
    const manual = new Set(evidence.manualCriterionKeys);
    if (
      actual.size !== evidence.checks.length ||
      manual.size !== evidence.manualCriterionKeys.length ||
      [...actual].some((criterionKey) => manual.has(criterionKey)) ||
      actual.size + manual.size !== expected.size ||
      [...expected].some(
        (criterionKey) =>
          !actual.has(criterionKey) && !manual.has(criterionKey),
      )
    ) {
      throw new Error("验证证据没有覆盖全部验收条件");
    }

    this.#evidence = Object.freeze({
      evidenceKey: evidence.evidenceKey,
      tenantKey: evidence.tenantKey,
      projectKey: evidence.projectKey,
      repositoryKey: evidence.repositoryKey,
      requirementKey: evidence.requirementKey,
      requirementRevision: evidence.requirementRevision,
      gitHashAlgorithm: evidence.gitHashAlgorithm,
      commitSha: evidence.commitSha,
      runnerKey: evidence.runnerKey,
      keyId: evidence.keyId,
      runnerName: evidence.runnerName,
      producedAt: evidence.producedAt,
      artifactHashAlgorithm: evidence.artifactHashAlgorithm,
      artifactHash: evidence.artifactHash,
      checks: evidence.checks.map((check) => ({ ...check })),
      ...(evidence.manualCriterionKeys.length > 0
        ? { manualCriterionKeys: [...evidence.manualCriterionKeys] }
        : {}),
      signature: evidence.signature,
    });
    this.#verifiedEvidenceReceipt = evidence;
    this.#verificationBlocker = null;
    this.#status = "awaitingAcceptance";
  }

  recordVerificationFailure(): void {
    if (
      this.#status !== "inDelivery" &&
      this.#status !== "awaitingAcceptance" &&
      this.#status !== "completed"
    ) {
      throw new RequirementStateConflictError(
        "当前需求版本已经不能记录独立验证失败结果",
      );
    }
    const failedRevision = this.#current;
    const reachedRevisionLimit =
      this.#revisions.length >= MAX_REQUIREMENT_REVISIONS;
    if (!reachedRevisionLimit) {
      this.#revisions.push({
        version: failedRevision.version + 1,
        title: failedRevision.title,
        summary: failedRevision.summary,
        acceptanceCriteria: failedRevision.acceptanceCriteria.map(
          (criterion) => ({
            ...criterion,
          }),
        ),
        changedBy: "独立验证失败",
        specHash: failedRevision.specHash,
        ...(failedRevision.spec
          ? { spec: RequirementWorkflow.#copySpec(failedRevision.spec) }
          : {}),
      });
      this.#confirmedVersion = null;
    }
    this.#deliveryCandidate = null;
    this.#deliveryCandidateRecordedAtMs = null;
    this.#evidence = null;
    this.#verifiedEvidenceReceipt = null;
    this.#verificationBlocker = null;
    this.#status = reachedRevisionLimit
      ? "verificationFailedAtLimit"
      : "needsReconfirmation";
  }

  accept(input: { actor: ApprovalActor }): void {
    if (this.#status !== "awaitingAcceptance") {
      throw new RequirementStateConflictError("请先完成独立验证并提交产品验收");
    }
    const actor = RequirementWorkflow.#validateActor(input.actor, "验收人");
    const recordedAt = this.#nowIso("验收时间");
    const evidence = this.#evidence;
    if (!evidence || !this.#verifiedEvidenceReceipt) {
      throw new Error("验收证据缺失，请重新执行独立验证");
    }
    try {
      VerifiedEvidenceReceipt.assertUsableAt(
        this.#verifiedEvidenceReceipt,
        this.#clock(),
      );
    } catch (error) {
      throw new RequirementStateConflictError(
        error instanceof Error ? error.message : "验收证据已经失效",
      );
    }
    this.#approvalRecords.push({
      action: "验收结果",
      ...actor,
      requirementKey: this.#key,
      revision: this.#current.version,
      recordedAt,
      evidence: RequirementWorkflow.#copyEvidence(evidence),
    });
    this.#status = "completed";
  }

  toPeopleView(): RequirementPeopleView {
    const status = this.#statusContent();
    return {
      title: this.#current.title,
      summary: this.#current.summary,
      version: `第 ${this.#current.version} 版`,
      status: status.label,
      nextStep: status.nextStep,
      acceptanceProgress:
        this.#status === "verificationFailedAtLimit"
          ? "独立验证未通过，当前版本已封存"
          : this.#evidence
            ? this.#status === "completed" &&
              (this.#evidence.manualCriterionKeys?.length ?? 0) > 0
              ? `${this.#current.acceptanceCriteria.length} / ${this.#current.acceptanceCriteria.length} 项已验收`
              : (this.#evidence.manualCriterionKeys?.length ?? 0) > 0
                ? `${this.#evidence.checks.length} / ${this.#current.acceptanceCriteria.length} 项独立验证通过，${this.#evidence.manualCriterionKeys!.length} 项待产品验收`
                : `${this.#evidence.checks.length} / ${this.#current.acceptanceCriteria.length} 项已通过`
            : "尚未开始验证",
    };
  }

  toAcceptanceView(): RequirementAcceptanceView | null {
    if (!this.#evidence) return null;
    const checksByCriterion = new Map(
      this.#evidence.checks.map((check) => [check.criterionKey, check]),
    );
    const manualCriterionKeys = new Set(
      this.#evidence.manualCriterionKeys ?? [],
    );
    return {
      verifiedBy: this.#evidence.runnerName,
      verifiedAt: this.#evidence.producedAt,
      checks: this.#current.acceptanceCriteria.map((criterion) => {
        const check = checksByCriterion.get(criterion.criterionKey);
        if (check?.status === "passed") {
          return {
            title: criterion.title,
            status: "已通过" as const,
          };
        }
        if (manualCriterionKeys.has(criterion.criterionKey)) {
          return {
            title: criterion.title,
            status:
              this.#status === "completed"
                ? ("产品已验收" as const)
                : ("待产品验收" as const),
          };
        }
        {
          throw new Error("需求验收视图与可信证据不一致");
        }
      }),
    };
  }

  toPreviewArtifactReference(): RequirementPreviewArtifactReference | null {
    if (!this.#evidence) return null;
    return {
      requirementRevision: this.#current.version,
      artifactHashAlgorithm: this.#evidence.artifactHashAlgorithm,
      artifactHash: this.#evidence.artifactHash,
    };
  }

  listAllowedActions(): RequirementAllowedAction[] {
    const canRevise = this.#revisions.length < MAX_REQUIREMENT_REVISIONS;
    switch (this.#status) {
      case "draft":
      case "needsReconfirmation":
        return [
          ...(canRevise ? (["revise"] as const) : []),
          "submitForConfirmation",
          "delete",
        ];
      case "awaitingConfirmation":
        return [
          ...(canRevise ? (["revise"] as const) : []),
          "confirm",
          "delete",
        ];
      case "confirmed":
        return [
          ...(canRevise ? (["revise"] as const) : []),
          "startDelivery",
          "delete",
        ];
      case "inDelivery":
        return ["terminateDelivery"];
      case "terminated":
        return [
          ...(canRevise ? (["revise"] as const) : []),
          "startDelivery",
          "delete",
        ];
      case "awaitingAcceptance":
        return [
          ...(canRevise ? (["revise"] as const) : []),
          "accept",
          "delete",
        ];
      case "completed":
      case "verificationFailedAtLimit":
        return ["delete"];
      default:
        return [];
    }
  }

  assertPersistenceIdentity(identity: {
    tenantKey: string;
    projectKey: string;
    requirementKey: string;
  }): void {
    if (
      identity.tenantKey.trim().toLowerCase() !== this.#tenantKey ||
      identity.projectKey.trim().toLowerCase() !== this.#projectKey ||
      identity.requirementKey.trim().toLowerCase() !== this.#key
    ) {
      throw new Error("需求聚合身份与持久化范围不一致");
    }
  }

  assertSpecIntegrity(spec: RequirementSpec): void {
    const parsed = RequirementSpecSchema.safeParse(spec);
    const currentCriteria = this.#current.acceptanceCriteria.map(
      (criterion) => criterion.title,
    );
    if (
      !parsed.success ||
      this.#current.specHash === null ||
      this.#current.specHash !== RequirementWorkflow.#hashSpec(parsed.data) ||
      this.#current.title !== parsed.data.title ||
      this.#current.summary !== parsed.data.goal ||
      currentCriteria.length !== parsed.data.acceptanceCriteria.length ||
      currentCriteria.some(
        (title, index) =>
          title !== parsed.data.acceptanceCriteria[index]?.title,
      )
    ) {
      throw new Error("需求规格与工作流业务内容不一致");
    }
  }

  /** 仅供持久化适配器把 v1 行中的权威当前规格迁移进聚合快照。 */
  restoreCurrentSpec(spec: RequirementSpec): void {
    const parsed = RequirementSpecSchema.parse(spec);
    const currentCriteria = this.#current.acceptanceCriteria.map(
      (criterion) => criterion.title,
    );
    const specHash = RequirementWorkflow.#hashSpec(parsed);
    if (
      this.#current.title !== parsed.title ||
      this.#current.summary !== parsed.goal ||
      currentCriteria.length !== parsed.acceptanceCriteria.length ||
      currentCriteria.some(
        (title, index) => title !== parsed.acceptanceCriteria[index]?.title,
      ) ||
      (this.#current.specHash !== null && this.#current.specHash !== specHash)
    ) {
      throw new Error("需求规格与工作流业务内容不一致");
    }
    this.#current.specHash = specHash;
    this.#current.spec = RequirementWorkflow.#copySpec(parsed);
  }

  get internalKey(): string {
    return this.#key;
  }

  get currentRevision(): number {
    return this.#current.version;
  }

  listRevisionsForPeople(): RequirementRevisionPeopleView[] {
    return this.#revisions.map((revision, index) => {
      const previous = this.#revisions[index - 1];
      const spec = RequirementWorkflow.#specForRevision(revision);
      return {
        revision: revision.version,
        version: `第 ${revision.version} 版`,
        changedBy: revision.changedBy,
        current: revision.version === this.#current.version,
        confirmed: this.#approvalRecords.some(
          (record) =>
            record.action === "确认需求" &&
            record.revision === revision.version,
        ),
        changes: previous
          ? RequirementWorkflow.#describeChanges(
              RequirementWorkflow.#specForRevision(previous),
              spec,
            )
          : ["创建需求"],
        contentState: revision.spec ? "完整规格" : "仅保留摘要",
        spec,
      };
    });
  }

  listApprovalRecords(): ApprovalRecord[] {
    return this.#approvalRecords.map((record) =>
      record.action === "验收结果"
        ? { ...record, evidence: { ...record.evidence } }
        : { ...record },
    );
  }

  toSnapshot(): RequirementWorkflowSnapshot {
    if (!this.#current.spec) {
      throw new Error("当前需求版本缺少完整规格，必须先完成旧数据迁移");
    }
    return {
      schemaVersion: 2,
      requirementKey: this.#key,
      tenantKey: this.#tenantKey,
      projectKey: this.#projectKey,
      status: this.#status,
      confirmedVersion: this.#confirmedVersion,
      revisions: this.#revisions.map((revision) => ({
        ...RequirementWorkflow.#copyRevision(revision),
        specHash: revision.spec ? revision.specHash : null,
        contentState: revision.spec ? "complete" : "legacy_summary",
      })),
      approvalRecords: this.listApprovalRecords(),
      deliveryCandidate: this.#deliveryCandidate
        ? { ...this.#deliveryCandidate }
        : null,
      deliveryCandidateRecordedAtMs: this.#deliveryCandidateRecordedAtMs,
      evidence: this.#evidence
        ? RequirementWorkflow.#copyEvidence(this.#evidence)
        : null,
      verificationBlocker: this.#verificationBlocker
        ? { ...this.#verificationBlocker }
        : null,
    };
  }

  static fromSnapshot(
    snapshot: RequirementWorkflowSnapshot,
    options: { clock?: () => Date; evidenceAuthority?: EvidenceAuthority } = {},
  ): RequirementWorkflow {
    const restored = RequirementWorkflow.#validateSnapshot(
      snapshot,
      options.evidenceAuthority,
    );
    const firstRevision = restored.revisions[0];
    if (!firstRevision) {
      throw new Error("需求工作流快照缺少版本");
    }
    const workflow = new RequirementWorkflow(
      RequirementWorkflow.#copyRevision(firstRevision),
      {
        tenantKey: restored.tenantKey,
        projectKey: restored.projectKey,
        ...(options.clock ? { clock: options.clock } : {}),
      },
      restored.requirementKey,
    );
    workflow.#revisions.splice(
      0,
      1,
      ...restored.revisions.map(RequirementWorkflow.#copyRevision),
    );
    workflow.#approvalRecords.push(
      ...restored.approvalRecords.map(RequirementWorkflow.#copyApprovalRecord),
    );
    workflow.#status = restored.status;
    workflow.#confirmedVersion = restored.confirmedVersion;
    workflow.#deliveryCandidate = restored.deliveryCandidate
      ? Object.freeze({ ...restored.deliveryCandidate })
      : null;
    workflow.#deliveryCandidateRecordedAtMs =
      restored.deliveryCandidateRecordedAtMs;
    workflow.#evidence = restored.evidence
      ? Object.freeze(RequirementWorkflow.#copyEvidence(restored.evidence))
      : null;
    workflow.#verifiedEvidenceReceipt = restored.evidence
      ? options.evidenceAuthority!.verifyPersisted({
          payload: RequirementWorkflow.#evidencePayload(restored.evidence),
          signature: restored.evidence.signature,
        })
      : null;
    workflow.#verificationBlocker = restored.verificationBlocker
      ? Object.freeze({ ...restored.verificationBlocker })
      : null;
    return workflow;
  }

  copyForTransaction(): RequirementWorkflow {
    const firstRevision = this.#revisions[0];
    if (!firstRevision) {
      throw new Error("需求缺少版本信息");
    }
    const copy = new RequirementWorkflow(
      RequirementWorkflow.#copyRevision(firstRevision),
      {
        tenantKey: this.#tenantKey,
        projectKey: this.#projectKey,
        clock: this.#clock,
      },
      this.#key,
    );
    copy.#revisions.splice(
      0,
      1,
      ...this.#revisions.map(RequirementWorkflow.#copyRevision),
    );
    copy.#approvalRecords.push(
      ...this.#approvalRecords.map(RequirementWorkflow.#copyApprovalRecord),
    );
    copy.#status = this.#status;
    copy.#confirmedVersion = this.#confirmedVersion;
    copy.#deliveryCandidate = this.#deliveryCandidate
      ? Object.freeze({ ...this.#deliveryCandidate })
      : null;
    copy.#deliveryCandidateRecordedAtMs = this.#deliveryCandidateRecordedAtMs;
    copy.#evidence = this.#evidence
      ? Object.freeze(RequirementWorkflow.#copyEvidence(this.#evidence))
      : null;
    copy.#verifiedEvidenceReceipt = this.#verifiedEvidenceReceipt;
    copy.#verificationBlocker = this.#verificationBlocker
      ? Object.freeze({ ...this.#verificationBlocker })
      : null;
    return copy;
  }

  get #current(): RequirementRevision {
    const current = this.#revisions.at(-1);
    if (!current) {
      throw new Error("需求缺少版本信息");
    }
    return current;
  }

  #assertCanAppendRevision(): void {
    if (this.#revisions.length >= MAX_REQUIREMENT_REVISIONS) {
      throw new RequirementStateConflictError(
        "需求版本已达到上限，请创建新的变更需求",
      );
    }
  }

  #statusContent(): {
    label: RequirementPeopleView["status"];
    nextStep: string;
  } {
    switch (this.#status) {
      case "draft":
        return { label: "正在整理", nextStep: "完善内容后提交确认" };
      case "awaitingConfirmation":
        return {
          label: "等待负责人确认",
          nextStep: "请负责人确认需求内容",
        };
      case "confirmed":
        return {
          label: "已确认，等待交付",
          nextStep: "可以安排 AI 开始实现",
        };
      case "needsReconfirmation":
        return {
          label: "内容已更新，等待重新确认",
          nextStep: "请负责人确认最新版本",
        };
      case "inDelivery":
        return { label: "AI 正在实现", nextStep: "等待独立验证完成" };
      case "terminated":
        return {
          label: "已强制终止",
          nextStep: "可以直接重新安排 AI 实现",
        };
      case "awaitingAcceptance":
        return {
          label: "等待产品验收",
          nextStep: "请体验 Preview 并确认结果",
        };
      case "completed":
        return { label: "已完成", nextStep: "无需处理" };
      case "verificationFailedAtLimit":
        return {
          label: "验证失败，版本已封存",
          nextStep: "请创建新的变更需求",
        };
    }
  }

  static #validateContent(input: {
    title: string;
    summary: string;
    acceptanceCriteria: string[];
  }): void {
    if (input.title.trim().length < 2) {
      throw new Error("请使用可理解的业务语言填写需求标题");
    }
    if (input.summary.trim().length < 4) {
      throw new Error("请说明需求希望解决的问题");
    }
    if (
      input.acceptanceCriteria.length === 0 ||
      input.acceptanceCriteria.some((item) => !item.trim())
    ) {
      throw new Error("至少需要一个可验证的验收条件");
    }
  }

  static #hashSpec(spec: RequirementSpec): string {
    const canonical = JSON.stringify({
      schemaVersion: spec.schemaVersion,
      title: spec.title,
      goal: spec.goal,
      userStories: spec.userStories.map((story) => ({
        role: story.role,
        need: story.need,
        value: story.value,
      })),
      acceptanceCriteria: spec.acceptanceCriteria.map((criterion) => ({
        title: criterion.title,
        description: criterion.description,
        priority: criterion.priority,
      })),
      openQuestions: [...spec.openQuestions],
    });
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  }

  static #createCriteria(
    titles: string[],
  ): RequirementRevision["acceptanceCriteria"] {
    return titles.map((title) => ({
      criterionKey: randomUUID(),
      title: title.trim(),
    }));
  }

  static #copyRevision(revision: RequirementRevision): RequirementRevision {
    return {
      ...revision,
      acceptanceCriteria: revision.acceptanceCriteria.map((criterion) => ({
        ...criterion,
      })),
      ...(revision.spec
        ? { spec: RequirementWorkflow.#copySpec(revision.spec) }
        : {}),
    };
  }

  static #copySpec(spec: RequirementSpec): RequirementSpec {
    return structuredClone(spec);
  }

  static #specForRevision(revision: RequirementRevision): RequirementSpec {
    if (revision.spec) return RequirementWorkflow.#copySpec(revision.spec);
    return {
      schemaVersion: 1,
      title: revision.title,
      goal: revision.summary,
      userStories: [],
      acceptanceCriteria: revision.acceptanceCriteria.map((criterion) => ({
        title: criterion.title,
        description: `验收时确认：${criterion.title}`,
        priority: "must",
      })),
      openQuestions: [],
    };
  }

  static #describeChanges(
    previous: RequirementSpec,
    current: RequirementSpec,
  ): string[] {
    const changes: string[] = [];
    if (previous.title !== current.title) changes.push("需求名称");
    if (previous.goal !== current.goal) changes.push("业务目标");
    if (
      JSON.stringify(previous.userStories) !==
      JSON.stringify(current.userStories)
    ) {
      changes.push("用户故事");
    }
    if (
      JSON.stringify(previous.acceptanceCriteria) !==
      JSON.stringify(current.acceptanceCriteria)
    ) {
      changes.push("验收标准");
    }
    if (
      JSON.stringify(previous.openQuestions) !==
      JSON.stringify(current.openQuestions)
    ) {
      changes.push("待澄清问题");
    }
    return changes.length > 0 ? changes : ["重新发起确认"];
  }

  static #copyApprovalRecord(record: ApprovalRecord): ApprovalRecord {
    return record.action === "验收结果"
      ? {
          ...record,
          evidence: RequirementWorkflow.#copyEvidence(record.evidence),
        }
      : { ...record };
  }

  static #copyEvidence(
    evidence: Readonly<RequirementEvidenceSnapshot>,
  ): RequirementEvidenceSnapshot {
    return {
      ...evidence,
      checks: evidence.checks.map((check) => ({ ...check })),
      ...(evidence.manualCriterionKeys
        ? { manualCriterionKeys: [...evidence.manualCriterionKeys] }
        : {}),
    };
  }

  static #evidencePayload(
    evidence: Readonly<RequirementEvidenceSnapshot>,
  ): EvidencePayload {
    return {
      schemaVersion: 1,
      evidenceKey: evidence.evidenceKey,
      tenantKey: evidence.tenantKey,
      projectKey: evidence.projectKey,
      repositoryKey: evidence.repositoryKey,
      requirementKey: evidence.requirementKey,
      requirementRevision: evidence.requirementRevision,
      gitHashAlgorithm: evidence.gitHashAlgorithm,
      commitSha: evidence.commitSha,
      runnerKey: evidence.runnerKey,
      keyId: evidence.keyId,
      producedAt: evidence.producedAt,
      artifactHashAlgorithm: evidence.artifactHashAlgorithm,
      artifactHash: evidence.artifactHash,
      checks: evidence.checks.map((check) => ({ ...check })),
      ...(evidence.manualCriterionKeys
        ? { manualCriterionKeys: [...evidence.manualCriterionKeys] }
        : {}),
    };
  }

  static #verifyPersistedEvidenceSnapshot(
    evidence: Readonly<RequirementEvidenceSnapshot>,
    evidenceAuthority: EvidenceAuthority | undefined,
  ): {
    evidence: RequirementEvidenceSnapshot;
    receipt: VerifiedEvidenceReceipt;
  } {
    if (!evidenceAuthority) {
      throw new Error("恢复验证证据需要受信任的 EvidenceAuthority");
    }
    let receipt: VerifiedEvidenceReceipt;
    try {
      receipt = evidenceAuthority.verifyPersisted({
        payload: RequirementWorkflow.#evidencePayload(evidence),
        signature: evidence.signature,
      });
    } catch (error) {
      throw new Error("需求工作流快照包含无法验真的验证证据", {
        cause: error,
      });
    }
    const verifiedEvidence: RequirementEvidenceSnapshot = {
      evidenceKey: receipt.evidenceKey,
      tenantKey: receipt.tenantKey,
      projectKey: receipt.projectKey,
      repositoryKey: receipt.repositoryKey,
      requirementKey: receipt.requirementKey,
      requirementRevision: receipt.requirementRevision,
      gitHashAlgorithm: receipt.gitHashAlgorithm,
      commitSha: receipt.commitSha,
      runnerKey: receipt.runnerKey,
      keyId: receipt.keyId,
      runnerName: receipt.runnerName,
      producedAt: receipt.producedAt,
      artifactHashAlgorithm: receipt.artifactHashAlgorithm,
      artifactHash: receipt.artifactHash,
      checks: receipt.checks.map((check) => ({ ...check })),
      ...(receipt.manualCriterionKeys.length > 0
        ? { manualCriterionKeys: [...receipt.manualCriterionKeys] }
        : {}),
      signature: receipt.signature,
    };
    if (
      evidence.runnerName !== receipt.runnerName ||
      EvidenceAuthority.canonicalPayload(
        RequirementWorkflow.#evidencePayload(evidence),
      ) !==
        EvidenceAuthority.canonicalPayload(
          RequirementWorkflow.#evidencePayload(verifiedEvidence),
        )
    ) {
      throw new Error("需求工作流快照包含被篡改的验证证据投影");
    }
    return { evidence: verifiedEvidence, receipt };
  }

  static #validateSnapshot(
    snapshot: RequirementWorkflowSnapshot,
    evidenceAuthority: EvidenceAuthority | undefined,
  ): RequirementWorkflowSnapshot {
    const statuses = new Set<RequirementStatus>([
      "draft",
      "awaitingConfirmation",
      "confirmed",
      "needsReconfirmation",
      "inDelivery",
      "terminated",
      "awaitingAcceptance",
      "completed",
      "verificationFailedAtLimit",
    ]);
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) ||
      !internalKeyPattern.test(snapshot.requirementKey) ||
      !internalKeyPattern.test(snapshot.tenantKey) ||
      !internalKeyPattern.test(snapshot.projectKey) ||
      !statuses.has(snapshot.status) ||
      !Array.isArray(snapshot.revisions) ||
      snapshot.revisions.length === 0 ||
      snapshot.revisions.length > MAX_REQUIREMENT_REVISIONS ||
      !Array.isArray(snapshot.approvalRecords)
    ) {
      throw new Error("需求工作流快照格式无效");
    }
    const revisions = snapshot.revisions.map((revision, index) => {
      const isV2 = snapshot.schemaVersion === 2;
      if (
        revision.version !== index + 1 ||
        !revision.changedBy?.trim() ||
        !Array.isArray(revision.acceptanceCriteria) ||
        (revision.specHash !== null &&
          !sha256Pattern.test(revision.specHash)) ||
        (isV2 &&
          revision.contentState !== "complete" &&
          revision.contentState !== "legacy_summary") ||
        (isV2 &&
          revision.contentState === "complete" &&
          revision.spec === undefined) ||
        (isV2 &&
          revision.contentState === "legacy_summary" &&
          (revision.spec !== undefined || revision.specHash !== null)) ||
        (isV2 &&
          index === snapshot.revisions.length - 1 &&
          revision.contentState !== "complete")
      ) {
        throw new Error("需求工作流快照包含无效版本");
      }
      RequirementWorkflow.#validateContent({
        title: revision.title,
        summary: revision.summary,
        acceptanceCriteria: revision.acceptanceCriteria.map(
          (criterion) => criterion.title,
        ),
      });
      if (revision.spec !== undefined) {
        const parsedSpec = RequirementSpecSchema.safeParse(revision.spec);
        if (
          !parsedSpec.success ||
          revision.specHash === null ||
          revision.specHash !==
            RequirementWorkflow.#hashSpec(parsedSpec.data) ||
          revision.title !== parsedSpec.data.title ||
          revision.summary !== parsedSpec.data.goal ||
          revision.acceptanceCriteria.length !==
            parsedSpec.data.acceptanceCriteria.length ||
          revision.acceptanceCriteria.some(
            (criterion, criterionIndex) =>
              criterion.title !==
              parsedSpec.data.acceptanceCriteria[criterionIndex]?.title,
          )
        ) {
          throw new Error("需求工作流快照的完整规格与版本不一致");
        }
      }
      const criterionKeys = new Set<string>();
      for (const criterion of revision.acceptanceCriteria) {
        if (
          !internalKeyPattern.test(criterion.criterionKey) ||
          criterionKeys.has(criterion.criterionKey)
        ) {
          throw new Error("需求工作流快照包含无效验收条件");
        }
        criterionKeys.add(criterion.criterionKey);
      }
      return RequirementWorkflow.#copyRevision(revision);
    });
    const currentRevision = revisions.length;
    const mustBeConfirmed = new Set<RequirementStatus>([
      "confirmed",
      "inDelivery",
      "terminated",
      "awaitingAcceptance",
      "completed",
      "verificationFailedAtLimit",
    ]);
    if (
      (mustBeConfirmed.has(snapshot.status) &&
        snapshot.confirmedVersion !== currentRevision) ||
      (!mustBeConfirmed.has(snapshot.status) &&
        snapshot.confirmedVersion !== null)
    ) {
      throw new Error("需求工作流快照的确认版本无效");
    }
    const approvalRecords = snapshot.approvalRecords.map((record) => {
      if (
        (record.action !== "确认需求" && record.action !== "验收结果") ||
        !internalKeyPattern.test(record.actorKey) ||
        !record.actorName?.trim() ||
        record.actorName.trim().length > 100 ||
        record.requirementKey !== snapshot.requirementKey ||
        !Number.isSafeInteger(record.revision) ||
        record.revision < 1 ||
        record.revision > currentRevision ||
        !Number.isFinite(Date.parse(record.recordedAt))
      ) {
        throw new Error("需求工作流快照包含无效审批记录");
      }
      return RequirementWorkflow.#copyApprovalRecord(record);
    });
    const confirmationApprovals = approvalRecords.filter(
      (record) => record.action === "确认需求",
    );
    const confirmedRevisions = new Set(
      confirmationApprovals.map((record) => record.revision),
    );
    const currentConfirmationCount = confirmationApprovals.filter(
      (record) => record.revision === currentRevision,
    ).length;
    if (
      confirmedRevisions.size !== confirmationApprovals.length ||
      (mustBeConfirmed.has(snapshot.status)
        ? currentConfirmationCount !== 1
        : currentConfirmationCount !== 0)
    ) {
      throw new Error("需求工作流快照的确认记录无效");
    }
    const candidate = snapshot.deliveryCandidate
      ? DeliveryReferenceSchema.safeParse(snapshot.deliveryCandidate)
      : null;
    if (
      (candidate && !candidate.success) ||
      (snapshot.deliveryCandidate === null) !==
        (snapshot.deliveryCandidateRecordedAtMs === null) ||
      (snapshot.deliveryCandidateRecordedAtMs !== null &&
        (!Number.isSafeInteger(snapshot.deliveryCandidateRecordedAtMs) ||
          snapshot.deliveryCandidateRecordedAtMs < 0))
    ) {
      throw new Error("需求工作流快照包含无效交付候选");
    }
    const deliveryCandidate =
      candidate && candidate.success ? { ...candidate.data } : null;
    if (
      deliveryCandidate &&
      (deliveryCandidate.tenantKey !== snapshot.tenantKey ||
        deliveryCandidate.projectKey !== snapshot.projectKey)
    ) {
      throw new Error("需求工作流快照的交付候选范围不匹配");
    }
    let evidence: RequirementEvidenceSnapshot | null = null;
    if (snapshot.evidence) {
      const verifiedEvidence =
        RequirementWorkflow.#verifyPersistedEvidenceSnapshot(
          snapshot.evidence,
          evidenceAuthority,
        ).evidence;
      if (
        verifiedEvidence.tenantKey !== snapshot.tenantKey ||
        verifiedEvidence.projectKey !== snapshot.projectKey ||
        verifiedEvidence.requirementKey !== snapshot.requirementKey ||
        verifiedEvidence.requirementRevision !== currentRevision
      ) {
        throw new Error("需求工作流快照包含无效验证证据");
      }
      evidence = verifiedEvidence;
    }
    const currentCriteria = new Set(
      revisions
        .at(-1)!
        .acceptanceCriteria.map((criterion) => criterion.criterionKey),
    );
    const evidenceCriteria = evidence
      ? new Set(evidence.checks.map((check) => check.criterionKey))
      : null;
    const manualEvidenceCriteria = evidence
      ? new Set(evidence.manualCriterionKeys ?? [])
      : null;
    const evidenceMatchesCandidate =
      evidence === null ||
      (deliveryCandidate !== null &&
        evidence.repositoryKey === deliveryCandidate.repositoryKey &&
        evidence.gitHashAlgorithm === deliveryCandidate.gitHashAlgorithm &&
        evidence.commitSha === deliveryCandidate.commitSha &&
        evidence.artifactHashAlgorithm ===
          deliveryCandidate.artifactHashAlgorithm &&
        evidence.artifactHash === deliveryCandidate.artifactHash &&
        snapshot.deliveryCandidateRecordedAtMs !== null &&
        Date.parse(evidence.producedAt) >=
          snapshot.deliveryCandidateRecordedAtMs &&
        evidence.checks.every((check) => check.status === "passed") &&
        evidenceCriteria?.size === evidence.checks.length &&
        manualEvidenceCriteria?.size ===
          (evidence.manualCriterionKeys?.length ?? 0) &&
        [...evidenceCriteria].every(
          (key) => !manualEvidenceCriteria.has(key),
        ) &&
        evidenceCriteria.size + manualEvidenceCriteria.size ===
          currentCriteria.size &&
        [...currentCriteria].every(
          (key) => evidenceCriteria.has(key) || manualEvidenceCriteria.has(key),
        ));
    const acceptanceApprovals = approvalRecords.filter(
      (record): record is Extract<ApprovalRecord, { action: "验收结果" }> =>
        record.action === "验收结果",
    );
    const acceptanceRevisions = new Set<number>();
    for (const record of acceptanceApprovals) {
      if (
        acceptanceRevisions.has(record.revision) ||
        !confirmedRevisions.has(record.revision)
      ) {
        throw new Error("需求工作流快照的验收记录无效");
      }
      acceptanceRevisions.add(record.revision);
      const historicalEvidence =
        RequirementWorkflow.#verifyPersistedEvidenceSnapshot(
          record.evidence,
          evidenceAuthority,
        ).evidence;
      const revisionCriteria = new Set(
        revisions[record.revision - 1]!.acceptanceCriteria.map(
          (criterion) => criterion.criterionKey,
        ),
      );
      const checkedCriteria = new Set(
        historicalEvidence.checks.map((check) => check.criterionKey),
      );
      const manualCriteria = new Set(
        historicalEvidence.manualCriterionKeys ?? [],
      );
      if (
        historicalEvidence.tenantKey !== snapshot.tenantKey ||
        historicalEvidence.projectKey !== snapshot.projectKey ||
        historicalEvidence.requirementKey !== snapshot.requirementKey ||
        historicalEvidence.requirementRevision !== record.revision ||
        Date.parse(record.recordedAt) <
          Date.parse(historicalEvidence.producedAt) ||
        historicalEvidence.checks.some((check) => check.status !== "passed") ||
        checkedCriteria.size !== historicalEvidence.checks.length ||
        manualCriteria.size !==
          (historicalEvidence.manualCriterionKeys?.length ?? 0) ||
        [...checkedCriteria].some((key) => manualCriteria.has(key)) ||
        checkedCriteria.size + manualCriteria.size !== revisionCriteria.size ||
        [...revisionCriteria].some(
          (key) => !checkedCriteria.has(key) && !manualCriteria.has(key),
        )
      ) {
        throw new Error("需求工作流快照的验收证据与版本不一致");
      }
    }
    const currentAcceptanceApprovals = acceptanceApprovals.filter(
      (record): record is Extract<ApprovalRecord, { action: "验收结果" }> =>
        record.revision === currentRevision,
    );
    const acceptanceMatchesEvidence =
      evidence !== null &&
      currentAcceptanceApprovals.every(
        (record) =>
          record.revision === currentRevision &&
          record.revision === evidence.requirementRevision &&
          record.evidence.signature === evidence.signature &&
          EvidenceAuthority.canonicalPayload(
            RequirementWorkflow.#evidencePayload(record.evidence),
          ) ===
            EvidenceAuthority.canonicalPayload(
              RequirementWorkflow.#evidencePayload(evidence),
            ),
      );
    const blocker = snapshot.verificationBlocker ?? null;
    if (
      blocker !== null &&
      (blocker.code !== "trusted_plan_missing" ||
        !internalKeyPattern.test(blocker.runnerKey) ||
        !internalKeyPattern.test(blocker.keyId) ||
        !Number.isFinite(Date.parse(blocker.reportedAt)) ||
        snapshot.status !== "inDelivery")
    ) {
      throw new Error("需求工作流快照包含无效验证计划阻塞");
    }
    if (
      ((snapshot.status === "awaitingAcceptance" ||
        snapshot.status === "completed") &&
        (!deliveryCandidate || !evidence)) ||
      (snapshot.status !== "awaitingAcceptance" &&
        snapshot.status !== "completed" &&
        evidence !== null) ||
      !evidenceMatchesCandidate ||
      ((snapshot.status === "draft" ||
        snapshot.status === "awaitingConfirmation" ||
        snapshot.status === "confirmed" ||
        snapshot.status === "needsReconfirmation" ||
        snapshot.status === "terminated" ||
        snapshot.status === "verificationFailedAtLimit") &&
        deliveryCandidate !== null) ||
      (snapshot.status === "completed" &&
        (currentAcceptanceApprovals.length !== 1 ||
          !acceptanceMatchesEvidence)) ||
      (snapshot.status !== "completed" &&
        snapshot.status !== "verificationFailedAtLimit" &&
        currentAcceptanceApprovals.length !== 0)
    ) {
      throw new Error("需求工作流快照的状态与交付资料不一致");
    }
    return {
      schemaVersion: snapshot.schemaVersion,
      requirementKey: snapshot.requirementKey.toLowerCase(),
      tenantKey: snapshot.tenantKey.toLowerCase(),
      projectKey: snapshot.projectKey.toLowerCase(),
      status: snapshot.status,
      confirmedVersion: snapshot.confirmedVersion,
      revisions,
      approvalRecords,
      deliveryCandidate,
      deliveryCandidateRecordedAtMs: snapshot.deliveryCandidateRecordedAtMs,
      evidence,
      verificationBlocker: blocker ? { ...blocker } : null,
    };
  }

  static #validateActor(actor: ApprovalActor, roleName: string): ApprovalActor {
    const actorKey = actor.actorKey.trim();
    const actorName = actor.actorName.trim();
    if (
      !internalKeyPattern.test(actorKey) ||
      actorName.length < 2 ||
      actorName.length > 100
    ) {
      throw new Error(`请记录${roleName}`);
    }
    return { actorKey: actorKey.toLowerCase(), actorName };
  }

  #nowIso(fieldName: string): string {
    return new Date(this.#clockTimestamp(fieldName)).toISOString();
  }

  #clockTimestamp(fieldName: string): number {
    const value = this.#clock().getTime();
    if (!Number.isFinite(value)) {
      throw new Error(`${fieldName}无效`);
    }
    return value;
  }
}
