import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";

import {
  assertCodexToolSurface,
  assertLauncherFilesystemBoundary,
  executeIsolatedCodexRun,
  type IsolatedCodexRunRequest,
} from "../src/isolation-launcher.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const request = (): IsolatedCodexRunRequest => {
  const protectedPaths = [path.resolve("controller/worker.json")];
  return {
    schemaVersion: 1 as const,
    challenge: randomUUID(),
    isolationKind: "separate_os_identity" as const,
    workspacePath: path.resolve("runner/worktree"),
    protectedPaths,
    protectedPathsHash: createHash("sha256")
      .update(JSON.stringify(protectedPaths), "utf8")
      .digest("hex"),
    controllerIdentity: "uid:1000",
    codexHomePath: path.resolve("runner/codex-home"),
    authentication: { store: "keyring" as const },
    codex: {
      reasoningEffort: "high" as const,
      sandboxMode: "workspace-write" as const,
      networkAccessEnabled: false as const,
      webSearchMode: "disabled" as const,
      approvalPolicy: "never" as const,
      config: {
        cli_auth_credentials_store: "keyring" as const,
        allow_login_shell: false as const,
        agents: { enabled: false as const },
        mcp_servers: {},
        features: {
          apps: false as const,
          auth_elicitation: false as const,
          browser_use: false as const,
          browser_use_external: false as const,
          browser_use_full_cdp_access: false as const,
          code_mode_host: false as const,
          computer_use: false as const,
          goals: false as const,
          guardian_approval: false as const,
          hooks: false as const,
          image_generation: false as const,
          in_app_browser: false as const,
          in_app_updates: false as const,
          memories: false as const,
          mentions_v2: false as const,
          shell_tool: false as const,
          unified_exec: false as const,
          shell_snapshot: false as const,
          multi_agent: false as const,
          plugin_sharing: false as const,
          plugins: false as const,
          web_search: false as const,
          remote_plugin: false as const,
          skill_mcp_dependency_install: false as const,
          skill_search: false as const,
          tool_call_mcp_elicitation: false as const,
          tool_suggest: false as const,
          view_image: false as const,
          workspace_dependencies: false as const,
        },
        history: { persistence: "none" as const },
        project_doc_max_bytes: 0 as const,
        project_doc_fallback_filenames: [],
        shell_environment_policy: {
          inherit: "none" as const,
          ignore_default_excludes: false as const,
          set: { PATH: "/usr/bin" },
        },
      },
    },
    prompt: "实现已确认需求",
    outputSchema: { type: "object" },
  };
};

const virtualRuntimeCodexHome = async (codexHomePath: string) => ({
  path: path.join(codexHomePath, ".forgex-run-test"),
  cleanup: async () => Promise.resolve(),
});

