import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  InMemoryLifecycleRepository,
  LifecycleService,
} from "../src/lifecycle-service.js";
import { SqliteLifecycleArtifactStore } from "../src/lifecycle-artifact-store.js";
import { LifecycleWorkflow } from "@forgex/domain";
import type { LifecycleExecutorPrincipal } from "@forgex/contracts/lifecycle";

describe("有界制品交接", () => {
  it("不可变制品跨实例读取，摘要不符拒绝；非开发任务、失效租约和其他租户不能上传", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-transfer-"));
    const file = path.join(root, "artifacts.sqlite");
    const scope = {
      tenantKey: randomUUID(),
      projectKey: randomUUID(),
      repositoryKey: randomUUID(),
    };
    let store = await SqliteLifecycleArtifactStore.open(file);
    const bytes = Buffer.from("隔离样板制品"),
      artifactDigest = createHash("sha256").update(bytes).digest("hex");
    const envelope = {
      schemaVersion: 1 as const,
      commitSha: "a".repeat(40),
      artifactDigest,
      bytesBase64: bytes.toString("base64"),
    };
    try {
      await expect(
        store.put(scope, { ...envelope, artifactDigest: "b".repeat(64) }),
      ).rejects.toThrow("摘要");
      await store.put(scope, envelope);
      await store.put(scope, envelope);
      store.close();
      store = await SqliteLifecycleArtifactStore.open(file);
      expect(
        await store.get(scope, artifactDigest, envelope.commitSha),
      ).toEqual(envelope);
      expect(
        await store.get(
          { ...scope, tenantKey: randomUUID() },
          artifactDigest,
          envelope.commitSha,
        ),
      ).toBeNull();
      const repository = new InMemoryLifecycleRepository();
      const flow = LifecycleWorkflow.create({
        ...scope,
        requesterKey: randomUUID(),
        createdBy: randomUUID(),
        title: "访客预约",
        brief: "隔离样板",
      });
      const executor: LifecycleExecutorPrincipal = {
        ...scope,
        executorKey: randomUUID(),
        capabilities: ["requirements_ai", "development"],
        publicKeyBase64: Buffer.alloc(44).toString("base64"),
      };
      const job = flow.claim({
        executorKey: executor.executorKey,
        capabilities: executor.capabilities,
        leaseMs: 60000,
      })!;
      await repository.transaction(scope.tenantKey, (s) => {
        s.workflows.push(flow.toSnapshot());
      });
      const service = new LifecycleService(repository, scope);
      const command = {
        schemaVersion: 2 as const,
        fencingToken: job.fencingToken!,
        inputDigest: job.inputDigest,
      };
      await expect(
        service.authorizeArtifact(executor, job.jobKey, command, "upload"),
      ).rejects.toThrow("开发任务");
      await expect(
        service.authorizeArtifact(
          { ...executor, tenantKey: randomUUID() },
          job.jobKey,
          command,
          "upload",
        ),
      ).rejects.toThrow("未找到");
      await repository.transaction(scope.tenantKey, (s) => {
        s.workflows[0]!.jobs[0]!.stage = "development";
      });
      expect(
        await service.authorizeArtifact(
          executor,
          job.jobKey,
          command,
          "upload",
        ),
      ).toEqual(job.input);
      await expect(
        service.authorizeArtifact(
          executor,
          job.jobKey,
          { ...command, fencingToken: randomUUID() },
          "upload",
        ),
      ).rejects.toThrow("租约");
      await expect(
        service.authorizeArtifact(
          executor,
          job.jobKey,
          { ...command, inputDigest: "f".repeat(64) },
          "upload",
        ),
      ).rejects.toThrow("租约");
      await repository.transaction(scope.tenantKey, (s) => {
        s.workflows[0]!.jobs[0]!.leaseUntil = "2000-01-01T00:00:00.000Z";
      });
      await expect(
        service.authorizeArtifact(executor, job.jobKey, command, "upload"),
      ).rejects.toThrow("租约");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
