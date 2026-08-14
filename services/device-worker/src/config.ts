import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { WorkerConnectionCredentialSchema } from "@forgex/contracts";
import {
  assertPrivateWindowsPath,
  assertTrustedWindowsPath,
} from "./windows-path-security.js";
import { CodexAuthenticationSchema } from "./codex-auth.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

const safeBaseRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.includes("\\") &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value),
    "Git 基线名称格式不正确",
  );

const absolutePath = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => path.isAbsolute(value), "工作区路径必须是绝对路径");

const sha256Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const technicalName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
const localSecretValue = z
  .string()
  .max(8_192)
  .refine(
    (value) => !/[\u0000\r\n]/u.test(value),
    "本地连接配置不能包含换行或空字符",
  );
const mcpConnectionBase = {
  schemaVersion: z.literal(1),
  connectionBindingKey: internalKey,
  allowedTools: z.array(technicalName).min(1).max(50),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
} as const;
const mcpLiteralArgument = z
  .object({
    kind: z.literal("literal"),
    value: z
      .string()
      .min(1)
      .max(1_000)
      .refine(
        (value) =>
          /^(?:--?[A-Za-z][A-Za-z0-9-]*|[A-Za-z0-9_][A-Za-z0-9_-]{0,999})$/u.test(
            value,
          ),
        "MCP 普通参数只能使用不解释为文件或代码的受限值",
      ),
  })
  .strict();
const mcpTrustedFileArgument = z
  .object({
    kind: z.literal("trusted_file"),
    path: absolutePath,
    sha256: sha256Hash,
  })
  .strict();

export const DeviceMcpConnectionSchema = z
  .discriminatedUnion("transport", [
    z
      .object({
        ...mcpConnectionBase,
        transport: z.literal("stdio"),
        commandPath: absolutePath,
        commandSha256: sha256Hash,
        args: z
          .array(
            z.discriminatedUnion("kind", [
              mcpLiteralArgument,
              mcpTrustedFileArgument,
            ]),
          )
          .max(50)
          .default([]),
        environment: z
          .record(
            z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/u),
            localSecretValue,
          )
          .default({}),
        workingDirectory: absolutePath.optional(),
      })
      .strict(),
    z
      .object({
        ...mcpConnectionBase,
        transport: z.literal("streamable_http"),
        url: z.url().refine((value) => {
          try {
            const url = new URL(value);
            return (
              url.username === "" &&
              url.password === "" &&
              url.search === "" &&
              url.hash === "" &&
              (url.protocol === "https:" ||
                (url.protocol === "http:" &&
                  ["127.0.0.1", "localhost", "::1"].includes(url.hostname)))
            );
          } catch {
            return false;
          }
        }, "远程 MCP 必须使用无 URL 凭据的 HTTPS；本机可使用 HTTP"),
        headers: z
          .record(
            z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9-]{0,99}$/u)
              .refine(
                (name) =>
                  ![
                    "accept",
                    "connection",
                    "content-length",
                    "content-type",
                    "host",
                    "mcp-protocol-version",
                    "mcp-session-id",
                    "origin",
                    "transfer-encoding",
                  ].includes(name.toLowerCase()),
                "不能覆盖 MCP 传输保留请求头",
              ),
            localSecretValue,
          )
          .default({}),
      })
      .strict(),
  ])
  .superRefine((connection, context) => {
    if (
      new Set(connection.allowedTools).size !== connection.allowedTools.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedTools"],
        message: "本地 MCP 工具白名单不能重复",
      });
    }
    if (
      connection.transport === "streamable_http" &&
      Object.keys(connection.headers).length > 50
    ) {
      context.addIssue({
        code: "custom",
        path: ["headers"],
        message: "本地 MCP 请求头不能超过 50 项",
      });
    }
  });

export type DeviceMcpConnection = z.infer<typeof DeviceMcpConnectionSchema>;

export const ControlPlaneOriginSchema = z
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "::1"].includes(url.hostname))),
    "控制面地址必须使用 HTTPS；本机开发可使用 HTTP",
  )
  .transform((url) => url.origin);

