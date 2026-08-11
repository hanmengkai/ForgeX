import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DeviceWorkerProjectSchema } from "../src/config.js";
import { GitWorktreeWorkspaceProvider } from "../src/workspace.js";
import {
  projectKey,
  repositoryKey,
  requirementAssignment,
} from "./fixtures.js";

const run = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("GitWorktreeWorkspaceProvider", () => {
  it("在宿主 Git 操作前拒绝仓库注入的 clean filter 执行面", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-worker-"));
    temporaryRoots.push(root);
    const repositoryRoot = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktrees");
    await run("git", ["init", "-b", "main", repositoryRoot]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.name",
      "ForgeX Test",
    ]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.email",
      "forgex@example.test",
    ]);
    await writeFile(path.join(repositoryRoot, "README.md"), "# Test\n", "utf8");
    await run("git", ["-C", repositoryRoot, "add", "README.md"]);
    await run("git", ["-C", repositoryRoot, "commit", "-m", "initial"]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "filter.forgex-escape.clean",
      "node should-never-run.js",
    ]);
    const project = DeviceWorkerProjectSchema.parse({
      projectKey,
      repositoryKey,
      repositoryRoot,
      worktreeRoot,
      baseRef: "main",
    });

    await expect(
      new GitWorktreeWorkspaceProvider().prepare(
        project,
        requirementAssignment,
      ),
    ).rejects.toThrow("外部命令能力");
  });

  it("在创建 ForgeX 分支前拒绝 onbranch 条件 include 注入的过滤器", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-worker-"));
    temporaryRoots.push(root);
    const repositoryRoot = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktrees");
    const markerPath = path.join(root, "filter-executed");
    const filterScript = path.join(root, "filter.cjs");
    const includedConfig = path.join(root, "forgex-branch.config");
    await run("git", ["init", "-b", "main", repositoryRoot]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.name",
      "ForgeX Test",
    ]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.email",
      "forgex@example.test",
    ]);
    await writeFile(
      filterScript,
      "const fs=require('node:fs'); fs.writeFileSync(process.argv[2], 'executed'); process.stdin.pipe(process.stdout);\n",
      "utf8",
    );
    const filterCommand = `\"${process.execPath}\" \"${filterScript}\" \"${markerPath}\"`;
    await writeFile(
      includedConfig,
      `[filter "forgex-escape"]\n\tclean = ${filterCommand}\n\tprocess = ${filterCommand}\n`,
      "utf8",
    );
    await writeFile(
      path.join(repositoryRoot, ".gitattributes"),
      "*.txt filter=forgex-escape\n",
      "utf8",
    );
    await writeFile(path.join(repositoryRoot, "README.md"), "# Test\n", "utf8");
    await run("git", [
      "-C",
      repositoryRoot,
      "add",
      ".gitattributes",
      "README.md",
    ]);
    await run("git", ["-C", repositoryRoot, "commit", "-m", "initial"]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "--local",
      "includeIf.onbranch:forgex/**.path",
      includedConfig,
    ]);
    const project = DeviceWorkerProjectSchema.parse({
      projectKey,
      repositoryKey,
      repositoryRoot,
      worktreeRoot,
      baseRef: "main",
    });

    await expect(
      new GitWorktreeWorkspaceProvider().prepare(
        project,
        requirementAssignment,
      ),
    ).rejects.toThrow("外部命令能力");
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("为每个租约创建独立分支，并由可信 Worker 生成干净提交", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-worker-"));
    temporaryRoots.push(root);
    const repositoryRoot = path.join(root, "repository");
    const worktreeRoot = path.join(root, "worktrees");
    await run("git", ["init", "-b", "main", repositoryRoot]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.name",
      "ForgeX Test",
    ]);
    await run("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.email",
      "forgex@example.test",
    ]);
    await writeFile(path.join(repositoryRoot, "README.md"), "# Test\n", "utf8");
    await run("git", ["-C", repositoryRoot, "add", "README.md"]);
    await run("git", ["-C", repositoryRoot, "commit", "-m", "initial"]);

    const project = DeviceWorkerProjectSchema.parse({
      projectKey,
      repositoryKey,
      repositoryRoot,
      worktreeRoot,
      baseRef: "main",
    });
    const provider = new GitWorktreeWorkspaceProvider();
    const workspace = await provider.prepare(project, requirementAssignment);
    expect(workspace.path).toBe(
      path.join(worktreeRoot, requirementAssignment.assignmentKey),
    );
    expect(workspace.branchName).toContain(requirementAssignment.assignmentKey);

    await writeFile(path.join(workspace.path, "feature.txt"), "done\n", "utf8");
    await expect(provider.commitCompleted(workspace)).resolves.toMatchObject({
      gitHashAlgorithm: "sha1",
      branchName: workspace.branchName,
    });
    await expect(provider.commitCompleted(workspace)).rejects.toThrow(
      "没有产生",
    );

    await run("git", ["-C", workspace.path, "switch", "-c", "other"]);
    await writeFile(path.join(workspace.path, "other.txt"), "other\n", "utf8");
    await expect(provider.commitCompleted(workspace)).rejects.toThrow(
      "预期交付分支",
    );

    await run("git", ["-C", workspace.path, "switch", workspace.branchName]);
    await run("git", ["-C", workspace.path, "switch", "--detach"]);
    await expect(provider.commitCompleted(workspace)).rejects.toThrow(
      "分离 HEAD",
    );
  }, 30_000);
});
