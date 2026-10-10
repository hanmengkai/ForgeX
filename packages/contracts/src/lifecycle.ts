import { z } from "zod";

import { RequirementSpecSchema } from "./index.js";

const key = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(2).max(10_000);
const actorName = z.string().trim().min(1).max(100);
const summary = z.string().trim().min(2).max(500);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const LifecycleCapabilitySchema = z.enum([
  "requirements_ai",
  "design_ai",
  "development",
  "testing",
  "staging_deploy",
  "production_deploy",
  "production_rollback",
]);
export type LifecycleCapability = z.infer<typeof LifecycleCapabilitySchema>;
export const LifecycleStageSchema = z.enum([
  ...LifecycleCapabilitySchema.options,
  "requirements_review",
  "requester_confirmation",
  "design_review",
  "code_review",
  "test_review",
  "staging_acceptance",
  "release_approval",
  "online_acceptance",
  "recovery_approval",
  "closed",
]);
export type LifecycleStage = z.infer<typeof LifecycleStageSchema>;
export const LifecycleRoleSchema = z.enum([
  "requester",
  "product_owner",
  "requirement_analyst",
  "developer",
  "tester",
  "test_ops",
  "production_ops",
  "administrator",
]);
export type LifecycleRole = z.infer<typeof LifecycleRoleSchema>;
export const lifecycleStageLabels: Record<LifecycleStage, string> = {
  requirements_ai: "AI 整理需求",
  requirements_review: "产品审核需求",
  requester_confirmation: "需求方确认",
  design_ai: "AI 设计方案",
  design_review: "独立设计审核",
  development: "AI 开发与自测",
  code_review: "研发代码审核",
  testing: "独立测试",
  test_review: "测试报告审核",
  staging_deploy: "部署测试环境",
  staging_acceptance: "需求方测试环境验收",
  release_approval: "三方生产放行",
  production_deploy: "发布生产环境",
  online_acceptance: "三方线上验收",
  recovery_approval: "三方恢复审批",
  production_rollback: "恢复生产环境",
  closed: "已关闭",
};
export const LifecycleRequirementsOutputSchema = z
  .object({
    kind: z.literal("requirements"),
    summary,
    spec: RequirementSpecSchema,
  })
  .strict();
export const LifecycleDesignOutputSchema = z
  .object({
    kind: z.literal("design"),
    summary,
    architecture: text,
    interfaces: z.array(text).min(1).max(100),
    migrations: z.array(text).max(100),
    testStrategy: z.array(text).min(1).max(100),
    rolloutPlan: text,
  })
  .strict();
export const LifecycleCodeOutputSchema = z
  .object({
    kind: z.literal("code"),
    summary,
    commitSha: commit,
    artifactDigest: digest,
    selfTests: z
      .array(z.object({ name: summary, passed: z.boolean() }).strict())
      .min(1)
      .max(200),
  })
  .strict();
export const LifecycleTestsOutputSchema = z
  .object({
    kind: z.literal("tests"),
    summary,
    commitSha: commit,
    artifactDigest: digest,
    checks: z
      .array(
        z
          .object({
            criterionIndex: z.number().int().min(0).max(79),
            name: summary,
            passed: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    planDigest: digest,
  })
  .strict();
const deploymentUrl = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, "验收地址必须是不含凭据的 HTTP(S) 地址");
export const LifecycleDeploymentOutputSchema = z
  .object({
    kind: z.literal("deployment"),
    summary,
    environment: z.enum(["staging", "production"]),
    commitSha: commit,
    artifactDigest: digest,
    url: deploymentUrl,
    healthy: z.boolean(),
    deploymentKey: key,
  })
  .strict();
export const LifecycleRollbackOutputSchema = z
  .object({
    kind: z.literal("rollback"),
    summary,
    productionJobKey: key,
    healthy: z.boolean(),
  })
  .strict();
export const LifecycleOutputSchema = z.discriminatedUnion("kind", [
  LifecycleRequirementsOutputSchema,
  LifecycleDesignOutputSchema,
  LifecycleCodeOutputSchema,
  LifecycleTestsOutputSchema,
  LifecycleDeploymentOutputSchema,
  LifecycleRollbackOutputSchema,
]);
export type LifecycleOutput = z.infer<typeof LifecycleOutputSchema>;
export const LifecycleTaskResultSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("succeeded"), output: LifecycleOutputSchema })
    .strict(),
  z.object({ status: z.enum(["failed", "blocked"]), reason: summary }).strict(),
]);
export type LifecycleTaskResult = z.infer<typeof LifecycleTaskResultSchema>;
const actorSchema = z
  .object({
    actorKey: key,
    actorName: z.string().trim().min(1).max(100),
    roles: z.array(LifecycleRoleSchema).min(1).max(8),
  })
  .strict();
