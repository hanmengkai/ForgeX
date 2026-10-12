import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, vi } from "vitest";
import { LifecycleWorkflow } from "@forgex/domain";
import type {
  LifecycleJob,
  LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import {
  HttpLifecycleArtifactClient,
  TransferringLifecyclePipeline,
  savePrivateBytes,
} from "../src/lifecycle-transfer.js";
import { DurableLifecycleAdapter } from "../src/lifecycle-receipt.js";
import {
  LifecycleDeliveryUnavailableError,
  LifecycleExecutorRuntime,
  MemoryLifecycleJournal,
} from "../src/lifecycle-runtime.js";
import {
  LifecycleWorkerConfigSchema,
  createLifecycleWorkerAdapter,
} from "../src/lifecycle-config.js";
import type { SampleLifecycleAdapter } from "../src/lifecycle-sample-adapter.js";

const job = (): LifecycleJob =>
  LifecycleWorkflow.create({
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
const bytes = Buffer.from("待交接的原始制品"),
  artifactDigest = createHash("sha256").update(bytes).digest("hex"),
  commitSha = "a".repeat(40);
const envelope = {
  schemaVersion: 1 as const,
  artifactDigest,
  commitSha,
  bytesBase64: bytes.toString("base64"),
};
const signal = () => new AbortController().signal;

describe("执行器交接与结果恢复", () => {
  it("交接内容和提交必须一致，拒绝凭据、重定向、超大响应和被改写内容", async () => {
    expect(
      () =>
        new HttpLifecycleArtifactClient({
          origin: "http://example.com",
          token: "a".repeat(32),
        }),
    ).toThrow();
    expect(
      () =>
        new HttpLifecycleArtifactClient({
          origin: "http://127.0.0.1",
          token: "短",
        }),
    ).toThrow();
    let response = Response.json({ data: envelope });
    const client = new HttpLifecycleArtifactClient({
      origin: "http://127.0.0.1:3000",
      token: "a".repeat(32),
      fetcher: async (_url, options) => {
        expect(options?.redirect).toBe("error");
        return response;
      },
    });
    expect(
      await client.get(job(), artifactDigest, commitSha, signal()),
    ).toEqual(bytes);
    response = Response.json({
      data: { ...envelope, commitSha: "b".repeat(40) },
    });
    await expect(
      client.get(job(), artifactDigest, commitSha, signal()),
    ).rejects.toThrow("批准提交");
    response = Response.json({
      data: {
        ...envelope,
        bytesBase64: Buffer.from("改写").toString("base64"),
      },
    });
    await expect(
      client.get(job(), artifactDigest, commitSha, signal()),
    ).rejects.toThrow("摘要");
    response = new Response("x".repeat(256 * 1024 + 1));
    await expect(
      client.get(job(), artifactDigest, commitSha, signal()),
    ).rejects.toThrow("超过上限");
    response = new Response(null);
    await expect(
      client.get(job(), artifactDigest, commitSha, signal()),
    ).rejects.toThrow("空响应");
    response = new Response(null, { status: 503 });
    await expect(
      client.get(job(), artifactDigest, commitSha, signal()),
    ).rejects.toBeInstanceOf(LifecycleDeliveryUnavailableError);
    response = new Response(null, { status: 403 });
    await expect(
      client.get(job(), artifactDigest, commitSha, signal()),
    ).rejects.toThrow("403");
    response = Response.json({
      data: { schemaVersion: 1, artifactDigest: "b".repeat(64) },
    });
    await expect(client.put(job(), envelope, signal())).rejects.toThrow(
      "确认摘要",
    );
    const interrupted = new HttpLifecycleArtifactClient({
      origin: "http://127.0.0.1",
      token: "a".repeat(32),
      fetcher: async () => {
        throw new Error("断网");
      },
    });
    await expect(
      interrupted.get(job(), artifactDigest, commitSha, signal()),
    ).rejects.toBeInstanceOf(LifecycleDeliveryUnavailableError);
  });
  it("上传确认丢失保留执行中日志，恢复只补传缓存制品与签名回执，不重复开发自测", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "forgex-upload-recovery-"),
    );
    try {
      await savePrivateBytes(
        path.join(root, "artifacts", `${artifactDigest}.mjs`),
        bytes,
      );
      const current = job();
      current.stage = "development";
      const result: LifecycleTaskResult = {
        status: "succeeded",
        output: {
          kind: "code",
          summary: "可信候选真实自测通过",
          artifactDigest,
          commitSha,
          selfTests: [{ name: "预约业务", passed: true }],
        },
      };
      let cached: LifecycleTaskResult | null = null,
        uploads = 0;
      const execute = vi.fn(async () => {
        cached = result;
        return result;
      });
      const pipeline = {
        root,
        execute,
        recover: async () => cached,
      } as unknown as SampleLifecycleAdapter;
      const transfer = new TransferringLifecyclePipeline(
        pipeline,
        new HttpLifecycleArtifactClient({
          origin: "http://127.0.0.1",
          token: "a".repeat(32),
          fetcher: async (_url, options) => {
            expect(JSON.parse(String(options?.body)).envelope).toEqual(
              envelope,
            );
            uploads++;
            if (uploads === 1) throw new Error("写入成功但确认丢失");
            return Response.json({
              data: { schemaVersion: 1, artifactDigest },
            });
          },
        }),
      );
      const journal = new MemoryLifecycleJournal(),
        complete = vi.fn(async () => {});
      const runtime = new LifecycleExecutorRuntime({
        client: {
          claim: async () => current,
          renew: async () => current,
          complete,
        },
        journal,
        privateKey: generateKeyPairSync("ed25519").privateKey,
        adapter: transfer,
      });
      await expect(runtime.tick()).rejects.toBeInstanceOf(
        LifecycleDeliveryUnavailableError,
      );
      expect((await journal.load())?.phase).toBe("executing");
      expect(await runtime.tick()).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(uploads).toBe(2);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(await journal.load()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("模型与执行结果先持久化；重建适配器恢复相同结果，输入变化和损坏回执拒绝", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-agent-receipt-"));
    try {
      const current = job(),
        result: LifecycleTaskResult = {
          status: "blocked",
          reason: "需要确认业务范围",
        },
        execute = vi.fn(async () => result);
      const inner = { execute, recover: async () => null };
      let adapter = new DurableLifecycleAdapter(root, inner);
      expect(await adapter.recover(current, signal())).toBeNull();
      expect(await adapter.execute(current, signal())).toEqual(result);
      adapter = new DurableLifecycleAdapter(root, inner);
      expect(await adapter.recover(current, signal())).toEqual(result);
      expect(await adapter.execute(current, signal())).toEqual(result);
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(
        adapter.recover({ ...current, inputDigest: "b".repeat(64) }, signal()),
      ).rejects.toThrow("摘要");
      expect(
        JSON.parse(
          await readFile(path.join(root, `${current.jobKey}.json`), "utf8"),
        ).schemaVersion,
      ).toBe(1);
      await savePrivateBytes(
        path.join(root, `${current.jobKey}.json`),
        Buffer.from("损坏"),
      );
      await expect(adapter.recover(current, signal())).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("配置显式选择本机 Codex，拒绝未知后端或多个适配器，不要求额外登录凭据", () => {
    const current = job(),
      project = {
        projectKey: current.input.projectKey,
        repositoryKey: current.input.repositoryKey,
        repositoryRoot: "/private/tmp/repo",
        worktreeRoot: "/private/tmp/worktrees",
        baseRef: "main",
        reasoningEffort: "low",
      };
    const base = {
      schemaVersion: 2,
      controlPlaneOrigin: "http://127.0.0.1",
      token: "a".repeat(32),
      privateKeyPath: "/private/tmp/key.pem",
      journalRoot: "/private/tmp/journal",
      sample: {
        schemaVersion: 1,
        root: "/private/tmp/pipeline",
        sourcePath: "/private/tmp/app.mjs",
      },
      execution: {
        schemaVersion: 1,
        provider: "codex",
        mode: "current_user",
        project,
        codexHomePath: "/Users/local/.codex",
        protectedPaths: ["/private/tmp/repo"],
      },
    };
    const config = LifecycleWorkerConfigSchema.parse(base);
    expect(config.execution?.provider).toBe("codex");
    if (process.platform === "darwin")
      expect(
        createLifecycleWorkerAdapter(config, ["/private/tmp/key.pem"]).adapter
          .constructor.name,
      ).toBe("CodexLifecycleAdapter");
    expect(() =>
      LifecycleWorkerConfigSchema.parse({
        ...base,
        execution: { ...base.execution, provider: "claude" },
      }),
    ).toThrow();
    expect(() =>
      LifecycleWorkerConfigSchema.parse({
        ...base,
        adapter: { endpoint: "https://example.com", token: "a".repeat(32) },
      }),
    ).toThrow();
    const remote = LifecycleWorkerConfigSchema.parse({
      ...base,
      sample: undefined,
      execution: undefined,
      adapter: { endpoint: "https://example.com", token: "a".repeat(32) },
    });
    expect(
      createLifecycleWorkerAdapter(remote, []).adapter.constructor.name,
    ).toBe("HttpLifecycleAdapter");
  });
});
