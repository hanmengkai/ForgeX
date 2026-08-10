import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpWorkerAssignment } from "../src/control-plane-client.js";
import { assertTrustedStdioMcpConnection } from "../src/config.js";
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
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("OfficialMcpExecutionAdapter", () => {
  it("通过官方 MCP stdio 协议执行精确绑定的本地工具", async () => {
    const commandPath = process.execPath;
    const commandSha256 = createHash("sha256")
      .update(await readFile(commandPath))
      .digest("hex");
    const sourceFixturePath = fileURLToPath(
      new URL("./mcp-stdio-fixture.mjs", import.meta.url),
    );
    const fixtureContent = await readFile(sourceFixturePath, "utf8");
    const root = await mkdtemp(
      path.join(path.dirname(sourceFixturePath), ".tmp-mcp-stdio-"),
    );
    temporaryRoots.push(root);
    const fixturePath = path.join(root, "mcp-server.mjs");
    await writeFile(fixturePath, fixtureContent, "utf8");
    const fixtureSha256 = createHash("sha256")
      .update(fixtureContent, "utf8")
      .digest("hex");
    const adapter = new OfficialMcpExecutionAdapter({
      connections: [
        {
          ...connection,
          commandPath,
          commandSha256,
          args: [
            {
              kind: "trusted_file",
              path: fixturePath,
              sha256: fixtureSha256,
            },
          ],
          timeoutMs: 10_000,
        },
      ],
      verifyStdioConnection: (stdioConnection) =>
        assertTrustedStdioMcpConnection(stdioConnection, {
          platform: "win32",
          assertWindowsTrustedLauncherPath: async () => Promise.resolve(),
        }),
    });

    await expect(
      adapter.execute({ assignment: assignment() }),
    ).resolves.toEqual({
      outcome: "succeeded",
      summary: "本地工具操作已完成",
    });

    await writeFile(fixturePath, `${fixtureContent}\n// tampered\n`, "utf8");
    await expect(adapter.execute({ assignment: assignment() })).rejects.toThrow(
      "MCP 参数文件内容与配置的可信摘要不一致",
    );
  });

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
      verifyStdioConnection: async () => Promise.resolve(),
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
      verifyStdioConnection: async () => Promise.resolve(),
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
      verifyStdioConnection: async () => Promise.resolve(),
    });

    await expect(
      adapter.execute({ assignment: assignment() }),
    ).resolves.toEqual({
      outcome: "failed",
      summary: "本地工具操作未完成",
    });
  });

  it("不会把 MCP 连接与工具清单异常中的敏感信息带出设备边界", async () => {
    const marker = "Authorization: Bearer local-mcp-secret-marker";
    const connectionFailure = new OfficialMcpExecutionAdapter({
      connections: [connection],
      connect: async () => {
        throw new Error(marker);
      },
      verifyStdioConnection: async () => Promise.resolve(),
    });

    const connectionError = await connectionFailure
      .execute({ assignment: assignment() })
      .catch((error: unknown) => error);
    expect(connectionError).toMatchObject({
      message: "本地 MCP 连接失败，服务端详情已隐藏",
    });
    expect(String(connectionError)).not.toContain(marker);

    const toolListFailure = new OfficialMcpExecutionAdapter({
      connections: [connection],
      connect: async () => ({
        listTools: async () => {
          throw new Error(marker);
        },
        callTool: async () => ({ content: [], isError: false }),
        close: async () => Promise.resolve(),
      }),
      verifyStdioConnection: async () => Promise.resolve(),
    });

    const listError = await toolListFailure
      .execute({ assignment: assignment() })
      .catch((error: unknown) => error);
    expect(listError).toMatchObject({
      message: "本地 MCP 工具清单读取失败，服务端详情已隐藏",
    });
    expect(String(listError)).not.toContain(marker);
  });

  it("真实 MCP 协议错误不得把服务端敏感信息写入 Worker 错误", async () => {
    const marker = "Authorization: Bearer local-mcp-secret-marker";
    const commandPath = process.execPath;
    const commandSha256 = createHash("sha256")
      .update(await readFile(commandPath))
      .digest("hex");
    const sourceFixturePath = fileURLToPath(
      new URL("./mcp-stdio-fixture.mjs", import.meta.url),
    );
    const fixtureContent = await readFile(sourceFixturePath, "utf8");
    const root = await mkdtemp(
      path.join(path.dirname(sourceFixturePath), ".tmp-mcp-error-"),
    );
    temporaryRoots.push(root);
    const fixturePath = path.join(root, "mcp-server.mjs");
    await writeFile(fixturePath, fixtureContent, "utf8");
    const fixtureSha256 = createHash("sha256")
      .update(fixtureContent, "utf8")
      .digest("hex");
    const adapter = new OfficialMcpExecutionAdapter({
      connections: [
        {
          ...connection,
          commandPath,
          commandSha256,
          args: [
            {
              kind: "trusted_file",
              path: fixturePath,
              sha256: fixtureSha256,
            },
          ],
          timeoutMs: 10_000,
        },
      ],
      verifyStdioConnection: (stdioConnection) =>
        assertTrustedStdioMcpConnection(stdioConnection, {
          platform: "win32",
          assertWindowsTrustedLauncherPath: async () => Promise.resolve(),
        }),
    });
    const errorArguments = { target: "error" };

    const error = await adapter
      .execute({
        assignment: assignment({
          arguments: errorArguments,
          argumentsHash: canonicalMcpJsonHash(errorArguments),
        }),
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "本地 MCP 工具调用失败，服务端详情已隐藏",
    });
    expect(String(error)).not.toContain(marker);
  });
});
