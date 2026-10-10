import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { describe, it, expect } from "vitest";
import { LifecycleWorkflow } from "@forgex/domain";
import type {
  LifecycleArtifact,
  LifecycleJob,
  LifecycleOutput,
} from "@forgex/contracts/lifecycle";
import { SampleLifecycleAdapter } from "../src/lifecycle-sample-adapter.js";
import {
  CodexLifecycleAdapter,
  type LifecycleTestPlan,
} from "../src/lifecycle-codex-adapter.js";
import type { CodexIsolationRunner } from "../src/codex-isolation.js";

const signal = () => new AbortController().signal;
const artifact = (output: LifecycleOutput): LifecycleArtifact => ({
  artifactKey: randomUUID(),
  jobKey: randomUUID(),
  executorKey: randomUUID(),
  createdAt: new Date().toISOString(),
  contentDigest: "a".repeat(64),
  output,
});
const createJob = (): LifecycleJob =>
  LifecycleWorkflow.create({
    tenantKey: randomUUID(),
    projectKey: randomUUID(),
    repositoryKey: randomUUID(),
    requesterKey: randomUUID(),
    createdBy: randomUUID(),
    title: "访客预约",
    brief: "提交预约并获取编号",
  }).claim({
    executorKey: randomUUID(),
    capabilities: ["requirements_ai"],
    leaseMs: 60000,
  })!;
const stage = (job: LifecycleJob, next: LifecycleJob["stage"]) => {
  job.stage = next;
  job.input.stage = next;
  return job;
};
const plan: LifecycleTestPlan = {
  schemaVersion: 1,
  summary: "合成计划仅指定探针，结果由真实执行产生",
  probes: ["create", "invalid", "idempotency", "query"].map(
    (probe, criterionIndex) => ({
      criterionIndex,
      probe: probe as "create" | "invalid" | "idempotency" | "query",
    }),
  ),
};
const runtimePath = fileURLToPath(
  new URL("../../../examples/p0-sample/business-runtime.mjs", import.meta.url),
);
const sourcePath = fileURLToPath(
  new URL("../../../examples/p0-sample/app.mjs", import.meta.url),
);
const digest = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");

