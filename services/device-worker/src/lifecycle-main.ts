import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  LifecycleWorkerConfigSchema,
  createLifecycleWorkerAdapter,
} from "./lifecycle-config.js";
import { DurableLifecycleAdapter } from "./lifecycle-receipt.js";
import { codexLoginStatus } from "./codex-login-status.js";
import type { LifecycleWorkerHeartbeat } from "@forgex/contracts/lifecycle";
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
const client = new HttpLifecycleClient({
  origin: config.controlPlaneOrigin,
  token: config.token,
});
const runtime = new LifecycleExecutorRuntime({
  client,
  adapter,
  journal,
  privateKey,
  onExecutionError: (message) => console.error(`本地执行诊断：${message}`),
});
const release = await journal.acquire();
console.log("独立交付执行器已就绪，等待已批准任务");
const heartbeat: LifecycleWorkerHeartbeat = {
  schemaVersion: 1,
  displayName:
    config.displayName ??
    (config.execution ? "本机当前用户 Codex" : "受控交付执行器"),
  provider:
    config.execution || config.codex
      ? "codex"
      : config.sample
        ? "sample"
        : "controlled_pipeline",
  loginState: config.execution || config.codex ? "unknown" : "not_required",
};
let checking = false;
const sendHeartbeat = async () => {
  if (checking) return;
  checking = true;
  try {
    if (config.execution)
      heartbeat.loginState = await codexLoginStatus(
        config.execution.codexHomePath,
      );
    const pending = await journal.load();
    heartbeat.executionState =
      pending?.phase === "completed"
        ? "awaiting_confirmation"
        : pending
          ? "executing"
          : "idle";
    await client.heartbeat(heartbeat);
  } catch {
  } finally {
    checking = false;
  }
};
await sendHeartbeat();
const heartbeatTimer = setInterval(() => void sendHeartbeat(), 15000);
heartbeatTimer.unref();
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
  clearInterval(heartbeatTimer);
  await release();
}
