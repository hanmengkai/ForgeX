import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { McpWorkerAssignment } from "../src/control-plane-client.js";
import {
  OfficialMcpExecutionAdapter,
  canonicalMcpJsonHash,
} from "../src/local-mcp.js";
import { assignmentKey, projectKey, requirementKey } from "./fixtures.js";

const invocationKey = requirementKey;
const connectionBindingKey = "77777777-7777-4777-8777-777777777777";
const inputSchema = {
  type: "object",
  properties: {
    target: { type: "string", title: "目标环境", writeOnly: false },
  },
  required: ["target"],
  additionalProperties: false,
};
const argumentsValue = { target: "production" };

const assignment = (overrides: Record<string, unknown> = {}) =>
  ({
    workKind: "mcp_invocation",
    assignmentKey,
    fencingToken: 7,
    projectKey,
    requirementKey,
    requirementRevision: 1,
    invocationKey,
    title: "发送上线通知",
    leasedUntil: "2026-08-10T10:01:00.000Z",
    execution: {
      connectionBindingKey,
      serviceName: "团队通知",
      toolName: "发送上线通知",
      technicalName: "notifications.send",
      transport: "stdio",
      effect: "external_action",
      serverRevision: 3,
      manifestHashAlgorithm: "sha256",
      manifestHash: "a".repeat(64),
      inputSchemaHashAlgorithm: "sha256",
      inputSchemaHash: canonicalMcpJsonHash(inputSchema),
      argumentsHashAlgorithm: "sha256",
      argumentsHash: canonicalMcpJsonHash(argumentsValue),
      arguments: argumentsValue,
      ...overrides,
    },
  }) as McpWorkerAssignment;

const connection = {
  schemaVersion: 1 as const,
  connectionBindingKey,
  transport: "stdio" as const,
  commandPath: path.resolve("fixtures/mcp-launcher"),
  commandSha256: "b".repeat(64),
  args: [],
  environment: {},
  allowedTools: ["notifications.send"],
  timeoutMs: 30_000,
};

describe("OfficialMcpExecutionAdapter", () => {
  it("按本地连接绑定、可信 Schema 和参数摘要精确执行工具", async () => {
    const callTool = vi.fn(async () => ({ content: [], isError: false }));
    const close = vi.fn(async () => Promise.resolve());
    const connect = vi.fn(async () => ({
      listTools: vi.fn(async () => ({
        tools: [{ name: "notifications.send", inputSchema }],
      })),
      callTool,
      close,
    }));
    const adapter = new OfficialMcpExecutionAdapter({
      connections: [connection],
      connect,
    });

    await expect(
      adapter.execute({ assignment: assignment() }),
    ).resolves.toEqual({
      outcome: "succeeded",
      summary: "本地工具操作已完成",
    });
    expect(connect).toHaveBeenCalledWith(connection, expect.any(AbortSignal));
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "notifications.send",
        arguments: argumentsValue,
        _meta: {
          "forgex/invocationKey": invocationKey,
          "forgex/assignmentKey": assignmentKey,
          "forgex/fencingToken": 7,
        },
      },
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("未知连接、本地工具越权或实际 Schema 漂移时均在调用前失败关闭", async () => {
    const callTool = vi.fn();
    const connect = vi.fn(async () => ({
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "notifications.send",
            inputSchema: { ...inputSchema, required: [] },
          },
        ],
      })),
      callTool,
      close: vi.fn(async () => Promise.resolve()),
    }));
    const adapter = new OfficialMcpExecutionAdapter({
      connections: [connection],
      connect,
    });

    await expect(
      adapter.execute({
        assignment: assignment({ connectionBindingKey: requirementKey }),
      }),
    ).rejects.toThrow("本地连接绑定");
    await expect(adapter.execute({ assignment: assignment() })).rejects.toThrow(
      "参数定义",
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("MCP 明确返回工具错误时形成已知失败结果", async () => {
    const adapter = new OfficialMcpExecutionAdapter({
      connections: [connection],
      connect: async () => ({
        listTools: async () => ({
          tools: [{ name: "notifications.send", inputSchema }],
        }),
        callTool: async () => ({ content: [], isError: true }),
        close: async () => Promise.resolve(),
      }),
    });

    await expect(
      adapter.execute({ assignment: assignment() }),
    ).resolves.toEqual({
      outcome: "failed",
      summary: "本地工具操作未完成",
    });
  });
});
