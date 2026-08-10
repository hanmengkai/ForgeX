import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import {
  WORKER_MCP_FAILED_SUMMARY,
  WORKER_MCP_SUCCEEDED_SUMMARY,
} from "@forgex/contracts";

import type { McpWorkerAssignment } from "./control-plane-client.js";
import {
  DeviceMcpConnectionSchema,
  type DeviceMcpConnection,
} from "./config.js";
import type { LocalMcpExecutionAdapter } from "./runtime.js";

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const canonicalJson = (
  input: unknown,
  maxBytes: number,
  depth = 1,
  state = { nodes: 0 },
): string => {
  const copy = (value: unknown, currentDepth: number): unknown => {
    if (currentDepth > MAX_JSON_DEPTH) {
      throw new Error("MCP 本地校验内容层级过深");
    }
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES) {
      throw new Error("MCP 本地校验内容过于复杂");
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("MCP JSON 数值必须有限");
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => copy(item, currentDepth + 1));
    }
    if (!isPlainObject(value)) {
      throw new Error("MCP 本地校验内容必须是 JSON");
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      if (key.length > 256 || value[key] === undefined) {
        throw new Error("MCP JSON 字段不符合边界");
      }
      result[key] = copy(value[key], currentDepth + 1);
    }
    return result;
  };
  const json = JSON.stringify(copy(input, depth));
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error("MCP 本地校验内容超过大小上限");
  }
  return json;
};

export const canonicalMcpJsonHash = (
  input: unknown,
  maxBytes = MAX_ARGUMENT_BYTES,
): string =>
  createHash("sha256")
    .update(canonicalJson(input, maxBytes), "utf8")
    .digest("hex");

const McpToolListSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            inputSchema: z.record(z.string(), z.unknown()),
          })
          .passthrough(),
      )
      .max(500),
    nextCursor: z.string().min(1).max(1_000).optional(),
  })
  .passthrough();

const McpToolResultSchema = z
  .object({
    content: z.array(z.unknown()).max(1_000),
    isError: z.boolean().optional(),
  })
  .passthrough();

interface BoundMcpClient {
  listTools(
    input: { cursor?: string },
    options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number },
  ): Promise<unknown>;
  callTool(
    input: {
      name: string;
      arguments: Record<string, unknown>;
      _meta: Record<string, string | number>;
    },
    options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type LocalMcpConnector = (
  connection: DeviceMcpConnection,
  signal: AbortSignal,
) => Promise<BoundMcpClient>;

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

const assertTrustedStdioCommand = async (
  connection: Extract<DeviceMcpConnection, { transport: "stdio" }>,
): Promise<void> => {
  const configured = path.normalize(path.resolve(connection.commandPath));
  const metadata = await lstat(configured);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > 128 * 1024 * 1024 ||
    !samePath(path.normalize(await realpath(configured)), configured)
  ) {
    throw new Error("本地 MCP 启动器必须是可信普通文件");
  }
  const digest = createHash("sha256")
    .update(await readFile(configured))
    .digest("hex");
  if (digest !== connection.commandSha256) {
    throw new Error("本地 MCP 启动器与配置摘要不一致");
  }
};

const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_MCP_RESPONSE_BYTES
  ) {
    throw new Error("本地 MCP 返回内容超过设备上限");
  }
  if (!response.body) return response;
  let received = 0;
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      if (received > MAX_MCP_RESPONSE_BYTES) {
        await reader.cancel("mcp_response_too_large");
        controller.error(new Error("本地 MCP 返回内容超过设备上限"));
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(stream, response);
};

const transportFor = async (
  connection: DeviceMcpConnection,
): Promise<Transport> => {
  if (connection.transport === "stdio") {
    await assertTrustedStdioCommand(connection);
    return new StdioClientTransport({
      command: connection.commandPath,
      args: connection.args,
      env: {
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
        ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
        ...connection.environment,
      },
      stderr: "ignore",
      cwd: connection.workingDirectory ?? path.dirname(connection.commandPath),
      maxBufferSize: MAX_MCP_RESPONSE_BYTES,
    });
  }
  return new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: {
      headers: connection.headers,
      redirect: "error",
    },
    fetch: boundedFetch,
    reconnectionOptions: {
      maxReconnectionDelay: 1_000,
      initialReconnectionDelay: 250,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  }) as unknown as Transport;
};

