import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RequirementWorkerAssignment } from "./control-plane-client.js";
import type { DeviceWorkerProject } from "./config.js";

const execFileAsync = promisify(execFile);
const fullGitHashPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface GitCommandRunner {
  run(args: string[]): Promise<{ stdout: string }>;
}

export class LocalGitCommandRunner implements GitCommandRunner {
  readonly #hooksDirectory = mkdtemp(
    path.join(os.tmpdir(), "forgex-disabled-git-hooks-"),
  );

  async run(args: string[]): Promise<{ stdout: string }> {
    const hooksDirectory = await this.#hooksDirectory;
    const result = await execFileAsync(
      "git",
      [
        "-c",
        `core.hooksPath=${hooksDirectory}`,
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...(process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
          ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
          ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
          ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
          ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
          ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
          GIT_ATTR_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    return { stdout: result.stdout };
  }
}

export interface PreparedWorkspace {
  path: string;
  branchName: string;
  baseCommit: string;
}

export interface CompletedWorkspace extends PreparedWorkspace {
  commitSha: string;
  gitHashAlgorithm: "sha1" | "sha256";
}

export interface RequirementWorkspaceProvider {
  prepare(
    project: DeviceWorkerProject,
    assignment: RequirementWorkerAssignment,
  ): Promise<PreparedWorkspace>;
  commitCompleted(workspace: PreparedWorkspace): Promise<CompletedWorkspace>;
  recoverCompleted(workspace: PreparedWorkspace): Promise<CompletedWorkspace>;
}

const normalizedRealPath = async (value: string): Promise<string> =>
  path.normalize(await realpath(value));

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

export class GitWorktreeWorkspaceProvider implements RequirementWorkspaceProvider {
  readonly #git: GitCommandRunner;

  constructor(git: GitCommandRunner = new LocalGitCommandRunner()) {
    this.#git = git;
  }

  async prepare(
    project: DeviceWorkerProject,
    assignment: RequirementWorkerAssignment,
  ): Promise<PreparedWorkspace> {
    const repositoryRoot = await normalizedRealPath(project.repositoryRoot);
    const configuredRepositoryRoot = path.normalize(
      path.resolve(project.repositoryRoot),
    );
    if (!samePath(repositoryRoot, configuredRepositoryRoot)) {
      throw new Error("项目主仓库路径不能经过符号链接或目录跳转");
    }
    const topLevel = path.normalize(
      (
        await this.#git.run([
          "-C",
          repositoryRoot,
          "rev-parse",
          "--show-toplevel",
        ])
      ).stdout.trim(),
    );
    if (!samePath(topLevel, repositoryRoot)) {
      throw new Error("项目配置必须指向 Git 主仓库根目录");
    }
    await this.#assertSafeRepositoryConfig(repositoryRoot);
    const baseCommit = (
      await this.#git.run([
        "-C",
        repositoryRoot,
        "rev-parse",
        "--verify",
        `${project.baseRef}^{commit}`,
      ])
    ).stdout
      .trim()
      .toLowerCase();
    if (!fullGitHashPattern.test(baseCommit)) {
      throw new Error("Git 基线没有返回完整提交摘要");
    }

    await mkdir(project.worktreeRoot, { recursive: true });
    const worktreeRoot = await normalizedRealPath(project.worktreeRoot);
    if (
      !samePath(
        worktreeRoot,
        path.normalize(path.resolve(project.worktreeRoot)),
      )
    ) {
      throw new Error("隔离工作树根目录不能经过符号链接或目录跳转");
    }
    const target = path.join(worktreeRoot, assignment.assignmentKey);
    const relativeTarget = path.relative(worktreeRoot, target);
    if (
      relativeTarget === "" ||
      relativeTarget.startsWith("..") ||
      path.isAbsolute(relativeTarget)
    ) {
      throw new Error("隔离工作树目标超出配置目录");
    }
    const branchName = `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`;

    try {
      await access(target);
      const existingTarget = await normalizedRealPath(target);
      if (!samePath(existingTarget, target)) {
        throw new Error("已有任务目录不能经过符号链接或目录跳转");
      }
      const existingTopLevel = path.normalize(
        (
          await this.#git.run(["-C", target, "rev-parse", "--show-toplevel"])
        ).stdout.trim(),
      );
      if (!samePath(existingTopLevel, target)) {
        throw new Error("已有任务目录不是当前隔离工作树");
      }
      const currentBranch = (
        await this.#git.run([
          "-C",
          target,
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ])
      ).stdout.trim();
      if (currentBranch !== branchName) {
        throw new Error("已有任务目录绑定了其他交付分支");
      }
      await this.#assertSafeRepositoryConfig(target);
      return { path: target, branchName, baseCommit };
    } catch (error) {
      if (
        error instanceof Error &&
        ([
          "已有任务目录不能经过符号链接或目录跳转",
          "已有任务目录不是当前隔离工作树",
          "已有任务目录绑定了其他交付分支",
        ].includes(error.message) ||
          !["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          ))
      ) {
        throw error;
      }
    }

    await this.#git.run([
      "-C",
      repositoryRoot,
      "worktree",
      "add",
      "-b",
      branchName,
      target,
      baseCommit,
    ]);
    await this.#assertSafeRepositoryConfig(target);
    return { path: target, branchName, baseCommit };
  }

  async commitCompleted(
    workspace: PreparedWorkspace,
  ): Promise<CompletedWorkspace> {
    let currentBranch: string;
    try {
      currentBranch = (
        await this.#git.run([
          "-C",
          workspace.path,
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ])
      ).stdout.trim();
    } catch {
      throw new Error("Codex 执行结束后工作树处于分离 HEAD，不能生成交付提交");
    }
    if (currentBranch !== workspace.branchName) {
      throw new Error("Codex 执行结束后离开了 ForgeX 预期交付分支");
    }
    await this.#assertSafeRepositoryConfig(workspace.path);
    const status = (
      await this.#git.run([
        "-C",
        workspace.path,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout.trim();
    if (!status) {
      throw new Error("Codex 没有产生可由设备 Worker 提交的本地改动");
    }

    const hooksDirectory = await mkdtemp(
      path.join(os.tmpdir(), "forgex-empty-git-hooks-"),
    );
    try {
      const trustedGitOptions = [
        "-C",
        workspace.path,
        "-c",
        `core.hooksPath=${hooksDirectory}`,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=ForgeX Device Worker",
        "-c",
        "user.email=device-worker@forgex.local",
      ];
      await this.#git.run([...trustedGitOptions, "add", "--all", "--", "."]);
      await this.#assertSafeStagedChanges(workspace);
      await this.#git.run([
        ...trustedGitOptions,
        "commit",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        "实现：完成 ForgeX 需求交付",
      ]);
    } finally {
      await rm(hooksDirectory, { recursive: true, force: true });
    }

    return this.recoverCompleted(workspace);
  }

  async recoverCompleted(
    workspace: PreparedWorkspace,
  ): Promise<CompletedWorkspace> {
    let currentBranch: string;
    try {
      currentBranch = (
        await this.#git.run([
          "-C",
          workspace.path,
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ])
      ).stdout.trim();
    } catch {
      throw new Error("待恢复交付工作树处于分离 HEAD");
    }
    if (currentBranch !== workspace.branchName) {
      throw new Error("待恢复交付工作树离开了 ForgeX 预期交付分支");
    }
    await this.#assertSafeRepositoryConfig(workspace.path);
    const completedStatus = (
      await this.#git.run([
        "-C",
        workspace.path,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout.trim();
    if (completedStatus) {
      throw new Error("待恢复交付工作树仍有未提交改动");
    }
    const commitSha = (
      await this.#git.run(["-C", workspace.path, "rev-parse", "HEAD"])
    ).stdout
      .trim()
      .toLowerCase();
    if (!fullGitHashPattern.test(commitSha)) {
      throw new Error("隔离工作树没有返回完整提交摘要");
    }
    if (commitSha === workspace.baseCommit) {
      throw new Error("Codex 没有产生新的本地提交，任务不会标记完成");
    }
    const expectedBranchCommit = (
      await this.#git.run([
        "-C",
        workspace.path,
        "rev-parse",
        "--verify",
        `refs/heads/${workspace.branchName}^{commit}`,
      ])
    ).stdout
      .trim()
      .toLowerCase();
    if (expectedBranchCommit !== commitSha) {
      throw new Error("ForgeX 预期交付分支没有指向当前提交");
    }
    await this.#git.run([
      "-C",
      workspace.path,
      "merge-base",
      "--is-ancestor",
      workspace.baseCommit,
      commitSha,
    ]);
    return {
      ...workspace,
      commitSha,
      gitHashAlgorithm: commitSha.length === 40 ? "sha1" : "sha256",
    };
  }

  async #assertSafeStagedChanges(workspace: PreparedWorkspace): Promise<void> {
    const names = (
      await this.#git.run([
        "-C",
        workspace.path,
        "diff",
        "--cached",
        "--name-only",
        "--no-ext-diff",
        "--",
        ".",
      ])
    ).stdout
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean);
    if (names.length === 0) {
      throw new Error("设备 Worker 没有找到可提交的项目改动");
    }
    const sensitiveName = names.find((name) => {
      const baseName = path.posix.basename(name.toLowerCase());
      return (
        baseName === ".env" ||
        (baseName.startsWith(".env.") && baseName !== ".env.example") ||
        /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json)$/u.test(
          baseName,
        ) ||
        /\.(?:key|p12|pfx)$/u.test(baseName)
      );
    });
    if (sensitiveName) {
      throw new Error(
        `设备 Worker 拒绝提交可能包含凭据的文件：${sensitiveName}`,
      );
    }

    const patch = (
      await this.#git.run([
        "-C",
        workspace.path,
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=0",
        "--",
        ".",
      ])
    ).stdout;
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(patch) ||
      /^\+[^+].{0,120}\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?(?!\[REDACTED\]|<YOUR_)[^\s"']{12,}/imu.test(
        patch,
      )
    ) {
      throw new Error("设备 Worker 拒绝提交疑似明文凭据");
    }
  }

  async #assertSafeRepositoryConfig(repositoryRoot: string): Promise<void> {
    const keys = (
      await this.#git.run([
        "-C",
        repositoryRoot,
        "config",
        "--local",
        "--includes",
        "--name-only",
        "--list",
        "-z",
      ])
    ).stdout
      .split("\u0000")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const unsafeKey = keys.find(
      (key) =>
        /^filter\..+\.(?:clean|smudge|process)$/u.test(key) ||
        /^diff\..+\.(?:command|textconv)$/u.test(key) ||
        /^include(?:if\..+)?\.path$/u.test(key) ||
        [
          "core.fsmonitor",
          "core.hookspath",
          "diff.external",
          "extensions.worktreeconfig",
        ].includes(key),
    );
    if (unsafeKey) {
      throw new Error(
        `项目 Git 配置包含设备宿主不会执行的外部命令能力：${unsafeKey}`,
      );
    }
  }
}
