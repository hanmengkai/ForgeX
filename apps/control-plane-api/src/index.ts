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
  KnowledgeBaseApplicationService,
  KnowledgeBaseCreateCommandSchema,
  KnowledgeSearchCommandSchema,
  KnowledgeSourcePublishCommandSchema,
  McpInvocationApplicationService,
  McpRegistryApplicationService,
  RequirementApplicationService,
  SkillRegistryApplicationService,
  WorkerFleetService,
  canPerformRequirementAction,
  type AuthenticatedPrincipal,
  type ExtensionCatalogRepository,
  type McpRegistryRepository,
  type KnowledgeBaseRepository,
  type McpInputSchemaStore,
  type McpInvocationRepository,
  type PlatformRole,
  type PreviewArtifactStore,
  type RequirementRepository,
  type SessionAuthenticator,
  type SkillArtifactStore,
  type SkillRegistryRepository,
  type WorkerFleetRepository,
} from "@forgex/application";
import {
  REQUIREMENT_REQUEST_BODY_LIMIT_BYTES,
  McpInvocationRequestSchema,
  RequirementSpecSchema,
  StartDeliveryCommandSchema,
  WorkerConnectionCredentialSchema,
  WorkerLeaseCommandSchema,
  WorkerMcpCompletionSchema,
  WorkerRegistrationSchema,
  type WorkerConnectionCredentialPayload,
  type McpInvocationRequestPayload,
} from "@forgex/contracts";
import type { RequirementAllowedAction } from "@forgex/domain";
import type {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";

declare module "fastify" {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
    workerConnection: WorkerConnectionCredentialPayload | null;
  }
}

export interface ControlPlaneApiOptions {
  authenticator: SessionAuthenticator;
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
  projectKey: string;
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
const emptyCommandSchema = z.object({}).strict();
const requirementListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
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
    submitConfirmation?: string;
    confirm?: string;
    startDelivery?: string;
    accept?: string;
  } = {};
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
const PREVIEW_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
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
    <header><strong>ForgeX 可信预览</strong><span>已隔离外部连接与页面跳转</span></header>
    <iframe id="forgex-preview" title="已验证的产品效果" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
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
  const requirements = new RequirementApplicationService({
    repository: options.requirementRepository,
    projectKey: options.projectKey,
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
  const deliveries = new DeliveryCoordinatorService({
    requirements,
    requirementRepository: options.requirementRepository,
    workers,
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

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/v1/worker-connection/")) {
      request.workerConnection = authenticateWorkerHeaders(request);
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
      path.startsWith("/api/v1/workers/")
    ) {
      const credential = requestSessionCredential(request);
      request.principal = await authenticate(credential.authorization);
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

  app.setErrorHandler((error, _request, reply) => {
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

  app.post("/api/v1/workers", async (request, reply) => {
    const principal = principalFrom(request);
    const registration = WorkerRegistrationSchema.safeParse(request.body);
    if (!registration.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "设备连接信息需要调整",
        validationDetails(registration.error),
      );
    }
    return reply
      .status(201)
      .send({ data: await workers.connect(principal, registration.data) });
  });

  app.get("/api/v1/workers", async (request, reply) => {
    const principal = principalFrom(request);
    const overview = await workers.overviewForPeople(principal);
    return reply.send({
      data: overview.workers,
      meta: overview.capacity,
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
    if (result.assignment?.workKind !== "mcp_invocation") {
      return reply.send({ data: { assignment: assignmentForWorker } });
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
    const command = WorkerLeaseCommandSchema.safeParse(request.body);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "validation_error",
        "任务租约信息需要调整",
        validationDetails(command.error),
      );
    }
    return reply.send({
      data: await workers.complete(workerConnectionFrom(request), command.data),
    });
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
