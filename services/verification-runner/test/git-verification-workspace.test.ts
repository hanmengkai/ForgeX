import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GitVerificationWorkspaceProvider } from "../src/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
let gitCommandPath = "";
let gitCommandSha256 = "";

beforeAll(async () => {
  const locator = await execFileAsync(
    process.platform === "win32" ? "where.exe" : "/usr/bin/which",
    ["git"],
    { encoding: "utf8" },
  );
  gitCommandPath = path.resolve(locator.stdout.trim().split(/\r?\n/u)[0]!);
  gitCommandSha256 = createHash("sha256")
    .update(await readFile(gitCommandPath))
    .digest("hex");
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const git = async (repository: string, args: string[]): Promise<string> => {
  const result = await execFileAsync(
    gitCommandPath,
    ["-C", repository, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    },
  );
  return result.stdout.trim();
};

const repositoryFixture = async () => {
  const root = path.join(os.tmpdir(), `forgex-runner-git-${randomUUID()}`);
  temporaryRoots.push(root);
  const repositoryRoot = path.join(root, "repository");
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(workspaceRoot, 0o700);
  await git(repositoryRoot, ["init"]);
  await git(repositoryRoot, ["config", "user.name", "ForgeX Test"]);
  await git(repositoryRoot, ["config", "user.email", "forgex@example.test"]);
  await writeFile(path.join(repositoryRoot, "result.txt"), "first", "utf8");
  await git(repositoryRoot, ["add", "result.txt"]);
  await git(repositoryRoot, ["commit", "-m", "first"]);
  const firstCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repositoryRoot, "result.txt"), "second", "utf8");
  await git(repositoryRoot, ["add", "result.txt"]);
  await git(repositoryRoot, ["commit", "-m", "second"]);
  const secondCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  return { root, repositoryRoot, workspaceRoot, firstCommit, secondCommit };
};

const providerFor = (fixture: Awaited<ReturnType<typeof repositoryFixture>>) =>
  new GitVerificationWorkspaceProvider({
    repositories: [
      {
        repositoryKey: "30000000-0000-4000-8000-000000000003",
        repositoryRoot: fixture.repositoryRoot,
      },
    ],
    workspaceRoot: fixture.workspaceRoot,
    gitCommandPath,
    gitCommandSha256,
    assertWindowsTrustedPath: async () => Promise.resolve(),
  });

describe("GitVerificationWorkspaceProvider", () => {
  it("只取出权威仓库中的精确提交，并在验证后删除隔离工作区", async () => {
    const fixture = await repositoryFixture();
    const provider = providerFor(fixture);

    const workspace = await provider.prepare({
      repositoryKey: "30000000-0000-4000-8000-000000000003",
      gitHashAlgorithm: "sha1",
      commitSha: fixture.firstCommit,
    });
    expect(
      await readFile(path.join(workspace.path, "result.txt"), "utf8"),
    ).toBe("first");
    await expect(git(workspace.path, ["rev-parse", "HEAD"])).resolves.toBe(
      fixture.firstCommit,
    );

    await workspace.dispose();
    await expect(
      readFile(path.join(workspace.path, "result.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝未知仓库、错误哈希算法和可能执行宿主命令的 Git 配置", async () => {
    const fixture = await repositoryFixture();
    const provider = providerFor(fixture);
    await expect(
      provider.prepare({
        repositoryKey: "31000000-0000-4000-8000-000000000003",
        gitHashAlgorithm: "sha1",
        commitSha: fixture.secondCommit,
      }),
    ).rejects.toThrow("仓库");
    await expect(
      provider.prepare({
        repositoryKey: "30000000-0000-4000-8000-000000000003",
        gitHashAlgorithm: "sha256",
        commitSha: fixture.secondCommit,
      }),
    ).rejects.toThrow("摘要算法");

    const includedConfig = path.join(fixture.root, "unsafe-git-config");
    await writeFile(
      includedConfig,
      '[filter "forgex"]\n\tclean = dangerous-command\n',
      "utf8",
    );
    await git(fixture.repositoryRoot, [
      "config",
      "include.path",
      includedConfig,
    ]);
    await expect(
      provider.prepare({
        repositoryKey: "30000000-0000-4000-8000-000000000003",
        gitHashAlgorithm: "sha1",
        commitSha: fixture.secondCommit,
      }),
    ).rejects.toThrow("Git 配置");
  });

  it("取件时不会执行权威仓库内的 Git hooks", async () => {
    const fixture = await repositoryFixture();
    const markerPath = path.join(fixture.root, "hook-executed");
    const hookPath = path.join(
      fixture.repositoryRoot,
      ".git",
      "hooks",
      "post-checkout",
    );
    await writeFile(
      hookPath,
      `#!/bin/sh\nprintf unsafe > '${markerPath.replaceAll("'", "'\\''")}'\n`,
      { mode: 0o700 },
    );
    if (process.platform !== "win32") await chmod(hookPath, 0o700);
    const provider = providerFor(fixture);

    const workspace = await provider.prepare({
      repositoryKey: "30000000-0000-4000-8000-000000000003",
      gitHashAlgorithm: "sha1",
      commitSha: fixture.secondCommit,
    });
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await workspace.dispose();
  });
});
