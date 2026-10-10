import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { CurrentUserCodexRunner } from "../src/current-user-codex.js";

describe.skipIf(process.platform !== "darwin")(
  "生命周期当前用户 CLI 回执协议（合成进程，不调用模型）",
  () => {
    it("仅接受完整回合；重连提示不会当作成功或立即失败；异常与登录失败拒绝", async () => {
      const root = await mkdtemp(
        path.join(await realpath(os.tmpdir()), "forgex-cli-protocol-"),
      );
      const scenarios = [
        {
          lines: [
            { type: "thread.started", thread_id: "合成会话" },
            { type: "error", message: "Reconnecting... 1/5 (timeout)" },
            {
              type: "item.completed",
              item: { type: "agent_message", text: '{"summary":"合成响应"}' },
            },
            { type: "turn.completed", usage: {} },
          ],
          success: true,
        },
        {
          lines: [
            { type: "thread.started", thread_id: "合成会话" },
            {
              type: "item.completed",
              item: { type: "agent_message", text: '{"summary":"合成响应"}' },
            },
            { type: "turn.completed", usage: {} },
          ],
          splitBytes: true,
          success: true,
        },
        {
          lines: [
            {
              type: "turn.failed",
              error: { message: "401 unauthorized secret-token" },
            },
          ],
          error: "登录不可用",
        },
        {
          lines: [{ type: "turn.failed", error: { message: "调用失败" } }],
          error: "推理回合失败",
        },
        { lines: ["无效 JSON"], error: "协议无效" },
        { lines: [], error: "未完成结构化响应" },
        { lines: ["x".repeat(4 * 1024 * 1024 + 1)], error: "安全上限" },
        { lines: [], emitError: true, error: "无法启动" },
      ];
      try {
        for (const scenario of scenarios) {
          const launcher = ((
            command: unknown,
            args: unknown,
            options: unknown,
          ) => {
            expect(command).toBe("/usr/bin/sandbox-exec");
            expect(args).toEqual(
              expect.arrayContaining([
                "--ignore-user-config",
                "--ignore-rules",
                "features.shell_tool=false",
                "features.hooks=true",
              ]),
            );
            expect((options as { env: unknown }).env).not.toHaveProperty(
              "OPENAI_API_KEY",
            );
            const child = Object.assign(new EventEmitter(), {
              stdin: new PassThrough(),
              stdout: new PassThrough(),
              stderr: new PassThrough(),
              kill: () => true,
            });
            child.stdin.on("finish", () =>
              setImmediate(() => {
                if (scenario.emitError) {
                  child.emit("error", new Error("合成启动失败"));
                  return;
                }
                for (const item of scenario.lines) {
                  const bytes = Buffer.from(
                    typeof item === "string"
                      ? item + "\n"
                      : JSON.stringify(item) + "\n",
                  );
                  if (scenario.splitBytes)
                    for (const byte of bytes)
                      child.stdout.emit("data", Buffer.from([byte]));
                  else child.stdout.emit("data", bytes);
                }
                child.emit("close", 0);
              }),
            );
            return child;
          }) as unknown as typeof spawn;
          const input = {
            workspacePath: root,
            codexHomePath: root,
            protectedPaths: [],
            prompt: "合成协议测试",
            outputSchema: { type: "object" },
            reasoningEffort: "low" as const,
            environment: {},
            signal: new AbortController().signal,
          };
          // 登录目录必须位于工作树外，两个目录均仅用于测试。
          const workspace = await mkdtemp(
            path.join(await realpath(os.tmpdir()), "forgex-cli-workspace-"),
          );
          input.workspacePath = workspace;
          try {
            const result = new CurrentUserCodexRunner(launcher).run(input);
            if (scenario.success)
              expect(await result).toEqual({
                threadId: "合成会话",
                finalResponse: '{"summary":"合成响应"}',
              });
            else await expect(result).rejects.toThrow(scenario.error);
          } finally {
            await rm(workspace, { recursive: true, force: true });
          }
        }
        await expect(
          new CurrentUserCodexRunner().run({
            workspacePath: root,
            codexHomePath: root,
            protectedPaths: [],
            prompt: "合成",
            outputSchema: {},
            reasoningEffort: "low",
            environment: {},
          }),
        ).rejects.toThrow("登录目录不能位于");
        const guardedWorkspace = await mkdtemp(
          path.join(await realpath(os.tmpdir()), "forgex-cli-hooks-"),
        );
        try {
          await writeFile(path.join(root, "hooks.json"), "{}");
          await expect(
            new CurrentUserCodexRunner().run({
              workspacePath: guardedWorkspace,
              codexHomePath: root,
              protectedPaths: [],
              prompt: "不应调用模型",
              outputSchema: {},
              reasoningEffort: "low",
              environment: {},
            }),
          ).rejects.toThrow("其他 Hooks");
        } finally {
          await rm(guardedWorkspace, { recursive: true, force: true });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
  },
);
