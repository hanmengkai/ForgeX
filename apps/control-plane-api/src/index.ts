import { createHash } from "node:crypto";

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z } from "zod";

import {
  ApplicationError,
  DeliveryCoordinatorService,
  ExtensionCatalogApplicationService,
  InMemoryPlatformConfigurationRepository,
  KnowledgeBaseApplicationService,
  KnowledgeBaseCreateCommandSchema,
  KnowledgeSearchCommandSchema,
  KnowledgeSourcePublishCommandSchema,
  McpInvocationApplicationService,
  McpRegistryApplicationService,
  PlatformConfigurationService,
  RequirementApplicationService,
  AuthenticatedRunnerSchema,
  RunnerVerificationFailureCommandSchema,
  VerificationCoordinatorService,
  SkillRegistryApplicationService,
  WorkerFleetService,
  canonicalizeMcpInputSchema,
  assertMcpManifestContainsNoCredential,
  canConnectWorker,
  canPerformRequirementAction,
  requirementCompletionDigest,
  type AuthenticatedPrincipal,
  type AuthenticatedRunner,
  type AccountAdministrationService,
  type ExtensionCatalogRepository,
  type McpRegistryRepository,
  type KnowledgeBaseRepository,
  type McpInputSchemaStore,
  type McpInvocationRepository,
  type PlatformRole,
  type PlatformConfigurationRepository,
  type PreviewArtifactStore,
  type RequirementRepository,
  type RunnerSessionAuthenticator,
  type SessionAuthenticator,
  type SkillArtifactStore,
  type SkillRegistryRepository,
  type WorkerFleetRepository,
} from "@forgex/application";
import {
  REQUIREMENT_REQUEST_BODY_LIMIT_BYTES,
  McpInvocationPeopleRequestSchema,
  McpInvocationRequestSchema,
  McpInvocationToolFormSchema,
  McpToolCatalogSchema,
  RequirementSpecSchema,
  StartDeliveryCommandSchema,
  WorkerConnectionCredentialSchema,
  WorkerEnrollmentExchangeSchema,
  WorkerLeaseCommandSchema,
  WorkerMcpCompletionSchema,
  WorkerRequirementCompletionSchema,
  SignedEvidenceSchema,
  type WorkerConnectionCredentialPayload,
  type McpInvocationPeopleRequestPayload,
  type McpInvocationRequestPayload,
} from "@forgex/contracts";
import type {
  EvidenceAuthority,
  RequirementAllowedAction,
} from "@forgex/domain";
import {
  McpServerManifestSchema,
  SignedMcpHealthAttestationSchema,
  SignedSkillEvaluationSchema,
  SkillPackageCodec,
  SkillPackageManifestSchema,
  type McpHealthAuthority,
  type SkillEvaluationAuthority,
} from "@forgex/extensions";

import {
  InMemoryBrowserSessionManager,
  type BrowserSessionManager,
} from "./browser-session.js";
import {
  InMemoryWorkerEnrollmentManager,
  type WorkerEnrollmentManager,
} from "./worker-enrollment.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
    workerConnection: WorkerConnectionCredentialPayload | null;
    runnerConnection: AuthenticatedRunner | null;
  }
}

export interface ControlPlaneApiOptions {
  accountService?: AccountAdministrationService;
  authenticator: SessionAuthenticator;
  runnerAuthenticator: RunnerSessionAuthenticator;
  evidenceAuthority: EvidenceAuthority;
  extensionCatalogRepository: ExtensionCatalogRepository;
  knowledgeBaseRepository: KnowledgeBaseRepository;
  mcpHealthAuthority: McpHealthAuthority;
  mcpInputSchemaStore: McpInputSchemaStore;
  mcpInvocationRepository: McpInvocationRepository;
  mcpRegistryRepository: McpRegistryRepository;
  skillArtifactStore: SkillArtifactStore;
  skillEvaluationAuthority: SkillEvaluationAuthority;
  skillRegistryRepository: SkillRegistryRepository;
  requirementRepository: RequirementRepository;
  previewArtifactStore: PreviewArtifactStore;
  workerFleetRepository: WorkerFleetRepository;
  platformConfigurationRepository?: PlatformConfigurationRepository;
  projectKey: string;
  repositoryKey: string;
  readiness?: () => Promise<void>;
  serviceVersion?: string;
  sessionCookieSecure?: boolean;
  sessionCookieMaxAgeSeconds?: number;
  browserSessionManager?: BrowserSessionManager;
  workerEnrollmentManager?: WorkerEnrollmentManager;
  clock?: () => Date;
  logger?: FastifyServerOptions["logger"];
}

const requirementParamsSchema = z
  .object({
    requirementKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const requirementRevisionCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.number().int().min(1).max(100),
    spec: RequirementSpecSchema,
  })
  .strict();
