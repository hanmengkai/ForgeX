import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKER_MCP_SUCCEEDED_SUMMARY } from "@forgex/contracts";

import { DeviceWorkerRuntime } from "../src/runtime.js";
import { InMemoryWorkerCompletionJournal } from "../src/completion-journal.js";
import { ControlPlaneClientError } from "../src/control-plane-client.js";
import {
  assignmentKey,
  mcpAssignment,
  requirementAssignment,
  workerConfig,
} from "./fixtures.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("DeviceWorkerRuntime", () => {
  it("非只读 MCP 在调用边界异常后只上报结果未知，不会自动重复副作用", async () => {
    const journal = new InMemoryWorkerCompletionJournal();
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(mcpAssignment)),
      renew: vi.fn(async () => Promise.resolve("2026-08-10T10:02:00.000Z")),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const mcp = {
      execute: vi.fn(async () => {
        throw new Error("工具返回前连接中断");
      }),
    };
    const runtime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces: {
        prepare: vi.fn(),
        commitCompleted: vi.fn(),
        recoverCompleted: vi.fn(),
      },
      codex: { execute: vi.fn() },
      mcp,
      completionJournal: journal,
    });

    await expect(runtime.runOnce()).rejects.toThrow("连接中断");
    await expect(journal.load()).resolves.toMatchObject({
      kind: "mcp_invocation_started",
      assignment: { invocationKey: mcpAssignment.invocationKey },
    });
    await expect(runtime.runOnce()).resolves.toMatchObject({
      kind: "mcp_completed",
      title: mcpAssignment.title,
    });
    expect(mcp.execute).toHaveBeenCalledOnce();
    expect(controlPlane.poll).toHaveBeenCalledOnce();
    expect(controlPlane.completeMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        projectKey: mcpAssignment.projectKey,
        invocationKey: mcpAssignment.invocationKey,
      }),
      {
        outcome: "unknown",
        summary: "本地工具操作结果需要人工核对",
      },
      undefined,
    );
  });

  it("只读 MCP 在调用边界异常后可以从持久意图安全重试", async () => {
    const journal = new InMemoryWorkerCompletionJournal();
    const readAssignment = {
      ...mcpAssignment,
      execution: { ...mcpAssignment.execution, effect: "read" as const },
    };
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(readAssignment)),
      renew: vi.fn(async () => Promise.resolve("2026-08-10T10:02:00.000Z")),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const mcp = {
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error("临时连接中断"))
        .mockResolvedValueOnce({
          outcome: "succeeded" as const,
          summary: "本地工具操作已完成",
        }),
    };
    const runtime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces: {
        prepare: vi.fn(),
        commitCompleted: vi.fn(),
        recoverCompleted: vi.fn(),
      },
      codex: { execute: vi.fn() },
      mcp,
      completionJournal: journal,
    });

    await expect(runtime.runOnce()).rejects.toThrow("临时连接中断");
    await expect(runtime.runOnce()).resolves.toMatchObject({
      kind: "mcp_completed",
    });
    expect(mcp.execute).toHaveBeenCalledTimes(2);
    expect(controlPlane.poll).toHaveBeenCalledOnce();
    expect(controlPlane.completeMcp).toHaveBeenCalledWith(
      expect.any(Object),
      {
        outcome: "succeeded",
        summary: "本地工具操作已完成",
      },
      undefined,
    );
  });

  it("只在 Codex 生成干净本地提交后完成租约", async () => {
    const worktreeRoot = await mkdtemp(
      path.join(os.tmpdir(), "forgex-runtime-log-"),
    );
    temporaryRoots.push(worktreeRoot);
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(requirementAssignment)),
      renew: vi.fn(async () => Promise.resolve("2026-08-10T10:02:00.000Z")),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
      reportRequirementProgress: vi.fn(async () => Promise.resolve(false)),
      reportRequirementLog: vi.fn(async () => Promise.resolve(false)),
    };
    const workspaces = {
      prepare: vi.fn(async () =>
        Promise.resolve({
          path: path.resolve("worktrees", assignmentKey),
          branchName: `forgex/${requirementAssignment.projectKey.slice(0, 8)}/${assignmentKey}`,
          baseCommit: "a".repeat(40),
        }),
      ),
      commitCompleted: vi.fn(async (workspace) =>
        Promise.resolve({
          ...workspace,
          commitSha: "b".repeat(40),
          gitHashAlgorithm: "sha1" as const,
        }),
      ),
      recoverCompleted: vi.fn(),
    };
    const codex = {
      execute: vi.fn(async (input) => {
        input.onProgress?.({
          kind: "tool",
          tool: "search_workspace_text",
          status: "completed",
        });
        input.onLog?.({
          stream: "stderr",
          text: "Authorization: Bearer runtime-secret-marker\n",
        });
        input.onProgress?.({
          kind: "file_change",
          changes: [{ path: "src/App.tsx", kind: "update" }],
          status: "completed",
        });
        return Promise.resolve({
          summary: "LEAK_MARKER_DO_NOT_UPLOAD",
          tests: ["npm test"],
          threadId: "thread-local",
        });
      }),
    };
    const config = workerConfig({
      repositoryRoot: path.resolve("repository"),
      worktreeRoot,
    });
    const runtime = new DeviceWorkerRuntime({
      config,
      controlPlane,
      workspaces,
      codex,
      completionJournal: new InMemoryWorkerCompletionJournal(),
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({
      kind: "requirement_completed",
      title: "访客预约",
      workspace: { commitSha: "b".repeat(40) },
    });
    expect(controlPlane.completeRequirement).toHaveBeenCalledOnce();
    expect(controlPlane.reportRequirementProgress).toHaveBeenCalledTimes(2);
    expect(controlPlane.reportRequirementLog).toHaveBeenCalledWith(
      requirementAssignment,
      expect.objectContaining({
        sequence: 1,
        stream: "stderr",
        text: "Authorization: Bearer [REDACTED_SECRET]\n",
      }),
      expect.any(AbortSignal),
    );
    expect(
      await readFile(
        path.join(
          worktreeRoot,
          ".forgex-execution-logs",
          assignmentKey,
          "execution.log",
        ),
        "utf8",
      ),
    ).toContain("Authorization: Bearer [REDACTED_SECRET]");
    expect(controlPlane.reportRequirementProgress).toHaveBeenNthCalledWith(
      1,
      requirementAssignment,
      expect.objectContaining({
        sequence: 1,
        event: {
          kind: "tool",
          tool: "search_workspace_text",
          status: "completed",
        },
      }),
      expect.any(AbortSignal),
    );
    expect(controlPlane.completeRequirement).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentKey: requirementAssignment.assignmentKey,
        repositoryKey: requirementAssignment.execution.repositoryKey,
      }),
      expect.objectContaining({
        summary: "已生成本地提交，等待独立验证",
        commitSha: "b".repeat(40),
      }),
      undefined,
    );
    expect(controlPlane.renew.mock.invocationCallOrder[0]).toBeLessThan(
      codex.execute.mock.invocationCallOrder[0]!,
    );
    expect(controlPlane.renew).toHaveBeenCalledTimes(2);
    expect(controlPlane.renew.mock.invocationCallOrder[1]).toBeLessThan(
      controlPlane.completeRequirement.mock.invocationCallOrder[0]!,
    );
  });

  it("未配置项目或未形成提交时绝不完成租约", async () => {
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(requirementAssignment)),
      renew: vi.fn(async () => Promise.resolve("2026-08-10T10:02:00.000Z")),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const config = workerConfig({
      repositoryRoot: path.resolve("repository"),
      worktreeRoot: path.resolve("worktrees"),
    });
    const runtime = new DeviceWorkerRuntime({
      config: { ...config, projects: [] },
      controlPlane,
      workspaces: {
        prepare: vi.fn(),
        commitCompleted: vi.fn(),
        recoverCompleted: vi.fn(),
      },
      codex: { execute: vi.fn() },
      completionJournal: new InMemoryWorkerCompletionJournal(),
    });
    await expect(runtime.runOnce()).rejects.toThrow("没有配置");
    expect(controlPlane.completeRequirement).not.toHaveBeenCalled();
  });

  it("本地仓库身份与权威任务不一致时不创建工作树也不启动 Codex", async () => {
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(requirementAssignment)),
      renew: vi
        .fn()
        .mockResolvedValueOnce("2026-08-10T10:02:00.000Z")
        .mockResolvedValueOnce("2026-08-10T10:02:00.000Z")
        .mockRejectedValueOnce(
          new ControlPlaneClientError(
            409,
            "invalid_lease",
            "永久证明已经提交，原租约已结束",
          ),
        ),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const config = workerConfig({
      repositoryRoot: path.resolve("repository"),
      worktreeRoot: path.resolve("worktrees"),
    });
    const workspaces = {
      prepare: vi.fn(),
      commitCompleted: vi.fn(),
      recoverCompleted: vi.fn(),
    };
    const codex = { execute: vi.fn() };
    const runtime = new DeviceWorkerRuntime({
      config: {
        ...config,
        projects: [
          {
            ...config.projects[0]!,
            repositoryKey: "77777777-7777-4777-8777-777777777777",
          },
        ],
      },
      controlPlane,
      workspaces,
      codex,
      completionJournal: new InMemoryWorkerCompletionJournal(),
    });
    await expect(runtime.runOnce()).rejects.toThrow("仓库");
    expect(workspaces.prepare).not.toHaveBeenCalled();
    expect(codex.execute).not.toHaveBeenCalled();
    expect(controlPlane.completeRequirement).not.toHaveBeenCalled();
  });

  it("完成响应中断后先从本地日志重发，不重新执行 Codex 或领取任务", async () => {
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(requirementAssignment)),
      renew: vi.fn(async () => Promise.resolve("2026-08-10T10:02:00.000Z")),
      completeRequirement: vi
        .fn()
        .mockRejectedValueOnce(new Error("模拟完成响应中断"))
        .mockResolvedValueOnce(true),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const journal = new InMemoryWorkerCompletionJournal();
    const workspaces = {
      prepare: vi.fn(async () =>
        Promise.resolve({
          path: path.resolve("worktrees", assignmentKey),
          branchName: `forgex/${requirementAssignment.projectKey.slice(0, 8)}/${assignmentKey}`,
          baseCommit: "a".repeat(40),
        }),
      ),
      commitCompleted: vi.fn(async (workspace) =>
        Promise.resolve({
          ...workspace,
          commitSha: "b".repeat(40),
          gitHashAlgorithm: "sha1" as const,
        }),
      ),
      recoverCompleted: vi.fn(async (workspace) =>
        Promise.resolve({
          ...workspace,
          commitSha: "b".repeat(40),
          gitHashAlgorithm: "sha1" as const,
        }),
      ),
    };
    const codex = {
      execute: vi.fn(async () =>
        Promise.resolve({
          summary: "LEAK_MARKER_DO_NOT_UPLOAD",
          tests: ["npm test"],
          threadId: "thread-local",
        }),
      ),
    };
    const runtime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces,
      codex,
      completionJournal: journal,
    });

    await expect(runtime.runOnce()).rejects.toThrow("响应中断");
    await expect(journal.load()).resolves.toMatchObject({
      kind: "requirement_delivery",
      result: {
        summary: "已生成本地提交，等待独立验证",
        commitSha: "b".repeat(40),
      },
    });
    expect(JSON.stringify(await journal.load())).not.toContain(
      "LEAK_MARKER_DO_NOT_UPLOAD",
    );
    const restartedRuntime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces,
      codex,
      completionJournal: journal,
    });
    await expect(restartedRuntime.runOnce()).resolves.toMatchObject({
      kind: "requirement_completed",
      title: requirementAssignment.title,
    });
    expect(controlPlane.poll).toHaveBeenCalledOnce();
    expect(codex.execute).toHaveBeenCalledOnce();
    expect(controlPlane.completeRequirement).toHaveBeenCalledTimes(2);
    await expect(journal.load()).resolves.toBeNull();
  });

  it("宿主提交后崩溃会从提交意图恢复原提交，不重复执行 Codex", async () => {
    const journal = new InMemoryWorkerCompletionJournal();
    const branchName = `forgex/${requirementAssignment.projectKey.slice(0, 8)}/${assignmentKey}`;
    await journal.saveCommitIntent({
      schemaVersion: 1,
      kind: "requirement_commit_pending",
      assignment: {
        assignmentKey,
        fencingToken: requirementAssignment.fencingToken,
        title: requirementAssignment.title,
        projectKey: requirementAssignment.projectKey,
        repositoryKey: requirementAssignment.execution.repositoryKey,
        requirementKey: requirementAssignment.requirementKey,
        requirementRevision: requirementAssignment.requirementRevision,
      },
      workspace: {
        path: path.resolve("worktrees", assignmentKey),
        branchName,
        baseCommit: "a".repeat(40),
      },
      summary: "已生成本地提交，等待独立验证",
    });
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(null)),
      renew: vi.fn(async () => Promise.resolve("2026-08-10T10:02:00.000Z")),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const workspaces = {
      prepare: vi.fn(),
      commitCompleted: vi.fn(),
      recoverCompleted: vi.fn(async (workspace) =>
        Promise.resolve({
          ...workspace,
          commitSha: "b".repeat(40),
          gitHashAlgorithm: "sha1" as const,
        }),
      ),
    };
    const codex = { execute: vi.fn() };
    const runtime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces,
      codex,
      completionJournal: journal,
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({
      kind: "requirement_completed",
      title: requirementAssignment.title,
    });
    expect(workspaces.recoverCompleted).toHaveBeenCalledOnce();
    expect(controlPlane.renew.mock.invocationCallOrder[0]).toBeLessThan(
      workspaces.recoverCompleted.mock.invocationCallOrder[0]!,
    );
    expect(workspaces.commitCompleted).not.toHaveBeenCalled();
    expect(codex.execute).not.toHaveBeenCalled();
    expect(controlPlane.poll).not.toHaveBeenCalled();
    expect(controlPlane.completeRequirement).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentKey }),
      expect.objectContaining({ commitSha: "b".repeat(40) }),
      undefined,
    );
    await expect(journal.load()).resolves.toBeNull();
  });

  it("提交意图恢复前必须先取得有效租约，失效时不会继续生成本地提交", async () => {
    const journal = new InMemoryWorkerCompletionJournal();
    const branchName = `forgex/${requirementAssignment.projectKey.slice(0, 8)}/${assignmentKey}`;
    await journal.saveCommitIntent({
      schemaVersion: 1,
      kind: "requirement_commit_pending",
      assignment: {
        assignmentKey,
        fencingToken: requirementAssignment.fencingToken,
        title: requirementAssignment.title,
        projectKey: requirementAssignment.projectKey,
        repositoryKey: requirementAssignment.execution.repositoryKey,
        requirementKey: requirementAssignment.requirementKey,
        requirementRevision: requirementAssignment.requirementRevision,
      },
      workspace: {
        path: path.resolve("worktrees", assignmentKey),
        branchName,
        baseCommit: "a".repeat(40),
      },
      summary: "已生成本地提交，等待独立验证",
    });
    const invalidLease = new ControlPlaneClientError(
      409,
      "invalid_lease",
      "任务租约已经失效",
    );
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(null)),
      renew: vi.fn(async () => Promise.reject(invalidLease)),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const workspaces = {
      prepare: vi.fn(),
      commitCompleted: vi.fn(),
      recoverCompleted: vi.fn(),
    };
    const runtime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces,
      codex: { execute: vi.fn() },
      completionJournal: journal,
    });

    await expect(runtime.runOnce()).rejects.toMatchObject({
      code: "invalid_lease",
    });
    expect(workspaces.recoverCompleted).not.toHaveBeenCalled();
    expect(workspaces.commitCompleted).not.toHaveBeenCalled();
    expect(controlPlane.completeRequirement).not.toHaveBeenCalled();
    await expect(journal.load()).resolves.toMatchObject({
      kind: "requirement_commit_pending",
    });
  });

  it("提交意图中的工作树路径被替换时在任何 Git 操作前拒绝恢复", async () => {
    const journal = new InMemoryWorkerCompletionJournal();
    await journal.saveCommitIntent({
      schemaVersion: 1,
      kind: "requirement_commit_pending",
      assignment: {
        assignmentKey,
        fencingToken: requirementAssignment.fencingToken,
        title: requirementAssignment.title,
        projectKey: requirementAssignment.projectKey,
        repositoryKey: requirementAssignment.execution.repositoryKey,
        requirementKey: requirementAssignment.requirementKey,
        requirementRevision: requirementAssignment.requirementRevision,
      },
      workspace: {
        path: path.resolve("second-repository"),
        branchName: `forgex/${requirementAssignment.projectKey.slice(0, 8)}/${assignmentKey}`,
        baseCommit: "a".repeat(40),
      },
      summary: "已生成本地提交，等待独立验证",
    });
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(null)),
      renew: vi.fn(async () => Promise.resolve("2026-08-10T10:02:00.000Z")),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.resolve(false)),
    };
    const workspaces = {
      prepare: vi.fn(),
      commitCompleted: vi.fn(),
      recoverCompleted: vi.fn(),
    };
    const runtime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces,
      codex: { execute: vi.fn() },
      completionJournal: journal,
    });

    await expect(runtime.runOnce()).rejects.toThrow("权威项目配置");
    expect(workspaces.recoverCompleted).not.toHaveBeenCalled();
    expect(workspaces.commitCompleted).not.toHaveBeenCalled();
    expect(controlPlane.completeRequirement).not.toHaveBeenCalled();
  });

  it("过期且没有永久证明的完成结果会隔离，不会永久占住设备", async () => {
    const journal = new InMemoryWorkerCompletionJournal();
    await journal.save({
      schemaVersion: 1,
      kind: "mcp_invocation",
      assignment: {
        assignmentKey,
        fencingToken: 7,
        title: "发送通知",
        projectKey: mcpAssignment.projectKey,
        invocationKey: mcpAssignment.invocationKey,
      },
      result: {
        outcome: "succeeded",
        summary: WORKER_MCP_SUCCEEDED_SUMMARY,
      },
    });
    const stale = new ControlPlaneClientError(
      409,
      "invalid_lease",
      "任务租约已经失效",
    );
    const controlPlane = {
      heartbeat: vi.fn(async () => Promise.resolve()),
      poll: vi.fn(async () => Promise.resolve(null)),
      renew: vi.fn(async () => Promise.reject(stale)),
      completeRequirement: vi.fn(async () => Promise.resolve(false)),
      completeMcp: vi.fn(async () => Promise.reject(stale)),
    };
    const runtime = new DeviceWorkerRuntime({
      config: workerConfig({
        repositoryRoot: path.resolve("repository"),
        worktreeRoot: path.resolve("worktrees"),
      }),
      controlPlane,
      workspaces: {
        prepare: vi.fn(),
        commitCompleted: vi.fn(),
        recoverCompleted: vi.fn(),
      },
      codex: { execute: vi.fn() },
      completionJournal: journal,
    });

    await expect(runtime.runOnce()).rejects.toMatchObject({
      code: "invalid_lease",
    });
    await expect(journal.load()).resolves.toBeNull();
    expect(journal.conflicts).toHaveLength(1);
    await expect(runtime.runOnce()).resolves.toEqual({ kind: "idle" });
    expect(controlPlane.poll).toHaveBeenCalledOnce();
  });
});