export type LifecycleActor = z.infer<typeof actorSchema>;
export const LifecycleApprovalSchema = z
  .object({
    actorKey: key,
    actorName,
    role: LifecycleRoleSchema,
    stage: LifecycleStageSchema,
    round: z.number().int().positive(),
    subjectDigest: digest,
    reason: summary,
    at: z.iso.datetime(),
  })
  .strict();
export const LifecycleArtifactSchema = z
  .object({
    artifactKey: key,
    jobKey: key,
    executorKey: key,
    createdAt: z.iso.datetime(),
    contentDigest: digest,
    output: LifecycleOutputSchema,
  })
  .strict();
export type LifecycleArtifact = z.infer<typeof LifecycleArtifactSchema>;
export const LifecycleTaskInputSchema = z
  .object({
    schemaVersion: z.literal(2),
    workflowKey: key,
    tenantKey: key,
    projectKey: key,
    repositoryKey: key,
    stage: LifecycleCapabilitySchema,
    title: summary,
    brief: text,
    requirementVersion: z.number().int().positive(),
    designVersion: z.number().int().positive(),
    round: z.number().int().positive(),
    artifacts: z.array(LifecycleArtifactSchema).max(7),
    feedback: z.array(summary).max(20),
    releaseApprovals: z.array(LifecycleApprovalSchema).max(3),
    productionJobKey: key.nullable(),
  })
  .strict();
export type LifecycleTaskInput = z.infer<typeof LifecycleTaskInputSchema>;
export const LifecycleJobSchema = z
  .object({
    jobKey: key,
    stage: LifecycleCapabilitySchema,
    round: z.number().int().positive(),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "blocked",
      "cancelled",
    ]),
    input: LifecycleTaskInputSchema,
    inputDigest: digest,
    executorKey: key.nullable(),
    fencingToken: key.nullable(),
    leaseUntil: z.iso.datetime().nullable(),
    resultDigest: digest.nullable(),
    result: LifecycleTaskResultSchema.nullable(),
  })
  .strict();
export type LifecycleJob = z.infer<typeof LifecycleJobSchema>;
export const LifecycleSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    workflowKey: key,
    tenantKey: key,
    projectKey: key,
    repositoryKey: key,
    requesterKey: key,
    createdBy: key,
    title: summary,
    brief: text,
    version: z.number().int().positive(),
    requirementVersion: z.number().int().positive(),
    designVersion: z.number().int().positive(),
    round: z.number().int().positive(),
    stage: LifecycleStageSchema,
    blockedReason: summary.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    current: z
      .object({
        requirements: key.optional(),
        design: key.optional(),
        code: key.optional(),
        tests: key.optional(),
        staging: key.optional(),
        production: key.optional(),
        rollback: key.optional(),
      })
      .strict(),
    artifacts: z.array(LifecycleArtifactSchema).max(250),
    jobs: z.array(LifecycleJobSchema).max(250),
    approvals: z.array(LifecycleApprovalSchema).max(1_000),
    objections: z
      .array(
        z
          .object({
            objectionKey: key,
            stage: LifecycleStageSchema,
            round: z.number().int().positive(),
            actorKey: key,
            actorName,
            reason: summary,
            resolution: summary.nullable(),
            resolvedBy: key.nullable(),
          })
          .strict(),
      )
      .max(1_000),
    events: z
      .array(
        z
          .object({
            eventKey: key,
            title: summary,
            detail: summary,
            at: z.iso.datetime(),
            roles: z.array(LifecycleRoleSchema).max(8),
          })
          .strict(),
      )
      .max(2_000),
    commands: z
      .array(z.object({ requestKey: key, digest }).strict())
      .max(2_000),
    sourceBugKey: key.nullable(),
  })
  .strict();
export type LifecycleSnapshot = z.infer<typeof LifecycleSnapshotSchema>;
export const LifecycleCreateCommandSchema = z
  .object({
    schemaVersion: z.literal(2),
    requestKey: key,
    projectKey: key,
    repositoryKey: key,
    requesterKey: key,
    title: summary,
    brief: text,
  })
  .strict();
export const LifecycleDecisionCommandSchema = z
  .object({
    schemaVersion: z.literal(2),
    requestKey: key,
    expectedVersion: z.number().int().positive(),
    role: LifecycleRoleSchema,
    decision: z.enum(["approve", "reject", "object"]),
    reason: summary,
    rework: z
      .enum([
        "requirements",
        "design",
        "implementation",
        "verification",
        "deployment",
      ])
      .optional(),
  })
  .strict();
export const LifecycleActionCommandSchema = z
  .object({
    schemaVersion: z.literal(2),
    requestKey: key,
    expectedVersion: z.number().int().positive(),
    action: z.enum(["retry", "resolve_objection", "request_recovery"]),
    reason: summary,
    objectionKey: key.optional(),
  })
  .strict();
