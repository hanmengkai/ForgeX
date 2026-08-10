import path from "node:path";

import { OpenAiCodexSdkAdapter } from "./codex-adapter.js";
import { ExternalCodexIsolationRunner } from "./codex-isolation.js";
import { FileWorkerCompletionJournal } from "./completion-journal.js";
import { loadDeviceWorkerConfig } from "./config.js";
import { WorkerControlPlaneClient } from "./control-plane-client.js";
import { DeviceWorkerRuntime, runDeviceWorkerLoop } from "./runtime.js";
import { DeviceWorkerInstanceLock } from "./instance-lock.js";
import { OfficialMcpExecutionAdapter } from "./local-mcp.js";
import { GitWorktreeWorkspaceProvider } from "./workspace.js";

const configPath = process.env.FORGEX_WORKER_CONFIG;
if (!configPath) {
  throw new Error("请通过 FORGEX_WORKER_CONFIG 指定设备 Worker 配置文件");
}

const config = await loadDeviceWorkerConfig(path.resolve(configPath));
const resolvedConfigPath = path.resolve(configPath);
const instanceLock = await DeviceWorkerInstanceLock.acquire(
  `${config.connection.tenantKey}:${config.connection.workerKey}`,
);
const runtime = new DeviceWorkerRuntime({
  config,
  controlPlane: new WorkerControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    connection: config.connection,
    requestTimeoutMs: config.requestTimeoutMs,
  }),
  workspaces: new GitWorktreeWorkspaceProvider(),
  codex: new OpenAiCodexSdkAdapter({
    allowedEnvironmentVariables: config.allowedEnvironmentVariables,
    codexHomePath: config.codexHomePath,
    runner: new ExternalCodexIsolationRunner({
      launcherPath: config.codexIsolation.launcherPath,
      launcherSha256: config.codexIsolation.launcherSha256,
      isolationKind: config.codexIsolation.isolationKind,
    }),
    protectedPaths: [
      resolvedConfigPath,
      config.completionJournalPath,
      path.dirname(config.completionJournalPath),
      ...config.projects.flatMap((project) => [project.repositoryRoot]),
    ],
  }),
  completionJournal: new FileWorkerCompletionJournal(
    config.completionJournalPath,
  ),
  ...(config.mcpConnections.length > 0
    ? {
        mcp: new OfficialMcpExecutionAdapter({
          connections: config.mcpConnections,
        }),
      }
    : {}),
});
const abort = new AbortController();
process.once("SIGINT", () => abort.abort("SIGINT"));
process.once("SIGTERM", () => abort.abort("SIGTERM"));

try {
  await runDeviceWorkerLoop({
    runtime,
    idlePollIntervalMs: config.idlePollIntervalMs,
    signal: abort.signal,
    onResult: (result) => {
      if (result.kind === "requirement_completed") {
        process.stdout.write(
          `已完成：${result.title ?? "交付任务"}（本地提交 ${result.workspace?.commitSha.slice(0, 12) ?? "已生成"}）\n`,
        );
      } else if (result.kind === "mcp_completed") {
        process.stdout.write(`已完成：${result.title ?? "外部工具操作"}\n`);
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "未知错误";
      process.stderr.write(`设备 Worker 暂未完成任务：${message}\n`);
    },
  });
} finally {
  await instanceLock.release();
}
