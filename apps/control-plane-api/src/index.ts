import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z } from "zod";

import {
  ApplicationError,
  DeliveryCoordinatorService,
  RequirementApplicationService,
  WorkerFleetService,
  canPerformRequirementAction,
  type AuthenticatedPrincipal,
  type PlatformRole,
  type RequirementRepository,
  type SessionAuthenticator,
  type WorkerFleetRepository,
} from "@forgex/application";
import {
  REQUIREMENT_REQUEST_BODY_LIMIT_BYTES,
  RequirementSpecSchema,
  StartDeliveryCommandSchema,
  WorkerConnectionCredentialSchema,
  WorkerLeaseCommandSchema,
  WorkerRegistrationSchema,
  type WorkerConnectionCredentialPayload,
} from "@forgex/contracts";
import type { RequirementAllowedAction } from "@forgex/domain";

declare module "fastify" {
  interface FastifyRequest {
    principal: AuthenticatedPrincipal | null;
    workerConnection: WorkerConnectionCredentialPayload | null;
  }
}

export interface ControlPlaneApiOptions {
  authenticator: SessionAuthenticator;
  requirementRepository: RequirementRepository;
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
) => {
  const self = `/api/v1/requirements/${requirementKey}`;
  const actions: {
    submitConfirmation?: string;
    confirm?: string;
    startDelivery?: string;
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
  return { self, actions };
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
      path === "/api/v1/workers" ||
      path.startsWith("/api/v1/workers/")
    ) {
      request.principal = await authenticate(request.headers.authorization);
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
        links: requirementLinks(
          result.requirementKey,
          result.allowedActions,
          principal,
        ),
      },
    });
  });

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
    return reply.send({ data: await workers.listForPeople(principal) });
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
    return reply.send({ data: await workers.poll(connection) });
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
    return reply.send({
      data: await workers.renew(workerConnectionFrom(request), command.data),
    });
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

  return app;
};
