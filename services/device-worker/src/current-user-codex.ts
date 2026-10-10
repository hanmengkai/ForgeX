import { spawn, execFile } from "node:child_process";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import type { ThreadEvent } from "@openai/codex-sdk";
import { sanitizeExecutionLogText } from "@forgex/contracts";
import {
  assertCodexToolSurface,
  disabledToolFeatures,
  processEventFromThreadEvent,
  workspaceMcpOverrides,
} from "./isolation-launcher.js";
import type {
  CodexIsolationRunner,
  IsolatedCodexRunInput,
} from "./codex-isolation.js";
import { WorkspaceAccess } from "./workspace-access.js";

const cli = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
const execFileAsync = promisify(execFile);
export const currentUserNativeToolGuard = [
  "-c",
  "features.hooks=true",
  "-c",
  `hooks.PreToolUse=[{matcher="^(Bash|apply_patch|Edit|Write|exec_command|request_permissions)$",hooks=[{type="command",command=${JSON.stringify('/usr/bin/printf \'%s\' \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"ForgeX 仅允许受控工作树 MCP，禁止原生命令及补丁工具"}}\'')},timeout=3}]}]`,
];

export function currentUserMacProxy(
  configuration: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [prefix, variable] of [
    ["HTTP", "HTTP_PROXY"],
    ["HTTPS", "HTTPS_PROXY"],
  ]) {
    const field = (name: string) =>
      new RegExp(`^\\s*${name} : (\\S+)\\s*$`, "mu").exec(configuration)?.[1];
    const host = field(`${prefix}Proxy`),
      port = Number(field(`${prefix}Port`));
    if (
      field(`${prefix}Enable`) === "1" &&
      host &&
      /^[A-Za-z0-9.-]+$/u.test(host) &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535
    )
      result[variable!] = `http://${host}:${port}`;
  }
  if (Object.keys(result).length) result.NO_PROXY = "127.0.0.1,localhost,::1";
  return result;
}

// 当前用户模式保留原登录位置，绝不把任意控制面环境传给模型进程。
export const currentUserCodexEnvironment = (
  source: NodeJS.ProcessEnv,
): Record<string, string> =>
  Object.fromEntries(
    [
      "HOME",
      "USERPROFILE",
      "PATH",
      "SystemRoot",
      "LANG",
      "LC_ALL",
      "CODEX_HOME",
      "CODEX_CA_CERTIFICATE",
      "SSL_CERT_FILE",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ].flatMap((key) => (source[key] ? [[key, source[key]!]] : [])),
  );

