import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DockerVerificationSandbox,
  type VerificationSuitePlan,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const plan: VerificationSuitePlan = {
  schemaVersion: 1,
  planKey: "node-quality",
  planVersion: 1,
  repositoryKey: "30000000-0000-4000-8000-000000000003",
  requirementKey: "60000000-0000-4000-8000-000000000006",
  requirementRevision: 2,
  gitHashAlgorithm: "sha1",
  commitSha: "a".repeat(40),
  suites: [
    {
      suiteKey: "unit",
      name: "单元测试",
      criterionKeys: ["70000000-0000-4000-8000-000000000007"],
      execution: {
        image: `registry.example.test/forgex/node@sha256:${"a".repeat(64)}`,
        command: ["npm", "test"],
        timeoutMs: 120_000,
      },
    },
    {
      suiteKey: "build",
      name: "生产构建",
      criterionKeys: ["71000000-0000-4000-8000-000000000007"],
      execution: {
        image: `registry.example.test/forgex/node@sha256:${"a".repeat(64)}`,
        command: ["npm", "run", "build"],
        timeoutMs: 180_000,
      },
    },
  ],
};

const fixture = async () => {
  const root = path.join(os.tmpdir(), `forgex-runner-docker-${randomUUID()}`);
  temporaryRoots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(root, 0o700);
  const dockerPath = path.join(root, process.platform === "win32" ? "docker.exe" : "docker");
  await writeFile(dockerPath, "trusted docker fixture", { mode: 0o700 });
  if (process.platform !== "win32") await chmod(dockerPath, 0o700);
  return {
    root,
    dockerPath,
    dockerSha256: createHash("sha256")
      .update("trusted docker fixture", "utf8")
      .digest("hex"),
  };
};

describe("DockerVerificationSandbox", () => {
  it("以无网络、非 root、不可变镜像和有界资源逐项运行固定套件", async () => {
    const { root, dockerPath, dockerSha256 } = await fixture();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const runProcess = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 1 });
    const sandbox = new DockerVerificationSandbox({
      dockerCommandPath: dockerPath,
      dockerCommandSha256: dockerSha256,
      runProcess,
      assertWindowsTrustedPath: async () => Promise.resolve(),
    });

    await expect(sandbox.run({ workspacePath, plan })).resolves.toEqual({
      suites: [
        { suiteKey: "unit", status: "passed" },
        { suiteKey: "build", status: "failed" },
      ],
    });
    expect(runProcess).toHaveBeenCalledTimes(2);
    const first = runProcess.mock.calls[0]![0] as {
      commandPath: string;
      args: string[];
      timeoutMs: number;
    };
    expect(first.commandPath).toBe(dockerPath);
    expect(first.timeoutMs).toBe(120_000);
    expect(first.args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--pull",
        "never",
        "--cap-drop",
        "ALL",
        "--user",
        "65532:65532",
        plan.suites[0]!.execution.image,
        "npm",
        "test",
      ]),
    );
    expect(first.args.join(" ")).not.toContain("sh -c");
  });

  it("每次执行前重验 Docker 程序摘要，并把基础设施错误转换为固定文案", async () => {
    const { root, dockerPath, dockerSha256 } = await fixture();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const runProcess = vi.fn(async () => ({
      exitCode: 125,
      stderr: "Authorization: Bearer local-secret-marker",
    }));
    const sandbox = new DockerVerificationSandbox({
      dockerCommandPath: dockerPath,
      dockerCommandSha256: dockerSha256,
      runProcess,
      assertWindowsTrustedPath: async () => Promise.resolve(),
    });

    const error = await sandbox
      .run({ workspacePath, plan })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("local-secret-marker");

    await writeFile(dockerPath, "replaced docker fixture");
    await expect(sandbox.run({ workspacePath, plan })).rejects.toThrow(
      "摘要",
    );
    expect(runProcess).toHaveBeenCalledOnce();
  });
});
