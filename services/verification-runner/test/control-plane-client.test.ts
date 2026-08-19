import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  RunnerControlPlaneClient,
  RunnerControlPlaneClientError,
} from "../src/index.js";

const target = {
  requirementKey: "60000000-0000-4000-8000-000000000006",
  requirementRevision: 2,
  repositoryKey: "30000000-0000-4000-8000-000000000003",
  gitHashAlgorithm: "sha1" as const,
  commitSha: "a".repeat(40),
  title: "访客预约",
  goal: "让访客可以提前预约",
  acceptanceCriteria: [
    {
      criterionKey: "70000000-0000-4000-8000-000000000007",
      title: "预约成功",
      description: "提交后可以看到预约结果",
      priority: "must" as const,
    },
  ],
  previewArtifact: null,
};

describe("RunnerControlPlaneClient", () => {
  it("使用独立 Runner 会话读取严格验证任务，不携带 Cookie", async () => {
    const fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual({
        Authorization: "Runner runner-session-secret",
        Accept: "application/json",
      });
      return new Response(
        JSON.stringify({ data: [target], meta: { count: 1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new RunnerControlPlaneClient({
      baseUrl: "https://control.example.test",
      sessionKey: "runner-session-secret",
      fetch,
    });

    await expect(client.listPending()).resolves.toEqual([target]);
    expect(fetch).toHaveBeenCalledWith(
      "https://control.example.test/api/v1/runner/verification-targets?limit=20",
      expect.any(Object),
    );
  });

  it("上传原始 Preview 字节的规范 base64 与摘要", async () => {
    const content = new TextEncoder().encode("<html>可信预览</html>");
    const artifactHash = createHash("sha256").update(content).digest("hex");
    const fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: 1,
        requirementRevision: 2,
        artifactHashAlgorithm: "sha256",
        artifactHash,
        contentBase64: Buffer.from(content).toString("base64"),
      });
      return new Response(
        JSON.stringify({
          data: { status: "preview_recorded", requirementRevision: 2 },
        }),
        { status: 200 },
      );
    });
    const client = new RunnerControlPlaneClient({
      baseUrl: "https://control.example.test",
      sessionKey: "runner-session-secret",
      fetch,
    });

    await expect(
      client.publishPreview(target, content, artifactHash),
    ).resolves.toBeUndefined();
  });

  it("接受控制面返回的中文验收进度并结束证据重试", async () => {
    const evidence = {
      payload: {
        schemaVersion: 1 as const,
        evidenceKey: "80000000-0000-4000-8000-000000000008",
        tenantKey: "10000000-0000-4000-8000-000000000001",
        projectKey: "20000000-0000-4000-8000-000000000002",
        repositoryKey: target.repositoryKey,
        requirementKey: target.requirementKey,
        requirementRevision: target.requirementRevision,
        gitHashAlgorithm: target.gitHashAlgorithm,
        commitSha: target.commitSha,
        runnerKey: "40000000-0000-4000-8000-000000000004",
        keyId: "50000000-0000-4000-8000-000000000005",
        producedAt: "2026-08-14T07:00:00.000Z",
        artifactHashAlgorithm: "sha256" as const,
        artifactHash: "b".repeat(64),
        checks: [
          {
            criterionKey: target.acceptanceCriteria[0]!.criterionKey,
            status: "passed" as const,
            testRunKey: "suite-a1",
          },
        ],
      },
      signature: Buffer.alloc(64, 1).toString("base64"),
    };
    const client = new RunnerControlPlaneClient({
      baseUrl: "https://control.example.test",
      sessionKey: "runner-session-secret",
      fetch: vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                status: "等待产品验收",
                acceptanceProgress: "1 / 1 项已通过",
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    });

    await expect(client.submitEvidence(evidence)).resolves.toBeUndefined();
  });

  it("把缺少可信计划作为显式阻塞上报控制面", async () => {
    const fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: 1,
        requirementKey: target.requirementKey,
        requirementRevision: target.requirementRevision,
        reason: "trusted_plan_missing",
        reportedAt: "2026-08-19T02:00:00.000Z",
      });
      return new Response(
        JSON.stringify({
          data: {
            status: "verification_blocked_recorded",
            requirementRevision: target.requirementRevision,
          },
        }),
        { status: 200 },
      );
    });
    const client = new RunnerControlPlaneClient({
      baseUrl: "https://control.example.test",
      sessionKey: "runner-session-secret",
      fetch,
    });

    await expect(
      client.reportBlocker(
        target,
        "trusted_plan_missing",
        "2026-08-19T02:00:00.000Z",
      ),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      `https://control.example.test/api/v1/runner/verification-targets/${target.requirementKey}/blocker`,
      expect.any(Object),
    );
  });

  it("响应结构漂移时使用固定本地错误，不透传远端敏感文本", async () => {
    const client = new RunnerControlPlaneClient({
      baseUrl: "https://control.example.test",
      sessionKey: "runner-session-secret",
      fetch: vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "internal_error",
                message: "Authorization: Bearer LEAK_MARKER",
              },
            }),
            { status: 500 },
          ),
        ),
      ),
    });

    const error = await client.listPending().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RunnerControlPlaneClientError);
    expect(String(error)).not.toContain("LEAK_MARKER");
  });
});
