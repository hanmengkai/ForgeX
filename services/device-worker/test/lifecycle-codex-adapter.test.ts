import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LifecycleWorkflow } from "@forgex/domain";
import { CodexLifecycleAdapter } from "../src/lifecycle-codex-adapter.js";
import { HttpLifecycleAdapter } from "../src/lifecycle-runtime.js";
import { DeviceWorkerProjectSchema } from "../src/config.js";
import type { CodexIsolationRunner } from "../src/codex-isolation.js";

const run = promisify(execFile);
describe("生命周期 Codex 适配边界（合成模型响应）", () => {
  it("需求阶段禁止改代码，开发构建结果必须绑定可信 Git 提交", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-p0-codex-"));
    try {
      const repositoryRoot = path.join(root, "repository");
      await run("git", ["init", "-q", "-b", "main", repositoryRoot]);
      await writeFile(path.join(repositoryRoot, "README.md"), "# 样板\n");
      await run("git", ["-C", repositoryRoot, "add", "README.md"]);
      await run("git", [
        "-C",
        repositoryRoot,
        "-c",
        "user.name=样板",
        "-c",
        "user.email=p0@forgex.local",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-qm",
        "初始化",
      ]);
      const project = DeviceWorkerProjectSchema.parse({
        projectKey: randomUUID(),
        repositoryKey: randomUUID(),
        repositoryRoot,
        worktreeRoot: path.join(root, "worktrees"),
        baseRef: "main",
      });
      const createJob = () =>
        LifecycleWorkflow.create({
          tenantKey: randomUUID(),
          projectKey: project.projectKey,
          repositoryKey: project.repositoryKey,
          requesterKey: randomUUID(),
          title: "访客预约",
          brief: "提交预约并获取编号",
          createdBy: randomUUID(),
        }).claim({
          executorKey: randomUUID(),
          capabilities: ["requirements_ai"],
          leaseMs: 60_000,
        })!;
      const output = {
        kind: "requirements",
        summary: "合成需求响应",
        spec: {
          schemaVersion: 1,
          title: "访客预约",
          goal: "提交预约并获取编号",
          userStories: [],
          acceptanceCriteria: [
            {
              title: "预约返回编号",
              description: "有效预约返回唯一编号",
              priority: "must",
            },
          ],
          openQuestions: [],
        },
      };
      let mutate = false;
      let development = false;
      let wrongCommit = false;
      const runner: CodexIsolationRunner = {
        run: async (input) => {
          expect(input.prompt).toContain("不得访问生产环境");
          expect(input.prompt).toContain(
            development
              ? "构建与测试由可信执行器运行"
              : "仅返回方案，不修改代码",
          );
          expect(input.environment).not.toHaveProperty("CODEX_HOME");
          expect(input.outputSchema).toBeDefined();
          if (development)
            await writeFile(
              path.join(input.workspacePath, "appointment.mjs"),
              "export const appointment = true;\n",
            );
          else if (mutate)
            await writeFile(
              path.join(input.workspacePath, "unexpected.txt"),
              "不应由需求阶段修改",
            );
          return {
            finalResponse: JSON.stringify(
              development
                ? {
                    status: "completed",
                    summary: "合成开发响应，仅声明实现完成",
                  }
                : output,
            ),
            threadId: "合成会话",
          };
        },
      };
      const adapter = new CodexLifecycleAdapter({
        project,
        runner,
        codexHomePath: path.join(root, "codex"),
        authentication: { store: "keyring" },
        protectedPaths: [root],
        pipeline: new HttpLifecycleAdapter({
          endpoint: "https://pipeline.example.test/execute",
          token: "a".repeat(32),
          fetcher: async (_url, options) => {
            if (!development) throw new Error("需求阶段不应调用发布网关");
            const request = JSON.parse(String(options?.body));
            if (request.recoverOnly || request.job.stage !== "development")
              return Response.json({
                status: "blocked",
                reason: "合成网关尚未提供已核对的外部记录",
              });
            const candidate = request.candidate;
            expect(candidate.commitSha).toMatch(/^[a-f0-9]{40}$/u);
            const file = await run("git", [
              "-C",
              candidate.workspacePath,
              "show",
              `${candidate.commitSha}:appointment.mjs`,
            ]);
            expect(file.stdout).toContain("appointment = true");
            return Response.json({
              status: "succeeded",
              output: {
                kind: "code",
                summary: "合成可信网关构建回执",
                commitSha: wrongCommit ? "f".repeat(40) : candidate.commitSha,
                artifactDigest: "a".repeat(64),
                selfTests: [{ name: "合成自测回执", passed: true }],
              },
            });
          },
        }),
      });
      expect(
        await adapter.execute(createJob(), new AbortController().signal),
      ).toMatchObject({ status: "succeeded", output });
      mutate = true;
      await expect(
        adapter.execute(createJob(), new AbortController().signal),
      ).rejects.toThrow("修改了代码");
      const wrong = createJob();
      wrong.input.repositoryKey = randomUUID();
      await expect(
        adapter.execute(wrong, new AbortController().signal),
      ).rejects.toThrow("不属于配置仓库");
      development = true;
      const developmentJob = () => {
        const current = createJob();
        current.stage = "development";
        current.input.stage = "development";
        return current;
      };
      expect(
        await adapter.execute(developmentJob(), new AbortController().signal),
      ).toMatchObject({ status: "succeeded", output: { kind: "code" } });
      wrongCommit = true;
      await expect(
        adapter.execute(developmentJob(), new AbortController().signal),
      ).rejects.toThrow("未绑定可信设备提交");
      expect(
        await adapter.recover(developmentJob(), new AbortController().signal),
      ).toMatchObject({ status: "blocked" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
