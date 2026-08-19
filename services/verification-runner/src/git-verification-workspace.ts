import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  PreparedVerificationWorkspace,
  VerificationWorkspaceProvider,
} from "./verification-engine.js";
import { VerificationPreparationBlockedError } from "./model.js";
import {
  assertDefaultWindowsTrustedPath,
  assertTrustedExecutable,
  assertTrustedPathAncestors,
  type WindowsTrustedPathCheck,
} from "./trusted-executable.js";
import { assertDefaultWindowsPrivatePath } from "./windows-path-security.js";

const execFileAsync = promisify(execFile);
const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const absolutePath = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => path.isAbsolute(value), "Runner 路径必须使用绝对路径");
const sha256Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const repositoryConfigSchema = z
  .object({ repositoryKey: internalKey, repositoryRoot: absolutePath })
  .strict();
const referenceSchema = z
  .object({
    repositoryKey: internalKey,
    gitHashAlgorithm: z.enum(["sha1", "sha256"]),
    commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  })
  .strict();

const unsafeGitConfigKey = (key: string): boolean => {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === "core.hookspath" ||
    normalized === "core.fsmonitor" ||
    normalized === "core.sshcommand" ||
    normalized === "core.attributesfile" ||
    normalized === "core.worktree" ||
    normalized === "core.sparsecheckout" ||
    normalized === "core.sparsecheckoutcone" ||
    normalized === "extensions.worktreeconfig" ||
    normalized === "include.path" ||
    normalized.startsWith("includeif.") ||
    normalized.startsWith("filter.") ||
    normalized.startsWith("credential.") ||
    normalized.startsWith("url.") ||
    normalized.startsWith("http.") ||
    normalized.startsWith("submodule.")
  );
};

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

const missingFile = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

const assertPlainDirectory = async (
  directoryPath: string,
  description: string,
): Promise<void> => {
  const [metadata, resolvedRealPath] = await Promise.all([
    lstat(directoryPath),
    realpath(directoryPath),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !samePath(resolvedRealPath, directoryPath)
  ) {
    throw new Error(`${description}必须是不跳转的本地目录`);
  }
};

const assertProtectedDirectory = async (
  directoryPath: string,
  description: string,
  windowsCheck: WindowsTrustedPathCheck,
  directWindowsCheck: WindowsTrustedPathCheck = windowsCheck,
): Promise<void> => {
  await assertTrustedPathAncestors({
    targetPath: directoryPath,
    description,
    assertWindowsTrustedPath: windowsCheck,
  });
  await assertPlainDirectory(directoryPath, description);
  const metadata = await lstat(directoryPath);
  if (process.platform === "win32") {
    await directWindowsCheck(directoryPath);
    return;
  }
  const currentUser =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    (Number(metadata.mode) & 0o022) !== 0 ||
    (currentUser !== undefined &&
      metadata.uid !== 0 &&
      metadata.uid !== currentUser)
  ) {
    throw new Error(`${description}不能由其他本机用户改写`);
  }
};

const assertProtectedFile = async (
  filePath: string,
  description: string,
  windowsCheck: WindowsTrustedPathCheck,
  directWindowsCheck: WindowsTrustedPathCheck = windowsCheck,
): Promise<void> => {
  await assertTrustedPathAncestors({
    targetPath: filePath,
    description,
    assertWindowsTrustedPath: windowsCheck,
  });
  const [metadata, resolvedRealPath] = await Promise.all([
    lstat(filePath),
    realpath(filePath),
  ]);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !samePath(resolvedRealPath, filePath)
  ) {
    throw new Error(`${description}必须是不跳转的本地普通文件`);
  }
  if (process.platform === "win32") {
    await directWindowsCheck(filePath);
    return;
  }
  const currentUser =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    (Number(metadata.mode) & 0o022) !== 0 ||
    (currentUser !== undefined &&
      metadata.uid !== 0 &&
      metadata.uid !== currentUser)
  ) {
    throw new Error(`${description}不能由其他本机用户改写`);
  }
};