describe.skipIf(process.platform !== "darwin")(
  "AI 候选与独立测试的真实隔离执行边界（合成源码，不调用模型）",
  () => {
    it("计划不能冒充覆盖；已审核提交实际独立测试，损坏制品和运行时版本拒绝", async () => {
      const root = await mkdtemp(
        path.join(await realpath(os.tmpdir()), "forgex-ai-plan-"),
      );
      const adapter = new SampleLifecycleAdapter({
        root,
        sourcePath,
        businessRuntimePath: runtimePath,
      });
      try {
        const requirement = await adapter.execute(createJob(), signal());
        if (requirement.status !== "succeeded")
          throw new Error("应生成合成需求");
        const testJob = () => {
          const job = stage(createJob(), "testing");
          job.input.artifacts = [artifact(requirement.output)];
          return job;
        };
        await expect(
          adapter.testWithPlan(createJob(), signal(), plan),
        ).rejects.toThrow("只能用于测试任务");
        expect(
          await adapter.testWithPlan(
            stage(createJob(), "testing"),
            signal(),
            plan,
          ),
        ).toMatchObject({
          status: "blocked",
          reason: expect.stringContaining("超出"),
        });
        expect(
          await adapter.testWithPlan(testJob(), signal(), {
            ...plan,
            probes: plan.probes.map((p) => ({ ...p, criterionIndex: 0 })),
          }),
        ).toMatchObject({ status: "blocked" });
        expect(
          await adapter.testWithPlan(testJob(), signal(), plan),
        ).toMatchObject({ status: "blocked", reason: "没有已审核代码制品" });
        const repository = path.join(root, "repository");
        await adapter.git.run(["init", "-q", "-b", "main", repository]);
        await writeFile(
          path.join(repository, "appointment.js"),
          await readFile(
            new URL("./fixtures/appointment-business.txt", import.meta.url),
            "utf8",
          ),
        );
        await adapter.git.run(["-C", repository, "add", "appointment.js"]);
        await adapter.git.run([
          "-C",
          repository,
          "-c",
          "user.name=合成样板",
          "-c",
          "user.email=sample@forgex.local",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-qm",
          "初始化：合成业务代码",
        ]);
        const commitSha = (
          await adapter.git.run(["-C", repository, "rev-parse", "HEAD"])
        ).stdout.trim();
        const codeJob = stage(createJob(), "development");
        const code = await adapter.run(codeJob, signal(), false, {
          workspacePath: repository,
          commitSha,
        });
        expect(code.status).toBe("succeeded");
        if (code.status !== "succeeded" || code.output.kind !== "code")
          throw new Error("应完成自测");
        expect(await adapter.run(codeJob, signal(), true)).toEqual(code);
        await writeFile(
          path.join(root, "results", `${codeJob.jobKey}.json`),
          "损坏的执行缓存",
        );
        await expect(adapter.recover(codeJob, signal())).rejects.toThrow();
        await writeFile(
          path.join(root, "results", `${codeJob.jobKey}.json`),
          JSON.stringify(code),
        );
        const testing = testJob();
        testing.input.artifacts.push(artifact(code.output));
        const tested = await adapter.testWithPlan(testing, signal(), plan);
        expect(tested).toMatchObject({
          status: "succeeded",
          output: {
            kind: "tests",
            commitSha,
            artifactDigest: code.output.artifactDigest,
            checks: [
              { passed: true },
              { passed: true },
              { passed: true },
              { passed: true },
            ],
          },
        });
        expect(await adapter.testWithPlan(testing, signal(), plan)).toEqual(
          tested,
        );
        const deployment = stage(createJob(), "staging_deploy");
        deployment.input.artifacts = [artifact(code.output)];
        const deployed = await adapter.execute(deployment, signal());
        expect(deployed).toMatchObject({
          status: "succeeded",
          output: {
            kind: "deployment",
            artifactDigest: code.output.artifactDigest,
          },
        });
        expect(await adapter.recover(deployment, signal())).toEqual(deployed);
        await adapter.close();
        expect(await adapter.recover(deployment, signal())).toMatchObject({
          status: "blocked",
          reason: expect.stringContaining("健康状态无法核对"),
        });
        const noRequirements = stage(createJob(), "testing");
        noRequirements.input.artifacts = [artifact(code.output)];
        expect(await adapter.execute(noRequirements, signal())).toMatchObject({
          status: "blocked",
          reason: "没有已确认需求",
        });
        const bytesPath = path.join(
          root,
          "artifacts",
          `${code.output.artifactDigest}.mjs`,
        );
        await writeFile(bytesPath, "损坏制品");
        await expect(
          adapter.testWithPlan(
            {
              ...testJob(),
              input: {
                ...testJob().input,
                artifacts: [
                  artifact(requirement.output),
                  artifact(code.output),
                ],
              },
            },
            signal(),
            plan,
          ),
        ).rejects.toThrow("摘要不匹配");
        const badRuntime = JSON.stringify({
          schemaVersion: 1,
          runtimeDigest: "f".repeat(64),
          businessSource: "function handleAppointment(){}",
        });
        const badDigest = digest(badRuntime);
        await writeFile(
          path.join(root, "artifacts", `${badDigest}.mjs`),
          badRuntime,
        );
        const badJob = testJob();
        badJob.input.artifacts.push(
          artifact({ ...code.output, artifactDigest: badDigest }),
        );
        await expect(
          adapter.testWithPlan(badJob, signal(), plan),
        ).rejects.toThrow("已批准版本");
        await writeFile(
          path.join(repository, "appointment.js"),
          "function handleAppointment(){return {status:404,body:{error:'未找到'},appointments:[]};}",
        );
        await adapter.git.run(["-C", repository, "add", "appointment.js"]);
        await adapter.git.run([
          "-C",
          repository,
          "-c",
          "user.name=合成样板",
          "-c",
          "user.email=sample@forgex.local",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-qm",
          "测试：故障候选",
        ]);
        const failed = await adapter.run(
          stage(createJob(), "development"),
          signal(),
          false,
          {
            workspacePath: repository,
            commitSha: (
              await adapter.git.run(["-C", repository, "rev-parse", "HEAD"])
            ).stdout.trim(),
          },
        );
        expect(failed).toMatchObject({
          status: "failed",
          reason: expect.stringContaining("真实自测失败"),
        });
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
    it("独立测试不能修改代码，开发不能修改协议文件，模型阻塞不能产生成功制品", async () => {
      const root = await mkdtemp(
        path.join(await realpath(os.tmpdir()), "forgex-ai-stage-"),
      );
      const pipeline = new SampleLifecycleAdapter({ root, sourcePath });
      try {
        const repo = path.join(root, "repository");
        await pipeline.git.run(["init", "-q", "-b", "main", repo]);
        await writeFile(path.join(repo, "README.md"), "合成协议");
        await pipeline.git.run(["-C", repo, "add", "README.md"]);
        await pipeline.git.run([
          "-C",
          repo,
          "-c",
          "user.name=合成样板",
          "-c",
          "user.email=sample@forgex.local",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-qm",
          "初始化",
        ]);
        const current = createJob();
        let mode = "plan";
        const runner: CodexIsolationRunner = {
          run: async (input) => {
            if (mode === "mutate")
              await writeFile(
                path.join(input.workspacePath, "README.md"),
                "越界修改",
              );
            return {
              threadId: "合成会话",
              finalResponse: JSON.stringify(
                mode === "blocked"
                  ? { status: "blocked", summary: "合成模型明确阻塞" }
                  : mode === "bad-json"
                    ? { unexpected: true }
                    : input.prompt.includes("独立测试 Agent")
                      ? plan
                      : { status: "completed", summary: "合成声明完成" },
              ),
            };
          },
        };
        const adapter = new CodexLifecycleAdapter({
          project: {
            projectKey: current.input.projectKey,
            repositoryKey: current.input.repositoryKey,
            repositoryRoot: repo,
            worktreeRoot: path.join(root, "worktrees"),
            baseRef: "main",
            reasoningEffort: "low",
          },
          runner,
          pipeline,
          codexHomePath: path.join(root, "home"),
          protectedPaths: [repo],
          testingAgent: true,
          allowedDevelopmentFiles: ["appointment.js"],
        });
        const next = (s: LifecycleJob["stage"]) => {
          const job = createJob();
          job.input.projectKey = current.input.projectKey;
          job.input.repositoryKey = current.input.repositoryKey;
          return stage(job, s);
        };
        expect(await adapter.execute(next("testing"), signal())).toMatchObject({
          status: "blocked",
        });
        mode = "mutate";
        await expect(
          adapter.execute(next("testing"), signal()),
        ).rejects.toThrow("修改了代码");
        await expect(
          adapter.execute(next("development"), signal()),
        ).rejects.toThrow("协议之外");
        mode = "blocked";
        expect(await adapter.execute(next("development"), signal())).toEqual({
          status: "blocked",
          reason: "合成模型明确阻塞",
        });
        mode = "bad-json";
        await expect(
          adapter.execute(next("development"), signal()),
        ).rejects.toThrow();
        const { testWithPlan: _plan, ...withoutPlan } = pipeline;
        const noPlan = new CodexLifecycleAdapter({
          ...adapter.options,
          pipeline: {
            ...withoutPlan,
            execute: pipeline.execute.bind(pipeline),
            run: pipeline.run.bind(pipeline),
          },
        });
        mode = "plan";
        await expect(noPlan.execute(next("testing"), signal())).rejects.toThrow(
          "未配置独立测试",
        );
        expect(
          await adapter.execute(next("staging_deploy"), signal()),
        ).toMatchObject({
          status: "blocked",
          reason: "没有可部署的已验证制品",
        });
      } finally {
        await pipeline.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
    it("进程权限阻止跨目录读写、出站请求和子进程，启动坏回执及超大源码不能通过", async () => {
      const root = await mkdtemp(
        path.join(await realpath(os.tmpdir()), "forgex-ai-canary-"),
      );
      const repository = path.join(root, "repository"),
        runtime = path.join(root, "canary-runtime.mjs"),
        outside = path.join(root, "outside-canary.txt");
      const pipeline = new SampleLifecycleAdapter({
        root,
        sourcePath,
        businessRuntimePath: runtime,
      });
      let networkCalls = 0;
      const server = createServer((_req, res) => {
        networkCalls++;
        res.end("禁止模型访问的样板目标");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      try {
        await writeFile(outside, "样板秘密标记");
        await pipeline.git.run(["init", "-q", "-b", "main", repository]);
        await writeFile(
          path.join(repository, "appointment.js"),
          "function handleAppointment(){}",
        );
        const commit = async () => {
          await pipeline.git.run(["-C", repository, "add", "appointment.js"]);
          await pipeline.git.run([
            "-C",
            repository,
            "-c",
            "user.name=合成样板",
            "-c",
            "user.email=sample@forgex.local",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-qm",
            "测试：权限金丝雀",
          ]);
          return (
            await pipeline.git.run(["-C", repository, "rev-parse", "HEAD"])
          ).stdout.trim();
        };
        const commitSha = await commit();
        const canaries = [
          `import {readFile} from 'node:fs/promises'; await readFile(${JSON.stringify(outside)});`,
          `import {writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(outside)},'越界写入');`,
          `await fetch('http://127.0.0.1:${port}/');`,
          `import {spawn} from 'node:child_process'; spawn('/usr/bin/true');`,
          "console.log('无效启动协议');setInterval(()=>{},1000);",
          "console.log('x'.repeat(4097));setInterval(()=>{},1000);",
        ];
        for (const program of canaries) {
          await writeFile(runtime, program);
          await expect(
            pipeline.run(stage(createJob(), "development"), signal(), false, {
              workspacePath: repository,
              commitSha,
            }),
          ).rejects.toThrow();
          expect(await readFile(outside, "utf8")).toBe("样板秘密标记");
          expect(networkCalls).toBe(0);
        }
        await writeFile(
          path.join(repository, "appointment.js"),
          "x".repeat(64 * 1024 + 1),
        );
        await expect(
          pipeline.run(stage(createJob(), "development"), signal(), false, {
            workspacePath: repository,
            commitSha: await commit(),
          }),
        ).rejects.toThrow("超过样板协议");
        expect(
          await pipeline.run(stage(createJob(), "development"), signal(), true),
        ).toMatchObject({
          status: "blocked",
          reason: "没有已核对的样板执行记录",
        });
      } finally {
        await pipeline.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
  },
);
