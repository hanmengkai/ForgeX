import {
  EvidenceCheckSchema,
  WORKER_REQUIREMENT_COMPLETION_SUMMARY,
  type RequirementSpec,
} from "@forgex/contracts";
import { z } from "zod";
import type {
  RequirementAllowedAction,
  RequirementPeopleView,
  RequirementWorkflow,
} from "@forgex/domain";

export type RequirementAuditAction =
  | "requirement.created"
  | "requirement.revised"
  | "requirement.confirmation_submitted"
  | "requirement.confirmed"
  | "requirement.accepted"
  | "delivery.requested"
  | "delivery.dispatched"
  | "delivery.terminated"
  | "delivery.completed"
  | "verification.preview_recorded"
  | "verification.failed"
  | "verification.completed";

const deliveryInternalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export interface DeliveryDispatchRecord {
  dispatchKey: string;
  tenantKey: string;
  projectKey: string;
  repositoryKey: string;
  requirementKey: string;
  requirementRevision: number;
  title: string;
  requiredCapabilities: string[];
  skills: DeliverySkillBinding[];
  requestedAt: string;
  dispatchedAt: string | null;
  cancelledAt?: string | null;
  cancellationCompletedAt?: string | null;
}

export const DeliverySkillBindingSchema = z
  .object({
    skillKey: deliveryInternalKey,
    version: z
      .string()
      .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
    artifactHashAlgorithm: z.literal("sha256"),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const DeliverySkillBindingsSchema = z
  .array(DeliverySkillBindingSchema)
  .max(10)
  .superRefine((skills, context) => {
    if (new Set(skills.map((skill) => skill.skillKey)).size !== skills.length) {
      context.addIssue({
        code: "custom",
        message: "交付 Skill 绑定不能重复",
      });
    }
  });

export type DeliverySkillBinding = z.infer<typeof DeliverySkillBindingSchema>;

const sha1Pattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export const DeliveryRunResultSchema = z
  .object({
    tenantKey: deliveryInternalKey,
    projectKey: deliveryInternalKey,
    repositoryKey: deliveryInternalKey,
    requirementKey: deliveryInternalKey,
    requirementRevision: z.number().int().positive().max(10_000),
    assignmentKey: deliveryInternalKey,
    fencingToken: z.number().int().positive(),
    gitHashAlgorithm: z.enum(["sha1", "sha256"]),
    baseCommit: z.string(),
    commitSha: z.string(),
    branchName: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .regex(/^forgex\/[a-f0-9-]+\/[a-f0-9-]+$/u),
    summary: z.literal(WORKER_REQUIREMENT_COMPLETION_SUMMARY),
    status: z.enum(["completion_pending", "completed"]),
    submittedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const hashPattern =
      result.gitHashAlgorithm === "sha1" ? sha1Pattern : sha256Pattern;
    for (const field of ["baseCommit", "commitSha"] as const) {
      if (!hashPattern.test(result[field])) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} 必须是完整的 ${result.gitHashAlgorithm} 摘要`,
        });
      }
    }
    if (result.baseCommit === result.commitSha) {
      context.addIssue({
        code: "custom",
        path: ["commitSha"],
        message: "交付提交必须不同于任务基线",
      });
    }
    if ((result.status === "completed") !== (result.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "交付运行状态与完成时间不一致",
      });
    }
    if (
      result.completedAt !== null &&
      Date.parse(result.completedAt) < Date.parse(result.submittedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "完成时间不能早于结果提交时间",
      });
    }
  });

export type DeliveryRunResult = z.infer<typeof DeliveryRunResultSchema>;

export const VerificationEvidenceRecordSchema = z
  .object({
    tenantKey: deliveryInternalKey,
    projectKey: deliveryInternalKey,
    requirementKey: deliveryInternalKey,
    requirementRevision: z.number().int().positive().max(10_000),
    evidenceKey: deliveryInternalKey,
    evidenceDigest: z.string().regex(sha256Pattern),
    runnerKey: deliveryInternalKey,
    keyId: deliveryInternalKey,
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type VerificationEvidenceRecord = z.infer<
  typeof VerificationEvidenceRecordSchema
>;

export const VerificationFailureRecordSchema = z
  .object({
    tenantKey: deliveryInternalKey,
    projectKey: deliveryInternalKey,
    repositoryKey: deliveryInternalKey,
    requirementKey: deliveryInternalKey,
    requirementRevision: z.number().int().positive().max(10_000),
    failureDigest: z.string().regex(sha256Pattern),
    runnerKey: deliveryInternalKey,
    keyId: deliveryInternalKey,
    verificationCompletedAt: z.iso.datetime(),
    checks: z.array(EvidenceCheckSchema).min(1).max(80),
    recordedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.checks.every((check) => check.status === "passed")) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "失败验证记录必须至少包含一项未通过结果",
      });
    }
    if (
      new Set(record.checks.map((check) => check.criterionKey)).size !==
      record.checks.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "失败验证记录不能重复验收条件",
      });
    }
  });

export type VerificationFailureRecord = z.infer<
  typeof VerificationFailureRecordSchema
>;

export interface RequirementAuditEvent {
  eventKey: string;
  tenantKey: string;
  projectKey: string;
  requirementKey: string;
  action: RequirementAuditAction;
  actorKey: string;
  actorName: string;
  recordedAt: string;
}

export interface RequirementRecord {
  tenantKey: string;
  projectKey: string;
  repositoryKey?: string | null;
  requirementKey: string;
  createdAt: string;
  spec: RequirementSpec;
  workflow: RequirementWorkflow;
}

export interface RequirementListOptions {
  afterPosition?: number;
  limit: number;
}

export interface RequirementListItem {
  requirementKey: string;
  repositoryKey: string | null;
  view: RequirementPeopleView;
  allowedActions: RequirementAllowedAction[];
}

export interface RequirementListPage {
  items: RequirementListItem[];
  nextPosition: number | null;
}

export interface RequirementTransaction {
  find(requirementKey: string): Promise<RequirementRecord | null>;
  save(record: RequirementRecord): void;
  appendAudit(event: RequirementAuditEvent): void;
  appendDeliveryDispatch(record: DeliveryDispatchRecord): void;
  markDeliveryDispatched(
    dispatchKey: string,
    dispatchedAt: string,
  ): Promise<boolean>;
  markDeliveryCancelled(
    dispatchKey: string,
    cancelledAt: string,
  ): Promise<boolean>;
  markDeliveryCancellationCompleted(
    dispatchKey: string,
    completedAt: string,
  ): Promise<boolean>;
  findDeliveryDispatch(
    requirementKey: string,
    requirementRevision: number,
  ): Promise<DeliveryDispatchRecord | null>;
  findDeliveryRunResult(
    requirementKey: string,
    requirementRevision: number,
  ): Promise<DeliveryRunResult | null>;
  saveDeliveryRunResult(result: DeliveryRunResult): void;
  markDeliveryRunCompleted(
    requirementKey: string,
    requirementRevision: number,
    proof: { assignmentKey: string; fencingToken: number },
    completedAt: string,
  ): Promise<boolean>;
  appendVerificationEvidence(record: VerificationEvidenceRecord): void;
  findVerificationFailure(
    requirementKey: string,
    requirementRevision: number,
  ): Promise<VerificationFailureRecord | null>;
  saveVerificationFailure(record: VerificationFailureRecord): void;
}

export interface RequirementRepository {
  transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T>;
  listForPeople(
    tenantKey: string,
    projectKey: string,
    options: RequirementListOptions,
  ): Promise<RequirementListPage>;
  listAuditEvents(
    tenantKey: string,
    projectKey: string,
  ): Promise<RequirementAuditEvent[]>;
  listPendingDeliveryDispatches(
    tenantKey: string,
    projectKey: string | null,
    limit: number,
  ): Promise<DeliveryDispatchRecord[]>;
  listPendingDeliveryCancellations(
    tenantKey: string,
    limit: number,
  ): Promise<DeliveryDispatchRecord[]>;
  listPendingDeliveryRunResults(
    tenantKey: string,
    limit: number,
  ): Promise<DeliveryRunResult[]>;
  findDeliveryRunResultByProof(
    tenantKey: string,
    proof: { assignmentKey: string; fencingToken: number },
  ): Promise<DeliveryRunResult | null>;
  listDeliveryRunsAwaitingVerification(
    tenantKey: string,
    projectKey: string,
    repositoryKey: string,
    limit: number,
  ): Promise<DeliveryRunResult[]>;
}