const extensionParamsSchema = z
  .object({
    extensionKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const knowledgeParamsSchema = z
  .object({
    knowledgeKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const knowledgeSourceParamsSchema = knowledgeParamsSchema
  .extend({
    sourceKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const knowledgeArchiveCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const skillExtensionParamsSchema = z
  .object({
    skillKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const skillVersionParamsSchema = skillExtensionParamsSchema
  .extend({
    version: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  })
  .strict();
const mcpInvocationParamsSchema = z
  .object({
    invocationKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const mcpExtensionParamsSchema = z
  .object({
    serverKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const mcpRevisionParamsSchema = mcpExtensionParamsSchema
  .extend({ revision: z.coerce.number().int().positive() })
  .strict();
const mcpToolParamsSchema = mcpExtensionParamsSchema
  .extend({
    toolKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const MAX_SKILL_PACKAGE_BYTES = 20 * 1024 * 1024;
const SKILL_PACKAGE_BODY_LIMIT_BYTES = 29 * 1024 * 1024;
const MCP_MANIFEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const extensionCanonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const skillPublishCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifest: SkillPackageManifestSchema,
    artifactContentBase64: z
      .string()
      .min(1)
      .max(Math.ceil(MAX_SKILL_PACKAGE_BYTES / 3) * 4)
      .regex(extensionCanonicalBase64Pattern),
  })
  .strict();
const skillEvaluationCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluation: SignedSkillEvaluationSchema,
  })
  .strict();
const mcpPublishCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifest: McpServerManifestSchema,
    inputSchemas: z
      .array(
        z
          .object({
            toolKey: z
              .string()
              .uuid()
              .transform((value) => value.toLowerCase()),
            schema: z.unknown(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      new Set(command.inputSchemas.map((item) => item.toolKey)).size !==
      command.inputSchemas.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["inputSchemas"],
        message: "MCP 工具 Schema 不能重复",
      });
    }
  });
const mcpHealthCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    health: SignedMcpHealthAttestationSchema,
  })
  .strict();
const revisionActionCommandSchema = z
  .object({ schemaVersion: z.literal(1) })
  .strict();
const mcpRecoveryCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    attestationKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const emptyCommandSchema = z.object({}).strict();
const requirementListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const runnerVerificationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const requireExtensionAdministrator = (
  principal: AuthenticatedPrincipal,
): void => {
  if (!principal.roles.includes("administrator")) {
    throw new ApplicationError(
      403,
      "extension_admin_required",
      "只有平台管理员可以管理团队能力或外部工具",
    );
  }
};
const PREVIEW_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const PREVIEW_ARTIFACT_BODY_LIMIT_BYTES = 7 * 1024 * 1024;
const MAX_PREVIEW_BASE64_LENGTH = Math.ceil(PREVIEW_MAX_ARTIFACT_BYTES / 3) * 4;
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const runnerPreviewArtifactBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementRevision: z.number().int().positive().max(10_000),
    artifactHashAlgorithm: z.literal("sha256"),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
    contentBase64: z
      .string()
      .min(1)
      .max(MAX_PREVIEW_BASE64_LENGTH)
      .regex(canonicalBase64Pattern),
  })
  .strict();

const platformRoleSchema = z.enum([
  "product_owner",
  "requirement_analyst",
  "developer",
  "administrator",
]);
const authenticatedPrincipalSchema = z
  .object({
    actorKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    actorName: z.string().trim().min(2).max(100),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u)
      .optional(),
    tenantKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    roles: z.array(platformRoleSchema).min(1).max(4),
  })
  .strict()
  .transform((principal) => ({
    ...principal,
    roles: [...new Set(principal.roles)] as PlatformRole[],
  }));

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const passwordSchema = z.string().min(12).max(128);
const credentialsSchema = z
  .object({
    schemaVersion: z.literal(1),
    username: usernameSchema,
    password: passwordSchema,
  })
  .strict();
const accountCreateSchema = z
  .object({
    schemaVersion: z.literal(1),
    username: usernameSchema,
    actorName: z.string().trim().min(2).max(100),
    roles: z.array(platformRoleSchema).min(1).max(4),
    password: passwordSchema,
  })
  .strict();
const accountUpdateSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.number().int().positive(),
    actorName: z.string().trim().min(2).max(100),
    roles: z.array(platformRoleSchema).min(1).max(4),
    enabled: z.boolean(),
    password: passwordSchema.optional(),
  })
  .strict();
const accountDeleteSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const accountParamsSchema = z
  .object({
    accountKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const platformCustomerParamsSchema = z
  .object({
    customerKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const platformProjectParamsSchema = z
  .object({
    projectKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const platformRepositoryParamsSchema = z
  .object({
    repositoryKey: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const platformResourceNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
    "名称不能包含控制字符",
  );
const platformGitUrlSchema = z
  .string()
  .trim()
  .min(4)
  .max(1_000)
  .refine((value) => {
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(value)) return true;
    try {
      const url = new URL(value);
      return (
        ["https:", "ssh:", "git:"].includes(url.protocol) &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "Git 地址必须使用 HTTPS、SSH 或 Git 协议，且不能包含密码、查询参数或片段");
const platformLocalPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(value) &&
      !/[\u0000\r\n]/u.test(value),
    "本地路径必须是 Windows、UNC 或 Linux 绝对路径",
  );
const platformDefaultBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine(
    (value) => !value.includes("..") && !value.includes("@{"),
    "默认分支格式不正确",
  );
const platformResourceCreateSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: platformResourceNameSchema,
    summary: z.string().trim().min(4).max(500),
  })
  .strict();
const platformResourceUpdateSchema = platformResourceCreateSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();
const platformRepositoryCreateSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: platformResourceNameSchema,
    gitUrl: platformGitUrlSchema,
    localPath: platformLocalPathSchema,
    defaultBranch: platformDefaultBranchSchema,
  })
  .strict();
const platformRepositoryUpdateSchema = platformRepositoryCreateSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();
const platformConfigurationDeleteSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

const SESSION_COOKIE_NAME = "forgex_session";
const sessionCookieValuePattern = /^[A-Za-z0-9._~-]{1,4096}$/;

const readSessionCookie = (cookieHeader: string | undefined): string | null => {
  if (!cookieHeader) return null;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const encodedValue = matches[0]!.slice(SESSION_COOKIE_NAME.length + 1);
  try {
    const value = decodeURIComponent(encodedValue);
    return sessionCookieValuePattern.test(value) ? value : null;
  } catch {
    return null;
  }
};

const requestSessionCredential = (request: FastifyRequest) => {
  if (request.headers.authorization) {
    return {
      authorization: request.headers.authorization,
      cookieAuthenticated: false,
    };
  }
  const cookieSession = readSessionCookie(request.headers.cookie);
  return {
    authorization: cookieSession ? `Bearer ${cookieSession}` : undefined,
    cookieAuthenticated: cookieSession !== null,
  };
};

type ValidationIssue = z.ZodError["issues"][number];

const validationMessage = (issue: ValidationIssue): string => {
  if (issue.code === "custom") {
    return issue.message;
  }
  switch (issue.code) {
    case "invalid_type":
    case "invalid_format":
    case "invalid_value":
      return "填写格式不正确";
    case "too_small":
      return "填写内容不完整";
    case "too_big":
      return "填写内容过多";
    case "unrecognized_keys":
      return "不支持这个字段";
    default:
      return "填写内容不符合要求";
  }
};

const validationDetails = (error: z.ZodError) =>
  error.issues.flatMap((issue) => {
    const fields =
      issue.code === "unrecognized_keys"
        ? issue.keys
        : [issue.path.join(".") || "请求内容"];
    return fields.map((field) => ({
      field,
      message: validationMessage(issue),
      code: issue.code,
    }));
  });

const requirementLinks = (
  requirementKey: string,
  allowedActions: RequirementAllowedAction[],
  principal: AuthenticatedPrincipal,
  previewAvailable = false,
) => {
  const self = `/api/v1/requirements/${requirementKey}`;
  const actions: {
    revise?: string;
    submitConfirmation?: string;
    confirm?: string;
    startDelivery?: string;
    accept?: string;
  } = {};
  if (
    allowedActions.includes("revise") &&
    canPerformRequirementAction(principal, "revise")
  ) {
    actions.revise = `${self}/revisions`;
  }
  if (
    allowedActions.includes("submitForConfirmation") &&
    canPerformRequirementAction(principal, "submitForConfirmation")
  ) {
    actions.submitConfirmation = `${self}/submit-confirmation`;
  }
  if (
    allowedActions.includes("confirm") &&
    canPerformRequirementAction(principal, "confirm")
  ) {
    actions.confirm = `${self}/confirm`;
  }
  if (
    allowedActions.includes("startDelivery") &&
    canPerformRequirementAction(principal, "startDelivery")
  ) {
    actions.startDelivery = `${self}/start-delivery`;
  }
  if (
    allowedActions.includes("accept") &&
    canPerformRequirementAction(principal, "accept")
  ) {
    actions.accept = `${self}/accept`;
  }
  return {
    self,
    history: `${self}/revisions`,
    ...(previewAvailable ? { preview: `${self}/preview` } : {}),
    actions,
  };
};

const mcpInvocationLinks = (
  invocationKey: string,
  allowedActions: ReadonlyArray<"approve" | "cancel">,
) => {
  const self = `/api/v1/mcp-invocations/${invocationKey}`;
  return {
    self,
    actions: {
      ...(allowedActions.includes("approve")
        ? { approve: `${self}/approve` }
        : {}),
      ...(allowedActions.includes("cancel")
        ? { cancel: `${self}/cancel` }
        : {}),
    },
  };
};

const knowledgeLinks = (knowledgeKey: string, canManage = true) => {
  const self = `/api/v1/knowledge-bases/${knowledgeKey}`;
  return {
    self,
    actions: {
      search: `${self}/search`,
      ...(canManage ? { publish: `${self}/sources` } : {}),
    },
  };
};

const knowledgeSourceLinks = (
  knowledgeKey: string,
  sourceKey: string,
  canManage = true,
) => {
  const self = `/api/v1/knowledge-bases/${knowledgeKey}/sources/${sourceKey}`;
  return {
    self,
    actions: {
      ...(canManage
        ? {
            publish: `${self}/revisions`,
            archive: `${self}/archive`,
          }
        : {}),
    },
  };
};

const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "worker-src 'none'",
  "navigate-to 'none'",
  "sandbox allow-scripts",
].join("; ");
const KNOWLEDGE_SOURCE_REQUEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const previewWrapper = (content: Uint8Array): string => {
  const base64Content = Buffer.from(content).toString("base64");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ForgeX 效果预览</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; background: Canvas; color: CanvasText; }
      header { display: flex; gap: .6rem; align-items: center; min-height: 2.5rem; padding: .5rem .8rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); font-size: .82rem; }
      header strong { color: #2f8061; }
      iframe { display: block; width: 100%; height: calc(100vh - 2.5rem); border: 0; background: white; }
      @media (prefers-color-scheme: dark) { header strong { color: #a9edca; } }
    </style>
  </head>
  <body>
    <header><strong>ForgeX 提交预览</strong><span>已绑定验证提交；交互效果仍需你确认</span></header>
    <iframe id="forgex-preview" title="与已验证提交绑定的产品效果" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    <script>
      const encoded = "${base64Content}";
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const frame = document.getElementById("forgex-preview");
      frame.src = URL.createObjectURL(new Blob([bytes], { type: "text/html;charset=utf-8" }));
    </script>
  </body>
</html>`;
};

const assertPreviewArtifactIntegrity = (
  target: Awaited<
    ReturnType<RequirementApplicationService["getPreviewTarget"]>
  >,
  artifact: NonNullable<Awaited<ReturnType<PreviewArtifactStore["get"]>>>,
): void => {
  if (
    artifact.tenantKey !== target.tenantKey ||
    artifact.projectKey !== target.projectKey ||
    artifact.requirementKey !== target.requirementKey ||
    artifact.requirementRevision !== target.requirementRevision ||
    artifact.artifactHashAlgorithm !== target.artifactHashAlgorithm ||
    artifact.artifactHash !== target.artifactHash ||
    !(artifact.content instanceof Uint8Array) ||
    artifact.content.byteLength < 1 ||
    artifact.content.byteLength > PREVIEW_MAX_ARTIFACT_BYTES ||
    createHash("sha256").update(artifact.content).digest("hex") !==
      target.artifactHash
  ) {
    throw new Error("Preview artifact integrity validation failed");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(artifact.content);
  } catch {
    throw new Error("Preview artifact integrity validation failed");
  }
};

export const buildControlPlaneApi = (
  options: ControlPlaneApiOptions,
): FastifyInstance => {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: REQUIREMENT_REQUEST_BODY_LIMIT_BYTES,
  });
  app.decorateRequest("principal", null);
  app.decorateRequest("workerConnection", null);
  app.decorateRequest("runnerConnection", null);
  app.get("/health/live", async () => ({
    status: "ok",
    service: "forgex-control-plane",
    version: options.serviceVersion ?? "development",
  }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await options.readiness?.();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });
  const requirements = new RequirementApplicationService({
    repository: options.requirementRepository,
    projectKey: options.projectKey,
    repositoryKey: options.repositoryKey,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const knowledgeBases = new KnowledgeBaseApplicationService({
    repository: options.knowledgeBaseRepository,
    projectKey: options.projectKey,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const skills = new SkillRegistryApplicationService({
    repository: options.skillRegistryRepository,
    artifactStore: options.skillArtifactStore,
    evaluationAuthority: options.skillEvaluationAuthority,
    projectKey: options.projectKey,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const mcpServers = new McpRegistryApplicationService({
    repository: options.mcpRegistryRepository,
    healthAuthority: options.mcpHealthAuthority,
    projectKey: options.projectKey,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const mcpInvocations = new McpInvocationApplicationService({
    repository: options.mcpInvocationRepository,
    schemaStore: options.mcpInputSchemaStore,
    toolDirectory: mcpServers,
    projectKey: options.projectKey,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const extensions = new ExtensionCatalogApplicationService({
    repository: options.extensionCatalogRepository,
    skillRegistry: skills,
    mcpRegistry: mcpServers,
    knowledgeDirectory: knowledgeBases,
    projectKey: options.projectKey,
  });
  const workers = new WorkerFleetService({
    repository: options.workerFleetRepository,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const platformConfiguration = new PlatformConfigurationService(
    options.platformConfigurationRepository ??
      new InMemoryPlatformConfigurationRepository(),
  );
  const deliveries = new DeliveryCoordinatorService({
    requirements,
    requirementRepository: options.requirementRepository,
    workers,
    projectKey: options.projectKey,
    skillDirectory: skills,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const verifications = new VerificationCoordinatorService({
    requirementRepository: options.requirementRepository,
    previewArtifactStore: options.previewArtifactStore,
    evidenceAuthority: options.evidenceAuthority,
    projectKey: options.projectKey,
    repositoryKey: options.repositoryKey,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const browserSessions =
    options.browserSessionManager ??
    new InMemoryBrowserSessionManager({
      ...(options.clock ? { clock: options.clock } : {}),
    });
  const workerEnrollments =
    options.workerEnrollmentManager ??
    new InMemoryWorkerEnrollmentManager({
      ...(options.clock ? { clock: options.clock } : {}),
    });

  const authenticate = async (
    authorization: string | undefined,
  ): Promise<AuthenticatedPrincipal> => {
    const principal = await options.authenticator.authenticate(authorization);
    if (!principal) {
      throw new ApplicationError(
        401,
        "authentication_required",
        "请先登录后再继续",
      );
    }
    const parsed = authenticatedPrincipalSchema.safeParse(principal);
    if (!parsed.success) {
      throw new ApplicationError(
        401,
        "invalid_session",
        "登录信息已失效，请重新登录",
      );
    }
    return parsed.data;
  };

  const authenticateWorkerHeaders = (
    request: FastifyRequest,
  ): WorkerConnectionCredentialPayload => {
    const authorization = request.headers.authorization;
    const sessionKey = authorization?.startsWith("Worker ")
      ? authorization.slice("Worker ".length)
      : undefined;
    const parsed = WorkerConnectionCredentialSchema.safeParse({
      schemaVersion: 1,
      tenantKey: request.headers["x-forgex-tenant-key"],
      workerKey: request.headers["x-forgex-worker-key"],
      sessionKey,
      generation: Number(request.headers["x-forgex-worker-generation"]),
    });
    if (!parsed.success) {
      throw new ApplicationError(
        401,
        "invalid_worker_session",
        "设备连接已经失效，请重新连接",
      );
    }
    return parsed.data;
  };

  const authenticateRunner = async (
    authorization: string | undefined,
  ): Promise<AuthenticatedRunner> => {
    const runner =
      await options.runnerAuthenticator.authenticate(authorization);
    const parsed = AuthenticatedRunnerSchema.safeParse(runner);
    if (!parsed.success) {
      throw new ApplicationError(
        401,
        "invalid_runner_session",
        "Runner 连接已经失效，请重新连接",
      );
    }
    return parsed.data;
  };

  const authenticateRequest = async (
    request: FastifyRequest,
  ): Promise<AuthenticatedPrincipal> => {
    const credential = requestSessionCredential(request);
    if (!credential.cookieAuthenticated) {
      return authenticate(credential.authorization);
    }
    const token = credential.authorization?.slice("Bearer ".length) ?? "";
    const principal = await browserSessions.authenticate(token);
    const parsed = authenticatedPrincipalSchema.safeParse(principal);
    if (!parsed.success) {
      throw new ApplicationError(
        401,
        "invalid_session",
        "登录信息已失效，请重新登录",
      );
    }
    return parsed.data;
  };

  const sessionCookieMaxAgeSeconds =
    options.sessionCookieMaxAgeSeconds ?? 8 * 60 * 60;
  if (
    !Number.isSafeInteger(sessionCookieMaxAgeSeconds) ||
    sessionCookieMaxAgeSeconds < 60 ||
    sessionCookieMaxAgeSeconds > 30 * 24 * 60 * 60
  ) {
    throw new Error("浏览器会话有效期配置不正确");
  }
  const sessionCookie = (token: string, maxAge: number): string =>
    [
      `${SESSION_COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
      ...(options.sessionCookieSecure === false ? [] : ["Secure"]),
    ].join("; ");

  const sessionProfile = (principal: AuthenticatedPrincipal) => ({
    actorName: principal.actorName,
    username: principal.username ?? principal.actorName,
    roles: principal.roles,
  });

  app.post("/api/v1/session", async (request, reply) => {
    let principal: AuthenticatedPrincipal;
    if (request.body !== undefined) {
      if (request.headers["x-forgex-csrf"] !== "1") {
        throw new ApplicationError(
          403,
          "csrf_validation_failed",
          "页面验证已失效，请刷新后重试",
        );
      }
      const credentials = credentialsSchema.safeParse(request.body);
      if (!credentials.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "账号或密码格式不正确",
          validationDetails(credentials.error),
        );
      }
      const { schemaVersion: _schemaVersion, ...loginInput } = credentials.data;
      principal =
        (await options.accountService?.authenticate(loginInput)) ??
        (() => {
          throw new ApplicationError(
            401,
            "invalid_credentials",
            "账号或密码不正确",
          );
        })();
    } else {
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
      if (!sessionCookieValuePattern.test(token)) {
        throw new ApplicationError(
          401,
          "invalid_session",
          "访问令牌无效，请检查后重试",
        );
      }
      principal = await authenticate(authorization);
    }
    const sessionToken = await browserSessions.create(
      principal,
      sessionCookieMaxAgeSeconds,
    );
    return reply
      .header("Cache-Control", "no-store")
      .header(
        "Set-Cookie",
        sessionCookie(sessionToken, sessionCookieMaxAgeSeconds),
      )
      .send({ data: sessionProfile(principal) });
  });

  app.get("/api/v1/session", async (request, reply) => {
    const principal = await authenticateRequest(request);
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: sessionProfile(principal) });
  });

  app.delete("/api/v1/session", async (request, reply) => {
    if (request.headers["x-forgex-csrf"] !== "1") {
      throw new ApplicationError(
        403,
        "csrf_validation_failed",
        "页面验证已失效，请刷新后重试",
      );
    }
    const cookieToken = readSessionCookie(request.headers.cookie);
    if (cookieToken) await browserSessions.revoke(cookieToken);
    return reply
      .header("Cache-Control", "no-store")
      .header("Set-Cookie", sessionCookie("deleted", 0))
      .status(204)
      .send();
  });

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/v1/worker-connection/")) {
      request.workerConnection = authenticateWorkerHeaders(request);
      return;
    }
    if (
      path === "/api/v1/runner/evidence" ||
      path.startsWith("/api/v1/runner/verification-targets")
    ) {
      request.runnerConnection = await authenticateRunner(
        request.headers.authorization,
      );
      return;
    }
    if (
      path === "/api/v1/requirements" ||
      path.startsWith("/api/v1/requirements/") ||
      path === "/api/v1/extensions" ||
      path.startsWith("/api/v1/extensions/") ||
      path === "/api/v1/knowledge-bases" ||
      path.startsWith("/api/v1/knowledge-bases/") ||
      path === "/api/v1/mcp-invocations" ||
      path.startsWith("/api/v1/mcp-invocations/") ||
      path === "/api/v1/workers" ||
      path.startsWith("/api/v1/workers/") ||
      path === "/api/v1/accounts" ||
      path.startsWith("/api/v1/accounts/") ||
      path === "/api/v1/platform/customers" ||
      path.startsWith("/api/v1/platform/customers/") ||
      path.startsWith("/api/v1/platform/projects/") ||
      path.startsWith("/api/v1/platform/repositories/") ||
      path === "/api/v1/worker-enrollments"
    ) {
      const credential = requestSessionCredential(request);
      request.principal = await authenticateRequest(request);
      if (
        credential.cookieAuthenticated &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        request.headers["x-forgex-csrf"] !== "1"
      ) {
        throw new ApplicationError(
          403,
          "csrf_validation_failed",
          "页面验证已失效，请刷新后重试",
        );
      }
    }
  });

  const principalFrom = (request: FastifyRequest): AuthenticatedPrincipal => {
    if (!request.principal) {
      throw new ApplicationError(
        401,
        "authentication_required",
        "请先登录后再继续",
      );
    }
    return request.principal;
  };

  const accountService = (): AccountAdministrationService => {
    if (!options.accountService) {
      throw new ApplicationError(
        503,
        "account_service_unavailable",
        "账号管理暂时不可用，请联系平台管理员",
      );
    }
    return options.accountService;
  };

  const accountView = (account: {
    accountKey: string;
    username: string;
    actorName: string;
    roles: PlatformRole[];
    enabled: boolean;
    revision: number;
  }) => ({
    username: account.username,
    actorName: account.actorName,
    roles: account.roles,
    enabled: account.enabled,
    revision: account.revision,
    links: { self: `/api/v1/accounts/${account.accountKey}` },
  });

  app.get("/api/v1/accounts", async (request, reply) => {
    const accounts = await accountService().list(principalFrom(request));
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: accounts.map(accountView) });
  });

  app.post("/api/v1/accounts", async (request, reply) => {
    const command = accountCreateSchema.safeParse(request.body);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "账号信息需要调整",
        validationDetails(command.error),
      );
    }
    const { schemaVersion: _schemaVersion, ...input } = command.data;
    const account = await accountService().create(
      principalFrom(request),
      input,
    );
    return reply
      .header("Cache-Control", "no-store")
      .header("Location", `/api/v1/accounts/${account.accountKey}`)
      .status(201)
      .send({ data: accountView(account) });
  });

  app.patch("/api/v1/accounts/:accountKey", async (request, reply) => {
    const params = accountParamsSchema.safeParse(request.params);
    const command = accountUpdateSchema.safeParse(request.body);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "账号信息需要调整",
        validationDetails(params.error),
      );
    }
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "账号信息需要调整",
        validationDetails(command.error),
      );
    }
    const { schemaVersion: _schemaVersion, ...input } = command.data;
    const principal = principalFrom(request);
    const account = await accountService().update(
      principal,
      params.data.accountKey,
      input,
    );
    await browserSessions.revokePrincipal(
      principal.tenantKey,
      account.accountKey,
    );
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: accountView(account) });
  });

  app.delete("/api/v1/accounts/:accountKey", async (request, reply) => {
    const params = accountParamsSchema.safeParse(request.params);
    const command = accountDeleteSchema.safeParse(request.body);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "账号删除请求需要调整",
        validationDetails(params.error),
      );
    }
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "账号删除请求需要调整",
        validationDetails(command.error),
      );
    }
    const principal = principalFrom(request);
    await accountService().delete(principal, params.data.accountKey, {
      expectedRevision: command.data.expectedRevision,
    });
    await browserSessions.revokePrincipal(
      principal.tenantKey,
      params.data.accountKey,
    );
    return reply.header("Cache-Control", "no-store").status(204).send();
  });

  const platformRepositoryView = (repository: {
    repositoryKey: string;
    name: string;
    gitUrl: string;
    localPath: string;
    defaultBranch: string;
    enabled: boolean;
    revision: number;
  }) => ({
    name: repository.name,
    gitUrl: repository.gitUrl,
    localPath: repository.localPath,
    defaultBranch: repository.defaultBranch,
    enabled: repository.enabled,
    revision: repository.revision,
    links: {
      self: `/api/v1/platform/repositories/${repository.repositoryKey}`,
    },
  });
  const platformProjectView = (project: {
    projectKey: string;
    name: string;
    summary: string;
    enabled: boolean;
    revision: number;
    repositories: Array<Parameters<typeof platformRepositoryView>[0]>;
  }) => ({
    name: project.name,
    summary: project.summary,
    enabled: project.enabled,
    revision: project.revision,
    repositories: project.repositories.map(platformRepositoryView),
    links: {
      self: `/api/v1/platform/projects/${project.projectKey}`,
      actions: {
        createRepository: `/api/v1/platform/projects/${project.projectKey}/repositories`,
      },
    },
  });
  const platformCustomerView = (customer: {
    customerKey: string;
    name: string;
    summary: string;
    enabled: boolean;
    revision: number;
    projects: Array<Parameters<typeof platformProjectView>[0]>;
  }) => ({
    name: customer.name,
    summary: customer.summary,
    enabled: customer.enabled,
    revision: customer.revision,
    projects: customer.projects.map(platformProjectView),
    links: {
      self: `/api/v1/platform/customers/${customer.customerKey}`,
      actions: {
        createProject: `/api/v1/platform/customers/${customer.customerKey}/projects`,
      },
    },
  });
  const platformValidationError = (error: z.ZodError): ApplicationError =>
    new ApplicationError(
      422,
      "validation_error",
      "平台配置信息需要调整",
      validationDetails(error),
    );

  app.get("/api/v1/platform/customers", async (request, reply) => {
    const customers = await platformConfiguration.list(principalFrom(request));
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: customers.map(platformCustomerView) });
  });

  app.post("/api/v1/platform/customers", async (request, reply) => {
    const command = platformResourceCreateSchema.safeParse(request.body);
    if (!command.success) throw platformValidationError(command.error);
    const { schemaVersion: _schemaVersion, ...input } = command.data;
    const customer = await platformConfiguration.createCustomer(
      principalFrom(request),
      input,
    );
    const view = platformCustomerView(customer);
    return reply
      .header("Cache-Control", "no-store")
      .header("Location", view.links.self)
      .status(201)
      .send({ data: view });
  });

  app.patch(
    "/api/v1/platform/customers/:customerKey",
    async (request, reply) => {
      const params = platformCustomerParamsSchema.safeParse(request.params);
      const command = platformResourceUpdateSchema.safeParse(request.body);
      if (!params.success) throw platformValidationError(params.error);
      if (!command.success) throw platformValidationError(command.error);
      const { schemaVersion: _schemaVersion, ...input } = command.data;
      const customer = await platformConfiguration.updateCustomer(
        principalFrom(request),
        params.data.customerKey,
        input,
      );
      return reply
        .header("Cache-Control", "no-store")
        .send({ data: platformCustomerView(customer) });
    },
  );

  app.delete(
    "/api/v1/platform/customers/:customerKey",
    async (request, reply) => {
      const params = platformCustomerParamsSchema.safeParse(request.params);
      const command = platformConfigurationDeleteSchema.safeParse(request.body);
      if (!params.success) throw platformValidationError(params.error);
      if (!command.success) throw platformValidationError(command.error);
      await platformConfiguration.deleteCustomer(
        principalFrom(request),
        params.data.customerKey,
        { expectedRevision: command.data.expectedRevision },
      );
      return reply.header("Cache-Control", "no-store").status(204).send();
    },
  );

  app.post(
    "/api/v1/platform/customers/:customerKey/projects",
    async (request, reply) => {
      const params = platformCustomerParamsSchema.safeParse(request.params);
      const command = platformResourceCreateSchema.safeParse(request.body);
      if (!params.success) throw platformValidationError(params.error);
      if (!command.success) throw platformValidationError(command.error);
      const { schemaVersion: _schemaVersion, ...input } = command.data;
      const project = await platformConfiguration.createProject(
        principalFrom(request),
        params.data.customerKey,
        input,
      );
      const view = platformProjectView(project);
      return reply
        .header("Cache-Control", "no-store")
        .header("Location", view.links.self)
        .status(201)
        .send({ data: view });
    },
  );

  app.patch("/api/v1/platform/projects/:projectKey", async (request, reply) => {
    const params = platformProjectParamsSchema.safeParse(request.params);
    const command = platformResourceUpdateSchema.safeParse(request.body);
    if (!params.success) throw platformValidationError(params.error);
    if (!command.success) throw platformValidationError(command.error);
    const { schemaVersion: _schemaVersion, ...input } = command.data;
    const project = await platformConfiguration.updateProject(
      principalFrom(request),
      params.data.projectKey,
      input,
    );
    return reply
      .header("Cache-Control", "no-store")
      .send({ data: platformProjectView(project) });
  });

  app.delete(
    "/api/v1/platform/projects/:projectKey",
    async (request, reply) => {
      const params = platformProjectParamsSchema.safeParse(request.params);
      const command = platformConfigurationDeleteSchema.safeParse(request.body);
      if (!params.success) throw platformValidationError(params.error);
      if (!command.success) throw platformValidationError(command.error);
      await platformConfiguration.deleteProject(
        principalFrom(request),
        params.data.projectKey,
        { expectedRevision: command.data.expectedRevision },
      );
      return reply.header("Cache-Control", "no-store").status(204).send();
    },
  );

  app.post(
    "/api/v1/platform/projects/:projectKey/repositories",
    async (request, reply) => {
      const params = platformProjectParamsSchema.safeParse(request.params);
      const command = platformRepositoryCreateSchema.safeParse(request.body);
      if (!params.success) throw platformValidationError(params.error);
      if (!command.success) throw platformValidationError(command.error);
      const { schemaVersion: _schemaVersion, ...input } = command.data;
      const repository = await platformConfiguration.createRepository(
        principalFrom(request),
        params.data.projectKey,
        input,
      );
      const view = platformRepositoryView(repository);
      return reply
        .header("Cache-Control", "no-store")
        .header("Location", view.links.self)
        .status(201)
        .send({ data: view });
    },
  );

  app.patch(
    "/api/v1/platform/repositories/:repositoryKey",
    async (request, reply) => {
      const params = platformRepositoryParamsSchema.safeParse(request.params);
      const command = platformRepositoryUpdateSchema.safeParse(request.body);
      if (!params.success) throw platformValidationError(params.error);
      if (!command.success) throw platformValidationError(command.error);
      const { schemaVersion: _schemaVersion, ...input } = command.data;
      const repository = await platformConfiguration.updateRepository(
        principalFrom(request),
        params.data.repositoryKey,
        input,
      );
      return reply
        .header("Cache-Control", "no-store")
        .send({ data: platformRepositoryView(repository) });
    },
  );

  app.delete(
    "/api/v1/platform/repositories/:repositoryKey",
    async (request, reply) => {
      const params = platformRepositoryParamsSchema.safeParse(request.params);
      const command = platformConfigurationDeleteSchema.safeParse(request.body);
      if (!params.success) throw platformValidationError(params.error);
      if (!command.success) throw platformValidationError(command.error);
      await platformConfiguration.deleteRepository(
        principalFrom(request),
        params.data.repositoryKey,
        { expectedRevision: command.data.expectedRevision },
      );
      return reply.header("Cache-Control", "no-store").status(204).send();
    },
  );

  const workerConnectionFrom = (
    request: FastifyRequest,
  ): WorkerConnectionCredentialPayload => {
    if (!request.workerConnection) {
      throw new ApplicationError(
        401,
        "invalid_worker_session",
        "设备连接已经失效，请重新连接",
      );
    }
    return request.workerConnection;
  };

  const runnerConnectionFrom = (
    request: FastifyRequest,
  ): AuthenticatedRunner => {
    if (!request.runnerConnection) {
      throw new ApplicationError(
        401,
        "invalid_runner_session",
        "Runner 连接已经失效，请重新连接",
      );
    }
    return request.runnerConnection;
  };

  app.setErrorHandler((error, request, reply) => {
    if (request.url.startsWith("/api/v1/worker-enrollments")) {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    }
    if (error instanceof ApplicationError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      return reply.status(400).send({
        error: {
          code: "invalid_json",
          message: "请求内容不是有效的 JSON",
        },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
    ) {
      return reply.status(413).send({
        error: {
          code: "payload_too_large",
          message: "请求内容过大，请精简后重试",
        },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
    ) {
      return reply.status(415).send({
        error: {
          code: "unsupported_media_type",
          message: "请求内容格式不受支持，请使用 JSON",
        },
      });
    }
    app.log.error(error);
    return reply.status(500).send({
      error: {
        code: "internal_error",
        message: "服务暂时无法完成操作，请稍后重试",
      },
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({
      error: {
        code: "route_not_found",
        message: "没有找到这个功能入口",
      },
    }),
  );

  app.get("/api/v1/runner/verification-targets", async (request, reply) => {
    const runner = runnerConnectionFrom(request);
    const query = runnerVerificationListQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "验证任务列表条件需要调整",
        validationDetails(query.error),
      );
    }
    const result = await verifications.listPending(runner, {
      limit: query.data.limit,
    });
    return reply.send({
      data: result.items,
      meta: { count: result.items.length },
    });
  });

  app.put(
    "/api/v1/runner/verification-targets/:requirementKey/preview",
    { bodyLimit: PREVIEW_ARTIFACT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const runner = runnerConnectionFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      const body = runnerPreviewArtifactBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "效果制品内容需要调整",
          validationDetails(params.success ? body.error! : params.error),
        );
      }
      const content = Buffer.from(body.data.contentBase64, "base64");
      if (
        content.byteLength < 1 ||
        content.byteLength > PREVIEW_MAX_ARTIFACT_BYTES ||
        content.toString("base64") !== body.data.contentBase64
      ) {
        throw new ApplicationError(
          422,
          "invalid_preview_artifact",
          "效果制品内容、大小或编码不正确",
        );
      }
      const result = await verifications.publishPreviewArtifact(runner, {
        schemaVersion: 1,
        requirementKey: params.data.requirementKey,
        requirementRevision: body.data.requirementRevision,
        artifactHashAlgorithm: body.data.artifactHashAlgorithm,
        artifactHash: body.data.artifactHash,
        content,
      });
      return reply.send({ data: result });
    },
  );

  app.post(
    "/api/v1/runner/verification-targets/:requirementKey/failure",
    async (request, reply) => {
      const runner = runnerConnectionFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      const body = RunnerVerificationFailureCommandSchema.safeParse(
        request.body,
      );
      if (
        !params.success ||
        !body.success ||
        params.data.requirementKey !== body.data.requirementKey
      ) {
        const details = !params.success
          ? validationDetails(params.error)
          : !body.success
            ? validationDetails(body.error)
            : [
                {
                  field: "requirementKey",
                  code: "invalid_value" as const,
                  message: "路径与结果中的需求不一致",
                },
              ];
        throw new ApplicationError(
          422,
          "validation_error",
          "验证失败结果需要调整",
          details,
        );
      }
      const result = await verifications.reportFailure(runner, body.data);
      return reply.send({ data: result });
    },
  );

  app.post("/api/v1/runner/evidence", async (request, reply) => {
    const runner = runnerConnectionFrom(request);
    const signed = SignedEvidenceSchema.safeParse(request.body);
    if (!signed.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "验证证据内容需要调整",
        validationDetails(signed.error),
      );
    }
    const result = await verifications.submitEvidence(runner, signed.data);
    return reply.send({
      data: {
        status: result.view.status,
        acceptanceProgress: result.view.acceptanceProgress,
      },
    });
  });

  app.post("/api/v1/requirements", async (request, reply) => {
    const principal = principalFrom(request);
    const parsed = RequirementSpecSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "需求内容需要调整",
        validationDetails(parsed.error),
      );
    }
    const result = await requirements.create(principal, parsed.data);
    return reply
      .status(201)
      .header("Location", `/api/v1/requirements/${result.requirementKey}`)
      .send({ data: result.view });
  });

  app.get("/api/v1/requirements", async (request, reply) => {
    const principal = principalFrom(request);
    const query = requirementListQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "列表条件需要调整",
        validationDetails(query.error),
      );
    }
    const result = await requirements.list(principal, {
      limit: query.data.limit,
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
    });
    return reply.send({
      data: result.items.map((item) => ({
        ...item.view,
        links: requirementLinks(
          item.requirementKey,
          item.allowedActions,
          principal,
        ),
      })),
      meta: { nextCursor: result.nextCursor },
    });
  });

  app.get("/api/v1/extensions", async (request, reply) => {
    const principal = principalFrom(request);
    return reply.send({
      data: await extensions.overviewForPeople(principal),
    });
  });

  app.post(
    "/api/v1/extensions/skills",
    { bodyLimit: SKILL_PACKAGE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const command = skillPublishCommandSchema.safeParse(request.body);
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "Skill 发布内容需要调整",
          validationDetails(command.error),
        );
      }
      const bytes = Uint8Array.from(
        Buffer.from(command.data.artifactContentBase64, "base64"),
      );
      try {
        SkillPackageCodec.decode(bytes);
      } catch {
        throw new ApplicationError(
          422,
          "invalid_skill_package",
          "Skill 制品不是规范的可信包",
        );
      }
      if (
        command.data.manifest.artifactSizeBytes !== bytes.byteLength ||
        command.data.manifest.artifactHash !==
          createHash("sha256").update(bytes).digest("hex")
      ) {
        throw new ApplicationError(
          422,
          "invalid_skill_package",
          "Skill 制品与清单摘要不一致",
        );
      }
      await skills.publish(principal, command.data.manifest, bytes);
      const self = `/api/v1/extensions/skills/${command.data.manifest.skillKey}`;
      return reply
        .code(201)
        .header("Location", self)
        .send({ data: { status: "已发布", links: { self } } });
    },
  );

  app.post(
    "/api/v1/extensions/skills/:skillKey/evaluations",
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const params = skillExtensionParamsSchema.safeParse(request.params);
      const command = skillEvaluationCommandSchema.safeParse(request.body);
      if (!params.success || !command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "Skill 评测内容需要调整",
          !params.success
            ? validationDetails(params.error)
            : validationDetails(command.error!),
        );
      }
      if (command.data.evaluation.payload.skillKey !== params.data.skillKey) {
        throw new ApplicationError(
          422,
          "skill_evaluation_mismatch",
          "Skill 评测没有绑定当前能力",
        );
      }
      try {
        options.skillEvaluationAuthority.verify(command.data.evaluation);
      } catch {
        throw new ApplicationError(
          422,
          "invalid_skill_evaluation",
          "Skill 独立评测未通过可信校验",
        );
      }
      await skills.recordEvaluation(
        principal.tenantKey,
        command.data.evaluation,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/extensions/skills/:skillKey/versions/:version/activate",
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const params = skillVersionParamsSchema.safeParse(request.params);
      const command = revisionActionCommandSchema.safeParse(request.body);
      if (!params.success || !command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "Skill 激活内容需要调整",
          !params.success
            ? validationDetails(params.error)
            : validationDetails(command.error!),
        );
      }
      await skills.activate(
        principal,
        params.data.skillKey,
        params.data.version,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/extensions/mcp",
    { bodyLimit: MCP_MANIFEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const command = mcpPublishCommandSchema.safeParse(request.body);
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "MCP 发布内容需要调整",
          validationDetails(command.error),
        );
      }
      const { manifest } = command.data;
      if (
        manifest.tenantKey !== principal.tenantKey ||
        manifest.projectKey !== options.projectKey.toLowerCase()
      ) {
        throw new ApplicationError(
          422,
          "mcp_scope_mismatch",
          "MCP 服务器不属于当前租户或项目",
        );
      }
      assertMcpManifestContainsNoCredential(manifest);
      const schemas = new Map(
        command.data.inputSchemas.map((item) => [item.toolKey, item.schema]),
      );
      if (
        schemas.size !== manifest.tools.length ||
        manifest.tools.some((tool) => !schemas.has(tool.toolKey))
      ) {
        throw new ApplicationError(
          422,
          "mcp_schema_mismatch",
          "MCP 发布必须逐项提供工具输入 Schema",
        );
      }
      const canonicalSchemas: Array<{
        toolKey: string;
        schema: Record<string, unknown>;
        hash: string;
      }> = [];
      try {
        for (const tool of manifest.tools) {
          const canonical = canonicalizeMcpInputSchema(
            schemas.get(tool.toolKey),
          );
          if (canonical.hash !== tool.inputSchemaHash) {
            throw new Error("schema_hash_mismatch");
          }
          canonicalSchemas.push({
            toolKey: tool.toolKey,
            schema: canonical.schema,
            hash: canonical.hash,
          });
        }
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          422,
          "mcp_schema_mismatch",
          "MCP 工具 Schema 与清单摘要不一致",
        );
      }
      for (const schema of canonicalSchemas) {
        await options.mcpInputSchemaStore.put(
          {
            tenantKey: principal.tenantKey,
            projectKey: options.projectKey,
            hashAlgorithm: "sha256",
            hash: schema.hash,
          },
          schema.schema,
        );
      }
      await mcpServers.publish(principal, manifest);
      const self = `/api/v1/extensions/mcp/${manifest.serverKey}`;
      return reply
        .code(201)
        .header("Location", self)
        .send({ data: { status: "已发布", links: { self } } });
    },
  );

  app.post(
    "/api/v1/extensions/mcp/:serverKey/health",
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const params = mcpExtensionParamsSchema.safeParse(request.params);
      const command = mcpHealthCommandSchema.safeParse(request.body);
      if (!params.success || !command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "MCP 探测内容需要调整",
          !params.success
            ? validationDetails(params.error)
            : validationDetails(command.error!),
        );
      }
      if (command.data.health.payload.serverKey !== params.data.serverKey) {
        throw new ApplicationError(
          422,
          "mcp_health_mismatch",
          "MCP 探测没有绑定当前服务器",
        );
      }
      try {
        const alreadyRecorded = await mcpServers.hasRecordedHealth(
          principal.tenantKey,
          command.data.health,
        );
        if (alreadyRecorded) {
          options.mcpHealthAuthority.verifyPersisted(command.data.health);
        } else {
          options.mcpHealthAuthority.verify(command.data.health);
        }
      } catch {
        throw new ApplicationError(
          422,
          "invalid_mcp_health",
          "MCP 独立探测未通过可信校验",
        );
      }
      const outcome = await mcpServers.recordHealth(
        principal.tenantKey,
        command.data.health,
      );
      return reply.send({ data: outcome });
    },
  );

  app.get(
    "/api/v1/extensions/mcp/:serverKey/revisions/:revision/probe-binding",
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const params = mcpRevisionParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "MCP 探测链参数需要调整",
          validationDetails(params.error),
        );
      }
      const [binding, recoveryChallengeKey] = await Promise.all([
        mcpServers.getNextProbeBinding(
          principal.tenantKey,
          params.data.serverKey,
          params.data.revision,
        ),
        mcpServers.getRecoveryChallenge(
          principal.tenantKey,
          params.data.serverKey,
          params.data.revision,
        ),
      ]);
      return reply.send({
        data: { ...binding, recoveryChallengeKey },
      });
    },
  );

  app.post(
    "/api/v1/extensions/mcp/:serverKey/revisions/:revision/enable",
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const params = mcpRevisionParamsSchema.safeParse(request.params);
      const command = revisionActionCommandSchema.safeParse(request.body);
      if (!params.success || !command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "MCP 启用内容需要调整",
          !params.success
            ? validationDetails(params.error)
            : validationDetails(command.error!),
        );
      }
      await mcpServers.enable(
        principal,
        params.data.serverKey,
        params.data.revision,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/extensions/mcp/:serverKey/revisions/:revision/recover",
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const params = mcpRevisionParamsSchema.safeParse(request.params);
      const command = mcpRecoveryCommandSchema.safeParse(request.body);
      if (!params.success || !command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "MCP 恢复内容需要调整",
          !params.success
            ? validationDetails(params.error)
            : validationDetails(command.error!),
        );
      }
      await mcpServers.recover(
        principal,
        params.data.serverKey,
        params.data.revision,
        command.data.attestationKey,
      );
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/v1/extensions/mcp/:serverKey/disable",
    async (request, reply) => {
      const principal = principalFrom(request);
      requireExtensionAdministrator(principal);
      reply.header("Cache-Control", "no-store");
      const params = mcpExtensionParamsSchema.safeParse(request.params);
      const command = revisionActionCommandSchema.safeParse(request.body);
      if (!params.success || !command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "MCP 停用内容需要调整",
          !params.success
            ? validationDetails(params.error)
            : validationDetails(command.error!),
        );
      }
      await mcpServers.disable(principal, params.data.serverKey);
      return reply.code(204).send();
    },
  );

  app.post("/api/v1/knowledge-bases", async (request, reply) => {
    const principal = principalFrom(request);
    const command = KnowledgeBaseCreateCommandSchema.safeParse(request.body);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "知识库信息需要调整",
        validationDetails(command.error),
      );
    }
    const result = await knowledgeBases.create(principal, command.data);
    const links = knowledgeLinks(result.knowledgeKey);
    return reply
      .code(201)
      .header("Location", links.self)
      .send({
        data: {
          name: result.name,
          status: result.status,
          links: { self: links.self },
        },
      });
  });

  app.get("/api/v1/knowledge-bases/:knowledgeKey", async (request, reply) => {
    const principal = principalFrom(request);
    const params = knowledgeParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "知识库入口需要调整",
        validationDetails(params.error),
      );
    }
    const item = await knowledgeBases.detailForPeople(
      principal,
      params.data.knowledgeKey,
    );
    return reply.send({
      data: {
        ...item.view,
        sources: item.sources.map(({ sourceKey, ...source }) => ({
          ...source,
          links: knowledgeSourceLinks(
            item.knowledgeKey,
            sourceKey,
            item.canManage,
          ),
        })),
        links: knowledgeLinks(item.knowledgeKey, item.canManage),
      },
    });
  });

  app.get(
    "/api/v1/knowledge-bases/:knowledgeKey/sources/:sourceKey",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = knowledgeSourceParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "业务资料入口需要调整",
          validationDetails(params.error),
        );
      }
      const item = await knowledgeBases.sourceForPeople(
        principal,
        params.data.knowledgeKey,
        params.data.sourceKey,
      );
      const { sourceKey, ...source } = item.source;
      return reply.send({
        data: {
          ...source,
          links: knowledgeSourceLinks(
            item.knowledgeKey,
            sourceKey,
            item.canManage,
          ),
        },
      });
    },
  );

  app.post(
    "/api/v1/knowledge-bases/:knowledgeKey/sources",
    { bodyLimit: KNOWLEDGE_SOURCE_REQUEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = knowledgeParamsSchema.safeParse(request.params);
      const command = KnowledgeSourcePublishCommandSchema.safeParse(
        request.body,
      );
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "业务资料需要调整",
          validationDetails(params.error),
        );
      }
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "业务资料需要调整",
          validationDetails(command.error),
        );
      }
      const result = await knowledgeBases.publishSource(
        principal,
        params.data.knowledgeKey,
        null,
        command.data,
      );
      const links = knowledgeSourceLinks(
        params.data.knowledgeKey,
        result.sourceKey,
      );
      return reply
        .code(201)
        .header("Location", links.self)
        .send({
          data: {
            title: result.title,
            version: result.version,
            links,
          },
        });
    },
  );

  app.post(
    "/api/v1/knowledge-bases/:knowledgeKey/sources/:sourceKey/revisions",
    { bodyLimit: KNOWLEDGE_SOURCE_REQUEST_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = knowledgeSourceParamsSchema.safeParse(request.params);
      const command = KnowledgeSourcePublishCommandSchema.safeParse(
        request.body,
      );
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "业务资料需要调整",
          validationDetails(params.error),
        );
      }
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "业务资料需要调整",
          validationDetails(command.error),
        );
      }
      const result = await knowledgeBases.publishSource(
        principal,
        params.data.knowledgeKey,
        params.data.sourceKey,
        command.data,
      );
      return reply.send({
        data: {
          title: result.title,
          version: result.version,
          links: knowledgeSourceLinks(
            params.data.knowledgeKey,
            result.sourceKey,
          ),
        },
      });
    },
  );

  app.post(
    "/api/v1/knowledge-bases/:knowledgeKey/sources/:sourceKey/archive",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = knowledgeSourceParamsSchema.safeParse(request.params);
      const command = knowledgeArchiveCommandSchema.safeParse(request.body);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "归档请求需要调整",
          validationDetails(params.error),
        );
      }
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "归档请求需要调整",
          validationDetails(command.error),
        );
      }
      await knowledgeBases.archiveSource(
        principal,
        params.data.knowledgeKey,
        params.data.sourceKey,
        command.data.requestKey,
      );
      return reply.send({ data: { status: "已归档" } });
    },
  );

  app.post(
    "/api/v1/knowledge-bases/:knowledgeKey/search",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = knowledgeParamsSchema.safeParse(request.params);
      const command = KnowledgeSearchCommandSchema.safeParse(request.body);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "检索内容需要调整",
          validationDetails(params.error),
        );
      }
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "检索内容需要调整",
          validationDetails(command.error),
        );
      }
      return reply.send({
        data: await knowledgeBases.search(
          principal,
          params.data.knowledgeKey,
          command.data,
        ),
      });
    },
  );

  app.get("/api/v1/mcp-invocations", async (request, reply) => {
    const principal = principalFrom(request);
    reply.header("Cache-Control", "no-store");
    const items = await mcpInvocations.listItemsForPeople(principal);
    return reply.send({
      data: items.map((item) => {
        return {
          ...item.view,
          links: mcpInvocationLinks(item.invocationKey, item.allowedActions),
        };
      }),
    });
  });

  app.get("/api/v1/mcp-invocations/:invocationKey", async (request, reply) => {
    const principal = principalFrom(request);
    reply.header("Cache-Control", "no-store");
    const params = mcpInvocationParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "请求内容需要调整",
        validationDetails(params.error),
      );
    }
    const item = await mcpInvocations.getItemForPeople(
      principal,
      params.data.invocationKey,
    );
    return reply.send({
      data: {
        ...item.view,
        links: mcpInvocationLinks(item.invocationKey, item.allowedActions),
      },
    });
  });

  app.post<{ Body: McpInvocationRequestPayload }>(
    "/api/v1/mcp-invocations",
    async (request, reply) => {
      const principal = principalFrom(request);
      const command = McpInvocationRequestSchema.safeParse(request.body);
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(command.error),
        );
      }
      const result = await mcpInvocations.request(principal, command.data);
      const self = `/api/v1/mcp-invocations/${result.invocationKey}`;
      return reply
        .code(201)
        .header("Location", self)
        .send({
          data: {
            title: result.title,
            status: result.status,
            links: { self },
          },
        });
    },
  );

  app.post(
    "/api/v1/mcp-invocations/:invocationKey/approve",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = mcpInvocationParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(params.error),
        );
      }
      await mcpInvocations.approve(principal, params.data.invocationKey);
      return reply.send({ data: { status: "等待设备执行" } });
    },
  );

  app.post(
    "/api/v1/mcp-invocations/:invocationKey/cancel",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = mcpInvocationParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(params.error),
        );
      }
      const dispatch = await mcpInvocations.requestCancellation(
        principal,
        params.data.invocationKey,
      );
      if (dispatch) {
        await workers.cancelPendingMcpInvocation(dispatch);
        await mcpInvocations.finalizeCancellation(
          dispatch.tenantKey,
          dispatch.projectKey,
          dispatch.invocationKey,
        );
      }
      return reply.send({ data: { status: "已取消" } });
    },
  );

  app.get("/api/v1/extensions/:extensionKey", async (request, reply) => {
    const principal = principalFrom(request);
    const params = extensionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "请求内容需要调整",
        validationDetails(params.error),
      );
    }
    return reply.send({
      data: await extensions.detailForPeople(
        principal,
        params.data.extensionKey,
      ),
    });
  });

  app.get("/api/v1/extensions/skills/:skillKey", async (request, reply) => {
    const principal = principalFrom(request);
    const params = skillExtensionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "请求内容需要调整",
        validationDetails(params.error),
      );
    }
    return reply.send({
      data: await extensions.skillDetailForPeople(
        principal,
        params.data.skillKey,
      ),
    });
  });

  app.get("/api/v1/extensions/mcp/:serverKey", async (request, reply) => {
    const principal = principalFrom(request);
    const params = mcpExtensionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "请求内容需要调整",
        validationDetails(params.error),
      );
    }
    return reply.send({
      data: await extensions.mcpDetailForPeople(
        principal,
        params.data.serverKey,
      ),
    });
  });

  app.get("/api/v1/extensions/mcp/:serverKey/tools", async (request, reply) => {
    const principal = principalFrom(request);
    reply.header("Cache-Control", "no-store");
    const params = mcpExtensionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "请求内容需要调整",
        validationDetails(params.error),
      );
    }
    const manifest = await mcpServers.getEnabledManifestForInvocation(
      principal.tenantKey,
      params.data.serverKey,
    );
    if (!manifest) {
      throw new ApplicationError(
        409,
        "mcp_tool_unavailable",
        "这项外部服务当前不可使用，请稍后重试",
      );
    }
    const impact = {
      read: "仅读取信息",
      write: "会修改业务数据",
      external_action: "会触发外部动作",
    } as const;
    return reply.send({
      data: McpToolCatalogSchema.parse({
        serviceName: manifest.name,
        summary: manifest.summary,
        tools: manifest.tools.map((tool) => ({
          title: tool.displayName,
          description: tool.description,
          impact: impact[tool.effect],
          confirmation:
            tool.approval === "automatic" ? "自动确认" : "需要产品负责人确认",
          links: {
            form: `/api/v1/extensions/mcp/${manifest.serverKey}/tools/${tool.toolKey}/form`,
          },
        })),
      }),
    });
  });

  app.get(
    "/api/v1/extensions/mcp/:serverKey/tools/:toolKey/form",
    async (request, reply) => {
      const principal = principalFrom(request);
      reply.header("Cache-Control", "no-store");
      const params = mcpToolParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(params.error),
        );
      }
      return reply.send({
        data: McpInvocationToolFormSchema.parse(
          await mcpInvocations.formForPeople(
            principal,
            params.data.serverKey,
            params.data.toolKey,
          ),
        ),
      });
    },
  );

  app.post<{ Body: McpInvocationPeopleRequestPayload }>(
    "/api/v1/extensions/mcp/:serverKey/tools/:toolKey/requests",
    async (request, reply) => {
      const principal = principalFrom(request);
      reply.header("Cache-Control", "no-store");
      const params = mcpToolParamsSchema.safeParse(request.params);
      const command = McpInvocationPeopleRequestSchema.safeParse(request.body);
      if (!params.success || !command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "外部操作表单需要调整",
          !params.success
            ? validationDetails(params.error)
            : validationDetails(command.error!),
        );
      }
      const result = await mcpInvocations.requestFromPeople(
        principal,
        params.data.serverKey,
        params.data.toolKey,
        command.data,
      );
      const self = `/api/v1/mcp-invocations/${result.invocationKey}`;
      return reply
        .code(201)
        .header("Location", self)
        .send({
          data: {
            title: result.title,
            status: result.status,
            links: { self },
          },
        });
    },
  );

  app.get("/api/v1/requirements/:requirementKey", async (request, reply) => {
    const principal = principalFrom(request);
    const params = requirementParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "请求内容需要调整",
        validationDetails(params.error),
      );
    }
    const result = await requirements.get(
      principal,
      params.data.requirementKey,
    );
    return reply.send({
      data: {
        ...result.view,
        spec: result.spec,
        acceptance: result.acceptance,
        revisions: result.revisions,
        links: requirementLinks(
          result.requirementKey,
          result.allowedActions,
          principal,
          result.acceptance !== null,
        ),
      },
    });
  });

  app.get(
    "/api/v1/requirements/:requirementKey/revisions",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "需求版本入口需要调整",
          validationDetails(params.error),
        );
      }
      const result = await requirements.get(
        principal,
        params.data.requirementKey,
      );
      return reply.send({
        data: result.revisions,
        links: {
          self: `/api/v1/requirements/${result.requirementKey}/revisions`,
        },
      });
    },
  );

  app.post(
    "/api/v1/requirements/:requirementKey/revisions",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      const command = requirementRevisionCommandSchema.safeParse(request.body);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "需求修订内容需要调整",
          validationDetails(params.error),
        );
      }
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "需求修订内容需要调整",
          validationDetails(command.error),
        );
      }
      const result = await requirements.revise(
        principal,
        params.data.requirementKey,
        command.data.expectedRevision,
        command.data.spec,
      );
      return reply.send({ data: result.view });
    },
  );

  app.get(
    "/api/v1/requirements/:requirementKey/preview",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(params.error),
        );
      }
      const target = await requirements.getPreviewTarget(
        principal,
        params.data.requirementKey,
      );
      const artifact = await options.previewArtifactStore.get(target);
      if (!artifact) {
        throw new ApplicationError(
          404,
          "preview_artifact_not_found",
          "效果预览暂时不可用，请稍后再试",
        );
      }
      assertPreviewArtifactIntegrity(target, artifact);
      return reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", PREVIEW_CONTENT_SECURITY_POLICY)
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header(
          "Permissions-Policy",
          "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY")
        .send(previewWrapper(artifact.content));
    },
  );

  app.post(
    "/api/v1/requirements/:requirementKey/submit-confirmation",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      const body = emptyCommandSchema.safeParse(request.body ?? {});
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(params.error),
        );
      }
      if (!body.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(body.error),
        );
      }
      const result = await requirements.submitForConfirmation(
        principal,
        params.data.requirementKey,
      );
      return reply.send({ data: result.view });
    },
  );

  app.post(
    "/api/v1/requirements/:requirementKey/confirm",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      const body = emptyCommandSchema.safeParse(request.body ?? {});
      if (!params.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(params.error),
        );
      }
      if (!body.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "请求内容需要调整",
          validationDetails(body.error),
        );
      }
      const result = await requirements.confirm(
        principal,
        params.data.requirementKey,
      );
      return reply.send({ data: result.view });
    },
  );

  app.post("/api/v1/worker-enrollments", async (request, reply) => {
    const principal = principalFrom(request);
    if (!canConnectWorker(principal)) {
      throw new ApplicationError(
        403,
        "worker_management_denied",
        "只有管理员可以签发设备接入码",
      );
    }
    const command = z
      .object({
        schemaVersion: z.literal(1),
        deviceName: z.string().trim().min(2).max(100),
        accountName: z.string().trim().min(2).max(100),
      })
      .strict()
      .safeParse(request.body);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "设备接入信息需要调整",
        validationDetails(command.error),
      );
    }
    const enrollment = await workerEnrollments.issue(
      principal,
      command.data.deviceName,
      command.data.accountName,
      10 * 60,
    );
    return reply
      .header("Cache-Control", "no-store")
      .header("Pragma", "no-cache")
      .status(201)
      .send({
        data: {
          schemaVersion: 1,
          enrollmentToken: enrollment.token,
          expiresAt: enrollment.expiresAt,
          exchangeUrl: "/api/v1/worker-enrollments/exchange",
        },
      });
  });

  app.post("/api/v1/worker-enrollments/exchange", async (request, reply) => {
    const exchange = WorkerEnrollmentExchangeSchema.safeParse(request.body);
    if (!exchange.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "设备接入请求格式不正确",
        validationDetails(exchange.error),
      );
    }
    const grant = await workerEnrollments.authorize(
      exchange.data.enrollmentToken,
      exchange.data.accountFingerprint,
    );
    if (!grant) {
      throw new ApplicationError(
        401,
        "invalid_worker_enrollment",
        "设备接入码无效、已过期或已经使用",
      );
    }
    const connected = await workers.connect(
      grant.principal,
      {
        schemaVersion: 1,
        deviceName: grant.deviceName,
        accountName: grant.accountName,
        accountFingerprint: exchange.data.accountFingerprint,
        capabilities: exchange.data.capabilities,
      },
      {
        enrollmentKey: createHash("sha256")
          .update("forgex-worker-enrollment:v1\0", "utf8")
          .update(exchange.data.enrollmentToken, "utf8")
          .digest("hex"),
        sessionKey: createHash("sha256")
          .update("forgex-worker-session:v1\0", "utf8")
          .update(exchange.data.enrollmentToken, "utf8")
          .digest("base64url"),
      },
    );
    return reply
      .header("Cache-Control", "no-store")
      .header("Pragma", "no-cache")
      .status(201)
      .send({ data: connected });
  });

  app.get("/api/v1/workers", async (request, reply) => {
    const principal = principalFrom(request);
    const overview = await workers.overviewForPeople(principal);
    return reply.send({
      data: overview.workers,
      meta: overview.capacity,
      links: {
        actions: canConnectWorker(principal)
          ? { connect: "/api/v1/worker-enrollments" }
          : {},
      },
    });
  });

  app.post(
    "/api/v1/requirements/:requirementKey/start-delivery",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new ApplicationError(
          404,
          "requirement_not_found",
          "没有找到这个需求",
        );
      }
      const command = StartDeliveryCommandSchema.safeParse(request.body);
      if (!command.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "交付安排需要调整",
          validationDetails(command.error),
        );
      }
      return reply.status(202).send({
        data: await deliveries.requestDelivery(
          principal,
          params.data.requirementKey,
          command.data,
        ),
      });
    },
  );

  app.post(
    "/api/v1/requirements/:requirementKey/accept",
    async (request, reply) => {
      const principal = principalFrom(request);
      const params = requirementParamsSchema.safeParse(request.params);
      const body = emptyCommandSchema.safeParse(request.body ?? {});
      if (!params.success) {
        throw new ApplicationError(
          404,
          "requirement_not_found",
          "没有找到这个需求",
        );
      }
      if (!body.success) {
        throw new ApplicationError(
          422,
          "validation_error",
          "验收请求需要调整",
          validationDetails(body.error),
        );
      }
      const result = await requirements.accept(
        principal,
        params.data.requirementKey,
      );
      return reply.send({ data: result.view });
    },
  );

  app.post("/api/v1/worker-connection/heartbeat", async (request, reply) => {
    const body = emptyCommandSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "心跳内容需要调整",
        validationDetails(body.error),
      );
    }
    return reply.send({
      data: await workers.heartbeat(workerConnectionFrom(request)),
    });
  });

  app.post("/api/v1/worker-connection/poll", async (request, reply) => {
    const body = emptyCommandSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "领取请求需要调整",
        validationDetails(body.error),
      );
    }
    const connection = workerConnectionFrom(request);
    await workers.assertConnection(connection);
    await deliveries.flushCompleted(connection.tenantKey);
    await deliveries.flushPending(connection.tenantKey);
    await mcpInvocations.flushQueuedToWorkers(connection.tenantKey, workers);
    const result = await workers.poll(connection);
    const assignmentForWorker = result.assignment
      ? (({
          workerKey: _workerKey,
          generation: _generation,
          workerFingerprintHash: _workerFingerprintHash,
          ...assignment
        }) => assignment)(result.assignment)
      : null;
    if (result.assignment?.workKind === "requirement_delivery") {
      const execution = await deliveries.executionForWorker(
        connection.tenantKey,
        {
          workKind: "requirement_delivery",
          projectKey: result.assignment.projectKey,
          requirementKey: result.assignment.requirementKey,
          requirementRevision: result.assignment.requirementRevision,
          title: result.assignment.title,
        },
      );
      return reply.send({
        data: { assignment: { ...assignmentForWorker!, execution } },
      });
    }
    if (!result.assignment) {
      return reply.send({ data: { assignment: null } });
    }
    try {
      const execution = await mcpInvocations.leaseForExecution(
        connection.tenantKey,
        result.assignment,
      );
      return reply.send({
        data: { assignment: { ...assignmentForWorker!, execution } },
      });
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          "mcp_invocation_stale",
          "mcp_invocation_state_conflict",
          "mcp_invocation_not_found",
          "expired_lease",
          "mcp_outcome_unknown",
        ].includes(error.code)
      ) {
        await workers.cancelMcpLease(connection, {
          schemaVersion: 1,
          assignmentKey: result.assignment.assignmentKey,
          fencingToken: result.assignment.fencingToken,
        });
        if (error.code === "mcp_invocation_stale") {
          await mcpInvocations.finalizeCancellation(
            connection.tenantKey,
            result.assignment.projectKey,
            result.assignment.invocationKey!,
          );
        }
        if (error.code === "mcp_outcome_unknown") {
          await mcpInvocations.finalizeOutcomeUnknownCleanup(
            connection.tenantKey,
            result.assignment.projectKey,
            result.assignment.invocationKey!,
          );
        }
        return reply.send({ data: { assignment: null } });
      }
      throw error;
    }
  });

  app.post("/api/v1/worker-connection/renew", async (request, reply) => {
    const command = WorkerLeaseCommandSchema.safeParse(request.body);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "任务租约信息需要调整",
        validationDetails(command.error),
      );
    }
    const connection = workerConnectionFrom(request);
    const result = await workers.renew(connection, command.data);
    const assignment = await workers.getCurrentLease(connection, command.data);
    try {
      await mcpInvocations.renewExecutionLease(
        connection.tenantKey,
        assignment,
      );
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        ["expired_lease", "mcp_outcome_unknown"].includes(error.code)
      ) {
        await workers.cancelMcpLease(connection, command.data);
        if (error.code === "mcp_outcome_unknown") {
          await mcpInvocations.finalizeOutcomeUnknownCleanup(
            connection.tenantKey,
            assignment.projectKey,
            assignment.invocationKey!,
          );
        }
      }
      throw error;
    }
    return reply.send({ data: result });
  });

  app.post("/api/v1/worker-connection/complete", async (request, reply) => {
    const command = WorkerRequirementCompletionSchema.safeParse(request.body);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "任务租约信息需要调整",
        validationDetails(command.error),
      );
    }
    const connection = workerConnectionFrom(request);
    const leaseCommand = {
      schemaVersion: 1 as const,
      assignmentKey: command.data.assignmentKey,
      fencingToken: command.data.fencingToken,
    };
    const deliveryScope = {
      tenantKey: connection.tenantKey,
      projectKey: command.data.projectKey,
      requirementKey: command.data.requirementKey,
      requirementRevision: command.data.requirementRevision,
    };
    const completionProof = {
      assignmentKey: command.data.assignmentKey,
      fencingToken: command.data.fencingToken,
      completionDigest: requirementCompletionDigest(command.data),
    };
    let completionResult: { alreadyCompleted: boolean };
    try {
      const assignment = await workers.getCurrentLease(
        connection,
        leaseCommand,
      );
      if (assignment.workKind !== "requirement_delivery") {
        throw new ApplicationError(
          409,
          "mcp_completion_required",
          "MCP 调用必须通过受控结果入口完成",
        );
      }
      if (
        assignment.projectKey !== command.data.projectKey ||
        assignment.requirementKey !== command.data.requirementKey ||
        assignment.requirementRevision !== command.data.requirementRevision
      ) {
        throw new ApplicationError(
          409,
          "delivery_completion_mismatch",
          "交付结果没有绑定当前设备任务",
        );
      }
      const execution = await deliveries.executionForWorker(
        connection.tenantKey,
        {
          workKind: "requirement_delivery",
          projectKey: assignment.projectKey,
          requirementKey: assignment.requirementKey,
          requirementRevision: assignment.requirementRevision,
          title: assignment.title,
        },
      );
      if (
        execution.repositoryKey !== command.data.repositoryKey ||
        command.data.branchName !==
          `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`
      ) {
        throw new ApplicationError(
          409,
          "delivery_completion_stale",
          "交付结果不再对应当前需求、仓库或设备租约",
        );
      }
      completionResult = await workers.complete(
        connection,
        leaseCommand,
        completionProof.completionDigest,
      );
    } catch (error) {
      if (
        !(error instanceof ApplicationError) ||
        error.code !== "invalid_lease" ||
        !(await workers.isRequirementDeliveryCompleted(
          deliveryScope,
          completionProof,
        ))
      ) {
        throw error;
      }
      completionResult = { alreadyCompleted: true };
    }
    if (
      !(await workers.isRequirementDeliveryCompleted(
        deliveryScope,
        completionProof,
      ))
    ) {
      throw new ApplicationError(
        409,
        "delivery_completion_mismatch",
        "交付结果与设备永久完成证明不一致",
      );
    }
    const run = await deliveries.submitExecutionResult(
      connection.tenantKey,
      {
        workKind: "requirement_delivery",
        assignmentKey: command.data.assignmentKey,
        fencingToken: command.data.fencingToken,
        projectKey: command.data.projectKey,
        requirementKey: command.data.requirementKey,
        requirementRevision: command.data.requirementRevision,
      },
      command.data,
    );
    await deliveries.finalizeExecutionResult(run);
    return reply.send({ data: completionResult });
  });

  app.post("/api/v1/worker-connection/mcp-complete", async (request, reply) => {
    const command = WorkerMcpCompletionSchema.safeParse(request.body);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "MCP 执行结果需要调整",
        validationDetails(command.error),
      );
    }
    const connection = workerConnectionFrom(request);
    const leaseCommand = {
      schemaVersion: 1 as const,
      assignmentKey: command.data.assignmentKey,
      fencingToken: command.data.fencingToken,
    };
    if (command.data.outcome === "unknown") {
      await workers.assertConnection(connection);
      await mcpInvocations.reportExecutionOutcomeUnknown(connection.tenantKey, {
        projectKey: command.data.projectKey,
        invocationKey: command.data.invocationKey,
        assignmentKey: command.data.assignmentKey,
        fencingToken: command.data.fencingToken,
        workerKey: connection.workerKey,
        workerGeneration: connection.generation,
      });
      await workers.cancelMcpLease(connection, leaseCommand);
      await mcpInvocations.finalizeOutcomeUnknownCleanup(
        connection.tenantKey,
        command.data.projectKey,
        command.data.invocationKey,
      );
      return reply.send({ data: { alreadyCompleted: false } });
    }
    let currentAssignment;
    try {
      currentAssignment = await workers.getMcpLease(connection, leaseCommand);
    } catch (error) {
      if (
        !(error instanceof ApplicationError) ||
        error.code !== "invalid_lease"
      ) {
        throw error;
      }
      const recovered = await workers.completeMcp(connection, leaseCommand);
      await mcpInvocations.finalizeExecutionResult(
        connection.tenantKey,
        recovered.completion,
      );
      return reply.send({ data: recovered });
    }
    await mcpInvocations.completeExecution(
      connection.tenantKey,
      currentAssignment,
      {
        outcome: command.data.outcome,
        summary: command.data.summary,
      },
    );
    const result = await workers.completeMcp(connection, leaseCommand);
    await mcpInvocations.finalizeExecutionResult(
      connection.tenantKey,
      result.completion,
    );
    return reply.send({ data: result });
  });

  return app;
};
