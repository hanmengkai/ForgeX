import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileWorkerCompletionJournal } from "../src/completion-journal.js";
import {
  assignmentKey,
  mcpAssignment,
  projectKey,
  repositoryKey,
  requirementKey,
} from "./fixtures.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("FileWorkerCompletionJournal", () => {
  it("持久化 MCP 开始意图，并只允许同一租约升级为已知结果或结果未知", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-journal-"));
    temporaryRoots.push(root);
    const journal = new FileWorkerCompletionJournal(
      path.join(root, "completion.json"),
    );
    const intent = {
      schemaVersion: 1 as const,
      kind: "mcp_invocation_started" as const,
      assignment: mcpAssignment,
    };

    await journal.saveMcpIntent(intent);
    await expect(journal.load()).resolves.toEqual(intent);
    await journal.save({
      schemaVersion: 1,
      kind: "mcp_invocation",
      assignment: {
        assignmentKey: mcpAssignment.assignmentKey,
        fencingToken: mcpAssignment.fencingToken,
        title: mcpAssignment.title,
        projectKey: mcpAssignment.projectKey,
        invocationKey: mcpAssignment.invocationKey,
      },
      result: {
        outcome: "unknown",
        summary: "本地工具操作结果需要人工核对",
      },
    });
    await expect(journal.load()).resolves.toMatchObject({
      kind: "mcp_invocation",
      result: { outcome: "unknown" },
    });
    await journal.clear();
    await expect(journal.load()).resolves.toBeNull();
  }, 15_000);

  it("原子保存并恢复待确认提交，成功后清除", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-journal-"));
    temporaryRoots.push(root);
    const journal = new FileWorkerCompletionJournal(
      path.join(root, "state", "completion.json"),
    );
    const completion = {
      schemaVersion: 1 as const,
      kind: "requirement_delivery" as const,
      assignment: {
        assignmentKey,
        fencingToken: 7,
        title: "访客预约",
        projectKey,
        repositoryKey,
        requirementKey,
        requirementRevision: 1,
      },
      result: {
        summary: "完成访客预约",
        branchName: `forgex/${projectKey.slice(0, 8)}/${assignmentKey}`,
        baseCommit: "a".repeat(40),
        commitSha: "b".repeat(40),
        gitHashAlgorithm: "sha1" as const,
      },
    };

    await journal.save(completion);
    await expect(journal.load()).resolves.toEqual(completion);
    await expect(journal.save(completion)).resolves.toBeUndefined();
    await expect(
      journal.save({
        ...completion,
        result: { ...completion.result, commitSha: "c".repeat(40) },
      }),
    ).rejects.toThrow("不能被另一项结果覆盖");
    await expect(journal.load()).resolves.toEqual(completion);
    await writeFile(
      path.join(root, "state", "completion.json.intent"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "requirement_commit_pending",
        assignment: completion.assignment,
        workspace: {
          path: path.join(root, "worktree"),
          branchName: completion.result.branchName,
          baseCommit: completion.result.baseCommit,
        },
        summary: completion.result.summary,
      }),
      "utf8",
    );
    await expect(journal.load()).resolves.toEqual(completion);
    await journal.clear();
    await expect(journal.load()).resolves.toBeNull();
  });

  it("提交意图使用原子文件，遗留的截断临时文件不会覆盖有效状态", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-journal-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "completion.json");
    const journal = new FileWorkerCompletionJournal(filePath);
    const intent = {
      schemaVersion: 1 as const,
      kind: "requirement_commit_pending" as const,
      assignment: {
        assignmentKey,
        fencingToken: 7,
        title: "访客预约",
        projectKey,
        repositoryKey,
        requirementKey,
        requirementRevision: 1,
      },
      workspace: {
        path: path.join(root, "worktree"),
        branchName: `forgex/${projectKey.slice(0, 8)}/${assignmentKey}`,
        baseCommit: "a".repeat(40),
      },
      summary: "完成访客预约",
    };
    await journal.saveCommitIntent(intent);
    await writeFile(`${filePath}.intent.interrupted.tmp`, "{", "utf8");

    await expect(journal.load()).resolves.toEqual(intent);
  });
});
