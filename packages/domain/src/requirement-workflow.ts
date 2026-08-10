import { randomUUID } from "node:crypto";

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
  acceptanceCriteria: string[];
  changedBy: string;
}

export interface RequirementRevisionInput {
  title?: string;
  summary?: string;
  acceptanceCriteria?: string[];
  changedBy: string;
}

export interface VerificationEvidence {
  passed: number;
  total: number;
  producedBy: string;
  independentlyVerified: boolean;
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

export class RequirementWorkflow {
  readonly #key: string;
  readonly #revisions: RequirementRevision[];
  #status: RequirementStatus = "draft";
  #confirmedVersion: number | null = null;
  #evidence: VerificationEvidence | null = null;

  private constructor(initialRevision: RequirementRevision) {
    this.#key = randomUUID();
    this.#revisions = [initialRevision];
  }

  static create(input: {
    title: string;
    summary: string;
    acceptanceCriteria: string[];
  }): RequirementWorkflow {
    RequirementWorkflow.#validateContent(input);
    return new RequirementWorkflow({
      version: 1,
      title: input.title.trim(),
      summary: input.summary.trim(),
      acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()),
      changedBy: "创建者"
    });
  }

  submitForConfirmation(): void {
    if (this.#status !== "draft" && this.#status !== "needsReconfirmation") {
      throw new Error("当前状态不能重复提交确认");
    }
    this.#status = "awaitingConfirmation";
  }

  confirm(input: { confirmedBy: string; confirmedAt: Date }): void {
    if (this.#status !== "awaitingConfirmation") {
      throw new Error("请先提交需求确认");
    }
    if (!input.confirmedBy.trim()) {
      throw new Error("请记录确认人");
    }
    if (Number.isNaN(input.confirmedAt.getTime())) {
      throw new Error("确认时间无效");
    }

    this.#confirmedVersion = this.#current.version;
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
        input.acceptanceCriteria ?? this.#current.acceptanceCriteria
    };
    RequirementWorkflow.#validateContent(next);

    this.#revisions.push({
      version: this.#current.version + 1,
      title: next.title.trim(),
      summary: next.summary.trim(),
      acceptanceCriteria: next.acceptanceCriteria.map((item) => item.trim()),
      changedBy: input.changedBy.trim()
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

  submitForAcceptance(evidence: VerificationEvidence): void {
    if (this.#status !== "inDelivery") {
      throw new Error("需求尚未进入交付，不能提交验收");
    }
    if (!evidence.independentlyVerified) {
      throw new Error("验证证据必须由独立执行者产生");
    }
    if (!evidence.producedBy.trim()) {
      throw new Error("请记录验证证据的执行者");
    }
    if (evidence.total < 1 || evidence.passed !== evidence.total) {
      throw new Error("所有验收条件通过后才能提交产品验收");
    }

    this.#evidence = { ...evidence, producedBy: evidence.producedBy.trim() };
    this.#status = "awaitingAcceptance";
  }

  accept(input: { acceptedBy: string; acceptedAt: Date }): void {
    if (this.#status !== "awaitingAcceptance") {
      throw new Error("请先完成独立验证并提交产品验收");
    }
    if (!input.acceptedBy.trim()) {
      throw new Error("请记录验收人");
    }
    if (Number.isNaN(input.acceptedAt.getTime())) {
      throw new Error("验收时间无效");
    }
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
        ? `${this.#evidence.passed} / ${this.#evidence.total} 项已通过`
        : "尚未开始验证"
    };
  }

  get internalKey(): string {
    return this.#key;
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
          nextStep: "请负责人确认需求内容"
        };
      case "confirmed":
        return {
          label: "已确认，等待交付",
          nextStep: "可以安排 AI 开始实现"
        };
      case "needsReconfirmation":
        return {
          label: "内容已更新，等待重新确认",
          nextStep: "请负责人确认最新版本"
        };
      case "inDelivery":
        return { label: "AI 正在实现", nextStep: "等待独立验证完成" };
      case "awaitingAcceptance":
        return {
          label: "等待产品验收",
          nextStep: "请体验 Preview 并确认结果"
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
}

