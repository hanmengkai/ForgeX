import { randomUUID } from "node:crypto";

import {
  RequirementSpecSchema,
  StartDeliveryCommandSchema,
  type RequirementSpec,
  type StartDeliveryCommandPayload,
} from "@forgex/contracts";
import {
  type RequirementAllowedAction,
  type RequirementAcceptanceView,
  type RequirementStatus,
  RequirementStateConflictError,
  RequirementWorkflow,
  type RequirementPeopleView,
  type RequirementRevisionPeopleView,
} from "@forgex/domain";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";
import {
  canPerformRequirementAction,
  type RequirementAuthorizedAction,
} from "./requirement-authorization.js";
import {
  DeliverySkillBindingsSchema,
  type DeliverySkillBinding,
  type DeliveryDispatchRecord,
  type DeliveryExecutionEventRecord,
  type RequirementAuditAction,
  type RequirementRecord,
  type RequirementRepository,
  type RequirementTransaction,
} from "./requirement-repository.js";
import type { PreviewArtifactReference } from "./preview-artifact-store.js";

export interface RequirementApplicationServiceOptions {
  repository: RequirementRepository;
  projectKey: string;
  repositoryKey?: string;
  clock?: () => Date;
}

export interface RequirementCommandResult {
  requirementKey: string;
  repositoryKey?: string | null;
  view: RequirementPeopleView;
  allowedActions: RequirementAllowedAction[];
}

export interface RequirementDetailResult extends RequirementCommandResult {
  spec: RequirementSpec;
  acceptance: RequirementAcceptanceView | null;
  revisions: RequirementRevisionPeopleView[];
  progress: RequirementProgressView;
  executionEvents: RequirementExecutionEventView[];
}

export interface RequirementExecutionEventView {
  title: string;
  detail: string;
  tone: "running" | "success" | "error" | "neutral";
  occurredAt: string;
}

export type RecordRequirementExecutionEventInput = Omit<
  DeliveryExecutionEventRecord,
  "tenantKey" | "projectKey"
>;

export type RequirementProgressStageKey =
  | "confirmation"
  | "queue"
  | "implementation"
  | "commit"
  | "verification"
  | "acceptance";

export interface RequirementProgressStageView {
  key: RequirementProgressStageKey;
  label: string;
  status: "completed" | "active" | "pending" | "terminated";
  detail: string;
}

export interface RequirementProgressView {
  percent: number;
  currentStage: string;
  updatedAt: string;
  stages: RequirementProgressStageView[];
}

const executionStatus = {
  started: { detail: "正在执行", tone: "running" },
  completed: { detail: "已完成", tone: "success" },
  failed: { detail: "未完成", tone: "error" },
} as const;

const executionEventView = (
  record: DeliveryExecutionEventRecord,
): RequirementExecutionEventView => {
  const event = record.event;
  if (event.kind === "lifecycle") {
    if (event.status === "started") {
      return {
        title: "Codex 开始分析需求",
        detail: "已进入受控项目工作区",
        tone: "running",
        occurredAt: record.occurredAt,
      };
    }
    if (event.status === "completed") {
      return {
        title: "Codex 完成工作区修改",
        detail: "等待设备生成本地提交",
        tone: "success",
        occurredAt: record.occurredAt,
      };
    }
    const failureDetail = {
      authentication: "Codex 登录不可用，请在设备端重新完成登录",
      rate_limit: "Codex 服务触发限流，请稍后重试",
      network: "设备与 Codex 服务的网络连接异常",
      execution: "设备已保留失败状态，供人工检查",
    } as const;
    return {
      title: "Codex 执行未完成",
      detail: event.reason
        ? failureDetail[event.reason]
        : "设备已保留失败状态，供人工检查",
      tone: "error",
      occurredAt: record.occurredAt,
    };
  }
  if (event.kind === "tool") {
    const title = {
      list_workspace: "浏览项目结构",
      read_workspace_file: "读取项目文件",
      search_workspace_text: "检索相关代码",
    }[event.tool];
    return {
      title,
      ...executionStatus[event.status],
      occurredAt: record.occurredAt,
    };
  }
  if (event.kind === "file_change") {
    const changeKind = { add: "新增", update: "更新", delete: "删除" } as const;
    const shown = event.changes
      .slice(0, 5)
      .map((change) => `${change.path}（${changeKind[change.kind]}）`)
      .join("、");
    const remaining = event.changes.length - 5;
    return {
      title: "更新项目文件",
      detail:
        `${shown}${remaining > 0 ? `，另有 ${remaining} 个文件` : ""}`.slice(
          0,
          500,
        ),
      tone: event.status === "completed" ? "success" : "error",
      occurredAt: record.occurredAt,
    };
  }
  const title = {
    test: "执行本地测试",
    build: "检查项目构建",
    lint: "检查代码规范",
    format: "整理代码格式",
    git: "检查代码变更",
    other: "执行受控本地命令",
  }[event.category];
  return {
    title,
    ...executionStatus[event.status],
    occurredAt: record.occurredAt,
  };
};

