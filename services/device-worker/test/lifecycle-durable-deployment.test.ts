import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { LifecycleWorkflow } from "@forgex/domain";
import type {
  LifecycleJob,
  LifecycleArtifact,
} from "@forgex/contracts/lifecycle";
import { SampleLifecycleAdapter } from "../src/lifecycle-sample-adapter.js";
import { stopSampleProcess } from "../src/sample-process.js";
import { savePrivateJson } from "../src/lifecycle-transfer.js";

describe.skipIf(process.platform !== "darwin")(
  "持久隔离发布身份与副作用恢复",
  () => {
    it("重建适配器且结果缓存丢失时核对发布回执，重复执行保持相同进程；缺少证据不再发布", async () => {
      const root = await mkdtemp(
          path.join(os.tmpdir(), "forgex-deploy-adopt-"),
        ),
        sourcePath = fileURLToPath(
          new URL("../../../examples/p0-sample/app.mjs", import.meta.url),
        );
      const original = new SampleLifecycleAdapter({
        root,
        sourcePath,
        durableDeployments: true,
      });
      let recovered = new SampleLifecycleAdapter({
        root,
        sourcePath,
        durableDeployments: true,
      });
      const initial = LifecycleWorkflow.create({
        tenantKey: randomUUID(),
        projectKey: randomUUID(),
        repositoryKey: randomUUID(),
        requesterKey: randomUUID(),
        createdBy: randomUUID(),
        title: "访客预约",
        brief: "隔离样板",
      }).claim({
        executorKey: randomUUID(),
        capabilities: ["requirements_ai"],
        leaseMs: 60000,
      })!;
      const current = (stage: LifecycleJob["stage"]): LifecycleJob => ({
        ...structuredClone(initial),
        jobKey: randomUUID(),
        stage,
        input: { ...structuredClone(initial.input), stage },
      });
      try {
        const code = await original.execute(
          current("development"),
          new AbortController().signal,
        );
        if (code.status !== "succeeded" || code.output.kind !== "code")
          throw new Error("应生成代码制品");
        const artifact: LifecycleArtifact = {
          artifactKey: randomUUID(),
          jobKey: randomUUID(),
          executorKey: initial.executorKey!,
          createdAt: new Date().toISOString(),
          contentDigest: "a".repeat(64),
          output: code.output,
        };
        const deploy = current("production_deploy");
        deploy.input.artifacts = [artifact];
        const result = await original.execute(
          deploy,
          new AbortController().signal,
        );
        expect(result.status).toBe("succeeded");
        const stateFile = path.join(
            root,
            "environments",
            `production-${initial.input.projectKey}-${initial.input.repositoryKey}`,
            "deployment.json",
          ),
          state = JSON.parse(await readFile(stateFile, "utf8"));
        await rm(path.join(root, "results", `${deploy.jobKey}.json`));
        expect(
          await recovered.recover(deploy, new AbortController().signal),
        ).toEqual(result);
        expect(
          await recovered.execute(deploy, new AbortController().signal),
        ).toEqual(result);
        expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(state);
        await expect(
          stopSampleProcess({ ...state, environmentKey: randomUUID() }),
        ).rejects.toThrow("禁止停止未知进程");
        expect((await fetch(`http://127.0.0.1:${state.port}/health`)).ok).toBe(
          true,
        );
        await rm(path.join(root, "results", `${deploy.jobKey}.json`), {
          force: true,
        });
        const { receipt: _receipt, ...unknown } = state;
        await savePrivateJson(stateFile, unknown);
        expect(
          await recovered.recover(deploy, new AbortController().signal),
        ).toBeNull();
        await savePrivateJson(stateFile, state);
        await recovered.close();
        expect(
          await original.recover(deploy, new AbortController().signal),
        ).toMatchObject({ status: "blocked" });
      } finally {
        await recovered.close();
        await original.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
  },
);
