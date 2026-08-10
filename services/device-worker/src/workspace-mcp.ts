import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WorkspaceAccess } from "./workspace-access.js";

const toolError = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: error instanceof Error ? error.message : "工作树读取失败",
    },
  ],
  isError: true,
});

export const createWorkspaceMcpServer = async (
  workspacePath: string,
): Promise<McpServer> => {
  const workspace = await WorkspaceAccess.open(workspacePath);
  const server = new McpServer(
    { name: "forgex-workspace-reader", version: "0.1.0" },
    {
      instructions:
        "只用于读取当前 ForgeX 任务工作树。不要请求凭据、Git 内部数据或工作树外路径。修改文件请使用 Codex 内置 apply_patch。",
    },
  );

  server.registerTool(
    "list_workspace",
    {
      title: "查看项目文件",
      description:
        "列出当前任务工作树内的文件和目录，自动隐藏凭据与 Git 内部路径。",
      inputSchema: z
        .object({
          path: z.string().max(500).default("."),
          depth: z.number().int().min(1).max(4).default(2),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        return {
          content: [{ type: "text", text: await workspace.list(input) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "read_workspace_file",
    {
      title: "读取项目文件",
      description:
        "按行读取当前任务工作树内的单个文本文件；不读取凭据、Git 内部路径、符号链接或大文件。",
      inputSchema: z
        .object({
          path: z.string().min(1).max(500),
          startLine: z.number().int().min(1).max(1_000_000).default(1),
          maxLines: z.number().int().min(1).max(500).default(300),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        return {
          content: [{ type: "text", text: await workspace.readFile(input) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "search_workspace_text",
    {
      title: "搜索项目文字",
      description:
        "在当前任务工作树的文本文件中做有界的字面量搜索，不执行正则表达式或外部命令。",
      inputSchema: z
        .object({
          query: z.string().min(1).max(100),
          path: z.string().max(500).default("."),
          caseSensitive: z.boolean().default(false),
          maxMatches: z.number().int().min(1).max(200).default(100),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        return {
          content: [{ type: "text", text: await workspace.search(input) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
};
