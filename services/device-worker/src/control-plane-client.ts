import { z } from "zod";

import {
  RequirementExecutionEnvelopeSchema,
  WorkerConnectionCredentialSchema,
  WorkerLeaseCommandSchema,
  WorkerMcpCompletionSchema,
  WorkerRequirementProcessEventSchema,
  WorkerRequirementLogChunkSchema,
  WorkerRequirementCompletionSchema,
  type CodexProcessEventPayload,
  type CodexTerminalLogChunkPayload,
  type WorkerConnectionCredentialPayload,
} from "@forgex/contracts";

import { ControlPlaneOriginSchema } from "./config.js";
import type { PendingRequirementCompletion } from "./completion-journal.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const readableText = z.string().trim().min(2).max(500);
const assignmentBase = {
  assignmentKey: internalKey,
  fencingToken: z.number().int().positive(),
  projectKey: internalKey,
  requirementRevision: z.number().int().positive().max(10_000),
  requirementKey: internalKey,
  title: z.string().trim().min(2).max(150),
  leasedUntil: z.iso.datetime(),
} as const;

export const RequirementWorkerAssignmentSchema = z
  .object({
    ...assignmentBase,
    workKind: z.literal("requirement_delivery"),
    execution: RequirementExecutionEnvelopeSchema,
  })
  .strict()
  .superRefine((assignment, context) => {
    if (
      assignment.projectKey !== assignment.execution.projectKey ||
      assignment.requirementKey !== assignment.execution.requirementKey ||
      assignment.requirementRevision !==
        assignment.execution.requirementRevision ||
      assignment.title !== assignment.execution.spec.title
    ) {
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "设备任务与权威需求执行信封不一致",
      });
    }
  });

const McpExecutionEnvelopeSchema = z
  .object({
    connectionBindingKey: internalKey,
    protocolVersion: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/u),
    serverIdentityHashAlgorithm: z.literal("sha256"),
    serverIdentityHash: z.string().regex(/^[a-f0-9]{64}$/u),
    serviceName: readableText,
    toolName: readableText,
    technicalName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    transport: z.enum(["stdio", "streamable_http"]),
    effect: z.enum(["read", "write", "external_action"]),
    serverRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    manifestHashAlgorithm: z.literal("sha256"),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    inputSchemaHashAlgorithm: z.literal("sha256"),
    inputSchemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
    argumentsHashAlgorithm: z.literal("sha256"),
    argumentsHash: z.string().regex(/^[a-f0-9]{64}$/u),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const McpWorkerAssignmentSchema = z
  .object({
    ...assignmentBase,
    workKind: z.literal("mcp_invocation"),
    invocationKey: internalKey,
    execution: McpExecutionEnvelopeSchema,
  })
  .strict();

export const WorkerAssignmentSchema = z.discriminatedUnion("workKind", [
  RequirementWorkerAssignmentSchema,
  McpWorkerAssignmentSchema,
]);

export type WorkerAssignment = z.infer<typeof WorkerAssignmentSchema>;
export type RequirementWorkerAssignment = z.infer<
  typeof RequirementWorkerAssignmentSchema
>;
export type McpWorkerAssignment = z.infer<typeof McpWorkerAssignmentSchema>;

const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().trim().min(1).max(100),
        message: z.string().trim().min(1).max(500),
      })
      .strict(),
  })
  .strict();

const pollResponseSchema = z
  .object({
    data: z.object({ assignment: WorkerAssignmentSchema.nullable() }).strict(),
  })
  .strict();
const heartbeatResponseSchema = z
  .object({ data: z.object({ status: z.literal("在线") }).strict() })
  .strict();
const renewResponseSchema = z
  .object({ data: z.object({ leasedUntil: z.iso.datetime() }).strict() })
  .strict();
const completionResponseSchema = z
  .object({
    data: z.object({ alreadyCompleted: z.boolean() }).passthrough(),
  })
  .strict();
const processEventResponseSchema = z
  .object({
    data: z.object({ alreadyRecorded: z.boolean() }).strict(),
  })
  .strict();
const logChunkResponseSchema = z
  .object({
    data: z.object({ alreadyStored: z.boolean() }).strict(),
  })
  .strict();

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

const responseLimitBytes = 1_048_576;

export const readBoundedControlPlaneResponse = async (
  response: Response,
): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > responseLimitBytes) {
    throw new ControlPlaneClientError(
      502,
      "response_too_large",
      "控制面返回内容超过设备协议上限",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > responseLimitBytes) {
        await reader.cancel("response_too_large");
        throw new ControlPlaneClientError(
          502,
          "response_too_large",
          "控制面返回内容超过设备协议上限",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
};

export class ControlPlaneClientError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneClientError";
  }
}

export class WorkerControlPlaneClient {
  readonly #baseUrl: string;
  readonly #connection: WorkerConnectionCredentialPayload;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;

