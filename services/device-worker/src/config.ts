import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { WorkerConnectionCredentialSchema } from "@forgex/contracts";

const execFileAsync = promisify(execFile);

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
            z
              .string()
              .max(1_000)
              .refine((value) => !value.includes("\u0000")),
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
    codexIsolation: z
      .object({
        launcherPath: absolutePath,
        launcherSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        isolationKind: z.enum(["separate_os_identity", "container"]),
      })
      .strict(),
    completionJournalPath: absolutePath,
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

const assertPrivateWindowsPath = async (target: string): Promise<void> => {
  const script = String.raw`
$acl = Get-Acl -LiteralPath $args[0]
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $current) { exit 3 }
$allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) {
    $readMask = [System.Security.AccessControl.FileSystemRights]::ReadData -bor [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [System.Security.AccessControl.FileSystemRights]::FullControl
    if (($rule.FileSystemRights -band $readMask) -ne 0) { exit 4 }
  }
}
exit 0
`;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, target],
      { windowsHide: true, timeout: 10_000 },
    );
  } catch {
    throw new Error(
      "设备配置与专用 Codex 目录必须仅允许当前 Windows 用户、SYSTEM 和管理员读取",
    );
  }
};

const assertTrustedWindowsLauncherPath = async (
  target: string,
): Promise<void> => {
  const script = String.raw`
$acl = Get-Acl -LiteralPath $args[0]
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
$allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
if ($allowed -notcontains $owner) { exit 3 }
$writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership -bor [System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::FullControl
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) {
    if (($rule.FileSystemRights -band $writeMask) -ne 0) { exit 4 }
  }
}
exit 0
`;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, target],
      { windowsHide: true, timeout: 10_000 },
    );
  } catch {
    throw new Error(
      "Codex 隔离启动器及其父目录必须由当前用户、SYSTEM 或管理员持有，且其他用户不可写",
    );
  }
};

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

export const loadDeviceWorkerConfig = async (
  filePath: string,
  options: DeviceWorkerConfigLoadOptions = {},
): Promise<DeviceWorkerConfig> => {
  const platform = options.platform ?? process.platform;
  const windowsPathCheck =
    options.assertWindowsPrivatePath ?? assertPrivateWindowsPath;
  const windowsLauncherCheck =
    options.assertWindowsTrustedLauncherPath ??
    assertTrustedWindowsLauncherPath;
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
  const launcherMetadata = await lstat(parsed.data.codexIsolation.launcherPath);
  if (
    !launcherMetadata.isFile() ||
    launcherMetadata.isSymbolicLink() ||
    launcherMetadata.size < 1 ||
    launcherMetadata.size > 128 * 1024 * 1024
  ) {
    throw new Error("Codex 隔离启动器必须是不可跳转的本地普通文件");
  }
  if (platform !== "win32" && (Number(launcherMetadata.mode) & 0o111) === 0) {
    throw new Error("Codex 隔离启动器必须具有可执行权限");
  }
  const launcherDirectory = path.dirname(
    path.resolve(parsed.data.codexIsolation.launcherPath),
  );
  const launcherDirectoryMetadata = await lstat(launcherDirectory);
  const actualLauncherDirectory = path.normalize(
    await realpath(launcherDirectory),
  );
  const configuredLauncherDirectory = path.normalize(launcherDirectory);
  const launcherDirectoryMatches =
    platform === "win32"
      ? actualLauncherDirectory.toLowerCase() ===
        configuredLauncherDirectory.toLowerCase()
      : actualLauncherDirectory === configuredLauncherDirectory;
  if (
    !launcherDirectoryMetadata.isDirectory() ||
    launcherDirectoryMetadata.isSymbolicLink() ||
    !launcherDirectoryMatches
  ) {
    throw new Error("Codex 隔离启动器父目录必须是不可跳转的本地目录");
  }
  if (platform === "win32") {
    await windowsLauncherCheck(launcherDirectory);
    await windowsLauncherCheck(parsed.data.codexIsolation.launcherPath);
  } else {
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : -1;
    for (const metadata of [launcherDirectoryMetadata, launcherMetadata]) {
      if (
        (Number(metadata.mode) & 0o022) !== 0 ||
        (typeof metadata.uid === "number" &&
          ![0, currentUid].includes(metadata.uid))
      ) {
        throw new Error(
          "Codex 隔离启动器及其父目录必须由当前用户或 root 持有，且组与其他用户不可写",
        );
      }
    }
  }
  const launcherDigest = createHash("sha256")
    .update(await readFile(parsed.data.codexIsolation.launcherPath))
    .digest("hex");
  if (launcherDigest !== parsed.data.codexIsolation.launcherSha256) {
    throw new Error("Codex 隔离启动器内容与配置的可信摘要不一致");
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
