import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceWorkerConfigSchema,
  loadDeviceWorkerConfig,
} from "../src/config.js";
import { projectKey, repositoryKey, tenantKey } from "./fixtures.js";

const base = {
  schemaVersion: 1 as const,
  controlPlaneUrl: "https://forgex.example.test",
  connection: {
    schemaVersion: 1 as const,
    tenantKey,
    workerKey: "55555555-5555-4555-8555-555555555555",
    sessionKey: "s".repeat(43),
    generation: 1,
  },
  codexHomePath: path.resolve("fixtures/codex-home"),
  codexIsolation: {
    launcherPath: path.resolve("fixtures/codex-isolation-launcher"),
    launcherSha256: "0".repeat(64),
    isolationKind: "separate_os_identity" as const,
  },
  completionJournalPath: path.resolve("fixtures/state/completion.json"),
  projects: [
    {
      projectKey,
      repositoryKey,
      repositoryRoot: path.resolve("fixtures/repository"),
      worktreeRoot: path.resolve("fixtures/worktrees"),
      baseRef: "main",
    },
  ],
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("设备 Worker 配置", () => {
  it("默认使用隔离 keyring，也允许显式绑定本机 Codex 登录文件", () => {
    const isolated = DeviceWorkerConfigSchema.parse(base);
    expect(isolated.codexAuthentication).toEqual({ store: "keyring" });

    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        codexAuthentication: {
          store: "file",
          authFilePath: path.resolve("fixtures/user-codex/auth.json"),
        },
      }).success,
    ).toBe(true);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        codexAuthentication: { store: "file" },
      }).success,
    ).toBe(false);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        codexAuthentication: {
          store: "keyring",
          authFilePath: path.resolve("fixtures/user-codex/auth.json"),
        },
      }).success,
    ).toBe(false);
  });

  it("生产控制面只允许 HTTPS，本机开发地址可以使用 HTTP", () => {
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        controlPlaneUrl: "http://forgex.example.test",
      }).success,
    ).toBe(false);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        controlPlaneUrl: "http://127.0.0.1:3000",
      }).success,
    ).toBe(true);
  });

  it("拒绝重复项目、仓库内工作树和凭据环境变量", () => {
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        projects: [base.projects[0], base.projects[0]],
      }).success,
    ).toBe(false);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        projects: [
          {
            ...base.projects[0]!,
            worktreeRoot: path.join(
              base.projects[0]!.repositoryRoot,
              ".worktrees",
            ),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        completionJournalPath: path.join(
          base.projects[0]!.repositoryRoot,
          "completion.json",
        ),
      }).success,
    ).toBe(false);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        allowedEnvironmentVariables: ["DATABASE_PASSWORD"],
      }).success,
    ).toBe(false);
  });

  it("本地 MCP 连接必须使用唯一绑定、明确工具白名单和受限传输", () => {
    const stdio = {
      schemaVersion: 1 as const,
      connectionBindingKey: "77777777-7777-4777-8777-777777777777",
      transport: "stdio" as const,
      commandPath: path.resolve("fixtures/mcp-launcher"),
      commandSha256: "a".repeat(64),
      args: [
        { kind: "literal", value: "--profile" },
        { kind: "literal", value: "team" },
      ],
      environment: { MCP_PROFILE: "team" },
      allowedTools: ["notifications.send"],
      timeoutMs: 30_000,
    };
    const http = {
      schemaVersion: 1 as const,
      connectionBindingKey: "88888888-8888-4888-8888-888888888888",
      transport: "streamable_http" as const,
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer local-only" },
      allowedTools: ["deploy.status"],
      timeoutMs: 30_000,
    };

    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        mcpConnections: [stdio, http],
      }).success,
    ).toBe(true);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        mcpConnections: [stdio, stdio],
      }).success,
    ).toBe(false);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        mcpConnections: [{ ...http, url: "http://mcp.example.test/mcp" }],
      }).success,
    ).toBe(false);
    expect(
      DeviceWorkerConfigSchema.safeParse({
        ...base,
        mcpConnections: [{ ...stdio, allowedTools: [] }],
      }).success,
    ).toBe(false);
  });

  it("Windows 启动时拒绝本机其他用户可读的明文连接配置", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-config-"));
    temporaryRoots.push(root);
    const codexHomePath = path.join(root, "codex-home");
    const configPath = path.join(root, "worker.json");
    await mkdir(codexHomePath);
    await writeFile(
      configPath,
      JSON.stringify({
        ...base,
        codexHomePath,
        completionJournalPath: path.join(root, "completion.json"),
      }),
      "utf8",
    );
    const assertWindowsPrivatePath = vi.fn(async () => {
      throw new Error("模拟 Users 组可读");
    });

    await expect(
      loadDeviceWorkerConfig(configPath, {
        platform: "win32",
        assertWindowsPrivatePath,
      }),
    ).rejects.toThrow("模拟 Users 组可读");
    expect(assertWindowsPrivatePath).toHaveBeenCalledWith(configPath);
  });

  it("启动时同时校验完成日志父目录的私有访问边界", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-config-"));
    temporaryRoots.push(root);
    const codexHomePath = path.join(root, "codex-home");
    const journalDirectory = path.join(root, "state");
    const launcherPath = path.join(root, "codex-isolation-launcher.exe");
    const launcherContent = "trusted isolation launcher";
    const configPath = path.join(root, "worker.json");
    await mkdir(codexHomePath);
    await mkdir(journalDirectory);
    await writeFile(launcherPath, launcherContent, "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        ...base,
        codexHomePath,
        codexIsolation: {
          launcherPath,
          launcherSha256: createHash("sha256")
            .update(launcherContent, "utf8")
            .digest("hex"),
          isolationKind: "separate_os_identity",
        },
        completionJournalPath: path.join(journalDirectory, "completion.json"),
      }),
      "utf8",
    );
    const assertWindowsPrivatePath = vi.fn(async () => Promise.resolve());
    const assertWindowsTrustedLauncherPath = vi.fn(async () =>
      Promise.resolve(),
    );

    await expect(
      loadDeviceWorkerConfig(configPath, {
        platform: "win32",
        assertWindowsPrivatePath,
        assertWindowsTrustedLauncherPath,
      }),
    ).resolves.toMatchObject({
      completionJournalPath: path.join(journalDirectory, "completion.json"),
    });
    expect(assertWindowsPrivatePath).toHaveBeenCalledWith(configPath);
    expect(assertWindowsPrivatePath).toHaveBeenCalledWith(journalDirectory);
    expect(assertWindowsTrustedLauncherPath).toHaveBeenCalledWith(root);
    expect(assertWindowsTrustedLauncherPath).toHaveBeenCalledWith(launcherPath);

    await writeFile(launcherPath, "tampered launcher", "utf8");
    await expect(
      loadDeviceWorkerConfig(configPath, {
        platform: "win32",
        assertWindowsPrivatePath,
        assertWindowsTrustedLauncherPath,
      }),
    ).rejects.toThrow("可信摘要");
  });

  it("启动时校验每个 stdio MCP 启动器的文件、父目录和可信摘要", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-config-"));
    temporaryRoots.push(root);
    const codexHomePath = path.join(root, "codex-home");
    const journalDirectory = path.join(root, "state");
    const mcpDirectory = path.join(root, "mcp-bin");
    const isolationLauncherPath = path.join(root, "isolation-launcher.exe");
    const mcpLauncherPath = path.join(mcpDirectory, "team-mcp.exe");
    const mcpProgramPath = path.join(mcpDirectory, "team-mcp.mjs");
    const isolationLauncherContent = "trusted isolation launcher";
    const mcpLauncherContent = "trusted mcp launcher";
    const mcpProgramContent = "export const server = 'trusted';";
    const configPath = path.join(root, "worker.json");
    await mkdir(codexHomePath);
    await mkdir(journalDirectory);
    await mkdir(mcpDirectory);
    await writeFile(isolationLauncherPath, isolationLauncherContent, "utf8");
    await writeFile(mcpLauncherPath, mcpLauncherContent, "utf8");
    await writeFile(mcpProgramPath, mcpProgramContent, "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        ...base,
        codexHomePath,
        codexIsolation: {
          launcherPath: isolationLauncherPath,
          launcherSha256: createHash("sha256")
            .update(isolationLauncherContent, "utf8")
            .digest("hex"),
          isolationKind: "separate_os_identity",
        },
        completionJournalPath: path.join(journalDirectory, "completion.json"),
        mcpConnections: [
          {
            schemaVersion: 1,
            connectionBindingKey: "77777777-7777-4777-8777-777777777777",
            transport: "stdio",
            commandPath: mcpLauncherPath,
            commandSha256: createHash("sha256")
              .update(mcpLauncherContent, "utf8")
              .digest("hex"),
            args: [
              {
                kind: "trusted_file",
                path: mcpProgramPath,
                sha256: createHash("sha256")
                  .update(mcpProgramContent, "utf8")
                  .digest("hex"),
              },
            ],
            environment: {},
            allowedTools: ["notifications.send"],
            timeoutMs: 30_000,
          },
        ],
      }),
      "utf8",
    );
    const assertWindowsPrivatePath = vi.fn(async () => Promise.resolve());
    const assertWindowsTrustedLauncherPath = vi.fn(async () =>
      Promise.resolve(),
    );

    await expect(
      loadDeviceWorkerConfig(configPath, {
        platform: "win32",
        assertWindowsPrivatePath,
        assertWindowsTrustedLauncherPath,
      }),
    ).resolves.toMatchObject({
      mcpConnections: [
        expect.objectContaining({ commandPath: mcpLauncherPath }),
      ],
    });
    expect(assertWindowsTrustedLauncherPath).toHaveBeenCalledWith(mcpDirectory);
    expect(assertWindowsTrustedLauncherPath).toHaveBeenCalledWith(
      mcpLauncherPath,
    );
    expect(assertWindowsTrustedLauncherPath).toHaveBeenCalledWith(
      mcpProgramPath,
    );

    await writeFile(mcpProgramPath, "tampered mcp program", "utf8");
    await expect(
      loadDeviceWorkerConfig(configPath, {
        platform: "win32",
        assertWindowsPrivatePath,
        assertWindowsTrustedLauncherPath,
      }),
    ).rejects.toThrow("MCP 参数文件内容与配置的可信摘要不一致");
    await writeFile(mcpProgramPath, mcpProgramContent, "utf8");

    await writeFile(mcpLauncherPath, "tampered mcp launcher", "utf8");
    await expect(
      loadDeviceWorkerConfig(configPath, {
        platform: "win32",
        assertWindowsPrivatePath,
        assertWindowsTrustedLauncherPath,
      }),
    ).rejects.toThrow("MCP 启动器内容与配置的可信摘要不一致");
  });
});