  constructor(options: {
    baseUrl: string;
    connection: WorkerConnectionCredentialPayload;
    requestTimeoutMs?: number;
    fetch?: FetchLike;
  }) {
    this.#baseUrl = ControlPlaneOriginSchema.parse(options.baseUrl);
    this.#connection = WorkerConnectionCredentialSchema.parse(
      options.connection,
    );
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#requestTimeoutMs = z
      .number()
      .int()
      .min(100)
      .max(10_000)
      .parse(options.requestTimeoutMs ?? 5_000);
  }

  async heartbeat(signal?: AbortSignal): Promise<void> {
    await this.#post(
      "/api/v1/worker-connection/heartbeat",
      {},
      heartbeatResponseSchema,
      signal,
    );
  }

  async poll(signal?: AbortSignal): Promise<WorkerAssignment | null> {
    const response = await this.#post(
      "/api/v1/worker-connection/poll",
      {},
      pollResponseSchema,
      signal,
    );
    return response.data.assignment;
  }

  async renew(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken">,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.#post(
      "/api/v1/worker-connection/renew",
      WorkerLeaseCommandSchema.parse({
        schemaVersion: 1,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
      }),
      renewResponseSchema,
      signal,
    );
    return response.data.leasedUntil;
  }

  async completeRequirement(
    assignment: PendingRequirementCompletion["assignment"],
    result: PendingRequirementCompletion["result"],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.#post(
      "/api/v1/worker-connection/complete",
      WorkerRequirementCompletionSchema.parse({
        schemaVersion: 1,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
        projectKey: assignment.projectKey,
        repositoryKey: assignment.repositoryKey,
        requirementKey: assignment.requirementKey,
        requirementRevision: assignment.requirementRevision,
        gitHashAlgorithm: result.gitHashAlgorithm,
        baseCommit: result.baseCommit,
        commitSha: result.commitSha,
        branchName: result.branchName,
        summary: result.summary,
      }),
      completionResponseSchema,
      signal,
    );
    return response.data.alreadyCompleted;
  }

  async reportRequirementProgress(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken">,
    progress: {
      eventKey: string;
      sequence: number;
      occurredAt: string;
      event: CodexProcessEventPayload;
    },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.#post(
      "/api/v1/worker-connection/requirement-progress",
      WorkerRequirementProcessEventSchema.parse({
        schemaVersion: 1,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
        ...progress,
      }),
      processEventResponseSchema,
      signal,
    );
    return response.data.alreadyRecorded;
  }

  async reportRequirementLog(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken">,
    chunk: {
      chunkKey: string;
      sequence: number;
      occurredAt: string;
      stream: CodexTerminalLogChunkPayload["stream"];
      text: string;
    },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.#post(
      "/api/v1/worker-connection/requirement-log",
      WorkerRequirementLogChunkSchema.parse({
        schemaVersion: 1,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
        ...chunk,
      }),
      logChunkResponseSchema,
      signal,
    );
    return response.data.alreadyStored;
  }

  async completeMcp(
    assignment: Pick<WorkerAssignment, "assignmentKey" | "fencingToken"> &
      Partial<Pick<McpWorkerAssignment, "projectKey" | "invocationKey">>,
    result: {
      outcome: "succeeded" | "failed" | "unknown";
      summary: string;
    },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const scope =
      result.outcome === "unknown"
        ? {
            projectKey: assignment.projectKey,
            invocationKey: assignment.invocationKey,
          }
        : {};
    const response = await this.#post(
      "/api/v1/worker-connection/mcp-complete",
      WorkerMcpCompletionSchema.parse({
        schemaVersion: 1,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
        ...scope,
        outcome: result.outcome,
        summary: result.summary,
      }),
      completionResponseSchema,
      signal,
    );
    return response.data.alreadyCompleted;
  }

  async #post<T>(
    pathname: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("control_plane_request_timeout"));
    }, this.#requestTimeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Worker ${this.#connection.sessionKey}`,
          "Content-Type": "application/json",
          "X-ForgeX-Tenant-Key": this.#connection.tenantKey,
          "X-ForgeX-Worker-Key": this.#connection.workerKey,
          "X-ForgeX-Worker-Generation": String(this.#connection.generation),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await readBoundedControlPlaneResponse(response);
    } catch (error) {
      if (timedOut) {
        throw new ControlPlaneClientError(
          504,
          "request_timeout",
          "控制面请求超时，设备稍后会安全重试",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ControlPlaneClientError(
        502,
        "invalid_response",
        "控制面返回了无法识别的内容",
      );
    }
    if (!response.ok) {
      const error = errorResponseSchema.safeParse(json);
      throw new ControlPlaneClientError(
        response.status,
        error.success ? error.data.error.code : "control_plane_error",
        error.success ? error.data.error.message : "控制面暂时无法完成设备请求",
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ControlPlaneClientError(
        502,
        "invalid_response",
        "控制面返回内容不符合设备协议",
      );
    }
    return parsed.data;
  }
}