export interface RequirementListQuery {
  cursor?: string;
  limit?: number;
}

export interface RequirementListResult {
  items: RequirementCommandResult[];
  nextCursor: string | null;
}

const encodeCursor = (position: number): string =>
  Buffer.from(JSON.stringify({ version: 1, after: position })).toString(
    "base64url",
  );

const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const decodeCursor = (cursor: string): number => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("after" in parsed) ||
      typeof parsed.after !== "number" ||
      !Number.isSafeInteger(parsed.after) ||
      parsed.after < 1
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed.after;
  } catch {
    throw new ApplicationError(
      422,
      "invalid_cursor",
      "这个翻页位置已失效，请从第一页重新查看",
    );
  }
};

const progressStages = [
  ["confirmation", "需求确认"],
  ["queue", "设备排队"],
  ["implementation", "AI 实现"],
  ["commit", "本地提交"],
  ["verification", "独立验证"],
  ["acceptance", "产品验收"],
] as const satisfies ReadonlyArray<
  readonly [RequirementProgressStageKey, string]
>;

const requirementProgress = (input: {
  status: RequirementStatus;
  createdAt: string;
  dispatch: DeliveryDispatchRecord | null;
  run: import("./requirement-repository.js").DeliveryRunResult | null;
  verificationFailed: boolean;
  acceptance: RequirementAcceptanceView | null;
}): RequirementProgressView => {
  const details: Record<RequirementProgressStageKey, string> = {
    confirmation: "等待负责人确认需求范围",
    queue: "等待空闲设备领取任务",
    implementation: "等待 AI 开始分析代码",
    commit: "等待设备生成本地提交",
    verification: "等待独立 Runner 验证",
    acceptance: "等待产品负责人体验并验收",
  };
  const statuses = new Map<
    RequirementProgressStageKey,
    RequirementProgressStageView["status"]
  >(progressStages.map(([key]) => [key, "pending"]));
  let percent = 10;
  let currentStage = "整理与确认需求";
  let updatedAt = input.createdAt;

  const complete = (key: RequirementProgressStageKey, detail: string) => {
    statuses.set(key, "completed");
    details[key] = detail;
  };
  const activate = (key: RequirementProgressStageKey, detail: string) => {
    statuses.set(key, "active");
    details[key] = detail;
  };

  if (
    [
      "confirmed",
      "inDelivery",
      "terminated",
      "awaitingAcceptance",
      "completed",
      "verificationFailedAtLimit",
    ].includes(input.status)
  ) {
    complete("confirmation", "负责人已确认当前需求版本");
    percent = 20;
    currentStage = "等待安排交付";
  } else {
    activate("confirmation", details.confirmation);
  }

  if (input.dispatch) {
    updatedAt =
      input.dispatch.cancelledAt ??
      input.dispatch.dispatchedAt ??
      input.dispatch.requestedAt;
    if (input.dispatch.dispatchedAt) {
      complete("queue", "设备已领取交付任务");
      percent = 45;
      currentStage = "AI 分析与修改";
      activate("implementation", "正在分析代码并完成需求修改");
    } else {
      activate("queue", "交付任务正在等待空闲设备");
      percent = 25;
      currentStage = "等待设备领取";
    }
  }

  if (input.run) {
    complete("queue", "设备已领取交付任务");
    complete("implementation", "AI 已完成工作树修改");
    complete("commit", "设备已生成受控本地提交");
    updatedAt = input.run.completedAt ?? input.run.submittedAt;
    percent = input.run.status === "completed" ? 75 : 65;
    currentStage =
      input.run.status === "completed" ? "独立验证中" : "登记本地提交";
    activate(
      "verification",
      input.run.status === "completed"
        ? "独立 Runner 正在验证真实交付结果"
        : "等待本地提交完成登记",
    );
  }

  if (input.verificationFailed) {
    statuses.set("verification", "terminated");
    details.verification = "独立验证未通过，需要修订后重新确认";
    percent = 75;
    currentStage = "独立验证未通过";
  }

  if (input.acceptance || input.status === "awaitingAcceptance") {
    for (const key of [
      "queue",
      "implementation",
      "commit",
      "verification",
    ] as const) {
      complete(key, details[key]);
    }
    activate("acceptance", "独立验证已通过，等待产品验收");
    updatedAt = input.acceptance?.verifiedAt ?? updatedAt;
    percent = 90;
    currentStage = "等待产品验收";
  }

  if (input.status === "completed") {
    for (const [key] of progressStages) complete(key, details[key]);
    percent = 100;
    currentStage = "交付已完成";
  }

  if (input.status === "terminated") {
    complete("confirmation", "负责人已确认当前需求版本");
    if (input.dispatch?.dispatchedAt) complete("queue", "设备曾领取交付任务");
    statuses.set("implementation", "terminated");
    details.implementation = input.dispatch?.cancellationCompletedAt
      ? "设备租约已撤销，未提交修改不会进入交付结果"
      : "终止指令已生效，设备任务正在撤销";
    percent = 35;
    currentStage = "交付已强制终止";
  }

  return {
    percent,
    currentStage,
    updatedAt,
    stages: progressStages.map(([key, label]) => ({
      key,
      label,
      status: statuses.get(key) ?? "pending",
      detail: details[key],
    })),
  };
};

