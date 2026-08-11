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

export const WorkerEnrollmentExchangeSchema = z
  .object({
    schemaVersion: z.literal(1),
    enrollmentToken: z.string().min(32).max(256),
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
  .superRefine((exchange, context) => {
    if (new Set(exchange.capabilities).size !== exchange.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "设备能力不能重复",
      });
    }
  });

export const McpInvocationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestKey: internalKey,
    serverKey: internalKey,
    toolKey: internalKey,
    arguments: z.unknown(),
  })
  .strict();

const mcpFormFieldKey = z.string().regex(/^[a-f0-9]{64}$/u);
const mcpFormUuidPath =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const mcpFormOptionSchema = z
  .object({
    optionKey: mcpFormFieldKey,
    label: z.string().trim().min(1).max(100),
  })
  .strict();
const mcpFormConstraintsSchema = z
  .object({
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    exclusiveMinimum: z.number().finite().optional(),
    exclusiveMaximum: z.number().finite().optional(),
    multipleOf: z.number().finite().positive().optional(),
    minItems: z.number().int().min(0).optional(),
    maxItems: z.number().int().min(0).optional(),
    itemMinLength: z.number().int().min(0).optional(),
    itemMaxLength: z.number().int().min(0).optional(),
  })
  .strict();

export const McpInvocationPeopleRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestKey: internalKey,
    inputs: z.record(mcpFormFieldKey, z.unknown()),
  })
  .strict()
  .superRefine((request, context) => {
    if (Object.keys(request.inputs).length > 50) {
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "外部操作参数不能超过 50 项",
      });
    }
  });

export const McpInvocationFormFieldSchema = z
  .object({
    fieldKey: mcpFormFieldKey,
    label: z.string().trim().min(2).max(100),
    description: z.string().trim().min(2).max(500),
    kind: z.enum([
      "text",
      "integer",
      "number",
      "boolean",
      "select",
      "text_list",
    ]),
    required: z.boolean(),
    options: z.array(mcpFormOptionSchema).max(100),
    constraints: mcpFormConstraintsSchema.optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if ((field.kind === "select") !== field.options.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "选择字段必须提供可选值，其他字段不能夹带可选值",
      });
    }
  });

export const McpInvocationToolFormSchema = z
  .object({
    serviceName: z.string().trim().min(2).max(100),
    title: z.string().trim().min(2).max(100),
    description: z.string().trim().min(4).max(500),
    impact: z.enum(["仅读取信息", "会修改业务数据", "会触发外部动作"]),
    confirmation: z.enum(["自动确认", "需要产品负责人确认"]),
    fields: z.array(McpInvocationFormFieldSchema).max(50),
    links: z
      .object({
        request: z
          .string()
          .regex(
            new RegExp(
              `^/api/v1/extensions/mcp/${mcpFormUuidPath}/tools/${mcpFormUuidPath}/requests$`,
              "i",
            ),
          ),
      })
      .strict(),
  })
  .strict();

