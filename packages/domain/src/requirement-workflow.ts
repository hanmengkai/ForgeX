import { randomUUID } from "node:crypto";

import {
  DeliveryReferenceSchema,
  type DeliveryReference,
} from "@forgex/contracts";

import { VerifiedEvidenceReceipt } from "./evidence.js";

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RequirementStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementStateConflictError";
  }
}

type RequirementStatus =
  | "draft"
  | "awaitingConfirmation"
  | "confirmed"
  | "needsReconfirmation"
  | "inDelivery"
  | "awaitingAcceptance"
  | "completed";

interface RequirementRevision {
  version: number;
  title: string;
  summary: string;
  acceptanceCriteria: Array<{
    criterionKey: string;
    title: string;
  }>;
  changedBy: string;
}

export interface RequirementRevisionInput {
  title?: string;
  summary?: string;
  acceptanceCriteria?: string[];
  changedBy: string;
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
      evidence: {
        evidenceKey: string;
        repositoryKey: string;
        gitHashAlgorithm: "sha1" | "sha256";
        commitSha: string;
        artifactHashAlgorithm: "sha256";
        artifactHash: string;
        runnerKey: string;
        keyId: string;
        producedAt: string;
      };
    });

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
    | "等待产品验收"
    | "已完成";
  nextStep: string;
  acceptanceProgress: string;
}

export type RequirementAllowedAction = "submitForConfirmation" | "confirm";

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
  #evidence: VerifiedEvidenceReceipt | null = null;

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
    return new RequirementWorkflow(
      {
        version: 1,
        title: input.title.trim(),
        summary: input.summary.trim(),
        acceptanceCriteria: RequirementWorkflow.#createCriteria(
          input.acceptanceCriteria,
        ),
        changedBy: "创建者",
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
    if (
      this.#status === "inDelivery" ||
      this.#status === "awaitingAcceptance" ||
      this.#status === "completed"
    ) {
      throw new Error("需求已经进入交付，请创建新的变更需求");
    }
    if (!input.changedBy.trim()) {
      throw new Error("请记录修改人");
    }

    const next = {
      title: input.title ?? this.#current.title,
      summary: input.summary ?? this.#current.summary,
      acceptanceCriteria:
        input.acceptanceCriteria ??
        this.#current.acceptanceCriteria.map((item) => item.title),
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
    });
    this.#confirmedVersion = null;
    this.#status = "needsReconfirmation";
  }

  startDelivery(): void {
    if (
      this.#status !== "confirmed" ||
      this.#confirmedVersion !== this.#current.version
    ) {
      throw new Error("需求需要先由负责人确认，才能开始交付");
    }
    this.#status = "inDelivery";
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
    if (
      actual.size !== evidence.checks.length ||
      actual.size !== expected.size ||
      [...expected].some((criterionKey) => !actual.has(criterionKey))
    ) {
      throw new Error("验证证据没有覆盖全部验收条件");
    }

    this.#evidence = evidence;
    this.#status = "awaitingAcceptance";
  }

  accept(input: { actor: ApprovalActor }): void {
    if (this.#status !== "awaitingAcceptance") {
      throw new Error("请先完成独立验证并提交产品验收");
    }
    const actor = RequirementWorkflow.#validateActor(input.actor, "验收人");
    const recordedAt = this.#nowIso("验收时间");
    const evidence = this.#evidence;
    if (!evidence) {
      throw new Error("验收证据缺失，请重新执行独立验证");
    }
    this.#approvalRecords.push({
      action: "验收结果",
      ...actor,
      requirementKey: this.#key,
      revision: this.#current.version,
      recordedAt,
      evidence: {
        evidenceKey: evidence.evidenceKey,
        repositoryKey: evidence.repositoryKey,
        gitHashAlgorithm: evidence.gitHashAlgorithm,
        commitSha: evidence.commitSha,
        artifactHashAlgorithm: evidence.artifactHashAlgorithm,
        artifactHash: evidence.artifactHash,
        runnerKey: evidence.runnerKey,
        keyId: evidence.keyId,
        producedAt: evidence.producedAt,
      },
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
      acceptanceProgress: this.#evidence
        ? `${this.#evidence.checks.length} / ${this.#current.acceptanceCriteria.length} 项已通过`
        : "尚未开始验证",
    };
  }

  listAllowedActions(): RequirementAllowedAction[] {
    switch (this.#status) {
      case "draft":
      case "needsReconfirmation":
        return ["submitForConfirmation"];
      case "awaitingConfirmation":
        return ["confirm"];
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

  get internalKey(): string {
    return this.#key;
  }

  listApprovalRecords(): ApprovalRecord[] {
    return this.#approvalRecords.map((record) =>
      record.action === "验收结果"
        ? { ...record, evidence: { ...record.evidence } }
        : { ...record },
    );
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
      ...this.#approvalRecords.map((record) =>
        record.action === "验收结果"
          ? { ...record, evidence: { ...record.evidence } }
          : { ...record },
      ),
    );
    copy.#status = this.#status;
    copy.#confirmedVersion = this.#confirmedVersion;
    copy.#deliveryCandidate = this.#deliveryCandidate
      ? Object.freeze({ ...this.#deliveryCandidate })
      : null;
    copy.#deliveryCandidateRecordedAtMs = this.#deliveryCandidateRecordedAtMs;
    copy.#evidence = this.#evidence;
    return copy;
  }

  get #current(): RequirementRevision {
    const current = this.#revisions.at(-1);
    if (!current) {
      throw new Error("需求缺少版本信息");
    }
    return current;
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
      case "awaitingAcceptance":
        return {
          label: "等待产品验收",
          nextStep: "请体验 Preview 并确认结果",
        };
      case "completed":
        return { label: "已完成", nextStep: "无需处理" };
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
    };
  }

  static #validateActor(actor: ApprovalActor, roleName: string): ApprovalActor {
    const actorKey = actor.actorKey.trim();
    const actorName = actor.actorName.trim();
    if (!actorKey || !actorName) {
      throw new Error(`请记录${roleName}`);
    }
    return { actorKey, actorName };
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