export const LifecycleExecutorPrincipalSchema = z
  .object({
    executorKey: key,
    tenantKey: key,
    projectKey: key,
    repositoryKey: key,
    capabilities: z.array(LifecycleCapabilitySchema).min(1).max(7),
    publicKeyBase64: z.string().min(40).max(2_000),
  })
  .strict();
export type LifecycleExecutorPrincipal = z.infer<
  typeof LifecycleExecutorPrincipalSchema
>;
export const LifecycleCompletionPayloadSchema = z
  .object({
    schemaVersion: z.literal(2),
    jobKey: key,
    fencingToken: key,
    inputDigest: digest,
    result: LifecycleTaskResultSchema,
  })
  .strict();
export type LifecycleCompletionPayload = z.infer<
  typeof LifecycleCompletionPayloadSchema
>;
export const LifecycleSignedCompletionSchema = z
  .object({
    payload: LifecycleCompletionPayloadSchema,
    signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
  })
  .strict();
export const LifecycleBugSchema = z
  .object({
    schemaVersion: z.literal(2),
    bugKey: key,
    tenantKey: key,
    projectKey: key,
    workflowKey: key,
    reportedBy: key,
    title: summary,
    description: text,
    severity: z.enum(["critical", "major", "minor"]),
    status: z.enum(["open", "repairing", "resolved"]),
    repairWorkflowKey: key.nullable(),
    createdAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type LifecycleBug = z.infer<typeof LifecycleBugSchema>;
export const LifecycleViewSchema = z
  .object({
    schemaVersion: z.literal(2),
    workflowKey: key,
    projectKey: key,
    repositoryKey: key,
    requesterKey: key,
    title: summary,
    brief: text,
    version: z.number().int().positive(),
    requirementVersion: z.number().int().positive(),
    designVersion: z.number().int().positive(),
    stage: LifecycleStageSchema,
    stageLabel: summary,
    blockedReason: summary.nullable(),
    updatedAt: z.iso.datetime(),
    sourceBugKey: key.nullable(),
    approvals: z
      .array(
        z
          .object({
            actorName,
            role: LifecycleRoleSchema,
            reason: summary,
            at: z.iso.datetime(),
          })
          .strict(),
      )
      .max(3),
    objections: LifecycleSnapshotSchema.shape.objections,
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum([
              "requirements",
              "design",
              "code",
              "tests",
              "deployment",
              "rollback",
            ]),
            summary,
            content: z.string().max(100_000).nullable(),
            url: deploymentUrl.nullable(),
            checks: z
              .array(z.object({ title: summary, passed: z.boolean() }).strict())
              .max(200),
            technical: z.record(z.string(), z.string().max(500)).nullable(),
          })
          .strict(),
      )
      .max(7),
    events: z
      .array(
        z
          .object({ title: summary, detail: summary, at: z.iso.datetime() })
          .strict(),
      )
      .max(100),
    currentJob: z
      .object({
        status: z.enum([
          "queued",
          "running",
          "succeeded",
          "failed",
          "blocked",
          "cancelled",
        ]),
        stageLabel: summary,
        attempt: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    allowedRoles: z.array(LifecycleRoleSchema).max(3),
    allowedActions: z
      .array(z.enum(["retry", "resolve_objection", "request_recovery"]))
      .max(3),
    canReportBug: z.boolean(),
  })
  .strict();
export type LifecycleView = z.infer<typeof LifecycleViewSchema>;
export const LifecycleContextSchema = z
  .object({
    schemaVersion: z.literal(2),
    projectKey: key,
    repositoryKey: key,
    actorKey: key,
    actorName,
    roles: z.array(LifecycleRoleSchema).min(1).max(8),
  })
  .strict();
export type LifecycleContext = z.infer<typeof LifecycleContextSchema>;
export const LifecycleNotificationSchema = z
  .object({
    notificationKey: key,
    workflowKey: key,
    title: summary,
    detail: summary,
    at: z.iso.datetime(),
    read: z.boolean(),
  })
  .strict();
export type LifecycleNotification = z.infer<typeof LifecycleNotificationSchema>;
export const LifecycleBugCreateCommandSchema = z
  .object({
    schemaVersion: z.literal(2),
    requestKey: key,
    title: summary,
    description: text,
    severity: z.enum(["critical", "major", "minor"]),
  })
  .strict();
export const LifecycleBugRepairCommandSchema = z
  .object({
    schemaVersion: z.literal(2),
    requestKey: key,
    action: z.enum(["start_repair", "resolve"]),
  })
  .strict();

export const canonicalLifecycleJson = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map(canonicalLifecycleJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalLifecycleJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
