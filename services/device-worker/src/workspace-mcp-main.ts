#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createWorkspaceMcpServer } from "./workspace-mcp.js";

if (process.argv[2] !== "--workspace" || !process.argv[3]) {
  throw new Error("ForgeX 工作树 MCP 只接受受控工作树参数");
}

const server = await createWorkspaceMcpServer(process.argv[3]);
await server.connect(new StdioServerTransport());
