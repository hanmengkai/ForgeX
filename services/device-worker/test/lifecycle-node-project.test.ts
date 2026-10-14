import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LifecycleWorkflow } from "@forgex/domain";
import { savePrivateJson } from "../src/lifecycle-transfer.js";
import {
  compileNodeProject,
  validateNodeTestPlan,
  NodeProjectLifecyclePipeline,
} from "../src/lifecycle-node-project.js";
describe("实际 TypeScript 项目失败边界", () => {
  it("错任务的部署回执不能作为恢复成功证据", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-node-receipt-"));
    try {
      const original = LifecycleWorkflow.create({
        tenantKey: randomUUID(),
        projectKey: randomUUID(),
        repositoryKey: randomUUID(),
        requesterKey: randomUUID(),
        createdBy: randomUUID(),
        title: "任务管理",
        brief: "创建查询任务",
      }).claim({
        executorKey: randomUUID(),
        capabilities: ["requirements_ai"],
        leaseMs: 60000,
      })!;
      const job = { ...original, stage: "staging_deploy" as const };
      const pipeline = new NodeProjectLifecyclePipeline({
        schemaVersion: 1,
        root,
        entrypoint: "src/app.ts",
        sourceFiles: ["src/app.ts"],
        runtimePath: path.join(root, "runtime.mjs"),
        runtimeSha256: "a".repeat(64),
        suitesPath: path.join(root, "suites.mjs"),
        suitesSha256: "a".repeat(64),
      });
      await savePrivateJson(
        path.join(root, "deployments", job.jobKey + ".json"),
        {
          schemaVersion: 1,
          jobKey: randomUUID(),
          inputDigest: job.inputDigest,
          pid: 1,
          processIdentity: "未知进程",
          port: 1,
          environmentKey: randomUUID(),
          artifactDigest: "a".repeat(64),
          receipt: {
            status: "succeeded",
            output: {
              kind: "deployment",
              summary: "损坏回执",
              environment: "staging",
              commitSha: "a".repeat(40),
              artifactDigest: "a".repeat(64),
              url: "http://127.0.0.1:1",
              healthy: true,
              deploymentKey: randomUUID(),
            },
          },
        },
      );
      await expect(
        pipeline.recover(job, new AbortController().signal),
      ).rejects.toThrow("绑定");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("编译类型错误、越界导入及非法路径拒绝", () => {
    expect(() =>
      compileNodeProject(
        { "src/app.ts": "const n: number = '错误'; export default n;" },
        "src/app.ts",
      ),
    ).toThrow("编译失败");
    expect(() =>
      compileNodeProject(
        { "src/app.ts": "import fs from 'node:fs'; export default fs;" },
        "src/app.ts",
      ),
    ).toThrow("编译失败");
    expect(() =>
      compileNodeProject(
        { "../escape.ts": "export default 1;" },
        "../escape.ts",
      ),
    ).toThrow();
  });
  it("编译真实 TypeScript 模块，保留入口", () => {
    const compiled = compileNodeProject(
      {
        "src/app.ts":
          "export default function handle(input: { title: string }) { return input.title.trim(); }",
      },
      "src/app.ts",
    );
    expect(compiled.entrypoint).toBe("src/app.js");
    expect(compiled.modules["src/app.js"]).toContain("exports.default");
  });
  it("运行时未提供的 Web 全局不能靠类型放宽通过", () => {
    expect(() =>
      compileNodeProject(
        {
          "src/app.ts":
            "export default function h() { return new URLSearchParams('a=1'); }",
        },
        "src/app.ts",
      ),
    ).toThrow("编译失败");
  });
  it("计划缺漏、重复、未知套件和旧预约协议不能宣称覆盖", () => {
    const plan = {
      schemaVersion: 2,
      summary: "独立测试计划",
      cases: [{ criterionIndex: 0, suiteKey: "create" }],
    };
    expect(() => validateNodeTestPlan(plan, 2, ["create", "query"])).toThrow();
    expect(() =>
      validateNodeTestPlan(
        { ...plan, cases: [plan.cases[0], plan.cases[0]] },
        2,
        ["create"],
      ),
    ).toThrow();
    expect(() =>
      validateNodeTestPlan(
        { ...plan, cases: [{ criterionIndex: 0, suiteKey: "shell" }] },
        1,
        ["create"],
      ),
    ).toThrow();
    expect(() =>
      validateNodeTestPlan({ schemaVersion: 1, probes: [] }, 1, ["create"]),
    ).toThrow();
  });
});
