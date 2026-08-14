import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";
import {
  CodexProcessEventSchema,
  type CodexProcessEventPayload,
} from "@forgex/contracts";

import type { CodexAuthentication } from "./codex-auth.js";

export const CODEX_PROGRESS_PREFIX = "FORGEX_CODEX_EVENT:";

const execFileAsync = promisify(execFile);

export const currentOsIdentity = async (): Promise<string> => {
  if (typeof process.getuid === "function") return `uid:${process.getuid()}`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  const sid = stdout.trim();
  if (!/^S-1-[0-9-]+$/u.test(sid)) {
    throw new Error("无法确认当前 Windows 执行身份");
  }
  return `sid:${sid}`;
};

export interface IsolatedCodexRunInput {
  workspacePath: string;
  protectedPaths: string[];
  codexHomePath: string;
  authentication?: CodexAuthentication;
  prompt: string;
  outputSchema: unknown;
  model?: string;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
  environment: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (event: CodexProcessEventPayload) => void;
}

export interface CodexIsolationRunner {
  run(input: IsolatedCodexRunInput): Promise<{
    finalResponse: string;
    threadId: string | null;
  }>;
}

const runResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    challenge: z.string().uuid(),
    isolationKind: z.enum(["separate_os_identity", "container"]),
    workspacePath: z.string().min(1).max(1_000),
    protectedPathsHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workspaceReadable: z.literal(true),
    workspaceWritable: z.literal(true),
    protectedPathsDenied: z.literal(true),
    controllerIdentitySeparated: z.literal(true),
    shellToolsDisabled: z.literal(true),
    controlledWorkspaceToolsOnly: z.literal(true),
    finalResponse: z.string().min(1).max(1_048_576),
    threadId: z.string().min(1).max(500).nullable(),
  })
  .strict();

