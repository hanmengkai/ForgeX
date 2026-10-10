import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ApplicationError,
  type AuthenticatedPrincipal,
  type LifecycleService,
} from "@forgex/application";
import type { LifecycleExecutorPrincipal } from "@forgex/contracts/lifecycle";

export interface LifecycleExecutorAuthenticator {
  authenticate(
    authorization: string | undefined,
  ): Promise<LifecycleExecutorPrincipal | null>;
}
export class HashedLifecycleExecutorAuthenticator implements LifecycleExecutorAuthenticator {
  constructor(
    readonly sessions: ReadonlyArray<{
      tokenSha256: string;
      executor: LifecycleExecutorPrincipal;
    }>,
  ) {}
  async authenticate(
    authorization: string | undefined,
  ): Promise<LifecycleExecutorPrincipal | null> {
    if (!authorization?.startsWith("Lifecycle ")) return null;
    const hash = createHash("sha256").update(authorization.slice(10)).digest();
    for (const session of this.sessions) {
      const expected = Buffer.from(session.tokenSha256, "hex");
      if (expected.length === hash.length && timingSafeEqual(hash, expected))
        return structuredClone(session.executor);
    }
    return null;
  }
}
export const registerLifecycleApi = (
  app: FastifyInstance,
  options: {
    service: LifecycleService;
    principal: (request: FastifyRequest) => AuthenticatedPrincipal;
    executor: (request: FastifyRequest) => LifecycleExecutorPrincipal;
    projectKey: string;
    repositoryKey: string;
  },
): void => {
  const key = (request: FastifyRequest, name: string): string => {
    const parsed = z
      .string()
      .uuid()
      .safeParse((request.params as Record<string, unknown>)[name]);
    if (!parsed.success)
      throw new ApplicationError(422, "validation_error", "交付标识格式不正确");
    return parsed.data;
  };
  app.get("/api/v2/lifecycle/context", async (request) => {
    const principal = options.principal(request);
    return {
      data: {
        schemaVersion: 2,
        projectKey: options.projectKey,
        repositoryKey: options.repositoryKey,
        actorKey: principal.actorKey,
        actorName: principal.actorName,
        roles: principal.roles,
      },
    };
  });
  app.get("/api/v2/lifecycle", async (request) => {
    const parsed = z
      .object({ projectKey: z.string().uuid().optional() })
      .strict()
      .safeParse(request.query);
    if (!parsed.success)
      throw new ApplicationError(422, "validation_error", "项目范围格式不正确");
    return {
      data: await options.service.list(
        options.principal(request),
        parsed.data.projectKey,
      ),
    };
  });
  app.post("/api/v2/lifecycle", async (request, reply) =>
    reply.status(201).send({
      data: await options.service.create(
        options.principal(request),
        request.body,
      ),
    }),
  );
  app.get("/api/v2/lifecycle/:workflowKey", async (request) => ({
    data: await options.service.get(
      options.principal(request),
      key(request, "workflowKey"),
    ),
  }));
  app.post("/api/v2/lifecycle/:workflowKey/decisions", async (request) => ({
    data: await options.service.decide(
      options.principal(request),
      key(request, "workflowKey"),
      request.body,
    ),
  }));
  app.post("/api/v2/lifecycle/:workflowKey/actions", async (request) => ({
    data: await options.service.action(
      options.principal(request),
      key(request, "workflowKey"),
      request.body,
    ),
  }));
  app.get("/api/v2/lifecycle/:workflowKey/bugs", async (request) => ({
    data: await options.service.listBugs(
      options.principal(request),
      key(request, "workflowKey"),
    ),
  }));
  app.post("/api/v2/lifecycle/:workflowKey/bugs", async (request, reply) =>
    reply.status(201).send({
      data: await options.service.reportBug(
        options.principal(request),
        key(request, "workflowKey"),
        request.body,
      ),
    }),
  );
  app.post("/api/v2/bugs/:bugKey/actions", async (request) => ({
    data: await options.service.repairBug(
      options.principal(request),
      key(request, "bugKey"),
      request.body,
    ),
  }));
  app.get("/api/v2/notifications", async (request) => ({
    data: await options.service.notifications(options.principal(request)),
  }));
  app.post(
    "/api/v2/notifications/:notificationKey/read",
    async (request, reply) => {
      const body = z
        .object({ schemaVersion: z.literal(2) })
        .strict()
        .safeParse(request.body);
      if (!body.success)
        throw new ApplicationError(
          422,
          "validation_error",
          "通知请求格式不正确",
        );
      await options.service.acknowledge(
        options.principal(request),
        key(request, "notificationKey"),
      );
      return reply.status(204).send();
    },
  );
  app.post("/api/v2/executor/claim", async (request) => {
    const body = z
      .object({ schemaVersion: z.literal(2) })
      .strict()
      .safeParse(request.body);
    if (!body.success)
      throw new ApplicationError(
        422,
        "validation_error",
        "任务领取请求格式不正确",
      );
    return { data: await options.service.claim(options.executor(request)) };
  });
  app.post("/api/v2/executor/jobs/:jobKey/renew", async (request) => ({
    data: await options.service.renew(
      options.executor(request),
      key(request, "jobKey"),
      request.body,
    ),
  }));
  app.post("/api/v2/executor/complete", async (request) => ({
    data: await options.service.complete(
      options.executor(request),
      request.body,
    ),
  }));
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v2/"))
      reply.header("Cache-Control", "no-store");
    return payload;
  });
};
