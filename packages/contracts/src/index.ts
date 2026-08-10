import { z } from "zod";

const internalCodePattern = /^(?:REQ|BUG|TASK|FEAT|STORY)[-_]?\d+$/i;

export const REQUIREMENT_REQUEST_BODY_LIMIT_BYTES = 1_048_576;

const readableText = (
  fieldName: string,
  minimumLength = 2,
  maximumLength = 2_000,
) =>
  z
    .string()
    .trim()
    .min(minimumLength, `${fieldName}需要使用可理解的业务语言`)
    .max(maximumLength, `${fieldName}内容过长`);

export const UserStorySchema = z
  .object({
    role: readableText("使用角色", 2, 100),
    need: readableText("用户需要", 2, 400),
    value: readableText("业务价值", 2, 400),
  })
  .strict();

export const AcceptanceCriterionSchema = z
  .object({
    title: readableText("验收条件标题", 2, 150),
    description: readableText("验收条件说明", 4, 800),
    priority: z.enum(["must", "should", "could"]),
  })
  .strict();

export const RequirementSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: readableText("需求标题", 2, 150).refine(
      (title) => !internalCodePattern.test(title),
      "需求标题不能只有内部编码",
    ),
    goal: readableText("需求目标", 4, 1_500),
    userStories: z.array(UserStorySchema).max(30),
    acceptanceCriteria: z
      .array(AcceptanceCriterionSchema)
      .min(1, "至少需要一个可验证的验收条件")
      .max(80, "验收条件数量不能超过 80 条"),
    openQuestions: z.array(readableText("待澄清问题", 2, 400)).max(30),
  })
  .strict();

const sha256Pattern = /^[a-f0-9]{64}$/;
const sha1Pattern = /^[a-f0-9]{40}$/;
const ed25519SignaturePattern = /^[A-Za-z0-9+/]{85}[AQgw]==$/;
const workerSessionKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const capabilityPattern = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const EvidenceCheckSchema = z
  .object({
    criterionKey: z.string().uuid(),
    status: z.enum(["passed", "failed"]),
    testRunKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const DeliveryReferenceSchema = z
  .object({
    tenantKey: internalKey,
    projectKey: internalKey,
    repositoryKey: internalKey,
    gitHashAlgorithm: z.enum(["sha1", "sha256"]),
    commitSha: z.string(),
    artifactHashAlgorithm: z.literal("sha256"),
    artifactHash: z.string().regex(sha256Pattern),
  })
  .strict()
  .superRefine((reference, context) => {
    const pattern =
      reference.gitHashAlgorithm === "sha1" ? sha1Pattern : sha256Pattern;
    if (!pattern.test(reference.commitSha)) {
      context.addIssue({
        code: "custom",
        path: ["commitSha"],
        message: `commitSha 必须是完整的 ${reference.gitHashAlgorithm} 摘要`,
      });
    }
  });

export const EvidencePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceKey: internalKey,
    tenantKey: internalKey,
    projectKey: internalKey,
    repositoryKey: internalKey,
    requirementKey: internalKey,
    requirementRevision: z.number().int().positive(),
    gitHashAlgorithm: z.enum(["sha1", "sha256"]),
    commitSha: z.string(),
    runnerKey: internalKey,
    keyId: internalKey,
    producedAt: z.iso.datetime(),
    artifactHashAlgorithm: z.literal("sha256"),
    artifactHash: z.string().regex(sha256Pattern),
    checks: z.array(EvidenceCheckSchema).min(1).max(500),
  })
  .strict()
  .superRefine((payload, context) => {
    const pattern =
      payload.gitHashAlgorithm === "sha1" ? sha1Pattern : sha256Pattern;
    if (!pattern.test(payload.commitSha)) {
      context.addIssue({
        code: "custom",
        path: ["commitSha"],
        message: `commitSha 必须是完整的 ${payload.gitHashAlgorithm} 摘要`,
      });
    }
    const criterionKeys = new Set<string>();
    payload.checks.forEach((check, index) => {
      if (criterionKeys.has(check.criterionKey)) {
        context.addIssue({
          code: "custom",
          path: ["checks", index, "criterionKey"],
          message: "同一验收条件不能重复提交验证结果",
        });
      }
      criterionKeys.add(check.criterionKey);
    });
  });

