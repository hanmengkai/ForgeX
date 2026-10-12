import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  LifecycleWorkerConfigSchema,
  createLifecycleWorkerAdapter,
} from "./lifecycle-config.js";
import { DurableLifecycleAdapter } from "./lifecycle-receipt.js";
import {
  assertLifecyclePrivatePath,
  FileLifecycleJournal,
  HttpLifecycleClient,
  LifecycleExecutorRuntime,
} from "./lifecycle-runtime.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("请提供执行器私有配置的绝对路径");
await assertLifecyclePrivatePath(path.resolve(configPath));
const config = LifecycleWorkerConfigSchema.parse(
  JSON.parse(await readFile(configPath, "utf8")),
);
await assertLifecyclePrivatePath(config.privateKeyPath);
const privateKey = createPrivateKey(
  await readFile(config.privateKeyPath, "utf8"),
);
const journal = new FileLifecycleJournal(config.journalRoot);
const receiptRoot = path.join(config.journalRoot, "receipts");
const { adapter: inner } = createLifecycleWorkerAdapter(config, [
  path.resolve(configPath),
  config.privateKeyPath,
  path.resolve(config.journalRoot),
]);
const adapter = new DurableLifecycleAdapter(receiptRoot, inner);
const runtime = new LifecycleExecutorRuntime({
  client: new HttpLifecycleClient({
    origin: config.controlPlaneOrigin,
    token: config.token,
  }),
  adapter,
  journal,
  privateKey,
  onExecutionError: (message) => console.error(`本地执行诊断：${message}`),
});
const release = await journal.acquire();
console.log("独立交付执行器已就绪，等待已批准任务");
let stopped = false;
let wake: (() => void) | null = null;
const stop = () => {
  stopped = true;
  wake?.();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  while (!stopped) {
    try {
      await runtime.tick();
    } catch {
      console.error("生命周期执行器等待控制面确认；执行日志已保留");
    }
    if (stopped) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, config.pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }
} finally {
  await release();
}
