import path from "node:path";
import { z } from "zod";
import { ExternalCodexIsolationRunner } from "./codex-isolation.js";
import { CurrentUserCodexRunner } from "./current-user-codex.js";
import { CodexAuthenticationSchema } from "./codex-auth.js";
import {
  DeviceWorkerProjectSchema,
  ControlPlaneOriginSchema,
} from "./config.js";
import { CodexLifecycleAdapter } from "./lifecycle-codex-adapter.js";
import { SampleLifecycleAdapter } from "./lifecycle-sample-adapter.js";
import {
  HttpLifecycleAdapter,
  type LifecycleExecutionAdapter,
} from "./lifecycle-runtime.js";
import {
  HttpLifecycleArtifactClient,
  TransferringLifecyclePipeline,
  savePrivateJson,
} from "./lifecycle-transfer.js";
import { randomUUID } from "node:crypto";
const absolute = z
  .string()
  .min(1)
  .refine((v) => path.isAbsolute(v), "执行器路径必须是绝对路径");
const projectOptions = {
  project: DeviceWorkerProjectSchema,
  codexHomePath: absolute,
  protectedPaths: z.array(absolute).min(1).max(250),
};
export const LifecycleWorkerConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    controlPlaneOrigin: ControlPlaneOriginSchema,
    token: z.string().min(20).max(4096),
    privateKeyPath: absolute,
    journalRoot: absolute,
    pollIntervalMs: z.number().int().min(1000).max(60000).default(3000),
    adapter: z
      .object({
        endpoint: z.string().url(),
        token: z.string().min(20).max(4096),
      })
      .strict()
      .optional(),
    sample: z
      .object({
        schemaVersion: z.literal(1),
        root: absolute,
        sourcePath: absolute,
        businessRuntimePath: absolute.optional(),
      })
      .strict()
      .optional(),
    execution: z
      .object({
        schemaVersion: z.literal(1),
        provider: z.literal("codex"),
        mode: z.literal("current_user"),
        ...projectOptions,
        instructions: z.string().max(20000).optional(),
        testingAgent: z.boolean().default(true),
        allowedDevelopmentFiles: z
          .array(z.string().min(1).max(500))
          .min(1)
          .max(100)
          .optional(),
      })
      .strict()
      .optional(),
    codex: z
      .object({
        ...projectOptions,
        authentication: CodexAuthenticationSchema,
        launcherPath: absolute,
        launcherSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        isolationKind: z.enum(["separate_os_identity", "container"]),
        launcherArguments: z.array(z.string().max(1000)).max(20).default([]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Boolean(v.sample) === Boolean(v.adapter))
      ctx.addIssue({
        code: "custom",
        message: "请选择一个受控样板或远程执行适配器",
      });
    if (v.execution && v.codex)
      ctx.addIssue({
        code: "custom",
        message: "不能同时配置两种 Codex 登录方式",
      });
    if (v.execution?.testingAgent && v.adapter)
      ctx.addIssue({
        code: "custom",
        message: "远程适配器尚未提供独立测试计划协议",
      });
  });
export type LifecycleWorkerConfig = z.infer<typeof LifecycleWorkerConfigSchema>;
export function createLifecycleWorkerAdapter(
  config: LifecycleWorkerConfig,
  protectedPaths: string[],
): {
  adapter: LifecycleExecutionAdapter;
  pipeline: SampleLifecycleAdapter | null;
} {
  const sample = config.sample
    ? new SampleLifecycleAdapter({
        root: config.sample.root,
        sourcePath: config.sample.sourcePath,
        ...(config.sample.businessRuntimePath
          ? { businessRuntimePath: config.sample.businessRuntimePath }
          : {}),
        durableDeployments: true,
      })
    : null;
  const pipeline = sample
    ? new TransferringLifecyclePipeline(
        sample,
        new HttpLifecycleArtifactClient({
          origin: config.controlPlaneOrigin,
          token: config.token,
        }),
      )
    : new HttpLifecycleAdapter(config.adapter!);
  const execution = config.execution ?? config.codex;
  if (!execution) return { adapter: pipeline, pipeline: sample };
  if (config.execution && process.platform !== "darwin")
    throw new Error("当前用户 Codex 执行方式仅在已验证的 macOS 沙箱中可用");
  return {
    adapter: new CodexLifecycleAdapter({
      project: execution.project,
      codexHomePath: execution.codexHomePath,
      ...(config.codex ? { authentication: config.codex.authentication } : {}),
      ...(config.execution?.instructions
        ? { instructions: config.execution.instructions }
        : {}),
      ...(config.execution
        ? { testingAgent: config.execution.testingAgent }
        : {}),
      ...(config.execution?.allowedDevelopmentFiles
        ? { allowedDevelopmentFiles: config.execution.allowedDevelopmentFiles }
        : {}),
      protectedPaths: [
        ...new Set([
          ...execution.protectedPaths,
          ...protectedPaths,
          ...(config.sample ? [config.sample.root] : []),
        ]),
      ],
      pipeline,
      runner: config.execution
        ? new CurrentUserCodexRunner()
        : new ExternalCodexIsolationRunner(config.codex!),
      onAgentResult: async (stage, response, job) => {
        await savePrivateJson(
          path.join(
            config.journalRoot,
            "model-results",
            `${randomUUID()}.json`,
          ),
          {
            schemaVersion: 1,
            provider: "codex",
            stage,
            jobKey: job.jobKey,
            inputDigest: job.inputDigest,
            threadId: response.threadId,
            output: JSON.parse(response.finalResponse),
            at: new Date().toISOString(),
          },
        );
        console.log(`真实 Codex Agent 已完成：${stage}`);
      },
    }),
    pipeline: sample,
  };
}