export const McpToolCatalogSchema = z
  .object({
    serviceName: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(4).max(500),
    tools: z
      .array(
        z
          .object({
            title: z.string().trim().min(2).max(100),
            description: z.string().trim().min(4).max(500),
            impact: z.enum(["仅读取信息", "会修改业务数据", "会触发外部动作"]),
            confirmation: z.enum(["自动确认", "需要产品负责人确认"]),
            links: z
              .object({
                form: z
                  .string()
                  .regex(
                    new RegExp(
                      `^/api/v1/extensions/mcp/${mcpFormUuidPath}/tools/${mcpFormUuidPath}/form$`,
                      "i",
                    ),
                  ),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
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
    skillKeys: z.array(internalKey).max(10).optional(),
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
    if (
      command.skillKeys &&
      new Set(command.skillKeys).size !== command.skillKeys.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["skillKeys"],
        message: "交付 Skill 不能重复",
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

const DeliverySkillResourceSchema = z
  .object({
    path: z
      .string()
      .min(3)
      .max(240)
      .regex(/^(?:references|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    mediaType: z.enum(["text/markdown", "text/plain", "application/json"]),
    content: z.string().max(40_000),
  })
  .strict();

export const RequirementExecutionEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskType: z.literal("requirement_delivery"),
    projectKey: internalKey,
    repositoryKey: internalKey,
    requirementKey: internalKey,
    requirementRevision: z.number().int().positive().max(10_000),
    spec: RequirementSpecSchema,
    skills: z
      .array(
        z
          .object({
            skillKey: internalKey,
            version: z
              .string()
              .trim()
              .min(1)
              .max(50)
              .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
            name: z.string().trim().min(2).max(100),
            artifactHashAlgorithm: z.literal("sha256"),
            artifactHash: z.string().regex(sha256Pattern),
            instructions: z.string().trim().min(20).max(40_000),
            resources: z.array(DeliverySkillResourceSchema).max(100),
          })
          .strict()
          .superRefine((skill, context) => {
            const paths = skill.resources.map((resource) =>
              resource.path.toLowerCase(),
            );
            if (new Set(paths).size !== paths.length) {
              context.addIssue({
                code: "custom",
                path: ["resources"],
                message: "交付 Skill 资源路径不能重复",
              });
            }
          }),
      )
      .max(10)
      .optional(),
    executionPolicy: z
      .object({
        workspaceIsolation: z.literal("dedicated_worktree"),
        productionAccess: z.literal("denied"),
        credentialHandling: z.literal("device_local_only"),
        completionEvidence: z.literal("independent_runner_required"),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    const skills = envelope.skills ?? [];
    if (new Set(skills.map((skill) => skill.skillKey)).size !== skills.length) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "交付执行信封不能重复绑定 Skill",
      });
    }
    if (
      skills.reduce(
        (total, skill) =>
          total +
          new TextEncoder().encode(skill.instructions).byteLength +
          skill.resources.reduce(
            (resourceTotal, resource) =>
              resourceTotal +
              new TextEncoder().encode(resource.content).byteLength,
            0,
          ),
        0,
      ) > 100_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "交付执行信封中的 Skill 内容总量不能超过 100 KB",
      });
    }
  });

export const WORKER_REQUIREMENT_COMPLETION_SUMMARY =
  "已生成本地提交，等待独立验证" as const;
export const WORKER_MCP_SUCCEEDED_SUMMARY = "本地工具操作已完成" as const;
export const WORKER_MCP_FAILED_SUMMARY = "本地工具操作未完成" as const;
export const WORKER_MCP_UNKNOWN_SUMMARY =
  "本地工具操作结果需要人工核对" as const;

export const WorkerRequirementCompletionSchema =
  WorkerLeaseCommandSchema.extend({
    projectKey: internalKey,
    repositoryKey: internalKey,
    requirementKey: internalKey,
    requirementRevision: z.number().int().positive().max(10_000),
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
  })
    .strict()
    .superRefine((result, context) => {
      const pattern =
        result.gitHashAlgorithm === "sha1" ? sha1Pattern : sha256Pattern;
      for (const field of ["baseCommit", "commitSha"] as const) {
        if (!pattern.test(result[field])) {
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
    });

export const WorkerMcpCompletionSchema = z.discriminatedUnion("outcome", [
  WorkerLeaseCommandSchema.extend({
    outcome: z.literal("succeeded"),
    summary: z.literal(WORKER_MCP_SUCCEEDED_SUMMARY),
  }).strict(),
  WorkerLeaseCommandSchema.extend({
    outcome: z.literal("failed"),
    summary: z.literal(WORKER_MCP_FAILED_SUMMARY),
  }).strict(),
  WorkerLeaseCommandSchema.extend({
    projectKey: internalKey,
    invocationKey: internalKey,
    outcome: z.literal("unknown"),
    summary: z.literal(WORKER_MCP_UNKNOWN_SUMMARY),
  }).strict(),
]);

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
  new RegExp(
    `^/api/v1/(?:extensions|knowledge-bases)/${extensionKeyPath}$`,
    "i",
  ),
);
const skillExtensionItemSchema = extensionItemSchema(
  new RegExp(`^/api/v1/extensions/skills/${extensionKeyPath}$`, "i"),
);
const mcpExtensionItemSchema = z
  .object({
    ...extensionItemFields,
    links: z
      .object({
        self: z
          .string()
          .regex(
            new RegExp(`^/api/v1/extensions/mcp/${extensionKeyPath}$`, "i"),
          ),
        tools: z
          .string()
          .regex(
            new RegExp(
              `^/api/v1/extensions/mcp/${extensionKeyPath}/tools$`,
              "i",
            ),
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.links.tools !== `${item.links.self}/tools`) {
      context.addIssue({
        code: "custom",
        path: ["links", "tools"],
        message: "MCP 工具入口与当前服务不匹配",
      });
    }
  });

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
    links: z
      .object({
        actions: z
          .object({
            createKnowledge: z.literal("/api/v1/knowledge-bases").optional(),
            publishSkill: z.literal("/api/v1/extensions/skills").optional(),
            publishMcp: z.literal("/api/v1/extensions/mcp").optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
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
export type WorkerEnrollmentExchangePayload = z.infer<
  typeof WorkerEnrollmentExchangeSchema
>;
export type McpInvocationRequestPayload = z.infer<
  typeof McpInvocationRequestSchema
>;
export type McpInvocationPeopleRequestPayload = z.infer<
  typeof McpInvocationPeopleRequestSchema
>;
export type McpInvocationFormField = z.infer<
  typeof McpInvocationFormFieldSchema
>;
export type McpInvocationToolForm = z.infer<typeof McpInvocationToolFormSchema>;
export type McpToolCatalog = z.infer<typeof McpToolCatalogSchema>;
export type StartDeliveryCommandPayload = z.infer<
  typeof StartDeliveryCommandSchema
>;
export type WorkerLeaseCommandPayload = z.infer<
  typeof WorkerLeaseCommandSchema
>;
export type RequirementExecutionEnvelope = z.infer<
  typeof RequirementExecutionEnvelopeSchema
>;
export type WorkerRequirementCompletionPayload = z.infer<
  typeof WorkerRequirementCompletionSchema
>;
export type WorkerMcpCompletionPayload = z.infer<
  typeof WorkerMcpCompletionSchema
>;
export type ExtensionItemForPeople = z.infer<
  typeof ExtensionItemForPeopleSchema
>;
export type ExtensionCatalogOverviewForPeople = z.infer<
  typeof ExtensionCatalogOverviewForPeopleSchema
>;
