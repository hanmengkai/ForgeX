import { mkdtemp, rm, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { LifecycleWorkflow } from "@forgex/domain";
import { SampleLifecycleAdapter } from "../src/lifecycle-sample-adapter.js";

const job = () => {
  const result = LifecycleWorkflow.create({
    tenantKey: randomUUID(),
    projectKey: randomUUID(),
    repositoryKey: randomUUID(),
    requesterKey: randomUUID(),
    createdBy: randomUUID(),
    title: "访客预约",
    brief: "提交预约获取编号",
  }).claim({
    executorKey: randomUUID(),
    capabilities: ["requirements_ai"],
    leaseMs: 60000,
  })!;
  result.stage = "development";
  result.input.stage = "development";
  return result;
};
describe("生命周期 AI 代码隔离样板", () => {
  it("拒绝提交不符和运行时外任意源码，不执行模板替代", async () => {
    const root = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "forgex-ai-boundary-"),
    );
    const adapter = new SampleLifecycleAdapter({
      root,
      sourcePath: fileURLToPath(
        new URL("../../../examples/p0-sample/app.mjs", import.meta.url),
      ),
      businessRuntimePath: fileURLToPath(
        new URL(
          "../../../examples/p0-sample/business-runtime.mjs",
          import.meta.url,
        ),
      ),
    });
    try {
      await adapter.git.run(["init", "-q", "-b", "main", root]);
      await writeFile(
        path.join(root, "appointment.js"),
        "function handleAppointment(){return {status:200,body:{},appointments:[]};}",
      );
      await adapter.git.run(["-C", root, "add", "appointment.js"]);
      await adapter.git.run([
        "-C",
        root,
        "-c",
        "user.name=样板",
        "-c",
        "user.email=p0@forgex.local",
        "commit",
        "-qm",
        "初始化",
      ]);
      await expect(
        adapter.run(job(), new AbortController().signal, false, {
          workspacePath: root,
          commitSha: "f".repeat(40),
        }),
      ).rejects.toThrow("提交");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("业务函数不能读取宿主对象或绕过执行超时", async () => {
    const runtime = await import(
      new URL(
        "../../../examples/p0-sample/business-runtime.mjs",
        import.meta.url,
      ).href
    );
    const input = {
      method: "GET",
      url: "/",
      body: null,
      appointments: [],
      newId: randomUUID(),
    };
    expect(() =>
      runtime.evaluateBusiness(
        "function handleAppointment(){return process.env;}",
        input,
      ),
    ).toThrow();
    expect(() =>
      runtime.evaluateBusiness(
        "function handleAppointment(){return this.constructor.constructor('return process')();}",
        input,
      ),
    ).toThrow();
    expect(() =>
      runtime.evaluateBusiness(
        "function handleAppointment(){while(true){}}",
        input,
      ),
    ).toThrow(/timed out/);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "生命周期 AI 业务代码真实进程沙箱",
  () => {
    it("真实业务代码在系统沙箱中完成 HTTP 自测并绑定提交和制品", async () => {
      const root = await mkdtemp(
        path.join(await realpath(os.tmpdir()), "forgex-ai-process-"),
      );
      const adapter = new SampleLifecycleAdapter({
        root,
        sourcePath: fileURLToPath(
          new URL("../../../examples/p0-sample/app.mjs", import.meta.url),
        ),
        businessRuntimePath: fileURLToPath(
          new URL(
            "../../../examples/p0-sample/business-runtime.mjs",
            import.meta.url,
          ),
        ),
      });
      try {
        await adapter.git.run(["init", "-q", "-b", "main", root]);
        const business = await readFile(
          new URL("./fixtures/appointment-business.txt", import.meta.url),
          "utf8",
        );
        await writeFile(path.join(root, "appointment.js"), business);
        await adapter.git.run(["-C", root, "add", "appointment.js"]);
        await adapter.git.run([
          "-C",
          root,
          "-c",
          "user.name=样板",
          "-c",
          "user.email=p0@forgex.local",
          "commit",
          "-qm",
          "初始化",
        ]);
        const commitSha = (
          await adapter.git.run(["-C", root, "rev-parse", "HEAD"])
        ).stdout.trim();
        const result = await adapter.run(
          job(),
          new AbortController().signal,
          false,
          { workspacePath: root, commitSha },
        );
        expect(result).toMatchObject({
          status: "succeeded",
          output: {
            kind: "code",
            commitSha,
            selfTests: [
              { passed: true },
              { passed: true },
              { passed: true },
              { passed: true },
            ],
          },
        });
        if (result.status !== "succeeded" || result.output.kind !== "code")
          throw new Error("应完成真实自测");
        const artifact = JSON.parse(
          await readFile(
            path.join(root, "artifacts", `${result.output.artifactDigest}.mjs`),
            "utf8",
          ),
        );
        expect(artifact.businessSource).toBe(business);
        expect(artifact.runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
  },
);