export class RequirementApplicationService {
  readonly #repository: RequirementRepository;
  readonly #projectKey: string;
  readonly #repositoryKey: string;
  readonly #clock: () => Date;

  constructor(options: RequirementApplicationServiceOptions) {
    if (!internalKeyPattern.test(options.projectKey.trim())) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    this.#repository = options.repository;
    this.#projectKey = options.projectKey.trim().toLowerCase();
    const repositoryKey = options.repositoryKey ?? options.projectKey;
    if (!internalKeyPattern.test(repositoryKey.trim())) {
      throw new Error("仓库范围必须使用有效的内部标识");
    }
    this.#repositoryKey = repositoryKey.trim().toLowerCase();
    this.#clock = options.clock ?? (() => new Date());
  }

  async recordExecutionEvent(
    tenantKey: string,
    input: RecordRequirementExecutionEventInput,
  ): Promise<boolean> {
    return this.#repository.transaction(
      tenantKey,
      this.#projectKey,
      async (transaction) => {
        const requirement = await transaction.find(input.requirementKey);
        if (!requirement || requirement.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        const snapshot = requirement.workflow.toSnapshot();
        if (
          snapshot.status !== "inDelivery" ||
          requirement.workflow.currentRevision !== input.requirementRevision
        ) {
          throw new ApplicationError(
            409,
            "delivery_progress_stale",
            "这条 Codex 过程记录已不属于当前交付版本",
          );
        }
        return transaction.appendDeliveryExecutionEvent({
          ...input,
          tenantKey,
          projectKey: this.#projectKey,
        });
      },
    );
  }

