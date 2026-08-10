import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { z } from "zod";

import {
  canonicalProtectedPaths,
  currentOsIdentity,
  protectedPathsDigest,
} from "./codex-isolation.js";
import { assertPrivateWindowsPath } from "./windows-path-security.js";

const absolutePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => path.isAbsolute(value));

const execFileAsync = promisify(execFile);

export const IsolatedCodexRunRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    challenge: z.string().uuid(),
    isolationKind: z.enum(["separate_os_identity", "container"]),
    workspacePath: absolutePath,
    protectedPaths: z.array(absolutePath).min(1).max(250),
    protectedPathsHash: z.string().regex(/^[a-f0-9]{64}$/u),
    controllerIdentity: z.string().min(3).max(200),
    codexHomePath: absolutePath,
    codex: z
      .object({
        model: z.string().min(1).max(100).optional(),
        reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
        sandboxMode: z.literal("workspace-write"),
        networkAccessEnabled: z.literal(false),
        webSearchMode: z.literal("disabled"),
        approvalPolicy: z.literal("never"),
        config: z
          .object({
            cli_auth_credentials_store: z.literal("keyring"),
            allow_login_shell: z.literal(false),
            agents: z.object({ enabled: z.literal(false) }).strict(),
            mcp_servers: z.object({}).strict(),
            features: z
              .object({
                apps: z.literal(false),
                auth_elicitation: z.literal(false),
                browser_use: z.literal(false),
                browser_use_external: z.literal(false),
                browser_use_full_cdp_access: z.literal(false),
                code_mode_host: z.literal(false),
                computer_use: z.literal(false),
                goals: z.literal(false),
                guardian_approval: z.literal(false),
                hooks: z.literal(false),
                image_generation: z.literal(false),
                in_app_browser: z.literal(false),
                in_app_updates: z.literal(false),
                memories: z.literal(false),
                mentions_v2: z.literal(false),
                shell_tool: z.literal(false),
                unified_exec: z.literal(false),
                shell_snapshot: z.literal(false),
                multi_agent: z.literal(false),
                plugin_sharing: z.literal(false),
                plugins: z.literal(false),
                web_search: z.literal(false),
                remote_plugin: z.literal(false),
                skill_mcp_dependency_install: z.literal(false),
                skill_search: z.literal(false),
                tool_call_mcp_elicitation: z.literal(false),
                tool_suggest: z.literal(false),
                view_image: z.literal(false),
                workspace_dependencies: z.literal(false),
              })
              .strict(),
            history: z.object({ persistence: z.literal("none") }).strict(),
            project_doc_max_bytes: z.literal(0),
            project_doc_fallback_filenames: z.array(z.never()).max(0),
            shell_environment_policy: z
              .object({
                inherit: z.literal("none"),
                ignore_default_excludes: z.literal(false),
                set: z.record(z.string(), z.string().max(4_096)),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    prompt: z.string().min(1).max(1_048_576),
    outputSchema: z.unknown(),
  })
  .strict();

export type IsolatedCodexRunRequest = z.infer<
  typeof IsolatedCodexRunRequestSchema
>;

interface CodexLike {
  startThread(options: {
    model?: string;
    sandboxMode: "workspace-write";
    workingDirectory: string;
    skipGitRepoCheck: true;
    modelReasoningEffort: IsolatedCodexRunRequest["codex"]["reasoningEffort"];
    networkAccessEnabled: false;
    webSearchMode: "disabled";
    approvalPolicy: "never";
  }): {
    readonly id: string | null;
    run(
      prompt: string,
      options: { outputSchema: unknown },
    ): Promise<{ finalResponse: string }>;
  };
}

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

const forbiddenCodexHomeEntries = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "skills",
  "plugins",
  "hooks",
] as const;

const workspaceMcpPath = fileURLToPath(
  new URL("./workspace-mcp-main.js", import.meta.url),
);
const codexCliPath = fileURLToPath(
  import.meta.resolve("@openai/codex/bin/codex.js"),
);

const disabledToolFeatures = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_updates",
  "memories",
  "mentions_v2",
  "multi_agent",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

const allowedEnabledRuntimeFeatures = new Set([
  "enable_request_compression",
  "fast_mode",
  "personality",
  "remote_compaction_v2",
  "secret_auth_storage",
]);

const projectTrustOverrideKey = (workspacePath: string): string =>
  `projects.${JSON.stringify(workspacePath)}.trust_level`;

const workspaceMcpConfiguration = (workspacePath: string) => ({
  command: process.execPath,
  args: [workspaceMcpPath, "--workspace", workspacePath],
  required: true,
  enabled_tools: [
    "list_workspace",
    "read_workspace_file",
    "search_workspace_text",
  ],
  startup_timeout_sec: 10,
  tool_timeout_sec: 30,
});

const workspaceMcpOverrides = (workspacePath: string): string[] => {
  const configuration = workspaceMcpConfiguration(workspacePath);
  return Object.entries(configuration).flatMap(([key, value]) => [
    "-c",
    `mcp_servers.forgex_workspace.${key}=${JSON.stringify(value)}`,
  ]);
};

const CodexMcpListSchema = z.array(
  z
    .object({
      name: z.string(),
      enabled: z.boolean(),
    })
    .passthrough(),
);

const CodexMcpDetailSchema = z
  .object({
    name: z.literal("forgex_workspace"),
    enabled: z.literal(true),
    transport: z
      .object({
        type: z.literal("stdio"),
        command: z.string(),
        args: z.array(z.string()),
      })
      .passthrough(),
    enabled_tools: z.array(z.string()),
    disabled_tools: z.null(),
    startup_timeout_sec: z.number(),
    tool_timeout_sec: z.number(),
  })
  .passthrough();

export const assertCodexToolSurface = async (
  request: IsolatedCodexRunRequest,
): Promise<void> => {
  const safeEnvironment = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    CODEX_HOME: request.codexHomePath,
  };
  const version = await execFileAsync(
    process.execPath,
    [codexCliPath, "--version"],
    {
      cwd: request.workspacePath,
      encoding: "utf8",
      env: safeEnvironment,
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (version.stdout.trim() !== "codex-cli 0.147.0") {
    throw new Error("ForgeX 设备只允许经过验证的 Codex CLI 0.147.0");
  }
  const featureOverrides = disabledToolFeatures.flatMap((feature) => [
    "-c",
    `features.${feature}=false`,
  ]);
  const projectTrustOverride = projectTrustOverrideKey(request.workspacePath);
  const inventory = await execFileAsync(
    process.execPath,
    [
      codexCliPath,
      "-c",
      `${projectTrustOverride}="untrusted"`,
      ...featureOverrides,
      "features",
      "list",
    ],
    {
      cwd: request.workspacePath,
      encoding: "utf8",
      env: safeEnvironment,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  const states = new Map<string, { enabled: boolean; stage: string }>();
  for (const line of inventory.stdout.split(/\r?\n/u)) {
    const match = /^(\S+)\s+(.+?)\s+(true|false)$/u.exec(line.trim());
    if (match?.[1] && match[2] && match[3]) {
      states.set(match[1], {
        stage: match[2].trim(),
        enabled: match[3] === "true",
      });
    }
  }
  for (const feature of disabledToolFeatures) {
    if (states.get(feature)?.enabled !== false) {
      throw new Error(`Codex 工具特性 ${feature} 没有被可靠关闭`);
    }
  }
  const unclassifiedEnabled = [...states.entries()]
    .filter(
      ([feature, state]) =>
        state.enabled &&
        state.stage !== "removed" &&
        !allowedEnabledRuntimeFeatures.has(feature),
    )
    .map(([feature]) => feature);
  if (unclassifiedEnabled.length > 0) {
    throw new Error(
      `Codex 出现未分类的启用特性：${unclassifiedEnabled.join(", ")}`,
    );
  }

  const mcpOverrides = [
    "-c",
    `${projectTrustOverride}="untrusted"`,
    ...workspaceMcpOverrides(request.workspacePath),
  ];
  const mcpInventory = await execFileAsync(
    process.execPath,
    [codexCliPath, ...mcpOverrides, "mcp", "list", "--json"],
    {
      cwd: request.workspacePath,
      encoding: "utf8",
      env: safeEnvironment,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  const enabledServers = CodexMcpListSchema.parse(
    JSON.parse(mcpInventory.stdout) as unknown,
  ).filter((server) => server.enabled);
  if (
    enabledServers.length !== 1 ||
    enabledServers[0]?.name !== "forgex_workspace"
  ) {
    throw new Error("Codex 只能启用 ForgeX 受控工作区 MCP 服务");
  }

  const mcpDetail = await execFileAsync(
    process.execPath,
    [codexCliPath, ...mcpOverrides, "mcp", "get", "forgex_workspace", "--json"],
    {
      cwd: request.workspacePath,
      encoding: "utf8",
      env: safeEnvironment,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  const actualMcp = CodexMcpDetailSchema.parse(
    JSON.parse(mcpDetail.stdout) as unknown,
  );
  const expectedMcp = workspaceMcpConfiguration(request.workspacePath);
  if (
    actualMcp.transport.command !== expectedMcp.command ||
    JSON.stringify(actualMcp.transport.args) !==
      JSON.stringify(expectedMcp.args) ||
    JSON.stringify(actualMcp.enabled_tools) !==
      JSON.stringify(expectedMcp.enabled_tools) ||
    actualMcp.startup_timeout_sec !== expectedMcp.startup_timeout_sec ||
    actualMcp.tool_timeout_sec !== expectedMcp.tool_timeout_sec
  ) {
    throw new Error("ForgeX 受控工作区 MCP 配置与可信清单不一致");
  }
};

export const assertLauncherFilesystemBoundary = async (
  request: IsolatedCodexRunRequest,
): Promise<void> => {
  const workspacePath = path.normalize(path.resolve(request.workspacePath));
  const workspaceMetadata = await lstat(workspacePath);
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw new Error("隔离 Codex 工作树不是本地普通目录");
  }
  if (!samePath(path.normalize(await realpath(workspacePath)), workspacePath)) {
    throw new Error("隔离 Codex 工作树不能经过符号链接或目录跳转");
  }
  await access(workspacePath);
  const probePath = path.join(
    workspacePath,
    `.forgex-isolation-${randomUUID()}.tmp`,
  );
  const probe = await open(probePath, "wx", 0o600);
  try {
    await probe.writeFile("forgex-isolation-probe", "utf8");
    await probe.sync();
  } finally {
    await probe.close();
    await unlink(probePath);
  }

  for (const protectedPath of request.protectedPaths) {
    try {
      await lstat(protectedPath);
      throw new Error(`隔离 Codex 仍能读取受保护路径：${protectedPath}`);
    } catch (error) {
      if (
        error instanceof Error &&
        ["EACCES", "EPERM", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        continue;
      }
      throw error;
    }
  }

  const codexHome = await lstat(request.codexHomePath);
  if (!codexHome.isDirectory() || codexHome.isSymbolicLink()) {
    throw new Error("隔离账户的 CODEX_HOME 必须是本地普通目录");
  }
  if (
    process.platform !== "win32" &&
    ((Number(codexHome.mode) & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        typeof codexHome.uid === "number" &&
        codexHome.uid !== process.getuid()))
  ) {
    throw new Error("隔离账户的 CODEX_HOME 必须由该账户独占");
  }
  if (process.platform === "win32") {
    await assertPrivateWindowsPath(request.codexHomePath);
  }
  for (const entry of forbiddenCodexHomeEntries) {
    try {
      await lstat(path.join(request.codexHomePath, entry));
      throw new Error(`隔离账户的 CODEX_HOME 不能包含 ${entry}`);
    } catch (error) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
};

export interface IsolationLauncherDependencies {
  currentIdentity?: () => Promise<string>;
  assertFilesystemBoundary?: (
    request: IsolatedCodexRunRequest,
  ) => Promise<void>;
  assertToolSurface?: (request: IsolatedCodexRunRequest) => Promise<void>;
  createCodex?: (options: CodexOptions) => CodexLike;
}

export const executeIsolatedCodexRun = async (
  raw: unknown,
  dependencies: IsolationLauncherDependencies = {},
): Promise<unknown> => {
  const request = IsolatedCodexRunRequestSchema.parse(raw);
  const protectedPaths = canonicalProtectedPaths(request.protectedPaths);
  if (
    protectedPaths.length !== request.protectedPaths.length ||
    protectedPaths.some(
      (value, index) => value !== request.protectedPaths[index],
    ) ||
    protectedPathsDigest(protectedPaths) !== request.protectedPathsHash
  ) {
    throw new Error("Codex 隔离请求的受保护路径清单不可信");
  }
  const workspacePath = path.normalize(path.resolve(request.workspacePath));
  if (
    protectedPaths.some((protectedPath) =>
      samePath(protectedPath, workspacePath),
    )
  ) {
    throw new Error("Codex 隔离工作树不能同时声明为受保护路径");
  }
  const runnerIdentity = await (
    dependencies.currentIdentity ?? currentOsIdentity
  )();
  if (runnerIdentity === request.controllerIdentity) {
    throw new Error("Codex 隔离启动器不能与 Worker 控制器使用同一系统身份");
  }
  await (
    dependencies.assertFilesystemBoundary ?? assertLauncherFilesystemBoundary
  )(request);
  await (dependencies.assertToolSurface ?? assertCodexToolSurface)(request);
  const shellEnvironment = request.codex.config.shell_environment_policy.set;
  const createCodex =
    dependencies.createCodex ?? ((options: CodexOptions) => new Codex(options));
  const projectTrustOverride = projectTrustOverrideKey(request.workspacePath);
  const codex = createCodex({
    env: {
      ...shellEnvironment,
      CODEX_HOME: request.codexHomePath,
    },
    config: {
      ...request.codex.config,
      [projectTrustOverride]: "untrusted",
      mcp_servers: {
        forgex_workspace: workspaceMcpConfiguration(request.workspacePath),
      },
    },
  });
  const thread = codex.startThread({
    ...(request.codex.model ? { model: request.codex.model } : {}),
    sandboxMode: request.codex.sandboxMode,
    workingDirectory: request.workspacePath,
    skipGitRepoCheck: true,
    modelReasoningEffort: request.codex.reasoningEffort,
    networkAccessEnabled: request.codex.networkAccessEnabled,
    webSearchMode: request.codex.webSearchMode,
    approvalPolicy: request.codex.approvalPolicy,
  });
  const turn = await thread.run(request.prompt, {
    outputSchema: request.outputSchema,
  });
  return {
    schemaVersion: 1,
    challenge: request.challenge,
    isolationKind: request.isolationKind,
    workspacePath: request.workspacePath,
    protectedPathsHash: request.protectedPathsHash,
    workspaceReadable: true,
    workspaceWritable: true,
    protectedPathsDenied: true,
    controllerIdentitySeparated: true,
    shellToolsDisabled: true,
    controlledWorkspaceToolsOnly: true,
    finalResponse: turn.finalResponse,
    threadId: thread.id,
  };
};
