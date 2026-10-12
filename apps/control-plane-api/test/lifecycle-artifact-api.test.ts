import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { SqliteLifecycleArtifactStore } from "@forgex/application";
import { createLifecycleFixture } from "./lifecycle-fixture.js";
import {
  HttpLifecycleArtifactClient,
  TransferringLifecyclePipeline,
} from "../../../services/device-worker/src/lifecycle-transfer.js";
import {
  LifecycleExecutorRuntime,
  MemoryLifecycleJournal,
  HttpLifecycleClient,
} from "../../../services/device-worker/src/lifecycle-runtime.js";

describe("控制面制品交接协议", () => {
  it("制品只向已领取且引用它的执行器开放，开发结果先交接，测试读取同一摘要", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-artifact-api-")),
      store = await SqliteLifecycleArtifactStore.open(
        path.join(root, "artifacts.sqlite"),
      );
    const fixture = await createLifecycleFixture(undefined, {
      artifactStore: store,
    });
    try {
      const agent = fixture.executors.find((e) => e.name === "agent")!,
        test = fixture.executors.find((e) => e.name === "test")!;
      for (const executor of [agent, test])
        fixture.runtimes[executor.name] = new LifecycleExecutorRuntime({
          client: new HttpLifecycleClient({
            origin: fixture.origin,
            token: executor.token,
          }),
          privateKey: executor.privateKey,
          journal: new MemoryLifecycleJournal(),
          adapter: new TransferringLifecyclePipeline(
            fixture.adapter,
            new HttpLifecycleArtifactClient({
              origin: fixture.origin,
              token: executor.token,
            }),
          ),
        });
      const created = await fixture.create();
      await fixture.runTo(created.workflowKey, "code_review");
      await fixture.approve(created.workflowKey, "developer");
      const current = await new HttpLifecycleClient({
        origin: fixture.origin,
        token: test.token,
      }).claim();
      expect(current?.stage).toBe("testing");
      if (!current) throw new Error("应领取测试");
      const code = current.input.artifacts.find(
        (a) => a.output.kind === "code",
      )!.output;
      if (code.kind !== "code") throw new Error("应有代码制品");
      const access = {
        schemaVersion: 2,
        fencingToken: current.fencingToken,
        inputDigest: current.inputDigest,
      };
      const post = (suffix: string, payload: unknown, token = test.token) =>
        fixture.app.inject({
          method: "POST",
          url: `/api/v2/executor/jobs/${current.jobKey}/artifacts${suffix}`,
          headers: {
            authorization: `Lifecycle ${token}`,
            "content-type": "application/json",
          },
          payload: JSON.stringify(payload),
        });
      expect(
        (
          await post("/read", {
            access,
            artifactDigest: code.artifactDigest,
            commitSha: code.commitSha,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post("/read", {
            access,
            artifactDigest: "f".repeat(64),
            commitSha: code.commitSha,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            "/read",
            {
              access,
              artifactDigest: code.artifactDigest,
              commitSha: code.commitSha,
            },
            agent.token,
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post("/read", {
            access: { ...access, fencingToken: "bad" },
            artifactDigest: code.artifactDigest,
            commitSha: code.commitSha,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await post("", {
            access,
            envelope: {
              schemaVersion: 1,
              artifactDigest: code.artifactDigest,
              commitSha: code.commitSha,
              bytesBase64: "eA==",
            },
          })
        ).statusCode,
      ).toBe(403);
      await fixture.runtimes.test!.options.journal.save({
        schemaVersion: 2,
        phase: "executing",
        job: current,
        completion: null,
      });
      const result = await fixture.runtimes.test!.options.adapter.execute(
        current,
        new AbortController().signal,
      );
      expect(result.status).toBe("succeeded");
      const cached = await fixture.runtimes.test!.options.adapter.recover!(
        current,
        new AbortController().signal,
      );
      expect(cached).toEqual(result);
    } finally {
      await fixture.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
