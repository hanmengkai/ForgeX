import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LifecycleWorkflow } from "@forgex/domain";
import {
  canonicalLifecycleJson,
  type LifecycleJob,
  type LifecycleTaskResult,
} from "@forgex/contracts/lifecycle";
import {
  FileLifecycleJournal,
  HttpLifecycleAdapter,
  LifecycleExecutorRuntime,
  MemoryLifecycleJournal,
} from "../src/lifecycle-runtime.js";

const output = {
  kind: "requirements" as const,
  summary: "已整理样板需求",
  spec: {
    schemaVersion: 1 as const,
    title: "预约样板",
    goal: "提交预约获取编号",
    userStories: [{ role: "访客", need: "预约", value: "到访" }],
    acceptanceCriteria: [
      {
        title: "获得预约编号",
        description: "提交后得到唯一编号",
        priority: "must" as const,
      },
    ],
    openQuestions: [],
  },
};
const job = (): LifecycleJob =>
  LifecycleWorkflow.create({
    tenantKey: randomUUID(),
    projectKey: randomUUID(),
    repositoryKey: randomUUID(),
    requesterKey: randomUUID(),
    title: "预约样板",
    brief: "提交预约获取编号",
    createdBy: randomUUID(),
  }).claim({
    executorKey: randomUUID(),
    capabilities: ["requirements_ai"],
    leaseMs: 60_000,
  })!;
describe("生命周期执行与回调恢复", () => {
  it("签名实际结果；确认响应丢失后只补发，不重复执行", async () => {
    const journal = new MemoryLifecycleJournal();
    let calls = 0,
      receipts = 0;
    const current = job();
    const pair = generateKeyPairSync("ed25519");
    const client = {
      claim: async () => current,
      renew: async () => current,
      complete: async (completion: {
        payload: unknown;
        signatureBase64: string;
      }) => {
        expect(
          verify(
            null,
            Buffer.from(canonicalLifecycleJson(completion.payload)),
            pair.publicKey,
            Buffer.from(completion.signatureBase64, "base64"),
          ),
        ).toBe(true);
        if (++receipts === 1) throw new Error("确认响应丢失");
      },
    };
    const adapter = {
      execute: async (): Promise<LifecycleTaskResult> => {
        calls++;
        return { status: "succeeded", output };
      },
    };
    const runtime = new LifecycleExecutorRuntime({
      client,
      adapter,
      journal,
      privateKey: pair.privateKey,
    });
    await expect(runtime.tick()).rejects.toThrow("确认响应丢失");
    expect(journal.pending?.phase).toBe("completed");
    expect(await runtime.tick()).toBe(true);
    expect(calls).toBe(1);
    expect(receipts).toBe(2);
    expect(journal.pending).toBeNull();
  });
  it("未知的中断副作用不会自动重复发布，而是报告阻塞", async () => {
    const journal = new MemoryLifecycleJournal();
    await journal.save({
      schemaVersion: 2,
      phase: "executing",
      job: job(),
      completion: null,
    });
    let calls = 0;
    let result: LifecycleTaskResult | null = null;
    const pair = generateKeyPairSync("ed25519");
    const current = journal.pending!.job;
    const runtime = new LifecycleExecutorRuntime({
      journal,
      privateKey: pair.privateKey,
      client: {
        claim: async () => null,
        renew: async () => current,
        complete: async (c) => {
          result = c.payload.result;
        },
      },
      adapter: {
        execute: async () => {
          calls++;
          return { status: "succeeded", output };
        },
      },
    });
    await runtime.tick();
    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: "blocked" });
  });
  it("执行适配器异常记录失败，不能默认为成功", async () => {
    let result: LifecycleTaskResult | null = null;
    const pair = generateKeyPairSync("ed25519");
    const current = job();
    const runtime = new LifecycleExecutorRuntime({
      journal: new MemoryLifecycleJournal(),
      privateKey: pair.privateKey,
      client: {
        claim: async () => current,
        renew: async () => current,
        complete: async (c) => {
          result = c.payload.result;
        },
      },
      adapter: {
        execute: async () => {
          throw new Error("部署失败：password=secret-value");
        },
      },
    });
    await runtime.tick();
    expect(result).toMatchObject({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
  it("磁盘日志重启恢复结果，多个实例不能同时持有同一日志", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-p0-journal-"));
    try {
      const journal = new FileLifecycleJournal(path.join(root, "executor"));
      const release = await journal.acquire();
      await expect(
        new FileLifecycleJournal(journal.root).acquire(),
      ).rejects.toThrow("已有持有者");
      const pending = {
        schemaVersion: 2 as const,
        phase: "executing" as const,
        job: job(),
        completion: null,
      };
      await journal.save(pending);
      expect(await new FileLifecycleJournal(journal.root).load()).toEqual(
        pending,
      );
      await release();
      const releaseAgain = await new FileLifecycleJournal(
        journal.root,
      ).acquire();
      await releaseAgain();
      await journal.clear();
      expect(await journal.load()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("拒绝符号链接日志和其他身份可读的日志目录", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forgex-p0-private-"));
    try {
      await symlink(
        root,
        path.join(root, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        new FileLifecycleJournal(path.join(root, "alias")).initialize(),
      ).rejects.toThrow("符号链接");
      if (process.platform !== "win32") {
        await chmod(root, 0o755);
        await expect(
          new FileLifecycleJournal(root).initialize(),
        ).rejects.toThrow("只能由执行身份");
      }
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("受控网关使用固定 HTTPS 入口、任务幂等键和只查询恢复模式", async () => {
    expect(
      () =>
        new HttpLifecycleAdapter({
          endpoint: "http://external.example.test/execute",
          token: "a".repeat(32),
        }),
    ).toThrow("HTTPS");
    const current = job();
    const adapter = new HttpLifecycleAdapter({
      endpoint: "https://pipeline.example.test/execute",
      token: "a".repeat(32),
      fetcher: async (url, options) => {
        expect(String(url)).toBe("https://pipeline.example.test/execute");
        expect(options?.redirect).toBe("error");
        expect(new Headers(options?.headers).get("idempotency-key")).toBe(
          current.jobKey,
        );
        expect(JSON.parse(String(options?.body)).recoverOnly).toBe(true);
        return Response.json({
          status: "blocked",
          reason: "外部记录不存在，尚未再次执行",
        });
      },
    });
    expect(
      await adapter.recover(current, new AbortController().signal),
    ).toMatchObject({ status: "blocked" });
  });
});
