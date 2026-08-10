import { describe, expect, it, vi } from "vitest";

import {
  WORKER_MCP_UNKNOWN_SUMMARY,
  WORKER_REQUIREMENT_COMPLETION_SUMMARY,
} from "@forgex/contracts";

import { WorkerControlPlaneClient } from "../src/control-plane-client.js";
import { mcpAssignment, requirementAssignment, tenantKey } from "./fixtures.js";

const connection = {
  schemaVersion: 1 as const,
  tenantKey,
  workerKey: "55555555-5555-4555-8555-555555555555",
  sessionKey: "s".repeat(43),
  generation: 3,
};

describe("WorkerControlPlaneClient", () => {
  it("只通过设备认证头出站轮询，并严格校验权威执行信封", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: { assignment: requirementAssignment } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://forgex.example.test",
      connection,
      fetch,
    });

    await expect(client.poll()).resolves.toEqual(requirementAssignment);
    expect(fetch).toHaveBeenCalledWith(
      "https://forgex.example.test/api/v1/worker-connection/poll",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Worker ${connection.sessionKey}`,
          "X-ForgeX-Tenant-Key": tenantKey,
          "X-ForgeX-Worker-Generation": "3",
        }),
        body: "{}",
      }),
    );
  });

  it("执行信封与租约任务不一致时拒绝执行", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                assignment: {
                  ...requirementAssignment,
                  execution: {
                    ...requirementAssignment.execution,
                    requirementRevision: 2,
                  },
                },
              },
            }),
            { status: 200 },
          ),
        ),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://forgex.example.test",
      connection,
      fetch,
    });
    await expect(client.poll()).rejects.toMatchObject({
      statusCode: 502,
      code: "invalid_response",
    });
  });

  it("只上报与权威任务绑定的仓库提交结果", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { alreadyCompleted: false } }), {
            status: 200,
          }),
        ),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://forgex.example.test",
      connection,
      fetch,
    });
    await client.completeRequirement(
      {
        assignmentKey: requirementAssignment.assignmentKey,
        fencingToken: requirementAssignment.fencingToken,
        title: requirementAssignment.title,
        projectKey: requirementAssignment.projectKey,
        repositoryKey: requirementAssignment.execution.repositoryKey,
        requirementKey: requirementAssignment.requirementKey,
        requirementRevision: requirementAssignment.requirementRevision,
      },
      {
        summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
        branchName: `forgex/${requirementAssignment.projectKey.slice(0, 8)}/${requirementAssignment.assignmentKey}`,
        baseCommit: "a".repeat(40),
        commitSha: "b".repeat(40),
        gitHashAlgorithm: "sha1",
      },
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      projectKey: requirementAssignment.projectKey,
      repositoryKey: requirementAssignment.execution.repositoryKey,
      requirementKey: requirementAssignment.requirementKey,
      baseCommit: "a".repeat(40),
      commitSha: "b".repeat(40),
    });
  });

  it("非只读 MCP 崩溃恢复时上报与项目、调用和租约绑定的结果未知", async () => {
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { alreadyCompleted: false } }), {
          status: 200,
        }),
      ),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://forgex.example.test",
      connection,
      fetch,
    });

    await client.completeMcp(
      {
        assignmentKey: mcpAssignment.assignmentKey,
        fencingToken: mcpAssignment.fencingToken,
        projectKey: mcpAssignment.projectKey,
        invocationKey: mcpAssignment.invocationKey,
      },
      { outcome: "unknown", summary: WORKER_MCP_UNKNOWN_SUMMARY },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://forgex.example.test/api/v1/worker-connection/mcp-complete",
      expect.objectContaining({
        body: expect.stringContaining('"outcome":"unknown"'),
      }),
    );
  });

  it("黑洞请求会在租约续租间隔前超时", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://forgex.example.test",
      connection,
      requestTimeoutMs: 100,
      fetch,
    });

    await expect(client.heartbeat()).rejects.toMatchObject({
      statusCode: 504,
      code: "request_timeout",
    });
  });

  it("响应体按字节流限制，超过上限时立即停止读取", async () => {
    const chunk = new Uint8Array(600_000);
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://forgex.example.test",
      connection,
      fetch,
    });

    await expect(client.heartbeat()).rejects.toMatchObject({
      statusCode: 502,
      code: "response_too_large",
    });
  });
});