export const DeviceWorkerProjectSchema = z
  .object({
    projectKey: internalKey,
    repositoryKey: internalKey,
    repositoryRoot: absolutePath,
    worktreeRoot: absolutePath,
    baseRef: safeBaseRef,
    model: z.string().trim().min(2).max(100).optional(),
    reasoningEffort: z
      .enum(["minimal", "low", "medium", "high", "xhigh"])
      .default("high"),
  })
  .strict()
  .superRefine((project, context) => {
    const repositoryRoot = path.resolve(project.repositoryRoot);
    const worktreeRoot = path.resolve(project.worktreeRoot);
    const relative = path.relative(repositoryRoot, worktreeRoot);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      context.addIssue({
        code: "custom",
        path: ["worktreeRoot"],
        message: "隔离工作树目录不能位于主仓库内部",
      });
    }
  });

export const DeviceWorkerConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    controlPlaneUrl: ControlPlaneOriginSchema,
    connection: WorkerConnectionCredentialSchema,
    codexHomePath: absolutePath,
    codexAuthentication: CodexAuthenticationSchema,
    codexIsolation: z
      .object({
        launcherPath: absolutePath,
        launcherSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        isolationKind: z.enum(["separate_os_identity", "container"]),
      })
      .strict(),
    completionJournalPath: absolutePath,
    capabilities: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9._-]{0,49}$/u),
      )
      .max(50)
      .default([]),
    projects: z.array(DeviceWorkerProjectSchema).min(1).max(100),
    mcpConnections: z.array(DeviceMcpConnectionSchema).max(50).default([]),
    idlePollIntervalMs: z.number().int().min(500).max(60_000).default(3_000),
    requestTimeoutMs: z.number().int().min(500).max(10_000).default(5_000),
    renewIntervalMs: z.number().int().min(1_000).max(30_000).default(15_000),
    allowedEnvironmentVariables: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/u))
      .max(50)
      .default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const keys = new Set<string>();
    const mcpBindingKeys = new Set<string>();
    if (new Set(config.capabilities).size !== config.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "设备能力不能重复",
      });
    }
    const journalPath = path.resolve(config.completionJournalPath);
    const codexHomePath = path.resolve(config.codexHomePath);
    const isolationLauncherPath = path.resolve(
      config.codexIsolation.launcherPath,
    );
    if (journalPath === codexHomePath) {
      context.addIssue({
        code: "custom",
        path: ["codexHomePath"],
        message: "专用 Codex 主目录不能与设备完成日志共用路径",
      });
    }
    if (config.requestTimeoutMs >= config.renewIntervalMs) {
      context.addIssue({
        code: "custom",
        path: ["requestTimeoutMs"],
        message: "单次控制面请求超时必须短于续租间隔",
      });
    }
    config.projects.forEach((project, index) => {
      if (keys.has(project.projectKey)) {
        context.addIssue({
          code: "custom",
          path: ["projects", index, "projectKey"],
          message: "同一项目不能重复配置",
        });
      }
      keys.add(project.projectKey);
      for (const root of [project.repositoryRoot, project.worktreeRoot]) {
        for (const [field, target, message] of [
          [
            "completionJournalPath",
            journalPath,
            "设备完成日志不能位于主仓库或任务工作树目录内部",
          ],
          [
            "codexHomePath",
            codexHomePath,
            "专用 Codex 主目录不能位于主仓库或任务工作树目录内部",
          ],
          [
            "codexIsolation",
            isolationLauncherPath,
            "Codex 隔离启动器不能位于主仓库或任务工作树目录内部",
          ],
        ] as const) {
          const relative = path.relative(path.resolve(root), target);
          if (
            relative === "" ||
            (!relative.startsWith("..") && !path.isAbsolute(relative))
          ) {
            context.addIssue({ code: "custom", path: [field], message });
          }
        }
      }
    });
    config.mcpConnections.forEach((connection, index) => {
      if (mcpBindingKeys.has(connection.connectionBindingKey)) {
        context.addIssue({
          code: "custom",
          path: ["mcpConnections", index, "connectionBindingKey"],
          message: "同一本地 MCP 连接绑定不能重复配置",
        });
      }
      mcpBindingKeys.add(connection.connectionBindingKey);
    });
    config.allowedEnvironmentVariables.forEach((name, index) => {
      if (
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|API_KEY|PRIVATE_KEY)/u.test(
          name,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["allowedEnvironmentVariables", index],
          message: "不能把凭据环境变量传给 Codex 执行进程",
        });
      }
    });
  });

