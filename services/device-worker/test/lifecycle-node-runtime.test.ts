import { describe, expect, it } from "vitest";
import { compileNodeProject } from "../src/lifecycle-node-project.js";
import { HttpLifecycleAdapter } from "../src/lifecycle-runtime.js";
import { LifecycleWorkflow } from "@forgex/domain";
import { randomUUID } from "node:crypto";

describe("Node 项目业务限制与远程计划协议", () => {
  it("业务读取进程环境、动态代码、循环和非法响应失败", async () => {
    const runtimePath = new URL(
      "../runtime/node-project-runtime.mjs",
      import.meta.url,
    ).href;
    const { evaluateNodeProject } = (await import(runtimePath)) as {
      evaluateNodeProject: (bundle: unknown, input: unknown) => unknown;
    };
    for (const source of [
      "export default function h(){ return (globalThis as any).process.env; }",
      "export default function h(){ return Function('return 1')(); }",
      "export default function h(){ while(true){} }",
      "export default function h(){ return {}; }",
    ]) {
      const bundle = {
        schemaVersion: 2,
        ...compileNodeProject({ "src/app.ts": source }, "src/app.ts"),
      };
      expect(() => evaluateNodeProject(bundle, {})).toThrow();
    }
  });
  it("远程计划用 v3 明确交接，旧任务保持 v2，错阶段拒绝", async () => {
    const job = LifecycleWorkflow.create({
      tenantKey: randomUUID(),
      projectKey: randomUUID(),
      repositoryKey: randomUUID(),
      requesterKey: randomUUID(),
      createdBy: randomUUID(),
      title: "任务管理",
      brief: "创建并查询任务",
    }).claim({
      executorKey: randomUUID(),
      capabilities: ["requirements_ai"],
      leaseMs: 60000,
    })!;
    const requests: Record<string, unknown>[] = [];
    const adapter = new HttpLifecycleAdapter({
      endpoint: "http://127.0.0.1/execute",
      token: "a".repeat(32),
      fetcher: async (_url, options) => {
        requests.push(JSON.parse(String(options?.body)));
        return Response.json({ status: "blocked", reason: "显式合成网关结果" });
      },
    });
    const plan = {
      schemaVersion: 2 as const,
      summary: "独立计划",
      cases: [{ criterionIndex: 0, suiteKey: "create" }],
    };
    await adapter.execute(job, new AbortController().signal);
    await expect(
      adapter.testWithPlan(job, new AbortController().signal, plan),
    ).rejects.toThrow("只能");
    await adapter.testWithPlan(
      { ...job, stage: "testing" },
      new AbortController().signal,
      plan,
    );
    expect(requests[0]).toMatchObject({ schemaVersion: 2, recoverOnly: false });
    expect(requests[1]).toMatchObject({ schemaVersion: 3, testPlan: plan });
  });
});
