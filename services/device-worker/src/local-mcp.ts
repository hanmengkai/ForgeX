import { createHash } from "node:crypto";
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
  assertTrustedStdioMcpConnection,
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

const McpServerIdentitySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100),
  })
  .passthrough()
  .transform((identity) => ({
    name: identity.name,
    version: identity.version,
  }));
const McpProtocolVersionSchema = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/u);

export const canonicalMcpServerIdentityHash = (input: unknown): string => {
  const identity = McpServerIdentitySchema.parse(input);
  return createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex");
};

interface BoundMcpClient {
  protocolVersion?: string;
  serverIdentity?: { name: string; version: string };
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

const withoutRemoteErrorDetails = async <Result>(
  publicMessage: string,
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch {
    // MCP 服务端错误可能包含本地凭据或业务数据，不能进入 Worker 日志。
    throw new Error(publicMessage);
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
    return new StdioClientTransport({
      command: connection.commandPath,
      args: connection.args.map((argument) =>
        argument.kind === "literal" ? argument.value : argument.path,
      ),
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
  let protocolVersion: string | undefined;
  const requestClient = client as unknown as {
    request(
      request: { method?: unknown },
      resultSchema: unknown,
      options?: unknown,
    ): Promise<unknown>;
  };
  const originalRequest = requestClient.request.bind(client);
  requestClient.request = async (request, resultSchema, options) => {
    const result = await originalRequest(request, resultSchema, options);
    if (request.method === "initialize") {
      protocolVersion = McpProtocolVersionSchema.parse(
        z.object({ protocolVersion: z.unknown() }).passthrough().parse(result)
          .protocolVersion,
      );
    }
    return result;
  };
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
  const serverIdentity = McpServerIdentitySchema.parse(
    client.getServerVersion(),
  );
  if (!protocolVersion) throw new Error("MCP 没有返回协商协议版本");
  return {
    protocolVersion,
    serverIdentity,
    listTools: (input, options) => client.listTools(input, options),
    callTool: (input, options) => client.callTool(input, undefined, options),
    close: () => client.close(),
  };
};

export interface LocalMcpProbeResult {
  protocolVersion: string;
  serverIdentity: { name: string; version: string };
  tools: Array<{
    technicalName: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export const probeLocalMcpConnection = async (
  connectionInput: DeviceMcpConnection,
  options: {
    signal?: AbortSignal;
    connect?: LocalMcpConnector;
    verifyStdioConnection?: typeof assertTrustedStdioMcpConnection;
  } = {},
): Promise<LocalMcpProbeResult> => {
  const connection = DeviceMcpConnectionSchema.parse(connectionInput);
  if (connection.transport === "stdio") {
    await (options.verifyStdioConnection ?? assertTrustedStdioMcpConnection)(
      connection,
    );
  }
  const signal = options.signal ?? new AbortController().signal;
  const client = await withoutRemoteErrorDetails(
    "本地 MCP 连接失败，服务端详情已隐藏",
    () => (options.connect ?? connectOfficialMcp)(connection, signal),
  );
  try {
    const protocolVersion = McpProtocolVersionSchema.parse(
      client.protocolVersion,
    );
    const serverIdentity = McpServerIdentitySchema.parse(client.serverIdentity);
    const tools: LocalMcpProbeResult["tools"] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await withoutRemoteErrorDetails(
        "本地 MCP 工具清单读取失败，服务端详情已隐藏",
        async () =>
          McpToolListSchema.parse(
            await client.listTools(cursor ? { cursor } : {}, {
              signal,
              timeout: connection.timeoutMs,
              maxTotalTimeout: connection.timeoutMs,
            }),
          ),
      );
      for (const tool of response.tools) {
        const normalizedName = tool.name.toLowerCase();
        if (names.has(normalizedName)) {
          throw new Error("本地 MCP 返回了重复工具");
        }
        names.add(normalizedName);
        tools.push({
          technicalName: tool.name,
          inputSchema: tool.inputSchema,
        });
        if (tools.length > connection.allowedTools.length) {
          throw new Error("本地 MCP 实际工具超过设备允许清单");
        }
      }
      cursor = response.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error("本地 MCP 工具分页游标循环");
      cursors.add(cursor);
      if (page === 19) throw new Error("本地 MCP 工具分页超过设备上限");
    }
    const expected = [...connection.allowedTools]
      .map((name) => name.toLowerCase())
      .sort();
    const observed = [...names].sort();
    if (JSON.stringify(expected) !== JSON.stringify(observed)) {
      throw new Error("本地 MCP 实际工具与设备允许清单不一致");
    }
    return {
      protocolVersion,
      serverIdentity,
      tools: tools.sort((left, right) =>
        left.technicalName < right.technicalName
          ? -1
          : left.technicalName > right.technicalName
            ? 1
            : 0,
      ),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
};

export class OfficialMcpExecutionAdapter implements LocalMcpExecutionAdapter {
  readonly #connections: Map<string, DeviceMcpConnection>;
  readonly #connect: LocalMcpConnector;
  readonly #verifyStdioConnection: typeof assertTrustedStdioMcpConnection;

  constructor(options: {
    connections: DeviceMcpConnection[];
    connect?: LocalMcpConnector;
    verifyStdioConnection?: typeof assertTrustedStdioMcpConnection;
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
    this.#verifyStdioConnection =
      options.verifyStdioConnection ?? assertTrustedStdioMcpConnection;
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
    if (connection.transport === "stdio") {
      await this.#verifyStdioConnection(connection);
    }

    const signal = input.signal ?? new AbortController().signal;
    const client = await withoutRemoteErrorDetails(
      "本地 MCP 连接失败，服务端详情已隐藏",
      () => this.#connect(connection, signal),
    );
    try {
      if (
        client.protocolVersion !== input.assignment.execution.protocolVersion ||
        canonicalMcpServerIdentityHash(client.serverIdentity) !==
          input.assignment.execution.serverIdentityHash
      ) {
        throw new Error("本地 MCP 服务身份或协议与可信任务不一致");
      }
      let cursor: string | undefined;
      let targetSchema: Record<string, unknown> | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < 20; page += 1) {
        const response = await withoutRemoteErrorDetails(
          "本地 MCP 工具清单读取失败，服务端详情已隐藏",
          async () =>
            McpToolListSchema.parse(
              await client.listTools(cursor ? { cursor } : {}, {
                signal,
                timeout: connection.timeoutMs,
                maxTotalTimeout: connection.timeoutMs,
              }),
            ),
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
      const result = await withoutRemoteErrorDetails(
        "本地 MCP 工具调用失败，服务端详情已隐藏",
        async () =>
          McpToolResultSchema.parse(
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