export const canonicalProtectedPaths = (values: string[]): string[] => {
  const pathsByIdentity = new Map<string, string>();
  for (const value of values) {
    const normalized = path.normalize(path.resolve(value));
    const identity =
      process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!pathsByIdentity.has(identity))
      pathsByIdentity.set(identity, normalized);
  }
  return [...pathsByIdentity.values()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const protectedPathsDigest = (values: string[]): string =>
  sha256(JSON.stringify(canonicalProtectedPaths(values)));

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

export class ExternalCodexIsolationRunner implements CodexIsolationRunner {
  readonly #launcherPath: string;
  readonly #launcherSha256: string;
  readonly #isolationKind: "separate_os_identity" | "container";
  readonly #timeoutMs: number;
  readonly #launcherArguments: string[];

  constructor(options: {
    launcherPath: string;
    launcherSha256: string;
    isolationKind: "separate_os_identity" | "container";
    timeoutMs?: number;
    launcherArguments?: string[];
  }) {
    if (!path.isAbsolute(options.launcherPath)) {
      throw new Error("Codex 隔离启动器必须使用绝对路径");
    }
    if (!/^[a-f0-9]{64}$/u.test(options.launcherSha256)) {
      throw new Error("Codex 隔离启动器摘要格式不正确");
    }
    this.#launcherPath = path.resolve(options.launcherPath);
    this.#launcherSha256 = options.launcherSha256;
    this.#isolationKind = options.isolationKind;
    this.#timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.#launcherArguments = [...(options.launcherArguments ?? [])];
  }

  async run(input: IsolatedCodexRunInput): Promise<{
    finalResponse: string;
    threadId: string | null;
  }> {
    await this.#assertLauncherIntegrity();
    const workspacePath = path.normalize(path.resolve(input.workspacePath));
    const protectedPaths = canonicalProtectedPaths(input.protectedPaths);
    if (protectedPaths.some((target) => samePath(target, workspacePath))) {
      throw new Error("Codex 隔离执行不能把当前工作树同时声明为受保护路径");
    }
    const challenge = randomUUID();
    const protectedPathsHash = protectedPathsDigest(protectedPaths);
    const controllerIdentity = await currentOsIdentity();
    const authentication = input.authentication ?? { store: "keyring" };
    const request = JSON.stringify({
      schemaVersion: 1,
      challenge,
      isolationKind: this.#isolationKind,
      workspacePath,
      protectedPaths,
      protectedPathsHash,
      controllerIdentity,
      codexHomePath: path.normalize(path.resolve(input.codexHomePath)),
      authentication,
      codex: {
        ...(input.model ? { model: input.model } : {}),
        reasoningEffort: input.reasoningEffort,
        sandboxMode: "workspace-write",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never",
        config: {
          cli_auth_credentials_store: authentication.store,
          allow_login_shell: false,
          agents: { enabled: false },
          mcp_servers: {},
          features: {
            apps: false,
            auth_elicitation: false,
            browser_use: false,
            browser_use_external: false,
            browser_use_full_cdp_access: false,
            code_mode_host: true,
            computer_use: false,
            goals: false,
            guardian_approval: false,
            hooks: false,
            image_generation: false,
            in_app_browser: false,
            in_app_updates: false,
            memories: false,
            mentions_v2: false,
            shell_tool: false,
            unified_exec: false,
            shell_snapshot: false,
            multi_agent: false,
            plugin_sharing: false,
            plugins: false,
            web_search: false,
            remote_plugin: false,
            skill_mcp_dependency_install: false,
            skill_search: false,
            tool_call_mcp_elicitation: false,
            tool_suggest: false,
            view_image: false,
            workspace_dependencies: false,
          },
          history: { persistence: "none" },
          project_doc_max_bytes: 0,
          project_doc_fallback_filenames: [],
          shell_environment_policy: {
            inherit: "none",
            ignore_default_excludes: false,
            set: input.environment,
          },
        },
      },
      prompt: input.prompt,
      outputSchema: input.outputSchema,
    });
    const responseText = await this.#spawnRun(
      request,
      input.signal,
      input.onProgress,
    );
    let response: unknown;
    try {
      response = JSON.parse(responseText);
    } catch {
      throw new Error("Codex 隔离启动器没有返回有效的执行证明");
    }
    const parsed = runResponseSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.challenge !== challenge ||
      parsed.data.isolationKind !== this.#isolationKind ||
      !samePath(path.normalize(parsed.data.workspacePath), workspacePath) ||
      parsed.data.protectedPathsHash !== protectedPathsHash
    ) {
      throw new Error("Codex 隔离启动器返回的执行证明与本次任务不一致");
    }
    return {
      finalResponse: parsed.data.finalResponse,
      threadId: parsed.data.threadId,
    };
  }

  async #assertLauncherIntegrity(): Promise<void> {
    const metadata = await lstat(this.#launcherPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > 128 * 1024 * 1024
    ) {
      throw new Error("Codex 隔离启动器不是可信的本地普通文件");
    }
    if (sha256(await readFile(this.#launcherPath)) !== this.#launcherSha256) {
      throw new Error("Codex 隔离启动器在设备启动后发生了变化");
    }
  }

  async #spawnRun(
    request: string,
    signal?: AbortSignal,
    onProgress?: (event: CodexProcessEventPayload) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.#launcherPath,
        [...this.#launcherArguments, "--forgex-codex-run"],
        {
          env: {
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
            ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      let stderrBuffer = "";
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(stdout);
      };
      const abort = (): void => {
        child.kill();
        finish(new Error("Codex 隔离执行已取消"));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("Codex 隔离执行超过设备允许时限"));
      }, this.#timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > 2 * 1024 * 1024) {
          child.kill();
          finish(new Error("Codex 隔离执行响应超过安全上限"));
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        if (Buffer.byteLength(stderrBuffer, "utf8") > 64 * 1024) {
          child.kill();
          finish(new Error("Codex 隔离启动器过程事件超过安全上限"));
          return;
        }
        const lines = stderrBuffer.split(/\r?\n/u);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith(CODEX_PROGRESS_PREFIX)) {
            try {
              const event = CodexProcessEventSchema.parse(
                JSON.parse(line.slice(CODEX_PROGRESS_PREFIX.length)) as unknown,
              );
              onProgress?.(event);
            } catch {
              child.kill();
              finish(new Error("Codex 隔离启动器返回了无效的过程事件"));
              return;
            }
          } else if (line.trim()) {
            stderr = `${stderr}${line}\n`.slice(-8_192);
          }
        }
      });
      child.once("error", (error) => finish(error));
      child.stdin.once("error", (error) => finish(error));
      child.once("close", (code) => {
        if (code !== 0) {
          finish(
            new Error(
              `Codex 隔离启动器拒绝当前任务${stderr ? `：${stderr.slice(0, 500)}` : ""}`,
            ),
          );
          return;
        }
        finish();
      });
      child.stdin.end(request, "utf8");
      if (signal?.aborted) abort();
    });
  }
}