const connectOfficialMcp: LocalMcpConnector = async (connection, signal) => {
  const client = new Client(
    { name: "forgex-device-worker", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = await transportFor(connection);
  try {
    await client.connect(transport, {
      signal,
      timeout: connection.timeoutMs,
      maxTotalTimeout: connection.timeoutMs,
    });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
  return {
    listTools: (input, options) => client.listTools(input, options),
    callTool: (input, options) => client.callTool(input, undefined, options),
    close: () => client.close(),
  };
};

export class OfficialMcpExecutionAdapter implements LocalMcpExecutionAdapter {
  readonly #connections: Map<string, DeviceMcpConnection>;
  readonly #connect: LocalMcpConnector;

  constructor(options: {
    connections: DeviceMcpConnection[];
    connect?: LocalMcpConnector;
  }) {
    const connections = z
      .array(DeviceMcpConnectionSchema)
      .max(50)
      .parse(options.connections);
    this.#connections = new Map(
      connections.map((connection) => [
        connection.connectionBindingKey,
        connection,
      ]),
    );
    if (this.#connections.size !== connections.length) {
      throw new Error("本地 MCP 连接绑定不能重复");
    }
    this.#connect = options.connect ?? connectOfficialMcp;
  }

  async execute(input: {
    assignment: McpWorkerAssignment;
    signal?: AbortSignal;
  }): Promise<{ outcome: "succeeded" | "failed"; summary: string }> {
    const connection = this.#connections.get(
      input.assignment.execution.connectionBindingKey,
    );
    if (!connection) throw new Error("设备找不到任务要求的本地连接绑定");
    if (connection.transport !== input.assignment.execution.transport) {
      throw new Error("本地 MCP 传输与可信任务不一致");
    }
    if (
      !connection.allowedTools.includes(
        input.assignment.execution.technicalName,
      )
    ) {
      throw new Error("本地 MCP 工具不在设备允许清单中");
    }
    if (
      canonicalMcpJsonHash(
        input.assignment.execution.arguments,
        MAX_ARGUMENT_BYTES,
      ) !== input.assignment.execution.argumentsHash
    ) {
      throw new Error("本地 MCP 参数与可信摘要不一致");
    }

    const signal = input.signal ?? new AbortController().signal;
    const client = await this.#connect(connection, signal);
    try {
      let cursor: string | undefined;
      let targetSchema: Record<string, unknown> | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < 20; page += 1) {
        const response = McpToolListSchema.parse(
          await client.listTools(cursor ? { cursor } : {}, {
            signal,
            timeout: connection.timeoutMs,
            maxTotalTimeout: connection.timeoutMs,
          }),
        );
        for (const tool of response.tools) {
          if (tool.name === input.assignment.execution.technicalName) {
            if (targetSchema) {
              throw new Error("本地 MCP 返回了重复的目标工具");
            }
            targetSchema = tool.inputSchema;
          }
        }
        cursor = response.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor)) throw new Error("本地 MCP 工具分页游标循环");
        cursors.add(cursor);
      }
      if (!targetSchema) throw new Error("本地 MCP 没有可信任务要求的工具");
      if (
        canonicalMcpJsonHash(targetSchema, MAX_SCHEMA_BYTES) !==
        input.assignment.execution.inputSchemaHash
      ) {
        throw new Error("本地 MCP 工具参数定义与可信任务不一致");
      }
      const result = McpToolResultSchema.parse(
        await client.callTool(
          {
            name: input.assignment.execution.technicalName,
            arguments: input.assignment.execution.arguments,
            _meta: {
              "forgex/invocationKey": input.assignment.invocationKey,
              "forgex/assignmentKey": input.assignment.assignmentKey,
              "forgex/fencingToken": input.assignment.fencingToken,
            },
          },
          {
            signal,
            timeout: connection.timeoutMs,
            maxTotalTimeout: connection.timeoutMs,
          },
        ),
      );
      return result.isError === true
        ? { outcome: "failed", summary: WORKER_MCP_FAILED_SUMMARY }
        : { outcome: "succeeded", summary: WORKER_MCP_SUCCEEDED_SUMMARY };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
