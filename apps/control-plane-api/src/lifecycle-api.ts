import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ApplicationError,
  type AuthenticatedPrincipal,
  type LifecycleService,
  type LifecycleArtifactStore,
  verifyLifecycleArtifact,
} from "@forgex/application";
import {
  LifecycleArtifactAccessSchema,
  LifecycleArtifactEnvelopeSchema,
  type LifecycleExecutorPrincipal,
} from "@forgex/contracts/lifecycle";

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
    artifactStore?: LifecycleArtifactStore;
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
  const transferSchema = z
    .object({
      access: LifecycleArtifactAccessSchema,
      envelope: LifecycleArtifactEnvelopeSchema,
    })
    .strict();
  app.post(
    "/api/v2/executor/jobs/:jobKey/artifacts",
    { bodyLimit: 256 * 1024 },
    async (request) => {
      if (!options.artifactStore)
        throw new ApplicationError(
          503,
          "artifact_store_unavailable",
          "制品交接服务尚未配置",
        );
      const parsed = transferSchema.safeParse(request.body);
      if (!parsed.success)
        throw new ApplicationError(
          422,
          "validation_error",
          "制品交接格式不正确",
        );
      const executor = options.executor(request);
      await options.service.authorizeArtifact(
        executor,
        key(request, "jobKey"),
        parsed.data.access,
        "upload",
      );
      try {
        verifyLifecycleArtifact(parsed.data.envelope);
      } catch {
        throw new ApplicationError(
          422,
          "artifact_invalid",
          "制品摘要或内容大小不正确",
        );
      }
      await options.artifactStore.put(executor, parsed.data.envelope);
      return {
        data: {
          schemaVersion: 1,
          artifactDigest: parsed.data.envelope.artifactDigest,
        },
      };
    },
  );
  app.post("/api/v2/executor/jobs/:jobKey/artifacts/read", async (request) => {
    if (!options.artifactStore)
      throw new ApplicationError(
        503,
        "artifact_store_unavailable",
        "制品交接服务尚未配置",
      );
    const parsed = z
      .object({
        access: LifecycleArtifactAccessSchema,
        artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      throw new ApplicationError(422, "validation_error", "制品读取格式不正确");
    const executor = options.executor(request),
      { access, artifactDigest, commitSha } = parsed.data;
    const input = await options.service.authorizeArtifact(
      executor,
      key(request, "jobKey"),
      access,
      "download",
    );
    if (
      !input.artifacts.some(
        (a) =>
          a.output.kind === "code" &&
          a.output.artifactDigest === artifactDigest &&
          a.output.commitSha === commitSha,
      )
    )
      throw new ApplicationError(
        403,
        "artifact_scope_denied",
        "当前任务没有获批使用这个制品",
      );
    const envelope = await options.artifactStore.get(
      executor,
      artifactDigest,
      commitSha,
    );
    if (!envelope)
      throw new ApplicationError(
        404,
        "artifact_not_found",
        "没有找到已交接制品，请联系研发负责人",
      );
    return { data: envelope };
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v2/"))
      reply.header("Cache-Control", "no-store");
    return payload;
  });
};
