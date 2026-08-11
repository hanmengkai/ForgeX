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
  preview: { entryPath: ".forgex/preview.html" },
  suites: [
    {
      suiteKey: "unit",
      name: "单元测试",
      criterionKeys: ["70000000-0000-4000-8000-000000000007"],
      execution: {
        image: `registry.example.test/forgex/node@sha256:${"a".repeat(64)}`,
        command: ["/forgex-verifier/node-quality", "--unit"],
        timeoutMs: 120_000,
      },
    },
    {
      suiteKey: "build",
      name: "生产构建",
      criterionKeys: ["71000000-0000-4000-8000-000000000007"],
      execution: {
        image: `registry.example.test/forgex/node@sha256:${"a".repeat(64)}`,
        command: ["/forgex-verifier/node-quality", "--build"],
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
  const dockerPath = path.join(
    root,
    process.platform === "win32" ? "docker.exe" : "docker",
  );
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
  it("进入取件循环前清理同一 Runner 上次崩溃遗留的容器", async () => {
    const { dockerPath, dockerSha256 } = await fixture();
    let listCount = 0;
    const runProcess = vi.fn(async (input: { args: string[] }) => {
      if (input.args[0] === "ps") {
        listCount += 1;
        return {
          exitCode: 0,
          stdout: listCount === 1 ? `${"a".repeat(64)}\n` : "",
        };
      }
      return { exitCode: 0, stdout: "" };
    });
    const sandbox = new DockerVerificationSandbox({
      dockerCommandPath: dockerPath,
      dockerCommandSha256: dockerSha256,
      containerUser: "12345:23456",
      runnerKey: "40000000-0000-4000-8000-000000000004",
      runProcess,
      assertWindowsTrustedPath: async () => Promise.resolve(),
    });

    await sandbox.initialize();
    expect(runProcess.mock.calls[1]![0]!.args).toEqual([
      "rm",
      "--force",
      "a".repeat(64),
    ]);
  });

  it("以无网络、非 root、不可变镜像和有界资源逐项运行固定套件", async () => {
    const { root, dockerPath, dockerSha256 } = await fixture();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    let suiteIndex = 0;
    const runProcess = vi.fn(async (input: { args: string[] }) => {
      if (input.args[0] === "run") {
        const exitCode = suiteIndex === 0 ? 0 : 1;
        suiteIndex += 1;
        return { exitCode };
      }
      return { exitCode: 0, stdout: "" };
    });
    const sandbox = new DockerVerificationSandbox({
      dockerCommandPath: dockerPath,
      dockerCommandSha256: dockerSha256,
      containerUser: "12345:23456",
      runnerKey: "40000000-0000-4000-8000-000000000004",
      runProcess,
      assertWindowsTrustedPath: async () => Promise.resolve(),
    });

    await expect(sandbox.run({ workspacePath, plan })).resolves.toEqual({
      suites: [
        { suiteKey: "unit", status: "passed" },
        { suiteKey: "build", status: "failed" },
      ],
    });
    expect(runProcess).toHaveBeenCalledTimes(8);
    const first = runProcess.mock.calls.find(
      ([input]) => input.args[0] === "run",
    )![0] as {
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
        "12345:23456",
        plan.suites[0]!.execution.image,
        "/forgex-verifier/node-quality",
        "--unit",
      ]),
    );
    expect(first.args).toContain(
      `type=bind,source=${workspacePath},target=/workspace,readonly`,
    );
    expect(first.args.join(" ")).not.toContain("sh -c");
  });

  it("执行超时后按不可预测容器名强制清理并确认容器已经消失", async () => {
    const { root, dockerPath, dockerSha256 } = await fixture();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const runProcess = vi.fn(async (input: { args: string[] }) => {
      if (input.args[0] === "run") throw new Error("verification_timeout");
      return { exitCode: 0, stdout: "" };
    });
    const sandbox = new DockerVerificationSandbox({
      dockerCommandPath: dockerPath,
      dockerCommandSha256: dockerSha256,
      containerUser: "12345:23456",
      runnerKey: "40000000-0000-4000-8000-000000000004",
      runProcess,
      assertWindowsTrustedPath: async () => Promise.resolve(),
    });

    await expect(sandbox.run({ workspacePath, plan })).rejects.toThrow(
      "受控容器",
    );
    const runCallIndex = runProcess.mock.calls.findIndex(
      ([input]) => input.args[0] === "run",
    );
    const runArgs = runProcess.mock.calls[runCallIndex]![0]!.args;
    const nameIndex = runArgs.indexOf("--name");
    expect(nameIndex).toBeGreaterThan(0);
    const containerName = runArgs[nameIndex + 1];
    expect(containerName).toMatch(/^forgex-verification-[a-f0-9-]+$/u);
    expect(runProcess.mock.calls[runCallIndex + 1]![0]!.args).toEqual([
      "rm",
      "--force",
      containerName,
    ]);
    expect(runProcess.mock.calls[runCallIndex + 2]![0]!.args).toEqual([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${containerName}$`,
    ]);
  });

  it("每次执行前重验 Docker 程序摘要，并把基础设施错误转换为固定文案", async () => {
    const { root, dockerPath, dockerSha256 } = await fixture();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const runProcess = vi.fn(async (input: { args: string[] }) => ({
      exitCode: input.args[0] === "run" ? 125 : 0,
      stdout: "",
      stderr: "Authorization: Bearer local-secret-marker",
    }));
    const sandbox = new DockerVerificationSandbox({
      dockerCommandPath: dockerPath,
      dockerCommandSha256: dockerSha256,
      containerUser: "12345:23456",
      runnerKey: "40000000-0000-4000-8000-000000000004",
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
      "受控容器",
    );
    expect(
      runProcess.mock.calls.filter(([input]) => input.args[0] === "run"),
    ).toHaveLength(1);
  });

  it("清理无法确认后会在下一次执行前重新扫描 Runner 遗留容器", async () => {
    const { root, dockerPath, dockerSha256 } = await fixture();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    let cleanupFailed = false;
    let labelScanCount = 0;
    const runProcess = vi.fn(async (input: { args: string[] }) => {
      if (
        input.args[0] === "ps" &&
        input.args.some((value) => value.startsWith("label="))
      ) {
        labelScanCount += 1;
        return { exitCode: 0, stdout: "" };
      }
      if (input.args[0] === "run") throw new Error("verification_timeout");
      if (input.args[0] === "rm" && !cleanupFailed) {
        cleanupFailed = true;
        return { exitCode: 1, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    });
    const sandbox = new DockerVerificationSandbox({
      dockerCommandPath: dockerPath,
      dockerCommandSha256: dockerSha256,
      containerUser: "12345:23456",
      runnerKey: "40000000-0000-4000-8000-000000000004",
      runProcess,
      assertWindowsTrustedPath: async () => Promise.resolve(),
    });

    await expect(sandbox.run({ workspacePath, plan })).rejects.toThrow();
    const scansAfterFirstFailure = labelScanCount;
    await expect(sandbox.run({ workspacePath, plan })).rejects.toThrow();
    expect(labelScanCount).toBeGreaterThan(scansAfterFirstFailure);
  });
});