export class GitVerificationWorkspaceProvider implements VerificationWorkspaceProvider {
  readonly #repositories = new Map<string, string>();
  readonly #workspaceRoot: string;
  readonly #gitCommandPath: string;
  readonly #gitCommandSha256: string;
  readonly #assertWindowsTrustedPath: WindowsTrustedPathCheck;
  readonly #assertWindowsPrivatePath: WindowsTrustedPathCheck;

  constructor(options: {
    repositories: Array<{ repositoryKey: string; repositoryRoot: string }>;
    workspaceRoot: string;
    gitCommandPath: string;
    gitCommandSha256: string;
    assertWindowsTrustedPath?: WindowsTrustedPathCheck;
    assertWindowsPrivatePath?: WindowsTrustedPathCheck;
  }) {
    const repositories = z
      .array(repositoryConfigSchema)
      .min(1)
      .max(100)
      .parse(options.repositories);
    for (const repository of repositories) {
      if (this.#repositories.has(repository.repositoryKey)) {
        throw new Error("Runner 不能重复配置同一代码仓库");
      }
      this.#repositories.set(
        repository.repositoryKey,
        path.resolve(repository.repositoryRoot),
      );
    }
    this.#workspaceRoot = path.resolve(
      absolutePath.parse(options.workspaceRoot),
    );
    this.#gitCommandPath = path.resolve(
      absolutePath.parse(options.gitCommandPath),
    );
    this.#gitCommandSha256 = sha256Hash.parse(options.gitCommandSha256);
    this.#assertWindowsTrustedPath =
      options.assertWindowsTrustedPath ?? assertDefaultWindowsTrustedPath;
    this.#assertWindowsPrivatePath =
      options.assertWindowsPrivatePath ?? assertDefaultWindowsPrivatePath;
  }

  async prepare(referenceInput: {
    repositoryKey: string;
    gitHashAlgorithm: "sha1" | "sha256";
    commitSha: string;
  }): Promise<PreparedVerificationWorkspace> {
    const reference = referenceSchema.parse(referenceInput);
    const repositoryRoot = this.#repositories.get(reference.repositoryKey);
    if (!repositoryRoot) throw new Error("Runner 没有配置当前权威代码仓库");
    await this.#assertRepositoryPaths(repositoryRoot);
    await assertTrustedExecutable({
      commandPath: this.#gitCommandPath,
      expectedSha256: this.#gitCommandSha256,
      description: "Runner Git 程序",
      assertWindowsTrustedPath: this.#assertWindowsTrustedPath,
    });
    await assertProtectedDirectory(
      repositoryRoot,
      "Runner 权威代码仓库",
      this.#assertWindowsTrustedPath,
      this.#assertWindowsPrivatePath,
    );
    const dotGitPath = path.join(repositoryRoot, ".git");
    try {
      await assertProtectedDirectory(
        dotGitPath,
        "Runner 权威仓库 Git 元数据",
        this.#assertWindowsTrustedPath,
        this.#assertWindowsPrivatePath,
      );
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    await assertProtectedDirectory(
      this.#workspaceRoot,
      "Runner 验证工作区根目录",
      this.#assertWindowsTrustedPath,
      this.#assertWindowsPrivatePath,
    );
    await assertPlainDirectory(this.#workspaceRoot, "Runner 验证工作区根目录");
    if (process.platform === "win32") {
      await this.#assertWindowsPrivatePath(this.#workspaceRoot);
    } else {
      const workspaceMetadata = await lstat(this.#workspaceRoot);
      const currentUser =
        typeof process.getuid === "function" ? process.getuid() : undefined;
      if (
        (Number(workspaceMetadata.mode) & 0o077) !== 0 ||
        (currentUser !== undefined && workspaceMetadata.uid !== currentUser)
      ) {
        throw new Error("Runner 验证工作区根目录必须仅允许当前控制器身份访问");
      }
    }

    const operationKey = randomUUID();
    const hooksPath = path.join(
      this.#workspaceRoot,
      `.forgex-empty-hooks-${operationKey}`,
    );
    await mkdir(hooksPath, { mode: 0o700 });
    await writeFile(path.join(hooksPath, "attributes"), "", { mode: 0o600 });
    try {
      const configKeys = (
        await this.#git(repositoryRoot, hooksPath, [
          "config",
          "--file",
          path.join(repositoryRoot, ".git", "config"),
          "--no-includes",
          "--name-only",
          "--list",
        ])
      )
        .split(/\r?\n/u)
        .filter((key) => key.length > 0);
      if (configKeys.some(unsafeGitConfigKey)) {
        throw new Error("Runner 权威仓库包含可能执行宿主命令的 Git 配置");
      }
      const objectFormat = await this.#git(repositoryRoot, hooksPath, [
        "rev-parse",
        "--show-object-format",
      ]);
      if (objectFormat !== reference.gitHashAlgorithm) {
        throw new Error("Runner 权威仓库的 Git 摘要算法与任务不一致");
      }
      try {
        await this.#git(repositoryRoot, hooksPath, [
          "cat-file",
          "-e",
          `${reference.commitSha}^{commit}`,
        ]);
      } catch {
        throw new VerificationPreparationBlockedError(
          "delivery_commit_missing",
        );
      }
    } catch (error) {
      await rm(hooksPath, { recursive: true, force: true });
      throw error;
    }

    const workspacePath = path.join(
      this.#workspaceRoot,
      `verification-${operationKey}`,
    );
    let prepared = false;
    try {
      await assertProtectedDirectory(
        this.#workspaceRoot,
        "Runner 验证工作区根目录",
        this.#assertWindowsTrustedPath,
        this.#assertWindowsPrivatePath,
      );
      await this.#assertRepositoryPaths(repositoryRoot);
      await this.#assertSafeRepositoryConfig(repositoryRoot, hooksPath);
      await this.#git(repositoryRoot, hooksPath, [
        "worktree",
        "add",
        "--detach",
        "--force",
        workspacePath,
        reference.commitSha,
      ]);
      prepared = true;
      await this.#assertRepositoryPaths(repositoryRoot);
      await this.#assertSafeRepositoryConfig(repositoryRoot, hooksPath);
      await assertProtectedDirectory(
        workspacePath,
        "Runner 隔离验证工作区",
        this.#assertWindowsTrustedPath,
        this.#assertWindowsPrivatePath,
      );
      const head = await this.#git(workspacePath, hooksPath, [
        "rev-parse",
        "HEAD",
      ]);
      if (head !== reference.commitSha) {
        throw new Error("Runner 隔离验证工作区没有落在权威提交上");
      }
      const status = await this.#git(workspacePath, hooksPath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (status !== "") {
        throw new Error("Runner 隔离验证工作区初始状态不干净");
      }
    } catch (error) {
      if (prepared) {
        await this.#dispose(repositoryRoot, workspacePath, hooksPath);
      } else await rm(workspacePath, { recursive: true, force: true });
      await rm(hooksPath, { recursive: true, force: true });
      throw error;
    }

    let disposed = false;
    return {
      path: workspacePath,
      dispose: async () => {
        if (disposed) return;
        await this.#dispose(repositoryRoot, workspacePath, hooksPath);
        disposed = true;
      },
    };
  }

  async #assertRepositoryPaths(repositoryRoot: string): Promise<void> {
    await assertProtectedDirectory(
      repositoryRoot,
      "Runner 权威代码仓库",
      this.#assertWindowsTrustedPath,
      this.#assertWindowsPrivatePath,
    );
    const dotGitPath = path.join(repositoryRoot, ".git");
    await assertProtectedDirectory(
      dotGitPath,
      "Runner 权威代码仓库 Git 元数据",
      this.#assertWindowsTrustedPath,
      this.#assertWindowsPrivatePath,
    );
    await assertProtectedFile(
      path.join(dotGitPath, "config"),
      "Runner 权威代码仓库 Git 配置",
      this.#assertWindowsTrustedPath,
      this.#assertWindowsPrivatePath,
    );
    const worktreeConfig = path.join(dotGitPath, "config.worktree");
    try {
      await assertProtectedFile(
        worktreeConfig,
        "Runner 权威代码仓库工作树配置",
        this.#assertWindowsTrustedPath,
        this.#assertWindowsPrivatePath,
      );
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    const infoPath = path.join(dotGitPath, "info");
    await assertProtectedDirectory(
      infoPath,
      "Runner 权威代码仓库 Git info 目录",
      this.#assertWindowsTrustedPath,
      this.#assertWindowsPrivatePath,
    );
    const infoAttributes = path.join(infoPath, "attributes");
    try {
      await assertProtectedFile(
        infoAttributes,
        "Runner 权威代码仓库私有 attributes",
        this.#assertWindowsTrustedPath,
        this.#assertWindowsPrivatePath,
      );
      if ((await readFile(infoAttributes, "utf8")).trim().length > 0) {
        throw new Error("Runner 权威代码仓库不能使用提交之外的 Git attributes");
      }
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
  }

  async #assertSafeRepositoryConfig(
    repositoryRoot: string,
    hooksPath: string,
  ): Promise<void> {
    const configKeys = (
      await this.#git(repositoryRoot, hooksPath, [
        "config",
        "--file",
        path.join(repositoryRoot, ".git", "config"),
        "--no-includes",
        "--name-only",
        "--list",
      ])
    )
      .split(/\r?\n/u)
      .filter((key) => key.length > 0);
    if (configKeys.some(unsafeGitConfigKey)) {
      throw new Error("Runner 权威代码仓库包含可能执行宿主命令的 Git 配置");
    }
  }

  async #dispose(
    repositoryRoot: string,
    workspacePath: string,
    hooksPath: string,
  ): Promise<void> {
    try {
      await this.#git(repositoryRoot, hooksPath, [
        "worktree",
        "remove",
        "--force",
        workspacePath,
      ]);
    } finally {
      await Promise.all([
        rm(workspacePath, { recursive: true, force: true }),
        rm(hooksPath, { recursive: true, force: true }),
      ]);
    }
  }

  async #git(
    workingDirectory: string,
    hooksPath: string,
    args: string[],
  ): Promise<string> {
    try {
      await assertTrustedExecutable({
        commandPath: this.#gitCommandPath,
        expectedSha256: this.#gitCommandSha256,
        description: "Runner Git 程序",
        assertWindowsTrustedPath: this.#assertWindowsTrustedPath,
      });
      const result = await execFileAsync(
        this.#gitCommandPath,
        [
          "-C",
          workingDirectory,
          "-c",
          `core.hooksPath=${hooksPath}`,
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.eol=lf",
          "-c",
          "core.symlinks=true",
          "-c",
          `core.attributesFile=${path.join(hooksPath, "attributes")}`,
          ...args,
        ],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
          windowsHide: true,
          env: {
            PATH: path.dirname(this.#gitCommandPath),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL:
              process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_PAGER: "",
            ...(process.platform === "win32"
              ? {
                  SystemRoot: process.env.SystemRoot,
                  TEMP: process.env.TEMP,
                  TMP: process.env.TMP,
                }
              : {
                  HOME: "/nonexistent",
                  XDG_CONFIG_HOME: "/nonexistent",
                }),
          },
        },
      );
      return result.stdout.trim();
    } catch {
      throw new Error("Runner 无法安全读取权威 Git 提交");
    }
  }
}
