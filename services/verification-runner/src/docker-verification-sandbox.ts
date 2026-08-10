import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  VerificationSuitePlanSchema,
  type VerificationSandbox,
} from "./verification-engine.js";
import {
  assertDefaultWindowsTrustedPath,
  assertTrustedExecutable,
  assertTrustedPathAncestors,
  type WindowsTrustedPathCheck,
} from "./trusted-executable.js";
import { assertDefaultWindowsPrivatePath } from "./windows-path-security.js";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const internalKeyPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export interface VerificationProcessInput {
  commandPath: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface VerificationProcessResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export type VerificationProcessRunner = (
  input: VerificationProcessInput,
) => Promise<VerificationProcessResult>;

const defaultProcessRunner: VerificationProcessRunner = async (input) =>
  new Promise((resolve, reject) => {
    let totalBytes = 0;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError: Error | null = null;
    const timeout = setTimeout(() => {
      terminationError = new Error("verification_timeout");
      child.kill("SIGKILL");
    }, input.timeoutMs);
    const environment: NodeJS.ProcessEnv = {
      PATH: path.dirname(input.commandPath),
    };
    if (process.platform === "win32") {
      environment.SystemRoot = process.env.SystemRoot;
      environment.WINDIR = process.env.WINDIR;
      environment.TEMP = process.env.TEMP;
      environment.TMP = process.env.TMP;
    } else {
      environment.HOME = "/nonexistent";
      environment.XDG_CONFIG_HOME = "/nonexistent";
    }
    const child = spawn(input.commandPath, input.args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const finish = (
      outcome:
        | { kind: "resolve"; result: VerificationProcessResult }
        | { kind: "reject"; error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (outcome.kind === "resolve") resolve(outcome.result);
      else reject(outcome.error);
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > input.maxOutputBytes) {
        terminationError = new Error("verification_output_too_large");
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", () =>
      finish({ kind: "reject", error: new Error("verification_spawn_failed") }),
    );
    child.once("close", (exitCode) => {
      if (terminationError) {
        finish({ kind: "reject", error: terminationError });
        return;
      }
      finish({ kind: "resolve", result: { exitCode, stdout, stderr } });
    });
  });

export class DockerVerificationSandbox implements VerificationSandbox {
  readonly #dockerCommandPath: string;
  readonly #dockerCommandSha256: string;
  readonly #containerUser: string;
  readonly #runnerKey: string;
  readonly #runProcess: VerificationProcessRunner;
  readonly #assertWindowsTrustedPath: WindowsTrustedPathCheck;
  readonly #assertWindowsPrivatePath: WindowsTrustedPathCheck;
  #reconciled = false;

  constructor(options: {
    dockerCommandPath: string;
    dockerCommandSha256: string;
    containerUser: string;
    runnerKey: string;
    runProcess?: VerificationProcessRunner;
    assertWindowsTrustedPath?: (target: string) => Promise<void>;
    assertWindowsPrivatePath?: (target: string) => Promise<void>;
  }) {
    if (!path.isAbsolute(options.dockerCommandPath)) {
      throw new Error("Runner Docker 程序必须使用绝对路径");
    }
    if (!sha256Pattern.test(options.dockerCommandSha256)) {
      throw new Error("Runner Docker 程序摘要格式不正确");
    }
    if (!/^[1-9]\d{0,9}:[1-9]\d{0,9}$/u.test(options.containerUser)) {
      throw new Error("Runner 容器用户必须使用非 root 的 uid:gid");
    }
    if (!internalKeyPattern.test(options.runnerKey)) {
      throw new Error("Runner 容器清理范围标识格式不正确");
    }
    this.#dockerCommandPath = path.resolve(options.dockerCommandPath);
    this.#dockerCommandSha256 = options.dockerCommandSha256;
    this.#containerUser = options.containerUser;
    this.#runnerKey = options.runnerKey.toLowerCase();
    this.#runProcess = options.runProcess ?? defaultProcessRunner;
    this.#assertWindowsTrustedPath =
      options.assertWindowsTrustedPath ?? assertDefaultWindowsTrustedPath;
    this.#assertWindowsPrivatePath =
      options.assertWindowsPrivatePath ??
      options.assertWindowsTrustedPath ??
      assertDefaultWindowsPrivatePath;
  }

  async run(input: { workspacePath: string; plan: unknown }): Promise<{
    suites: Array<{ suiteKey: string; status: "passed" | "failed" }>;
  }> {
    const plan = VerificationSuitePlanSchema.parse(input.plan);
    if (!path.isAbsolute(input.workspacePath)) {
      throw new Error("Runner 容器工作区必须使用绝对路径");
    }
    const workspacePath = path.resolve(input.workspacePath);
    await assertTrustedPathAncestors({
      targetPath: workspacePath,
      description: "Runner 容器工作区",
      assertWindowsTrustedPath: this.#assertWindowsTrustedPath,
    });
    const [workspaceMetadata, workspaceRealPath] = await Promise.all([
      lstat(workspacePath),
      realpath(workspacePath),
    ]);
    if (
      !workspaceMetadata.isDirectory() ||
      workspaceMetadata.isSymbolicLink() ||
      path.resolve(workspaceRealPath) !== workspacePath ||
      /[,\u0000\r\n]/u.test(workspacePath)
    ) {
      throw new Error("Runner 容器工作区不是可信的本地目录");
    }
    if (process.platform === "win32") {
      await this.#assertWindowsPrivatePath(workspacePath);
    } else {
      const currentUser =
        typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        (Number(workspaceMetadata.mode) & 0o022) !== 0 ||
        (currentUser !== undefined && workspaceMetadata.uid !== currentUser)
      ) {
        throw new Error("Runner 容器工作区不能由其他本机用户改写");
      }
    }
    await this.initialize();

    const suites: Array<{
      suiteKey: string;
      status: "passed" | "failed";
    }> = [];
    for (const suite of plan.suites) {
      const containerName = `forgex-verification-${randomUUID()}`;
      let result: VerificationProcessResult;
      let executionError: unknown;
      await this.#assertDockerCommand();
      try {
        result = await this.#runProcess({
          commandPath: this.#dockerCommandPath,
          timeoutMs: suite.execution.timeoutMs,
          maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
          args: [
            "run",
            "--name",
            containerName,
            "--label",
            `forgex.verification.runner=${this.#runnerKey}`,
            "--pull",
            "never",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--memory",
            "2g",
            "--cpus",
            "2",
            "--user",
            this.#containerUser,
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=268435456",
            "--mount",
            `type=bind,source=${workspacePath},target=/workspace,readonly`,
            "--workdir",
            "/workspace",
            suite.execution.image,
            ...suite.execution.command,
          ],
        });
      } catch (error) {
        executionError = error;
        result = { exitCode: null };
      } finally {
        await this.#removeContainer(containerName);
      }
      if (executionError) {
        throw new Error("Runner 无法在受控容器中完成验证套件");
      }
      if (
        result.exitCode === null ||
        [125, 126, 127].includes(result.exitCode)
      ) {
        throw new Error("Runner 受控容器基础设施暂时不可用");
      }
      suites.push({
        suiteKey: suite.suiteKey,
        status: result.exitCode === 0 ? "passed" : "failed",
      });
    }
    return { suites };
  }

  async #removeContainer(containerName: string): Promise<void> {
    this.#reconciled = false;
    try {
      const removed = await this.#runDocker({
        commandPath: this.#dockerCommandPath,
        args: ["rm", "--force", containerName],
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      if (removed.exitCode !== 0) throw new Error("verification_rm_failed");
      const remaining = await this.#runDocker({
        commandPath: this.#dockerCommandPath,
        args: [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `name=^/${containerName}$`,
        ],
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      if (remaining.exitCode !== 0 || (remaining.stdout ?? "").trim() !== "") {
        throw new Error("verification_container_still_exists");
      }
    } catch {
      throw new Error("Runner 无法确认受控容器已经清理");
    }
  }

  async #reconcileContainers(): Promise<void> {
    if (this.#reconciled) return;
    try {
      const listed = await this.#runDocker({
        commandPath: this.#dockerCommandPath,
        args: [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=forgex.verification.runner=${this.#runnerKey}`,
        ],
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      if (listed.exitCode !== 0) throw new Error("verification_list_failed");
      const containerIds = (listed.stdout ?? "")
        .split(/\r?\n/u)
        .filter((value) => value.length > 0);
      if (containerIds.some((value) => !/^[a-f0-9]{12,64}$/u.test(value))) {
        throw new Error("verification_list_invalid");
      }
      if (containerIds.length > 0) {
        const removed = await this.#runDocker({
          commandPath: this.#dockerCommandPath,
          args: ["rm", "--force", ...containerIds],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        });
        if (removed.exitCode !== 0) throw new Error("verification_rm_failed");
      }
      const remaining = await this.#runDocker({
        commandPath: this.#dockerCommandPath,
        args: [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=forgex.verification.runner=${this.#runnerKey}`,
        ],
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      if (remaining.exitCode !== 0 || (remaining.stdout ?? "").trim() !== "") {
        throw new Error("verification_reconcile_incomplete");
      }
      this.#reconciled = true;
    } catch {
      throw new Error("Runner 无法清理上次中断遗留的受控容器");
    }
  }

  async initialize(): Promise<void> {
    await this.#reconcileContainers();
  }

  async #runDocker(
    input: VerificationProcessInput,
  ): Promise<VerificationProcessResult> {
    await this.#assertDockerCommand();
    return this.#runProcess(input);
  }

  async #assertDockerCommand(): Promise<void> {
    await assertTrustedExecutable({
      commandPath: this.#dockerCommandPath,
      expectedSha256: this.#dockerCommandSha256,
      description: "Runner Docker 程序",
      assertWindowsTrustedPath: this.#assertWindowsTrustedPath,
    });
  }
}