export const SignedEvidenceSchema = z
  .object({
    payload: EvidencePayloadSchema,
    signature: z.string().regex(ed25519SignaturePattern),
  })
  .strict();

export const WorkerRegistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    deviceName: z.string().trim().min(2).max(100),
    accountName: z.string().trim().min(2).max(100),
    accountFingerprint: z.string().regex(sha256Pattern),
    capabilities: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(capabilityPattern, "设备能力格式不正确"),
      )
      .max(50),
  })
  .strict()
  .superRefine((registration, context) => {
    if (
      new Set(registration.capabilities).size !==
      registration.capabilities.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "设备能力不能重复",
      });
    }
  });

export const WorkerConnectionCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantKey: internalKey,
    workerKey: internalKey,
    sessionKey: z.string().regex(workerSessionKeyPattern),
    generation: z.number().int().positive(),
  })
  .strict();

export const StartDeliveryCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requiredCapabilities: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(capabilityPattern, "交付能力格式不正确"),
      )
      .max(50),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      new Set(command.requiredCapabilities).size !==
      command.requiredCapabilities.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredCapabilities"],
        message: "交付能力不能重复",
      });
    }
  });

export const WorkerLeaseCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentKey: internalKey,
    fencingToken: z.number().int().positive(),
  })
  .strict();

const extensionKeyPath =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const extensionItemFields = {
  name: z.string().trim().min(2).max(100),
  summary: z.string().trim().min(4).max(500),
  status: z.enum(["可使用", "正在更新", "需要处理", "暂不可用"]),
  detail: z.string().trim().min(2).max(200),
  supportingText: z.string().trim().min(2).max(200),
};
const extensionItemSchema = (path: RegExp) =>
  z
    .object({
      ...extensionItemFields,
      links: z.object({ self: z.string().regex(path) }).strict(),
    })
    .strict();
const knowledgeExtensionItemSchema = extensionItemSchema(
  new RegExp(`^/api/v1/extensions/${extensionKeyPath}$`, "i"),
);
const skillExtensionItemSchema = extensionItemSchema(
  new RegExp(`^/api/v1/extensions/skills/${extensionKeyPath}$`, "i"),
);
const mcpExtensionItemSchema = extensionItemSchema(
  new RegExp(`^/api/v1/extensions/mcp/${extensionKeyPath}$`, "i"),
);

export const ExtensionItemForPeopleSchema = z.union([
  knowledgeExtensionItemSchema,
  skillExtensionItemSchema,
  mcpExtensionItemSchema,
]);

export const ExtensionCatalogOverviewForPeopleSchema = z
  .object({
    businessKnowledge: z.array(knowledgeExtensionItemSchema).max(100),
    teamCapabilities: z.array(skillExtensionItemSchema).max(100),
    externalTools: z.array(mcpExtensionItemSchema).max(100),
  })
  .strict();

export const ExtensionCatalogResponseSchema = z
  .object({ data: ExtensionCatalogOverviewForPeopleSchema })
  .strict();

export type RequirementSpec = z.infer<typeof RequirementSpecSchema>;
export type UserStory = z.infer<typeof UserStorySchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type EvidenceCheck = z.infer<typeof EvidenceCheckSchema>;
export type DeliveryReference = z.infer<typeof DeliveryReferenceSchema>;
export type EvidencePayload = z.infer<typeof EvidencePayloadSchema>;
export type SignedEvidence = z.infer<typeof SignedEvidenceSchema>;
export type WorkerRegistrationPayload = z.infer<
  typeof WorkerRegistrationSchema
>;
export type WorkerConnectionCredentialPayload = z.infer<
  typeof WorkerConnectionCredentialSchema
>;
export type StartDeliveryCommandPayload = z.infer<
  typeof StartDeliveryCommandSchema
>;
export type WorkerLeaseCommandPayload = z.infer<
  typeof WorkerLeaseCommandSchema
>;
export type ExtensionItemForPeople = z.infer<
  typeof ExtensionItemForPeopleSchema
>;
export type ExtensionCatalogOverviewForPeople = z.infer<
  typeof ExtensionCatalogOverviewForPeopleSchema
>;