describe("executeIsolatedCodexRun", () => {
  it("只把 hmk 登录文件带入单次运行目录，并原子保留 Codex 刷新结果", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-auth-reuse-"));
    temporaryRoots.push(root);
    const codexHomePath = path.join(root, "isolated-home");
    const authFilePath = path.join(root, "hmk-auth.json");
    await mkdir(codexHomePath);
    await writeFile(
      authFilePath,
      JSON.stringify({ tokens: { access_token: "before" } }),
      "utf8",
    );
    const input = request();
    input.codexHomePath = codexHomePath;
    input.authentication = { store: "file", authFilePath };
    input.codex.config.cli_auth_credentials_store = "file";
    const createCodex = vi.fn((options: CodexOptions) => ({
      startThread: () => ({
        id: "thread-file-auth",
        runStreamed: async () => {
          const runtimeHome = options.env?.CODEX_HOME;
          if (!runtimeHome) throw new Error("缺少运行时 CODEX_HOME");
          expect(
            JSON.parse(
              await readFile(path.join(runtimeHome, "auth.json"), "utf8"),
            ),
          ).toMatchObject({ tokens: { access_token: "before" } });
          await writeFile(
            path.join(runtimeHome, "auth.json"),
            JSON.stringify({ tokens: { access_token: "after" } }),
            "utf8",
          );
          return {
            events: (async function* () {
              yield { type: "turn.started" as const };
              yield {
                type: "item.completed" as const,
                item: {
                  id: "message-1",
                  type: "agent_message" as const,
                  text: JSON.stringify({
                    status: "completed",
                    summary: "已完成",
                    tests: [],
                  }),
                },
              };
              yield {
                type: "turn.completed" as const,
                usage: {
                  input_tokens: 0,
                  cached_input_tokens: 0,
                  cache_write_input_tokens: 0,
                  output_tokens: 0,
                  reasoning_output_tokens: 0,
                },
              };
            })(),
          };
        },
      }),
    }));

    await executeIsolatedCodexRun(input, {
      currentIdentity: async () => "uid:2000",
      assertFilesystemBoundary: vi.fn(),
      assertToolSurface: vi.fn(),
      assertPrivateCredentialPath: vi.fn(),
      createCodex,
    });

    expect(JSON.parse(await readFile(authFilePath, "utf8"))).toMatchObject({
      tokens: { access_token: "after" },
    });
    await expect(readdir(codexHomePath)).resolves.toEqual([]);
  });

  it("登录文件不是有效 JSON 时在创建 Codex 前失败关闭并清理临时目录", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-auth-invalid-"));
    temporaryRoots.push(root);
    const codexHomePath = path.join(root, "isolated-home");
    const authFilePath = path.join(root, "hmk-auth.json");
    await mkdir(codexHomePath);
    await writeFile(authFilePath, "not-json", "utf8");
    const input = request();
    input.codexHomePath = codexHomePath;
    input.authentication = { store: "file", authFilePath };
    input.codex.config.cli_auth_credentials_store = "file";
    const createCodex = vi.fn();

    await expect(
      executeIsolatedCodexRun(input, {
        currentIdentity: async () => "uid:2000",
        assertFilesystemBoundary: vi.fn(),
        assertToolSurface: vi.fn(),
        assertPrivateCredentialPath: vi.fn(),
        createCodex,
      }),
    ).rejects.toThrow("Codex 登录缓存不是有效的 JSON 对象");

    expect(createCodex).not.toHaveBeenCalled();
    await expect(readdir(codexHomePath)).resolves.toEqual([]);
  });

  it("每轮结束后清理 Codex 自动生成的禁止配置，避免后续任务被旧状态阻断", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-home-cleanup-"));
    temporaryRoots.push(root);
    const codexHomePath = path.join(root, "codex-home");
    await mkdir(codexHomePath);
    const staleRuntimeHome = path.join(codexHomePath, ".forgex-run-abcdef");
    await mkdir(staleRuntimeHome);
    await writeFile(
      path.join(staleRuntimeHome, "config.toml"),
      'trust_level = "untrusted"\n',
      "utf8",
    );
    const input = request();
    input.codexHomePath = codexHomePath;
    const runStreamed = vi.fn(async () => ({
      events: (async function* () {
        yield { type: "turn.started" as const };
        yield {
          type: "item.completed" as const,
          item: {
            id: "message-1",
            type: "agent_message" as const,
            text: JSON.stringify({
              status: "completed",
              summary: "已完成",
              tests: [],
            }),
          },
        };
        yield {
          type: "turn.completed" as const,
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        };
      })(),
    }));

    await executeIsolatedCodexRun(input, {
      currentIdentity: async () => "uid:2000",
      assertFilesystemBoundary: vi.fn(),
      assertToolSurface: async (runtimeRequest) => {
        await writeFile(
          path.join(runtimeRequest.codexHomePath, "config.toml"),
          'trust_level = "untrusted"\n',
          "utf8",
        );
        await mkdir(path.join(runtimeRequest.codexHomePath, "skills"));
      },
      createCodex: () => ({
        startThread: () => ({ id: "thread-cleanup", runStreamed }),
      }),
    });

    await expect(
      access(path.join(codexHomePath, "config.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(codexHomePath, "skills")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(codexHomePath)).resolves.toEqual([]);
  });

  it("同一回合的重复失败只上报一次脱敏原因", async () => {
    const runStreamed = vi.fn(async () => ({
      events: (async function* () {
        yield { type: "turn.started" as const };
        yield {
          type: "error" as const,
          message: "401 unauthorized TOKEN=secret",
        };
        yield {
          type: "error" as const,
          message: "401 unauthorized TOKEN=secret",
        };
      })(),
    }));
    const emitProgress = vi.fn();

    await expect(
      executeIsolatedCodexRun(request(), {
        currentIdentity: async () => "uid:2000",
        assertFilesystemBoundary: vi.fn(),
        assertToolSurface: vi.fn(),
        prepareRuntimeCodexHome: virtualRuntimeCodexHome,
        createCodex: () => ({
          startThread: () => ({ id: "thread-failed", runStreamed }),
        }),
        emitProgress,
      }),
    ).rejects.toThrow("Codex 执行回合未完成");

    expect(emitProgress.mock.calls.map(([event]) => event)).toEqual([
      { kind: "lifecycle", status: "started" },
      {
        kind: "lifecycle",
        status: "failed",
        reason: "authentication",
      },
    ]);
    expect(JSON.stringify(emitProgress.mock.calls)).not.toContain("TOKEN");
    expect(JSON.stringify(emitProgress.mock.calls)).not.toContain("401");
  });

  it("流式执行只打印受控工具和文件变更，不打印思维、参数或原始内容", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-secret" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "reasoning-1", type: "reasoning", text: "内部思维" },
      },
      {
        type: "item.completed",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          server: "forgex_workspace",
          tool: "read_workspace_file",
          arguments: { path: ".env" },
          result: {
            content: [{ type: "text", text: "TOKEN=secret" }],
            structured_content: null,
          },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "change-1",
          type: "file_change",
          changes: [{ path: "src/App.tsx", kind: "update" }],
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "message-1",
          type: "agent_message",
          text: JSON.stringify({
            status: "completed",
            summary: "已完成",
            tests: [],
          }),
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];
    const runStreamed = vi.fn(async () => ({
      events: (async function* () {
        for (const event of events) yield event;
      })(),
    }));
    const createCodex = vi.fn(() => ({
      startThread: () => ({ id: "thread-secret", runStreamed }),
    }));
    const emitProgress = vi.fn();

    await executeIsolatedCodexRun(request(), {
      currentIdentity: async () => "uid:2000",
      assertFilesystemBoundary: vi.fn(),
      assertToolSurface: vi.fn(),
      prepareRuntimeCodexHome: virtualRuntimeCodexHome,
      createCodex,
      emitProgress,
    });

    expect(emitProgress.mock.calls.map(([event]) => event)).toEqual([
      { kind: "lifecycle", status: "started" },
      {
        kind: "tool",
        tool: "read_workspace_file",
        status: "completed",
      },
      {
        kind: "file_change",
        changes: [{ path: "src/App.tsx", kind: "update" }],
        status: "completed",
      },
      { kind: "lifecycle", status: "completed" },
    ]);
    expect(JSON.stringify(emitProgress.mock.calls)).not.toContain("内部思维");
    expect(JSON.stringify(emitProgress.mock.calls)).not.toContain("TOKEN");
    expect(JSON.stringify(emitProgress.mock.calls)).not.toContain(".env");
    expect(JSON.stringify(emitProgress.mock.calls)).not.toContain(
      "thread-secret",
    );
  });

  it("以真实固定版本 CLI 证明除受控工作树工具外的内置工具均已关闭", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-tools-"));
    temporaryRoots.push(root);
    const workspacePath = path.join(root, "workspace");
    const codexHomePath = path.join(root, "codex-home");
    await mkdir(workspacePath);
    await mkdir(codexHomePath);
    const input = request();
    input.workspacePath = workspacePath;
    input.codexHomePath = codexHomePath;

    await expect(assertCodexToolSurface(input)).resolves.toBeUndefined();
  });

  it("真实 CLI 清单出现额外启用 MCP 时必须失败关闭", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-mcp-tools-"));
    temporaryRoots.push(root);
    const workspacePath = path.join(root, "workspace");
    const codexHomePath = path.join(root, "codex-home");
    await mkdir(workspacePath);
    await mkdir(codexHomePath);
    await writeFile(
      path.join(codexHomePath, "config.toml"),
      '[mcp_servers.extra]\ncommand = "node"\nargs = ["extra.js"]\n',
      "utf8",
    );
    const input = request();
    input.workspacePath = workspacePath;
    input.codexHomePath = codexHomePath;

    await expect(assertCodexToolSurface(input)).rejects.toThrow(
      "只能启用 ForgeX 受控工作区 MCP 服务",
    );
  });

  it.skipIf(process.platform === "win32")(
    "受保护目录即使不可列举但已知子文件可读也必须失败关闭",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "forgex-boundary-"));
      temporaryRoots.push(root);
      const workspacePath = path.join(root, "workspace");
      const protectedPath = path.join(root, "controller");
      const codexHomePath = path.join(root, "codex-home");
      await mkdir(workspacePath);
      await mkdir(protectedPath);
      await mkdir(codexHomePath, { mode: 0o700 });
      await writeFile(path.join(protectedPath, ".env"), "SECRET=visible", {
        mode: 0o644,
      });
      await chmod(protectedPath, 0o111);
      const input = request();
      input.workspacePath = workspacePath;
      input.protectedPaths = [protectedPath];
      input.protectedPathsHash = createHash("sha256")
        .update(JSON.stringify([protectedPath]), "utf8")
        .digest("hex");
      input.codexHomePath = codexHomePath;

      await expect(assertLauncherFilesystemBoundary(input)).rejects.toThrow(
        "仍能读取受保护路径",
      );
      await chmod(protectedPath, 0o700);
    },
  );

  it("隔离启动器与控制器身份相同时在创建 Codex 前失败关闭", async () => {
    const createCodex = vi.fn();
    await expect(
      executeIsolatedCodexRun(request(), {
        currentIdentity: async () => "uid:1000",
        assertFilesystemBoundary: vi.fn(),
        assertToolSurface: vi.fn(),
        createCodex,
      }),
    ).rejects.toThrow("不能与 Worker 控制器使用同一系统身份");
    expect(createCodex).not.toHaveBeenCalled();
  });

  it("受保护路径摘要与清单不一致时在创建 Codex 前失败关闭", async () => {
    const createCodex = vi.fn();
    const input = request();
    input.protectedPathsHash = "0".repeat(64);

    await expect(
      executeIsolatedCodexRun(input, {
        currentIdentity: async () => "uid:2000",
        assertFilesystemBoundary: vi.fn(),
        assertToolSurface: vi.fn(),
        createCodex,
      }),
    ).rejects.toThrow("受保护路径清单不可信");
    expect(createCodex).not.toHaveBeenCalled();
  });

  it("同一隔离实例验证文件边界后才通过官方 SDK 运行结构化任务", async () => {
    const runStreamed = vi.fn(async () => ({
      events: (async function* () {
        yield { type: "turn.started" as const };
        yield {
          type: "item.completed" as const,
          item: {
            id: "message-1",
            type: "agent_message" as const,
            text: JSON.stringify({
              status: "completed",
              summary: "已完成",
              tests: [],
            }),
          },
        };
        yield {
          type: "turn.completed" as const,
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        };
      })(),
    }));
    const startThread = vi.fn(() => ({
      id: "thread-isolated",
      runStreamed,
    }));
    const createCodex = vi.fn((_options: CodexOptions) => ({ startThread }));
    const assertFilesystemBoundary = vi.fn(async () => Promise.resolve());
    const assertToolSurface = vi.fn(async () => Promise.resolve());
    const input = request();

    await expect(
      executeIsolatedCodexRun(input, {
        currentIdentity: async () => "uid:2000",
        assertFilesystemBoundary,
        assertToolSurface,
        prepareRuntimeCodexHome: virtualRuntimeCodexHome,
        createCodex,
      }),
    ).resolves.toMatchObject({
      challenge: input.challenge,
      controllerIdentitySeparated: true,
      protectedPathsDenied: true,
      shellToolsDisabled: true,
      controlledWorkspaceToolsOnly: true,
      finalResponse: expect.stringContaining("completed"),
      threadId: "thread-isolated",
    });
    expect(assertFilesystemBoundary).toHaveBeenCalledOnce();
    expect(assertToolSurface).toHaveBeenCalledOnce();
    expect(createCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PATH: "/usr/bin",
          CODEX_HOME: expect.any(String),
        },
        config: expect.objectContaining({
          cli_auth_credentials_store: "keyring",
          features: expect.objectContaining({
            apps: false,
            browser_use: false,
            computer_use: false,
            shell_tool: false,
            unified_exec: false,
            view_image: false,
            workspace_dependencies: false,
          }),
          mcp_servers: expect.objectContaining({
            forgex_workspace: expect.objectContaining({
              enabled_tools: [
                "list_workspace",
                "read_workspace_file",
                "search_workspace_text",
              ],
            }),
          }),
        }),
      }),
    );
    const runtimeCodexHome = createCodex.mock.calls[0]?.[0].env?.CODEX_HOME;
    if (!runtimeCodexHome) throw new Error("测试没有取得隔离 CODEX_HOME");
    expect(runtimeCodexHome).not.toBe(input.codexHomePath);
    expect(path.dirname(runtimeCodexHome)).toBe(input.codexHomePath);
    const projectTrustOverride = `projects.${JSON.stringify(input.workspacePath)}.trust_level`;
    expect(createCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          [projectTrustOverride]: "untrusted",
        }),
      }),
    );
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: input.workspacePath,
        sandboxMode: "workspace-write",
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        approvalPolicy: "never",
      }),
    );
    expect(runStreamed).toHaveBeenCalledWith(input.prompt, {
      outputSchema: input.outputSchema,
    });
  });
});
