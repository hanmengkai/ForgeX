import type { ThreadEvent } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import { terminalLogChunksFromThreadEvent } from "../src/isolation-launcher.js";

describe("terminalLogChunksFromThreadEvent", () => {
  it("把命令及聚合 stdout/stderr 映射为终端打印", () => {
    const started: ThreadEvent = {
      type: "item.started",
      item: {
        id: "command-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "",
        status: "in_progress",
      },
    };
    const completed: ThreadEvent = {
      type: "item.completed",
      item: {
        id: "command-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "PASS unit\nTests: 12 passed\n",
        exit_code: 0,
        status: "completed",
      },
    };

    expect(terminalLogChunksFromThreadEvent(started)).toEqual([
      { stream: "stdout", text: "$ npm test\n" },
    ]);
    expect(terminalLogChunksFromThreadEvent(completed)).toEqual([
      {
        stream: "stdout",
        text: "PASS unit\nTests: 12 passed\n[process exited with code 0]\n",
      },
    ]);
  });

  it("保留工具、文件和错误事件的终端语义且不暴露内部推理", () => {
    const events: ThreadEvent[] = [
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "reasoning-1", type: "reasoning", text: "检查现有组件" },
      },
      {
        type: "item.completed",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          server: "forgex_workspace",
          tool: "search_workspace_text",
          arguments: { query: "TOKEN=secret" },
          result: {
            content: [],
            structured_content: { secret: "do-not-print" },
          },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "file-1",
          type: "file_change",
          changes: [{ path: "src/App.tsx", kind: "update" }],
          status: "completed",
        },
      },
      { type: "error", message: "Authorization: Bearer local-secret-marker" },
    ];

    const chunks = events.flatMap(terminalLogChunksFromThreadEvent);
    expect(chunks).toEqual([
      { stream: "system", text: "[codex] turn started\n" },
      { stream: "system", text: "[codex] reasoning completed\n" },
      {
        stream: "system",
        text: "[tool] forgex_workspace.search_workspace_text completed\n",
      },
      { stream: "system", text: "[file] update src/App.tsx\n" },
      {
        stream: "stderr",
        text: "[error] Authorization: Bearer [REDACTED_SECRET]\n",
      },
    ]);
    expect(JSON.stringify(chunks)).not.toContain("do-not-print");
    expect(JSON.stringify(chunks)).not.toContain("local-secret-marker");
    expect(JSON.stringify(chunks)).not.toContain("检查现有组件");
  });
});
