import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RequirementExecutionLogWriter,
  sanitizeExecutionLogText,
} from "../src/execution-log.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("RequirementExecutionLogWriter", () => {
  it("把日志写到 worktree 根目录下的需求专属目录，不进入业务工作树", async () => {
    const worktreeRoot = await mkdtemp(
      path.join(os.tmpdir(), "forgex-worker-log-"),
    );
    roots.push(worktreeRoot);
    const assignmentKey = "44444444-4444-4444-8444-444444444444";
    const writer = await RequirementExecutionLogWriter.open({
      worktreeRoot,
      assignmentKey,
    });

    await writer.append({
      occurredAt: "2026-08-14T01:00:00.000Z",
      stream: "stdout",
      text: "npm test\nall passed\n",
    });

    expect(writer.filePath).toBe(
      path.join(
        worktreeRoot,
        ".forgex-execution-logs",
        assignmentKey,
        "execution.log",
      ),
    );
    expect(await readFile(writer.filePath, "utf8")).toBe(
      "[2026-08-14T01:00:00.000Z] [stdout] npm test\n" +
        "[2026-08-14T01:00:00.000Z] [stdout] all passed\n",
    );
  });

  it("持久化前脱敏常见凭据和私钥", () => {
    const original = [
      "Authorization: Bearer local-secret-marker",
      'api_key = "actual-secret-value-123456"',
      "-----BEGIN PRIVATE KEY-----",
      "private-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const sanitized = sanitizeExecutionLogText(original);

    expect(sanitized).toContain("[REDACTED_SECRET]");
    expect(sanitized).not.toContain("local-secret-marker");
    expect(sanitized).not.toContain("actual-secret-value-123456");
    expect(sanitized).not.toContain("private-material");
  });
});
