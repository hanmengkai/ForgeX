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
