import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ExternalCodexIsolationRunner } from "./codex-isolation.js";
import { CodexAuthenticationSchema } from "./codex-auth.js";
import {
  DeviceWorkerProjectSchema,
  ControlPlaneOriginSchema,
} from "./config.js";
import { CodexLifecycleAdapter } from "./lifecycle-codex-adapter.js";
import {
  assertLifecyclePrivatePath,
  FileLifecycleJournal,
  HttpLifecycleAdapter,
  HttpLifecycleClient,
  LifecycleExecutorRuntime,
} from "./lifecycle-runtime.js";

const absolute = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value));
const configSchema = z
  .object({
    schemaVersion: z.literal(2),
    controlPlaneOrigin: ControlPlaneOriginSchema,
    token: z.string().min(20).max(4_096),
    privateKeyPath: absolute,
    journalRoot: absolute,
    pollIntervalMs: z.number().int().min(1_000).max(60_000).default(3_000),
    adapter: z
      .object({
        endpoint: z.string().url(),
        token: z.string().min(20).max(4_096),
      })
      .strict(),
    codex: z
      .object({
        project: DeviceWorkerProjectSchema,
        codexHomePath: absolute,
        authentication: CodexAuthenticationSchema,
        protectedPaths: z.array(absolute).min(1).max(250),
        launcherPath: absolute,
        launcherSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        isolationKind: z.enum(["separate_os_identity", "container"]),
        launcherArguments: z.array(z.string().max(1_000)).max(20).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

const configPath = process.argv[2];
if (!configPath) throw new Error("请提供执行器私有配置的绝对路径");
await assertLifecyclePrivatePath(path.resolve(configPath));
const config = configSchema.parse(
  JSON.parse(await readFile(configPath, "utf8")),
);
await assertLifecyclePrivatePath(config.privateKeyPath);
const privateKey = createPrivateKey(
  await readFile(config.privateKeyPath, "utf8"),
);
const journal = new FileLifecycleJournal(config.journalRoot);
const codex = config.codex
  ? {
      ...config.codex,
      protectedPaths: [
        ...new Set([
          ...config.codex.protectedPaths,
          path.resolve(configPath),
          config.privateKeyPath,
          path.resolve(config.journalRoot),
        ]),
      ],
    }
  : null;
const pipeline = new HttpLifecycleAdapter(config.adapter);
const adapter = codex
  ? new CodexLifecycleAdapter({
      ...codex,
      pipeline,
      runner: new ExternalCodexIsolationRunner(codex),
    })
  : pipeline;
const runtime = new LifecycleExecutorRuntime({
  client: new HttpLifecycleClient({
    origin: config.controlPlaneOrigin,
    token: config.token,
  }),
  adapter,
  journal,
  privateKey,
});
const release = await journal.acquire();
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
