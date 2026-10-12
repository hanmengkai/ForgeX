import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LifecycleArtifactEnvelopeSchema,
  type LifecycleArtifactEnvelope,
  type LifecycleJob,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import { ControlPlaneOriginSchema } from "./config.js";
import {
  assertLifecyclePrivatePath,
  LifecycleDeliveryUnavailableError,
} from "./lifecycle-runtime.js";
import type {
  LifecycleCandidatePipeline,
  LifecycleTestPlan,
} from "./lifecycle-codex-adapter.js";
import type { SampleLifecycleAdapter } from "./lifecycle-sample-adapter.js";

export async function savePrivateJson(
  file: string,
  value: unknown,
): Promise<void> {
  await savePrivateBytes(file, Buffer.from(JSON.stringify(value)));
}
export async function savePrivateBytes(
  file: string,
  bytes: Buffer,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertLifecyclePrivatePath(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`,
    handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    if (process.platform !== "win32") {
      const dir = await open(path.dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
export function decodeLifecycleArtifact(
  envelope: LifecycleArtifactEnvelope,
): Buffer {
  const parsed = LifecycleArtifactEnvelopeSchema.parse(envelope),
    bytes = Buffer.from(parsed.bytesBase64, "base64");
  if (
    bytes.length > 128 * 1024 ||
    bytes.toString("base64") !== parsed.bytesBase64 ||
    createHash("sha256").update(bytes).digest("hex") !== parsed.artifactDigest
  )
    throw new Error("交接制品摘要不匹配或大小超限");
  return bytes;
}
export class HttpLifecycleArtifactClient {
  readonly origin: string;
  constructor(
    readonly options: { origin: string; token: string; fetcher?: typeof fetch },
  ) {
    this.origin = ControlPlaneOriginSchema.parse(options.origin);
    if (options.token.length < 20 || /[\r\n]/u.test(options.token))
      throw new Error("制品交接令牌不正确");
  }
  async #request(
    job: LifecycleJob,
    suffix: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(
        new URL(
          `/api/v2/executor/jobs/${job.jobKey}/artifacts${suffix}`,
          this.origin,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Lifecycle ${this.options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
          redirect: "error",
        },
      );
    } catch {
      throw new LifecycleDeliveryUnavailableError(
        "制品交接连接中断，等待恢复核对",
      );
    }
    if (response.status >= 500 || [408, 429].includes(response.status))
      throw new LifecycleDeliveryUnavailableError(
        "制品交接暂时不可用，等待恢复核对",
      );
    if (!response.ok)
      throw new Error(`制品交接失败（${response.status}），本地执行记录已保留`);
    if (!response.body) throw new Error("制品交接返回空响应");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 256 * 1024) throw new Error("制品交接响应超过上限");
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("超过上限"))
        throw error;
      throw new LifecycleDeliveryUnavailableError(
        "制品交接确认中断，等待恢复核对",
      );
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  #access(job: LifecycleJob) {
    return {
      schemaVersion: 2,
      fencingToken: job.fencingToken,
      inputDigest: job.inputDigest,
    };
  }
  async put(
    job: LifecycleJob,
    envelope: LifecycleArtifactEnvelope,
    signal: AbortSignal,
  ): Promise<void> {
    decodeLifecycleArtifact(envelope);
    const receipt = z
      .object({
        data: z
          .object({ schemaVersion: z.literal(1), artifactDigest: z.string() })
          .strict(),
      })
      .strict()
      .parse(
        await this.#request(
          job,
          "",
          { access: this.#access(job), envelope },
          signal,
        ),
      );
    if (receipt.data.artifactDigest !== envelope.artifactDigest)
      throw new Error("制品交接确认摘要不匹配");
  }
  async get(
    job: LifecycleJob,
    artifactDigest: string,
    commitSha: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const envelope = z
      .object({ data: LifecycleArtifactEnvelopeSchema })
      .strict()
      .parse(
        await this.#request(
          job,
          "/read",
          { access: this.#access(job), artifactDigest, commitSha },
          signal,
        ),
      ).data;
    if (
      envelope.artifactDigest !== artifactDigest ||
      envelope.commitSha !== commitSha
    )
      throw new Error("交接制品未绑定已批准提交");
    return decodeLifecycleArtifact(envelope);
  }
}

// 每个执行器使用自己的制品目录，开发只上传已自测且绑定 Git 提交的原始字节。
export class TransferringLifecyclePipeline implements LifecycleCandidatePipeline {
  constructor(
    readonly pipeline: SampleLifecycleAdapter,
    readonly client: HttpLifecycleArtifactClient,
  ) {}
  async #download(job: LifecycleJob, signal: AbortSignal) {
    for (const artifact of job.input.artifacts) {
      if (artifact.output.kind !== "code") continue;
      const code = artifact.output;
      const bytes = await this.client.get(
        job,
        code.artifactDigest,
        code.commitSha,
        signal,
      );
      await savePrivateBytes(
        path.join(
          this.pipeline.root,
          "artifacts",
          `${code.artifactDigest}.mjs`,
        ),
        bytes,
      );
    }
  }
  async #upload(
    job: LifecycleJob,
    result: LifecycleTaskResult,
    signal: AbortSignal,
  ) {
    if (result.status !== "succeeded" || result.output.kind !== "code")
      return result;
    const code = result.output,
      file = path.join(
        this.pipeline.root,
        "artifacts",
        `${code.artifactDigest}.mjs`,
      );
    await assertLifecyclePrivatePath(file);
    await this.client.put(
      job,
      {
        schemaVersion: 1,
        commitSha: code.commitSha,
        artifactDigest: code.artifactDigest,
        bytesBase64: (await readFile(file)).toString("base64"),
      },
      signal,
    );
    return result;
  }
  async execute(job: LifecycleJob, signal: AbortSignal) {
    await this.#download(job, signal);
    return this.#upload(job, await this.pipeline.execute(job, signal), signal);
  }
  async run(
    job: LifecycleJob,
    signal: AbortSignal,
    recoverOnly: boolean,
    candidate?: { workspacePath: string; commitSha: string },
  ) {
    if (recoverOnly)
      return (
        (await this.recover(job, signal)) ?? {
          status: "blocked" as const,
          reason: "没有可核对的执行记录",
        }
      );
    await this.#download(job, signal);
    return this.#upload(
      job,
      await this.pipeline.run(job, signal, false, candidate),
      signal,
    );
  }
  async testWithPlan(
    job: LifecycleJob,
    signal: AbortSignal,
    plan: LifecycleTestPlan,
  ) {
    await this.#download(job, signal);
    return this.pipeline.testWithPlan(job, signal, plan);
  }
  async recover(job: LifecycleJob, signal: AbortSignal) {
    const result = await this.pipeline.recover(job, signal);
    return result ? this.#upload(job, result, signal) : null;
  }
}