export type DeviceWorkerConfig = z.infer<typeof DeviceWorkerConfigSchema>;
export type DeviceWorkerProject = z.infer<typeof DeviceWorkerProjectSchema>;

export interface DeviceWorkerConfigLoadOptions {
  platform?: NodeJS.Platform;
  assertWindowsPrivatePath?: (target: string) => Promise<void>;
  assertWindowsTrustedLauncherPath?: (target: string) => Promise<void>;
}

const assertPrivatePosixMetadata = (
  metadata: Awaited<ReturnType<typeof lstat>>,
  message: string,
): void => {
  if ((Number(metadata.mode) & 0o077) !== 0) throw new Error(message);
  if (
    typeof process.getuid === "function" &&
    typeof metadata.uid === "number" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error(message);
  }
};

const missingFile = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

const sameLocalPath = (
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean => {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
};

const assertTrustedDirectory = async (input: {
  target: string;
  label: string;
  platform: NodeJS.Platform;
  windowsPathCheck: (target: string) => Promise<void>;
}): Promise<Awaited<ReturnType<typeof lstat>>> => {
  const target = path.resolve(input.target);
  const metadata = await lstat(target);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameLocalPath(await realpath(target), target, input.platform)
  ) {
    throw new Error(`${input.label}必须是不可跳转的本地目录`);
  }
  if (input.platform === "win32") {
    await input.windowsPathCheck(target);
  } else {
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : -1;
    if (
      (Number(metadata.mode) & 0o022) !== 0 ||
      (typeof metadata.uid === "number" &&
        ![0, currentUid].includes(metadata.uid))
    ) {
      throw new Error(
        `${input.label}必须由当前用户或 root 持有，且组与其他用户不可写`,
      );
    }
  }
  return metadata;
};

const assertTrustedFile = async (input: {
  target: string;
  expectedSha256: string;
  label: string;
  platform: NodeJS.Platform;
  windowsPathCheck: (target: string) => Promise<void>;
  executable?: boolean;
}): Promise<void> => {
  const target = path.resolve(input.target);
  const metadata = await lstat(target);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > 128 * 1024 * 1024 ||
    !sameLocalPath(await realpath(target), target, input.platform)
  ) {
    throw new Error(`${input.label}必须是不可跳转的本地普通文件`);
  }
  if (
    input.executable === true &&
    input.platform !== "win32" &&
    (Number(metadata.mode) & 0o111) === 0
  ) {
    throw new Error(`${input.label}必须具有可执行权限`);
  }
  const directory = path.dirname(target);
  await assertTrustedDirectory({
    target: directory,
    label: `${input.label}父目录`,
    platform: input.platform,
    windowsPathCheck: input.windowsPathCheck,
  });
  if (input.platform === "win32") {
    await input.windowsPathCheck(target);
  } else {
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : -1;
    if (
      (Number(metadata.mode) & 0o022) !== 0 ||
      (typeof metadata.uid === "number" &&
        ![0, currentUid].includes(metadata.uid))
    ) {
      throw new Error(
        `${input.label}必须由当前用户或 root 持有，且组与其他用户不可写`,
      );
    }
  }
  const digest = createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
  if (digest !== input.expectedSha256) {
    throw new Error(`${input.label}内容与配置的可信摘要不一致`);
  }
};

