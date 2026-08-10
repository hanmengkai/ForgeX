import { randomUUID } from "node:crypto";

import {
  StartDeliveryCommandSchema,
  type RequirementSpec,
  type StartDeliveryCommandPayload,
} from "@forgex/contracts";
import {
  type RequirementAllowedAction,
  RequirementStateConflictError,
  RequirementWorkflow,
  type RequirementPeopleView,
} from "@forgex/domain";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";
import {
  canPerformRequirementAction,
  type RequirementAuthorizedAction,
} from "./requirement-authorization.js";
import type {
  DeliveryDispatchRecord,
  RequirementAuditAction,
  RequirementRecord,
  RequirementRepository,
  RequirementTransaction,
} from "./requirement-repository.js";

export interface RequirementApplicationServiceOptions {
  repository: RequirementRepository;
  projectKey: string;
  clock?: () => Date;
}

export interface RequirementCommandResult {
  requirementKey: string;
  view: RequirementPeopleView;
  allowedActions: RequirementAllowedAction[];
}

export interface RequirementDetailResult extends RequirementCommandResult {
  spec: RequirementSpec;
}

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

export class RequirementApplicationService {
  readonly #repository: RequirementRepository;
  readonly #projectKey: string;
  readonly #clock: () => Date;

  constructor(options: RequirementApplicationServiceOptions) {
    if (!internalKeyPattern.test(options.projectKey.trim())) {
      throw new Error("项目范围必须使用有效的内部标识");
    }
    this.#repository = options.repository;
    this.#projectKey = options.projectKey.trim().toLowerCase();
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(
    principal: AuthenticatedPrincipal,
    spec: RequirementSpec,
  ): Promise<RequirementCommandResult> {
    this.#requireAction(principal, "create");
    const workflow = RequirementWorkflow.create(
      {
        title: spec.title,
        summary: spec.goal,
        acceptanceCriteria: spec.acceptanceCriteria.map(
          (criterion) => criterion.title,
        ),
      },
      {
        tenantKey: principal.tenantKey,
        projectKey: this.#projectKey,
        clock: this.#clock,
      },
    );
    const record: RequirementRecord = {
      tenantKey: principal.tenantKey.toLowerCase(),
      projectKey: this.#projectKey,
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
    return this.#repository.transaction(
      principal.tenantKey,
      this.#projectKey,
      (transaction) => {
        const record = transaction.find(requirementKey);
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
          requirementKey: record.requirementKey,
          requirementRevision: record.workflow.currentRevision,
          title: record.spec.title,
          requiredCapabilities: [...command.data.requiredCapabilities],
          requestedAt: this.#nowIso(),
          dispatchedAt: null,
        };
        transaction.save(record);
        transaction.appendDeliveryDispatch(dispatch);
        this.#appendAudit(transaction, record, principal, "delivery.requested");
        return {
          ...dispatch,
          requiredCapabilities: [...dispatch.requiredCapabilities],
        };
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
      (transaction) => {
        const record = transaction.find(requirementKey);
        if (!record || record.projectKey !== this.#projectKey) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这个需求",
          );
        }
        return {
          requirementKey: record.requirementKey,
          view: record.workflow.toPeopleView(),
          allowedActions: record.workflow.listAllowedActions(),
          spec: structuredClone(record.spec),
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
      (transaction) => {
        const record = transaction.find(requirementKey);
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
  ): void {
    transaction.appendAudit({
      eventKey: randomUUID(),
      tenantKey: record.tenantKey,
      projectKey: record.projectKey,
      requirementKey: record.requirementKey,
      action,
      actorKey: principal.actorKey,
      actorName: principal.actorName,
      recordedAt: this.#nowIso(),
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
