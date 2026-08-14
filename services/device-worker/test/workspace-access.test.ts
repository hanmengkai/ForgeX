import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceAccess } from "../src/workspace-access.js";
import { createWorkspaceMcpServer } from "../src/workspace-mcp.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const workspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forgex-workspace-mcp-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "feature.ts"),
    "export const greeting = 'hello';\nexport const count = 2;\n",
    "utf8",
  );
  await writeFile(path.join(root, ".env"), "TOKEN=must-not-leak", "utf8");
  await writeFile(
    path.join(root, ".env.example"),
    "TOKEN=<YOUR_TOKEN>",
    "utf8",
  );
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "config"), "secret", "utf8");
  return { root, access: await WorkspaceAccess.open(root) };
};

describe("WorkspaceAccess", () => {
  it("通过官方 MCP 协议只暴露四个受控工作树工具", async () => {
    const { root } = await workspace();
    const server = await createWorkspaceMcpServer(root);
    const client = new Client({ name: "forgex-test", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "list_workspace",
        "read_workspace_file",
        "search_workspace_text",
        "write_workspace_file",
      ]);
      const result = await client.callTool({
        name: "read_workspace_file",
        arguments: { path: "src/feature.ts", startLine: 1, maxLines: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("greeting"),
          }),
        ]),
      );

      const denied = await client.callTool({
        name: "read_workspace_file",
        arguments: { path: ".env" },
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("凭据"),
          }),
        ]),
      );

      const written = await client.callTool({
        name: "write_workspace_file",
        arguments: {
          path: "src/generated.ts",
          content: "export const generated = true;\n",
        },
      });
      expect(written.isError).not.toBe(true);
      await expect(
        readFile(path.join(root, "src/generated.ts"), "utf8"),
      ).resolves.toBe("export const generated = true;\n");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("只向 Codex 返回当前工作树的普通业务文本", async () => {
    const { access } = await workspace();

    await expect(
      access.readFile({ path: "src/feature.ts", startLine: 2, maxLines: 1 }),
    ).resolves.toBe("2: export const count = 2;");
    await expect(access.list({ depth: 2 })).resolves.toContain(".env [受保护]");
    await expect(access.list({ depth: 2 })).resolves.toContain(".env.example");
    await expect(access.list({ depth: 2 })).resolves.toContain(".git [受保护]");
    await expect(
      access.search({ query: "greeting", maxMatches: 10 }),
    ).resolves.toContain("src/feature.ts:1");
  });

  it("拒绝路径穿越、凭据文件和通过目录链接读取外部文件", async () => {
    const { root, access } = await workspace();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "forgex-workspace-outside-"),
    );
    roots.push(outside);
    await writeFile(path.join(outside, "data.txt"), "outside-secret", "utf8");
    await symlink(outside, path.join(root, "linked"), "junction");

    await expect(access.readFile({ path: "../data.txt" })).rejects.toThrow(
      "相对路径",
    );
    await expect(access.readFile({ path: ".env" })).rejects.toThrow("凭据");
    await expect(access.readFile({ path: ".GIT/config" })).rejects.toThrow(
      "Git 内部数据",
    );
    await expect(access.readFile({ path: "CON" })).rejects.toThrow(
      "Git 内部数据",
    );
    await expect(access.readFile({ path: "linked/data.txt" })).rejects.toThrow(
      "工作树外",
    );
    await expect(
      access.search({ query: "outside-secret", path: "linked" }),
    ).rejects.toThrow("工作树外");
    await expect(access.list({ depth: 1 })).resolves.toContain(
      "linked [符号链接已忽略]",
    );
  });

  it("只原子写入工作树内的普通业务文本", async () => {
    const { root, access } = await workspace();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "forgex-workspace-write-outside-"),
    );
    roots.push(outside);
    await symlink(outside, path.join(root, "write-linked"), "junction");

    await expect(
      access.writeFile({
        path: "generated/nested/result.txt",
        content: "first\n",
      }),
    ).resolves.toBe("已写入 generated/nested/result.txt（6 字节）");
    await expect(
      access.writeFile({
        path: "generated/nested/result.txt",
        content: "second\n",
      }),
    ).resolves.toBe("已写入 generated/nested/result.txt（7 字节）");
    await expect(
      readFile(path.join(root, "generated/nested/result.txt"), "utf8"),
    ).resolves.toBe("second\n");
    await expect(
      access.writeFile({ path: ".env", content: "TOKEN=blocked" }),
    ).rejects.toThrow("凭据");
    await expect(
      access.writeFile({ path: "../outside.txt", content: "blocked" }),
    ).rejects.toThrow("相对路径");
    await expect(
      access.writeFile({ path: "write-linked/outside.txt", content: "no" }),
    ).rejects.toThrow("符号链接");
    await expect(
      access.writeFile({
        path: "too-large.txt",
        content: "x".repeat(1_048_577),
      }),
    ).rejects.toThrow("1 MiB");
  });
});