export const assertTrustedStdioMcpConnection = async (
  connection: Extract<DeviceMcpConnection, { transport: "stdio" }>,
  options: Pick<
    DeviceWorkerConfigLoadOptions,
    "platform" | "assertWindowsTrustedLauncherPath"
  > = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const windowsPathCheck =
    options.assertWindowsTrustedLauncherPath ?? assertTrustedWindowsPath;
  await assertTrustedFile({
    target: connection.commandPath,
    expectedSha256: connection.commandSha256,
    label: "MCP 启动器",
    platform,
    windowsPathCheck,
    executable: true,
  });
  for (const argument of connection.args) {
    if (argument.kind !== "trusted_file") continue;
    await assertTrustedFile({
      target: argument.path,
      expectedSha256: argument.sha256,
      label: "MCP 参数文件",
      platform,
      windowsPathCheck,
    });
  }
  if (connection.workingDirectory) {
    await assertTrustedDirectory({
      target: connection.workingDirectory,
      label: "MCP 工作目录",
      platform,
      windowsPathCheck,
    });
  }
};

export const loadDeviceWorkerConfig = async (
  filePath: string,
  options: DeviceWorkerConfigLoadOptions = {},
): Promise<DeviceWorkerConfig> => {
  const platform = options.platform ?? process.platform;
  const windowsPathCheck =
    options.assertWindowsPrivatePath ?? assertPrivateWindowsPath;
  const windowsLauncherCheck =
    options.assertWindowsTrustedLauncherPath ?? assertTrustedWindowsPath;
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("设备 Worker 配置必须是普通文件，不能使用符号链接");
  }
  if (platform !== "win32") {
    assertPrivatePosixMetadata(
      metadata,
      "设备 Worker 配置包含连接密钥，文件必须由当前用户持有且权限限制为当前用户可读写",
    );
  }
  if (metadata.size > 1_048_576) {
    throw new Error("设备 Worker 配置文件不能超过 1 MiB");
  }
  if (platform === "win32") await windowsPathCheck(resolved);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    throw new Error("设备 Worker 配置不是有效的 JSON");
  }
  const parsed = DeviceWorkerConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("设备 Worker 配置不符合当前版本要求");
  }
  await assertTrustedFile({
    target: parsed.data.codexIsolation.launcherPath,
    expectedSha256: parsed.data.codexIsolation.launcherSha256,
    label: "Codex 隔离启动器",
    platform,
    windowsPathCheck: windowsLauncherCheck,
    executable: true,
  });
  for (const connection of parsed.data.mcpConnections) {
    if (connection.transport !== "stdio") continue;
    await assertTrustedStdioMcpConnection(connection, {
      platform,
      assertWindowsTrustedLauncherPath: windowsLauncherCheck,
    });
  }
  const journalPath = path.resolve(parsed.data.completionJournalPath);
  const journalDirectory = path.dirname(journalPath);
  const journalDirectoryMetadata = await lstat(journalDirectory);
  const actualJournalDirectory = path.normalize(
    await realpath(journalDirectory),
  );
  const configuredJournalDirectory = path.normalize(journalDirectory);
  const journalDirectoryMatches =
    platform === "win32"
      ? actualJournalDirectory.toLowerCase() ===
        configuredJournalDirectory.toLowerCase()
      : actualJournalDirectory === configuredJournalDirectory;
  if (
    !journalDirectoryMetadata.isDirectory() ||
    journalDirectoryMetadata.isSymbolicLink() ||
    !journalDirectoryMatches
  ) {
    throw new Error("设备完成日志目录必须是不可跳转的本地目录");
  }
  if (platform === "win32") {
    await windowsPathCheck(journalDirectory);
  } else {
    assertPrivatePosixMetadata(
      journalDirectoryMetadata,
      "设备完成日志目录必须由当前用户持有且限制为当前用户访问",
    );
  }
  try {
    const journalMetadata = await lstat(journalPath);
    if (!journalMetadata.isFile() || journalMetadata.isSymbolicLink()) {
      throw new Error("设备完成日志必须是不可跳转的普通文件");
    }
    if (platform === "win32") {
      await windowsPathCheck(journalPath);
    } else {
      assertPrivatePosixMetadata(
        journalMetadata,
        "设备完成日志必须由当前用户持有且限制为当前用户访问",
      );
    }
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
  return parsed.data;
};
