import { createHash, sign, type KeyObject } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { sanitizeExecutionLogText } from "@forgex/contracts";
import {
  canonicalLifecycleJson,
  LifecycleJobSchema,
  LifecycleSignedCompletionSchema,
  LifecycleTaskResultSchema,
  type LifecycleJob,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import { ControlPlaneOriginSchema } from "./config.js";
import { assertPrivateWindowsPath } from "./windows-path-security.js";

export type LifecycleSignedCompletion = z.infer<
  typeof LifecycleSignedCompletionSchema
>;
const pendingSchema = z
  .object({
    schemaVersion: z.literal(2),
    phase: z.enum(["executing", "completed"]),
    job: LifecycleJobSchema,
    completion: LifecycleSignedCompletionSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.phase === "completed") !== (value.completion !== null))
      ctx.addIssue({ code: "custom", message: "生命周期执行日志状态不一致" });
  });
export type LifecyclePending = z.infer<typeof pendingSchema>;
export interface LifecycleJournal {
  load(): Promise<LifecyclePending | null>;
  save(pending: LifecyclePending): Promise<void>;
  clear(): Promise<void>;
}
export class MemoryLifecycleJournal implements LifecycleJournal {
  pending: LifecyclePending | null = null;
  async load() {
    return structuredClone(this.pending);
  }
  async save(value: LifecyclePending) {
    this.pending = pendingSchema.parse(structuredClone(value));
  }
  async clear() {
    this.pending = null;
  }
}
export interface LifecycleExecutionAdapter {
  execute(job: LifecycleJob, signal: AbortSignal): Promise<LifecycleTaskResult>;
  recover?(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult | null>;
}
export interface LifecycleExecutionClient {
  claim(): Promise<LifecycleJob | null>;
  renew(job: LifecycleJob): Promise<LifecycleJob>;
  complete(completion: LifecycleSignedCompletion): Promise<void>;
}
export class LifecycleDeliveryUnavailableError extends Error {}

export const assertLifecyclePrivatePath = async (
  target: string,
): Promise<void> => {
  const normalized = path.resolve(target);
  if ((await realpath(normalized)) !== normalized)
    throw new Error("生命周期私有路径不能经过符号链接");
  const stat = await lstat(normalized);
  if (stat.isSymbolicLink()) throw new Error("生命周期私有路径不能是符号链接");
  if (process.platform === "win32") {
    await assertPrivateWindowsPath(normalized);
    return;
  }
  if (
    typeof process.getuid !== "function" ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("生命周期配置及日志只能由执行身份访问");
};
export class FileLifecycleJournal implements LifecycleJournal {
  readonly root: string;
  readonly file: string;
  constructor(root: string) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, "pending.json");
  }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertLifecyclePrivatePath(this.root);
  }
  async load(): Promise<LifecyclePending | null> {
    await this.initialize();
    try {
      await assertLifecyclePrivatePath(this.file);
      const stat = await lstat(this.file);
      if (stat.size > 2 * 1024 * 1024)
        throw new Error("生命周期执行日志超过上限");
      return pendingSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async save(pending: LifecyclePending): Promise<void> {
    await this.initialize();
    const text = JSON.stringify(pendingSchema.parse(pending));
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("生命周期执行日志超过上限");
    const temporary = path.join(this.root, `${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.file);
      await this.#syncDirectory();
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async clear(): Promise<void> {
    await this.initialize();
    await rm(this.file, { force: true });
    await this.#syncDirectory();
  }
  async acquire(): Promise<() => Promise<void>> {
    await this.initialize();
    // 升级期间不能绕过旧实例的文件锁，否则新旧执行器会同时持有同一日志。
    try {
      await lstat(path.join(this.root, "executor.lock"));
      throw new Error("旧版执行器锁仍在，请先确认旧 Worker 已停止并归档旧锁");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lock = path.join(this.root, "executor-lock.sqlite");
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertLifecyclePrivatePath(lock);
    // 文件存在不表示进程存活；数据库锁在异常退出后由操作系统自动释放。
    const database = new DatabaseSync(lock);
    try {
      database.exec("BEGIN EXCLUSIVE");
    } catch {
      database.close();
      throw new Error("执行日志已有持有者，请等待旧执行器退出");
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      database.exec("ROLLBACK");
      database.close();
    };
  }
  async #syncDirectory() {
    if (process.platform === "win32") return;
    const dir = await open(this.root, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
export class LifecycleExecutorRuntime {
  constructor(
    readonly options: {
      client: LifecycleExecutionClient;
      adapter: LifecycleExecutionAdapter;
      journal: LifecycleJournal;
      privateKey: KeyObject;
      onExecutionError?: (message: string) => void;
    },
  ) {
    if (
      options.privateKey.asymmetricKeyType !== "ed25519" ||
      options.privateKey.type !== "private"
    )
      throw new Error("生命周期结果必须由本地 Ed25519 私钥签名");
  }
  async tick(): Promise<boolean> {
    const pending = await this.options.journal.load();
    if (pending?.phase === "completed") {
      await this.options.client.complete(pending.completion!);
      await this.options.journal.clear();
      return true;
    }
    const job = pending?.job ?? (await this.options.client.claim());
    if (!job) return false;
    if (
      createHash("sha256")
        .update(canonicalLifecycleJson(job.input))
        .digest("hex") !== job.inputDigest
    )
      throw new Error("生命周期任务输入摘要不正确");
    const controller = new AbortController();
    let renewal: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (renewal) return;
      renewal = this.options.client
        .renew(job)
        .then(() => {})
        .catch(() => {
          controller.abort();
        })
        .finally(() => {
          renewal = null;
        });
    }, 30_000);
    timer.unref();
    let result: LifecycleTaskResult;
    try {
      if (pending) {
        result = (await this.options.adapter.recover?.(
          job,
          controller.signal,
        )) ?? {
          status: "blocked",
          reason:
            "执行器在执行中退出，尚未确认外部副作用，请核对本地执行记录后恢复",
        };
      } else {
        await this.options.journal.save({
          schemaVersion: 2,
          phase: "executing",
          job,
          completion: null,
        });
        result = await this.options.adapter.execute(job, controller.signal);
      }
      result = LifecycleTaskResultSchema.parse(result);
    } catch (error) {
      if (error instanceof LifecycleDeliveryUnavailableError) throw error;
      try {
        this.options.onExecutionError?.(
          sanitizeExecutionLogText(
            error instanceof Error ? error.message : "执行异常",
          ).slice(0, 2000),
        );
      } catch {}
      result = {
        status: "failed",
        reason: "受控执行器未完成任务，请核对本地执行日志和适配配置后恢复",
      };
    } finally {
      clearInterval(timer);
      if (renewal) await renewal;
    }
    const payload = {
      schemaVersion: 2 as const,
      jobKey: job.jobKey,
      fencingToken: job.fencingToken!,
      inputDigest: job.inputDigest,
      result,
    };
    const completion = {
      payload,
      signatureBase64: sign(
        null,
        Buffer.from(canonicalLifecycleJson(payload)),
        this.options.privateKey,
      ).toString("base64"),
    };
    await this.options.journal.save({
      schemaVersion: 2,
      phase: "completed",
      job,
      completion,
    });
    await this.options.client.complete(completion);
    await this.options.journal.clear();
    return true;
  }
}
const boundedJson = async (response: Response): Promise<unknown> => {
  if (!response.body) throw new Error("生命周期连接返回空响应");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      await response.body.cancel().catch(() => {});
      throw new Error("生命周期连接响应超过上限");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};
export class HttpLifecycleClient implements LifecycleExecutionClient {
  readonly origin: string;
  constructor(
    readonly options: { origin: string; token: string; fetcher?: typeof fetch },
  ) {
    this.origin = ControlPlaneOriginSchema.parse(options.origin);
    if (options.token.length < 20 || /[\r\n]/u.test(options.token))
      throw new Error("生命周期执行器令牌格式不正确");
  }
  async #request(endpoint: string, body: unknown): Promise<unknown> {
    const response = await (this.options.fetcher ?? fetch)(
      new URL(endpoint, this.origin),
      {
        method: "POST",
        headers: {
          authorization: `Lifecycle ${this.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`生命周期控制面请求失败：${response.status}`);
    return boundedJson(response);
  }
  async claim(): Promise<LifecycleJob | null> {
    return z
      .object({ data: LifecycleJobSchema.nullable() })
      .strict()
      .parse(
        await this.#request("/api/v2/executor/claim", { schemaVersion: 2 }),
      ).data;
  }
  async renew(job: LifecycleJob): Promise<LifecycleJob> {
    return z
      .object({ data: LifecycleJobSchema })
      .strict()
      .parse(
        await this.#request(`/api/v2/executor/jobs/${job.jobKey}/renew`, {
          schemaVersion: 2,
          fencingToken: job.fencingToken,
        }),
      ).data;
  }
  async complete(completion: LifecycleSignedCompletion): Promise<void> {
    await this.#request("/api/v2/executor/complete", completion);
  }
}
export class HttpLifecycleAdapter implements LifecycleExecutionAdapter {
  readonly endpoint: URL;
  constructor(
    readonly options: {
      endpoint: string;
      token: string;
      fetcher?: typeof fetch;
    },
  ) {
    this.endpoint = new URL(options.endpoint);
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      !(
        this.endpoint.protocol === "https:" ||
        (this.endpoint.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname))
      )
    )
      throw new Error("受控执行适配器必须使用 HTTPS 或本机回环地址且不含凭据");
    if (options.token.length < 20 || /[\r\n]/u.test(options.token))
      throw new Error("受控适配器令牌格式不正确");
  }
  async execute(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult> {
    return this.run(job, signal);
  }
  async recover(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult | null> {
    return this.run(job, signal, true);
  }
  async run(
    job: LifecycleJob,
    signal: AbortSignal,
    recoverOnly = false,
    candidate?: { workspacePath: string; commitSha: string },
  ): Promise<LifecycleTaskResult> {
    const response = await (this.options.fetcher ?? fetch)(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "idempotency-key": job.jobKey,
      },
      body: JSON.stringify({
        schemaVersion: 2,
        job,
        recoverOnly,
        ...(candidate ? { candidate } : {}),
      }),
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("受控执行适配器没有返回有效结果");
    return LifecycleTaskResultSchema.parse(await boundedJson(response));
  }
}