export const currentUserCodexArguments = (input: {
  workspacePath: string;
  schemaPath: string;
  reasoningEffort: string;
  model?: string;
  extraDisabledFeatures?: string[];
}): string[] => [
  cli,
  "exec",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--dangerously-bypass-hook-trust",
  "--json",
  "--skip-git-repo-check",
  "--sandbox",
  "workspace-write",
  "--cd",
  input.workspacePath,
  "--output-schema",
  input.schemaPath,
  "-c",
  'approval_policy="never"',
  "-c",
  'cli_auth_credentials_store="auto"',
  "-c",
  "allow_login_shell=false",
  "-c",
  "agents.enabled=false",
  "-c",
  "sandbox_workspace_write.network_access=false",
  "-c",
  'web_search="disabled"',
  "-c",
  'history.persistence="none"',
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  "project_doc_fallback_filenames=[]",
  "-c",
  'shell_environment_policy.inherit="none"',
  "-c",
  `projects.${JSON.stringify(input.workspacePath)}.trust_level="untrusted"`,
  "-c",
  `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
  ...disabledToolFeatures.flatMap((feature) => [
    "-c",
    `features.${feature}=false`,
  ]),
  ...(input.extraDisabledFeatures ?? []).flatMap((feature) => [
    "-c",
    `features.${feature}=false`,
  ]),
  "-c",
  "features.web_search=false",
  "-c",
  "features.code_mode_host=true",
  ...workspaceMcpOverrides(input.workspacePath),
  ...currentUserNativeToolGuard,
  ...(input.model ? ["--model", input.model] : []),
  "-",
];

export class CurrentUserCodexRunner implements CodexIsolationRunner {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}
  async run(
    input: IsolatedCodexRunInput,
  ): Promise<{ finalResponse: string; threadId: string | null }> {
    await WorkspaceAccess.open(input.workspacePath);
    const home = await realpath(input.codexHomePath);
    const relative = path.relative(input.workspacePath, home);
    if (!relative.startsWith("..") && !path.isAbsolute(relative))
      throw new Error("登录目录不能位于模型工作树内");
    const root = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "forgex-current-user-"),
    );
    try {
      // 清洁目录只用于核对工具清单；推理仍使用当前用户的原登录缓存。
      let commandPath = process.execPath,
        commandArguments = [cli];
      for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
        const candidate = path.resolve(
          entry,
          process.platform === "win32" ? "codex.exe" : "codex",
        );
        try {
          await access(candidate);
          const executable = await realpath(candidate);
          const detected = (
            await execFileAsync(executable, ["--version"], {
              encoding: "utf8",
              timeout: 10000,
            })
          ).stdout.trim();
          if (detected === "codex-cli 0.162.0-alpha.17.2") {
            commandPath = executable;
            commandArguments = [];
            break;
          }
        } catch {}
      }
      const version = (
        await execFileAsync(commandPath, [...commandArguments, "--version"], {
          encoding: "utf8",
          timeout: 10000,
        })
      ).stdout.trim();
      if (
        !["codex-cli 0.147.0", "codex-cli 0.162.0-alpha.17.2"].includes(version)
      )
        throw new Error(
          "当前 Codex CLI 版本尚未核对工具权限，请使用已验证版本",
        );
      const inventory = await execFileAsync(
        commandPath,
        [...commandArguments, "features", "list"],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...currentUserCodexEnvironment(process.env),
            CODEX_HOME: root,
          },
        },
      );
      // 关闭版本中所有工具特性，只保留 MCP 宿主；新增 CLI 版本需要重新验证。
      const extraDisabledFeatures = inventory.stdout
        .split(/\r?\n/u)
        .flatMap((line) => {
          const match = /^([A-Za-z0-9_]+)\s+(.+?)\s+(?:true|false)$/u.exec(
            line.trim(),
          );
          return match?.[1] &&
            match[1] !== "code_mode_host" &&
            match[2]?.trim() !== "removed"
            ? [match[1]]
            : [];
        });
      await assertCodexToolSurface(
        { workspacePath: input.workspacePath, codexHomePath: root },
        {
          commandPath,
          arguments: commandArguments,
          expectedVersion: version,
          extraDisabledFeatures,
          nativeToolGuard: currentUserNativeToolGuard,
        },
      );
      try {
        await access(path.join(home, "hooks.json"));
        throw new Error(
          "当前用户目录含有其他 Hooks，不能与样板的固定权限守卫混用",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const schemaPath = path.join(root, "schema.json");
      await writeFile(schemaPath, JSON.stringify(input.outputSchema), {
        mode: 0o600,
      });
      const environment = currentUserCodexEnvironment(process.env);
      environment.CODEX_HOME = home;
      environment.TMPDIR = root;
      if (
        process.platform === "darwin" &&
        !["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(
          (k) => environment[k],
        )
      ) {
        const proxy = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 32 * 1024,
        });
        for (const [key, value] of Object.entries(
          currentUserMacProxy(proxy.stdout),
        ))
          environment[key] ??= value;
      }
      let model = input.model;
      if (!model) {
        // 只读取用户选择的模型名称；配置中的工具、凭据和权限不会继承。
        try {
          model = /^model\s*=\s*"([A-Za-z0-9._-]{1,100})"\s*$/mu.exec(
            await readFile(path.join(home, "config.toml"), "utf8"),
          )?.[1];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const signal = AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(15 * 60_000),
      ]);
      return await new Promise((resolve, reject) => {
        const args = currentUserCodexArguments({
          ...input,
          schemaPath,
          extraDisabledFeatures,
          ...(model ? { model } : {}),
        });
        const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(input.workspacePath)}) (subpath ${JSON.stringify(root)}) (literal ${JSON.stringify(path.join(home, "auth.json"))}) (subpath ${JSON.stringify(path.join(home, "tmp"))}) (literal ${JSON.stringify(path.join(home, "installation_id"))}) (literal "/dev/null"))`;
        if (process.platform !== "darwin")
          throw new Error("当前用户 Codex 模式尚未验证该系统的文件写入边界");
        const child = this.spawnProcess(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            profile,
            commandPath,
            ...commandArguments,
            ...args.slice(1),
            "-c",
            `log_dir=${JSON.stringify(root)}`,
            "-c",
            `sqlite_home=${JSON.stringify(root)}`,
          ],
          {
            cwd: input.workspacePath,
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
            signal,
          },
        );
        let buffer = "",
          bytes = 0,
          stderr = "",
          finalResponse = "",
          threadId: string | null = null,
          completed = false,
          failed = false;
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        const fail = (error: Error) => {
          failed = true;
          child.kill("SIGTERM");
          reject(error);
        };
        child.on("error", () =>
          fail(new Error("Codex 调用中断或无法启动，未回填模板结果")),
        );
        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024)
            return fail(new Error("Codex 返回内容超过安全上限"));
          buffer += stdoutDecoder.write(chunk);
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as ThreadEvent;
              if (event.type === "thread.started") threadId = event.thread_id;
              if (event.type === "turn.completed") completed = true;
              if (
                event.type === "turn.failed" ||
                (event.type === "error" &&
                  !/^Reconnecting\.\.\./u.test(event.message))
              ) {
                const message =
                  event.type === "error" ? event.message : event.error.message;
                const auth = /401|unauthorized|login|auth|credential/iu.test(
                  message,
                );
                return fail(
                  new Error(
                    auth
                      ? "当前用户 Codex 登录不可用，请在该用户终端重新登录后重试"
                      : `Codex 推理回合失败：${sanitizeExecutionLogText(message).slice(0, 500)}`,
                  ),
                );
              }
              if (
                event.type === "item.completed" &&
                event.item.type === "agent_message"
              )
                finalResponse = event.item.text;
              const progress = processEventFromThreadEvent(
                event,
                input.workspacePath,
              );
              if (progress)
                void Promise.resolve(input.onProgress?.(progress)).catch(
                  () => {},
                );
            } catch {
              return fail(new Error("Codex 返回的事件协议无效"));
            }
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 8192) stderr += stderrDecoder.write(chunk);
        });
        child.on("close", (code) => {
          if (failed) return;
          if (code !== 0 || !completed || !finalResponse.trim()) {
            reject(
              new Error(
                /401|unauthorized|login|auth|credential/iu.test(stderr)
                  ? "当前用户 Codex 登录不可用，请重新登录后重试"
                  : `Codex 未完成结构化响应（退出 ${code}）：${sanitizeExecutionLogText(stderr).slice(0, 1000)}`,
              ),
            );
            return;
          }
          resolve({ finalResponse, threadId });
        });
        child.stdin.end(input.prompt);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
