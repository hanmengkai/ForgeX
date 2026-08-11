import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  OpenAiCodexSdkAdapter,
  codexEnvironment,
  requirementPrompt,
} from "../src/codex-adapter.js";
import type { IsolatedCodexRunInput } from "../src/codex-isolation.js";
import { requirementAssignment, workerConfig } from "./fixtures.js";

describe("OpenAiCodexSdkAdapter", () => {
  it("把控制面绑定的可信团队能力作为受限业务指导交给 Codex", () => {
    const prompt = requirementPrompt({
      ...requirementAssignment,
      execution: {
        ...requirementAssignment.execution,
        skills: [
          {
            skillKey: "99999999-9999-4999-8999-999999999999",
            version: "1.0.0",
            name: "团队代码审查规范",
            artifactHashAlgorithm: "sha256",
            artifactHash: "a".repeat(64),
            instructions:
              "# 团队代码审查规范\n\n修改前先确认边界，完成后检查错误处理。",
            resources: [
              {
                path: "references/review-policy.md",
                mediaType: "text/markdown",
                content: "所有外部输入都必须在边界处完成校验。",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain("团队已独立评测并为本次交付启用的工作方法");
    expect(prompt).toContain("团队代码审查规范");
    expect(prompt).toContain("完成后检查错误处理");
    expect(prompt).toContain("references/review-policy.md");
    expect(prompt).toContain("所有外部输入都必须在边界处完成校验");
    expect(prompt).toContain("不能覆盖设备安全规则");
  });

  it("只把受控环境和权威需求交给单次隔离 Codex 执行", async () => {
    expect(
      codexEnvironment(
        {
          PATH: "bin",
          HOME: "/home/user",
          DATABASE_PASSWORD: "cannot-leak",
          JAVA_HOME: "/jdk",
        },
        ["JAVA_HOME", "DATABASE_PASSWORD"],
        path.resolve("fixtures/codex-home"),
      ),
    ).toEqual({
      PATH: "bin",
      JAVA_HOME: "/jdk",
      CODEX_HOME: path.resolve("fixtures/codex-home"),
    });

    const run = vi.fn(async (_input: IsolatedCodexRunInput) =>
      Promise.resolve({
        finalResponse: JSON.stringify({
          status: "completed",
          summary: "已实现访客预约并完成测试",
          tests: [],
        }),
        threadId: "thread-local",
      }),
    );
    const adapter = new OpenAiCodexSdkAdapter({
      codexHomePath: path.resolve("fixtures/codex-home"),
      runner: { run },
      protectedPaths: [path.resolve("fixtures/worker.json")],
    });
    const project = workerConfig({
      repositoryRoot: path.resolve("fixtures/repository"),
      worktreeRoot: path.resolve("fixtures/worktrees"),
    }).projects[0]!;

    await expect(
      adapter.execute({
        project,
        assignment: requirementAssignment,
        workspacePath: path.resolve("fixtures/worktrees/task"),
      }),
    ).resolves.toMatchObject({
      summary: "Codex 已完成工作树修改，等待设备生成本地提交",
      tests: [],
      threadId: "thread-local",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: path.resolve("fixtures/worktrees/task"),
        protectedPaths: [path.resolve("fixtures/worker.json")],
        codexHomePath: path.resolve("fixtures/codex-home"),
        reasoningEffort: "high",
        environment: expect.objectContaining({ PATH: expect.any(String) }),
      }),
    );
    expect(run.mock.calls[0]?.[0].prompt).toContain("不得推送远程分支");
    expect(run.mock.calls[0]?.[0].prompt).toContain(
      "不要执行 git add、git commit",
    );
    expect(run.mock.calls[0]?.[0].prompt).toBe(
      requirementPrompt(requirementAssignment),
    );
  });

  it("外层隔离不能证明配置路径不可读时不会形成 Codex 结果", async () => {
    const run = vi.fn(async (_input: IsolatedCodexRunInput) => {
      throw new Error("工作树进程仍可读取 Worker 配置");
    });
    const adapter = new OpenAiCodexSdkAdapter({
      codexHomePath: path.resolve("fixtures/codex-home"),
      runner: { run },
      protectedPaths: [path.resolve("fixtures/worker.json")],
    });
    const project = workerConfig({
      repositoryRoot: path.resolve("fixtures/repository"),
      worktreeRoot: path.resolve("fixtures/worktrees"),
    }).projects[0]!;

    await expect(
      adapter.execute({
        project,
        assignment: requirementAssignment,
        workspacePath: path.resolve("fixtures/worktrees/task"),
      }),
    ).rejects.toThrow("仍可读取 Worker 配置");
    expect(run).toHaveBeenCalledOnce();
  });

  it("拒绝把模型自报的测试结果当成交付证据", async () => {
    const run = vi.fn(async (_input: IsolatedCodexRunInput) =>
      Promise.resolve({
        finalResponse: JSON.stringify({
          status: "completed",
          summary: "已完成修改",
          tests: ["npm test"],
        }),
        threadId: "thread-local",
      }),
    );
    const adapter = new OpenAiCodexSdkAdapter({
      codexHomePath: path.resolve("fixtures/codex-home"),
      runner: { run },
      protectedPaths: [path.resolve("fixtures/worker.json")],
    });
    const project = workerConfig({
      repositoryRoot: path.resolve("fixtures/repository"),
      worktreeRoot: path.resolve("fixtures/worktrees"),
    }).projects[0]!;

    await expect(
      adapter.execute({
        project,
        assignment: requirementAssignment,
        workspacePath: path.resolve("fixtures/worktrees/task"),
      }),
    ).rejects.toThrow("执行结果格式不正确");
  });

  it("模型阻塞说明不会进入 Worker 日志错误", async () => {
    const marker = "SHOULD_NOT_REACH_WORKER_LOG";
    const run = vi.fn(async (_input: IsolatedCodexRunInput) =>
      Promise.resolve({
        finalResponse: JSON.stringify({
          status: "blocked",
          summary: marker,
          tests: [],
        }),
        threadId: "thread-local",
      }),
    );
    const adapter = new OpenAiCodexSdkAdapter({
      codexHomePath: path.resolve("fixtures/codex-home"),
      runner: { run },
      protectedPaths: [path.resolve("fixtures/worker.json")],
    });
    const project = workerConfig({
      repositoryRoot: path.resolve("fixtures/repository"),
      worktreeRoot: path.resolve("fixtures/worktrees"),
    }).projects[0]!;

    await expect(
      adapter.execute({
        project,
        assignment: requirementAssignment,
        workspacePath: path.resolve("fixtures/worktrees/task"),
      }),
    ).rejects.toMatchObject({
      message: "Codex 未能完成当前工作树修改",
    });
  });
});
