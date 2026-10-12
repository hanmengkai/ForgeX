import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LifecycleTaskResultSchema,
  type LifecycleJob,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import {
  assertLifecyclePrivatePath,
  type LifecycleExecutionAdapter,
} from "./lifecycle-runtime.js";
import { savePrivateJson } from "./lifecycle-transfer.js";
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    result: LifecycleTaskResultSchema,
  })
  .strict();

export class DurableLifecycleAdapter implements LifecycleExecutionAdapter {
  constructor(
    readonly root: string,
    readonly adapter: LifecycleExecutionAdapter,
  ) {}
  async execute(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult> {
    const previous = await this.#load(job);
    if (previous) return previous;
    const result = await this.adapter.execute(job, signal);
    await savePrivateJson(this.#file(job), {
      schemaVersion: 1,
      inputDigest: job.inputDigest,
      result,
    });
    return result;
  }
  async recover(
    job: LifecycleJob,
    signal: AbortSignal,
  ): Promise<LifecycleTaskResult | null> {
    return (
      (await this.#load(job)) ??
      (await this.adapter.recover?.(job, signal)) ??
      null
    );
  }
  #file(job: LifecycleJob) {
    z.string().uuid().parse(job.jobKey);
    return path.join(this.root, `${job.jobKey}.json`);
  }
  async #load(job: LifecycleJob): Promise<LifecycleTaskResult | null> {
    const file = this.#file(job);
    try {
      await assertLifecyclePrivatePath(file);
      if ((await stat(file)).size > 2 * 1024 * 1024)
        throw new Error("执行回执超过上限");
      const receipt = receiptSchema.parse(
        JSON.parse(await readFile(file, "utf8")),
      );
      if (receipt.inputDigest !== job.inputDigest)
        throw new Error("执行回执输入摘要不一致");
      return receipt.result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
