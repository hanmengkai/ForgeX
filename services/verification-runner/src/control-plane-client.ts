import { z } from "zod";

import {
  EvidenceCheckSchema,
  SignedEvidenceSchema,
  type EvidenceCheck,
  type SignedEvidence,
} from "@forgex/contracts";

import {
  VerificationRunnerTargetSchema,
  type VerificationRunnerTarget,
} from "./model.js";

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export const RunnerControlPlaneOriginSchema = z
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "::1"].includes(url.hostname))),
    "Runner 控制面必须使用 HTTPS，本机开发可使用回环 HTTP",
  )
  .transform((url) => url.origin);

export const RunnerSessionKeySchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

const listResponseSchema = z
  .object({
    data: z.array(VerificationRunnerTargetSchema).max(100),
    meta: z.object({ count: z.number().int().min(0).max(100) }).strict(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.meta.count !== response.data.length) {
      context.addIssue({
        code: "custom",
        path: ["meta", "count"],
        message: "Runner 任务数量元数据不一致",
      });
    }
  });

const previewResponseSchema = z
  .object({
    data: z
      .object({
        status: z.literal("preview_recorded"),
        requirementRevision: z.number().int().positive().max(10_000),
      })
      .strict(),
  })
  .strict();

const evidenceResponseSchema = z
  .object({
    data: z
      .object({
        status: z.string().trim().min(2).max(100),
        acceptanceProgress: z
          .object({
            completed: z.number().int().min(0),
            total: z.number().int().min(0),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const failureResponseSchema = z
  .object({
    data: z
      .object({
        status: z.literal("verification_failed_recorded"),
        requirementRevision: z.number().int().positive().max(10_000),
      })
      .strict(),
  })
  .strict();

const errorResponseSchema = z
  .object({
    error: z.object({ code: z.string().trim().min(1).max(100) }).passthrough(),
  })
  .strict();

const RESPONSE_LIMIT_BYTES = 1_048_576;

const readBoundedResponse = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > RESPONSE_LIMIT_BYTES
  ) {
    throw new RunnerControlPlaneClientError(
      502,
      "response_too_large",
      "控制面响应超过 Runner 协议上限",
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
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel("response_too_large");
        throw new RunnerControlPlaneClientError(
          502,
          "response_too_large",
          "控制面响应超过 Runner 协议上限",
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

export class RunnerControlPlaneClientError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerControlPlaneClientError";
  }
}

export class RunnerControlPlaneClient {
  readonly #baseUrl: string;
  readonly #sessionKey: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;

  constructor(options: {
    baseUrl: string;
    sessionKey: string;
    requestTimeoutMs?: number;
    fetch?: FetchLike;
  }) {
    this.#baseUrl = RunnerControlPlaneOriginSchema.parse(options.baseUrl);
    this.#sessionKey = RunnerSessionKeySchema.parse(options.sessionKey);
    this.#requestTimeoutMs = z
      .number()
      .int()
      .min(100)
      .max(30_000)
      .parse(options.requestTimeoutMs ?? 5_000);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async listPending(limit = 20): Promise<VerificationRunnerTarget[]> {
    const pageSize = z.number().int().min(1).max(100).parse(limit);
    const response = await this.#request(
      `/api/v1/runner/verification-targets?limit=${pageSize}`,
      { method: "GET" },
      listResponseSchema,
    );
    return response.data;
  }

  async publishPreview(
    targetInput: VerificationRunnerTarget,
    content: Uint8Array,
    artifactHash: string,
  ): Promise<void> {
    const target = VerificationRunnerTargetSchema.parse(targetInput);
    const hash = z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(artifactHash);
    const response = await this.#request(
      `/api/v1/runner/verification-targets/${target.requirementKey}/preview`,
      {
        method: "PUT",
        body: JSON.stringify({
          requirementRevision: target.requirementRevision,
          artifactHashAlgorithm: "sha256",
          artifactHash: hash,
          contentBase64: Buffer.from(content).toString("base64"),
        }),
      },
      previewResponseSchema,
    );
    if (response.data.requirementRevision !== target.requirementRevision) {
      throw new RunnerControlPlaneClientError(
        502,
        "invalid_response",
        "控制面返回了不一致的需求版本",
      );
    }
  }

  async submitEvidence(evidenceInput: SignedEvidence): Promise<void> {
    const evidence = SignedEvidenceSchema.parse(evidenceInput);
    await this.#request(
      "/api/v1/runner/evidence",
      { method: "POST", body: JSON.stringify(evidence) },
      evidenceResponseSchema,
    );
  }

  async reportFailure(
    targetInput: VerificationRunnerTarget,
    checksInput: EvidenceCheck[],
    verificationCompletedAt: string,
  ): Promise<void> {
    const target = VerificationRunnerTargetSchema.parse(targetInput);
    const checks = z
      .array(EvidenceCheckSchema)
      .min(1)
      .max(80)
      .parse(checksInput);
    const completedAt = z.iso.datetime().parse(verificationCompletedAt);
    const response = await this.#request(
      `/api/v1/runner/verification-targets/${target.requirementKey}/failure`,
      {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          requirementKey: target.requirementKey,
          requirementRevision: target.requirementRevision,
          verificationCompletedAt: completedAt,
          checks,
        }),
      },
      failureResponseSchema,
    );
    if (response.data.requirementRevision !== target.requirementRevision) {
      throw new RunnerControlPlaneClientError(
        502,
        "invalid_response",
        "控制面返回了不一致的需求版本",
      );
    }
  }

  async #request<T>(
    pathname: string,
    init: Pick<RequestInit, "method" | "body">,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("runner_control_plane_timeout"));
    }, this.#requestTimeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#baseUrl}${pathname}`, {
        ...init,
        headers:
          init.body === undefined
            ? {
                Authorization: `Runner ${this.#sessionKey}`,
                Accept: "application/json",
              }
            : {
                Authorization: `Runner ${this.#sessionKey}`,
                Accept: "application/json",
                "Content-Type": "application/json",
              },
        redirect: "error",
        signal: controller.signal,
      });
      text = await readBoundedResponse(response);
    } catch (error) {
      if (timedOut) {
        throw new RunnerControlPlaneClientError(
          504,
          "request_timeout",
          "Runner 请求控制面超时，将在稍后安全重试",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RunnerControlPlaneClientError(
        502,
        "invalid_response",
        "控制面返回了无法识别的 Runner 协议内容",
      );
    }
    if (!response.ok) {
      const remoteError = errorResponseSchema.safeParse(json);
      throw new RunnerControlPlaneClientError(
        response.status,
        remoteError.success
          ? remoteError.data.error.code
          : "control_plane_error",
        "控制面暂时无法完成 Runner 请求",
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new RunnerControlPlaneClientError(
        502,
        "invalid_response",
        "控制面返回内容不符合 Runner 协议",
      );
    }
    return parsed.data;
  }
}