  async create(
    principal: AuthenticatedPrincipal,
    spec: RequirementSpec,
  ): Promise<RequirementCommandResult> {
    this.#requireAction(principal, "create");
    const workflow = RequirementWorkflow.createFromSpec(spec, {
      tenantKey: principal.tenantKey,
      projectKey: this.#projectKey,
      clock: this.#clock,
    });
    const record: RequirementRecord = {
      tenantKey: principal.tenantKey.toLowerCase(),
      projectKey: this.#projectKey,
      repositoryKey: this.#repositoryKey,
      requirementKey: workflow.internalKey,
      createdAt: this.#nowIso(),
      spec: structuredClone(spec),
      workflow,
    };

    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        transaction.save(record);
        this.#appendAudit(
          transaction,
          record,
          principal,
          "requirement.created",
        );
        return {
          requirementKey: record.requirementKey,
          repositoryKey: record.repositoryKey ?? null,
          view: workflow.toPeopleView(),
          allowedActions: workflow.listAllowedActions(),
        };
      },
    );
  }

  async submitForConfirmation(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
  ): Promise<RequirementCommandResult> {
    this.#requireAction(principal, "submitForConfirmation");
    return this.#mutate(
      principal,
      requirementKey,
      "requirement.confirmation_submitted",
      (workflow) => workflow.submitForConfirmation(),
    );
  }

  async revise(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    expectedRevision: number,
    spec: RequirementSpec,
  ): Promise<RequirementCommandResult> {
    this.#requireAction(principal, "revise");
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      expectedRevision > 100
    ) {
      throw new ApplicationError(
        422,
        "invalid_requirement_revision",
        "预期需求版本无效",
      );
    }
    const parsed = RequirementSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new ApplicationError(
        422,
        "invalid_requirement_revision",
        "需求修订内容需要调整",
      );
    }
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(requirementKey);
        if (!record || record.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        if (record.workflow.currentRevision !== expectedRevision) {
          throw new ApplicationError(
            409,
            "requirement_revision_conflict",
            "需求已被其他人更新，请刷新后合并改动",
          );
        }
        try {
          record.workflow.revise({
            changedBy: principal.actorName,
            spec: parsed.data,
          });
        } catch (error) {
          if (error instanceof RequirementStateConflictError) {
            throw new ApplicationError(
              409,
              "requirement_state_conflict",
              error.message,
            );
          }
          if (error instanceof Error) {
            throw new ApplicationError(
              409,
              "requirement_state_conflict",
              error.message,
            );
          }
          throw error;
        }
        record.spec = structuredClone(parsed.data);
        transaction.save(record);
        this.#appendAudit(
          transaction,
          record,
          principal,
          "requirement.revised",
        );
        return {
          requirementKey: record.requirementKey,
          repositoryKey: record.repositoryKey ?? null,
          view: record.workflow.toPeopleView(),
          allowedActions: record.workflow.listAllowedActions(),
        };
      },
    );
  }

  async confirm(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
  ): Promise<RequirementCommandResult> {
    this.#requireAction(principal, "confirm");
    return this.#mutate(
      principal,
      requirementKey,
      "requirement.confirmed",
      (workflow) =>
        workflow.confirm({
          actor: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
        }),
    );
  }

  async requestDelivery(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    input: StartDeliveryCommandPayload,
    skills: DeliverySkillBinding[] = [],
  ): Promise<DeliveryDispatchRecord> {
    this.#requireAction(principal, "startDelivery");
    const command = StartDeliveryCommandSchema.safeParse(input);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "invalid_delivery_command",
        "交付安排需要调整",
      );
    }
    const parsedSkills = DeliverySkillBindingsSchema.safeParse(skills);
    if (
      !parsedSkills.success ||
      parsedSkills.data.length !== (command.data.skillKeys?.length ?? 0) ||
      parsedSkills.data.some(
        (skill, index) => skill.skillKey !== command.data.skillKeys?.[index],
      )
    ) {
      throw new Error("交付 Skill 绑定必须与已校验的交付命令完全一致");
    }
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(requirementKey);
        if (!record || record.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        try {
          record.workflow.startDelivery();
        } catch (error) {
          if (error instanceof RequirementStateConflictError) {
            throw new ApplicationError(
              409,
              "requirement_state_conflict",
              error.message,
            );
          }
          throw error;
        }
        const dispatch: DeliveryDispatchRecord = {
          dispatchKey: randomUUID(),
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          repositoryKey: record.repositoryKey ?? this.#repositoryKey,
          requirementKey: record.requirementKey,
          requirementRevision: record.workflow.currentRevision,
          title: record.spec.title,
          requiredCapabilities: [...command.data.requiredCapabilities],
          skills: parsedSkills.data.map((skill) => ({ ...skill })),
          requestedAt: this.#nowIso(),
          dispatchedAt: null,
          cancelledAt: null,
          cancellationCompletedAt: null,
        };
        transaction.save(record);
        transaction.appendDeliveryDispatch(dispatch);
        this.#appendAudit(transaction, record, principal, "delivery.requested");
        return {
          ...dispatch,
          requiredCapabilities: [...dispatch.requiredCapabilities],
          skills: dispatch.skills.map((skill) => ({ ...skill })),
        };
      },
    );
  }

  async accept(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
  ): Promise<RequirementCommandResult> {
    this.#requireAction(principal, "accept");
    return this.#mutate(
      principal,
      requirementKey,
      "requirement.accepted",
      (workflow) =>
        workflow.accept({
          actor: {
            actorKey: principal.actorKey,
            actorName: principal.actorName,
          },
        }),
    );
  }

  async terminateDelivery(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    cancelAssignment: (
      dispatch: DeliveryDispatchRecord,
    ) => Promise<unknown> = async () => undefined,
  ): Promise<RequirementCommandResult> {
    this.#requireAction(principal, "terminateDelivery");
    const outcome = await this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(requirementKey);
        if (!record || record.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        const dispatch = await transaction.findDeliveryDispatch(
          record.requirementKey,
          record.workflow.currentRevision,
        );
        if (!dispatch) {
          throw new ApplicationError(
            409,
            "delivery_dispatch_not_found",
            "当前交付还没有形成可终止的设备任务",
          );
        }
        try {
          record.workflow.terminateDelivery();
        } catch (error) {
          if (error instanceof RequirementStateConflictError) {
            throw new ApplicationError(
              409,
              "requirement_state_conflict",
              error.message,
            );
          }
          throw error;
        }
        const recordedAt = this.#nowIso();
        await transaction.markDeliveryCancelled(
          dispatch.dispatchKey,
          recordedAt,
        );
        transaction.save(record);
        this.#appendAudit(
          transaction,
          record,
          principal,
          "delivery.terminated",
          recordedAt,
        );
        return {
          dispatch: structuredClone(dispatch),
          result: {
            requirementKey: record.requirementKey,
            repositoryKey: record.repositoryKey ?? null,
            view: record.workflow.toPeopleView(),
            allowedActions: record.workflow.listAllowedActions(),
          },
        };
      },
    );
    try {
      await cancelAssignment(outcome.dispatch);
      await this.acknowledgeDeliveryCancellation(outcome.dispatch);
    } catch {
      // 已落库的撤销待办会在 Worker poll/renew 前幂等重试。
    }
    return outcome.result;
  }

  async acknowledgeDeliveryCancellation(
    dispatch: DeliveryDispatchRecord,
  ): Promise<void> {
    await this.#repository.transaction(
      dispatch.tenantKey,
      dispatch.projectKey,
      async (transaction) => {
        await transaction.markDeliveryCancellationCompleted(
          dispatch.dispatchKey,
          this.#nowIso(),
        );
      },
    );
  }

  async list(
    principal: AuthenticatedPrincipal,
    query: RequirementListQuery = {},
  ): Promise<RequirementListResult> {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError(
        422,
        "invalid_page_size",
        "每页数量需要在 1 到 100 之间",
      );
    }
    const page = await this.#repository.listForPeople(
      principal.tenantKey,
      this.#projectKey,
      {
        ...(query.cursor ? { afterPosition: decodeCursor(query.cursor) } : {}),
        limit,
      },
    );
    return {
      items: page.items,
      nextCursor: page.nextPosition ? encodeCursor(page.nextPosition) : null,
    };
  }

  async get(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
  ): Promise<RequirementDetailResult> {
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(requirementKey);
        if (!record || record.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        const [dispatch, run, verificationFailure, executionEvents] =
          await Promise.all([
            transaction.findDeliveryDispatch(
              record.requirementKey,
              record.workflow.currentRevision,
            ),
            transaction.findDeliveryRunResult(
              record.requirementKey,
              record.workflow.currentRevision,
            ),
            transaction.findVerificationFailure(
              record.requirementKey,
              record.workflow.currentRevision,
            ),
            transaction.listDeliveryExecutionEvents(
              record.requirementKey,
              record.workflow.currentRevision,
              100,
            ),
          ]);
        const acceptance = record.workflow.toAcceptanceView();
        return {
          requirementKey: record.requirementKey,
          repositoryKey: record.repositoryKey ?? null,
          view: record.workflow.toPeopleView(),
          allowedActions: record.workflow.listAllowedActions(),
          spec: structuredClone(record.spec),
          acceptance,
          revisions: record.workflow.listRevisionsForPeople(),
          progress: requirementProgress({
            status: record.workflow.toSnapshot().status,
            createdAt: record.createdAt,
            dispatch,
            run,
            verificationFailed: verificationFailure !== null,
            acceptance,
          }),
          executionEvents: executionEvents.map(executionEventView),
        };
      },
    );
  }

  async getPreviewTarget(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
  ): Promise<PreviewArtifactReference> {
    this.#requireAction(principal, "viewPreview");
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(requirementKey);
        if (!record || record.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        const reference = record.workflow.toPreviewArtifactReference();
        if (!reference) {
          throw new ApplicationError(
            409,
            "preview_not_ready",
            "效果预览还没有通过独立验证",
          );
        }
        return {
          tenantKey: record.tenantKey,
          projectKey: record.projectKey,
          requirementKey: record.requirementKey,
          ...reference,
        };
      },
    );
  }

  async #mutate(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    action: RequirementAuditAction,
    mutation: (workflow: RequirementWorkflow) => void,
  ): Promise<RequirementCommandResult> {
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(requirementKey);
        if (!record || record.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        try {
          mutation(record.workflow);
        } catch (error) {
          if (error instanceof ApplicationError) {
            throw error;
          }
          if (error instanceof RequirementStateConflictError) {
            throw new ApplicationError(
              409,
              "requirement_state_conflict",
              error.message,
            );
          }
          throw error;
        }
        transaction.save(record);
        this.#appendAudit(transaction, record, principal, action);
        return {
          requirementKey: record.requirementKey,
          repositoryKey: record.repositoryKey ?? null,
          view: record.workflow.toPeopleView(),
          allowedActions: record.workflow.listAllowedActions(),
        };
      },
    );
  }

  #appendAudit(
    transaction: RequirementTransaction,
    record: RequirementRecord,
    principal: AuthenticatedPrincipal,
    action: RequirementAuditAction,
    recordedAt = this.#nowIso(),
  ): void {
    transaction.appendAudit({
      eventKey: randomUUID(),
      tenantKey: record.tenantKey,
      projectKey: record.projectKey,
      requirementKey: record.requirementKey,
      action,
      actorKey: principal.actorKey,
      actorName: principal.actorName,
      recordedAt,
    });
  }

  #requireAction(
    principal: AuthenticatedPrincipal,
    action: RequirementAuthorizedAction,
  ): void {
    if (!canPerformRequirementAction(principal, action)) {
      throw new ApplicationError(
        403,
        "permission_denied",
        "当前账号没有执行此操作的权限",
      );
    }
  }

  #nowIso(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("服务端时间无效");
    }
    return new Date(value.getTime()).toISOString();
  }
}
