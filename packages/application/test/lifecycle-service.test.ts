import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalLifecycleJson,
  type LifecycleCompletionPayload,
} from "@forgex/contracts/lifecycle";
import {
  InMemoryLifecycleRepository,
  LifecycleService,
} from "../src/lifecycle-service.js";
import type { AuthenticatedPrincipal } from "../src/auth.js";

const tenantKey = randomUUID(),
  projectKey = randomUUID(),
  repositoryKey = randomUUID();
const requester: AuthenticatedPrincipal = {
  tenantKey,
  actorKey: randomUUID(),
  actorName: "需求方甲",
  roles: ["requester"],
};
const product: AuthenticatedPrincipal = {
  tenantKey,
  actorKey: randomUUID(),
  actorName: "产品负责人",
  roles: ["product_owner"],
};
const pair = generateKeyPairSync("ed25519");
const executor = {
  executorKey: randomUUID(),
  tenantKey,
  projectKey,
  repositoryKey,
  capabilities: ["requirements_ai" as const],
  publicKeyBase64: pair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64"),
};
const createCommand = () => ({
  schemaVersion: 2 as const,
  requestKey: randomUUID(),
  projectKey,
  repositoryKey,
  requesterKey: requester.actorKey,
  title: "预约需求",
  brief: "预约访客提交并获得预约编号",
});
const service = () =>
  new LifecycleService(new InMemoryLifecycleRepository(), {
    projectKey,
    repositoryKey,
  });
const output = {
  kind: "requirements" as const,
  summary: "需求方案已整理",
  spec: {
    schemaVersion: 1 as const,
    title: "预约需求",
    goal: "预约访客提交并获得编号",
    userStories: [{ role: "访客", need: "提交预约", value: "获得编号" }],
    acceptanceCriteria: [
      {
        title: "提交返回编号",
        description: "有效提交返回唯一编号",
        priority: "must" as const,
      },
    ],
    openQuestions: [],
  },
};

describe("生命周期服务权限与事务", () => {
  it("创建幂等，相同请求标识不能改写内容", async () => {
    const s = service(),
      command = createCommand();
    const first = await s.create(requester, command);
    const second = await s.create(requester, command);
    expect(second.workflowKey).toBe(first.workflowKey);
    await expect(
      s.create(requester, { ...command, title: "其他需求" }),
    ).rejects.toThrow("幂等");
  });
  it("外部需求方与其他租户不能读取不属于自己的需求", async () => {
    const s = service();
    const flow = await s.create(requester, createCommand());
    await expect(
      s.get({ ...requester, actorKey: randomUUID() }, flow.workflowKey),
    ).rejects.toThrow("未找到");
    await expect(
      s.get({ ...requester, tenantKey: randomUUID() }, flow.workflowKey),
    ).rejects.toThrow("未找到");
  });
  it("执行器跨仓库不能领取；完成结果必须验签", async () => {
    const s = service();
    await s.create(requester, createCommand());
    expect(
      await s.claim({ ...executor, repositoryKey: randomUUID() }),
    ).toBeNull();
    const job = (await s.claim(executor))!;
    const payload: LifecycleCompletionPayload = {
      schemaVersion: 2,
      jobKey: job.jobKey,
      fencingToken: job.fencingToken!,
      inputDigest: job.inputDigest,
      result: { status: "succeeded", output },
    };
    await expect(
      s.complete(executor, {
        payload,
        signatureBase64: Buffer.alloc(64).toString("base64"),
      }),
    ).rejects.toThrow("签名");
    const signatureBase64 = sign(
      null,
      Buffer.from(canonicalLifecycleJson(payload)),
      pair.privateKey,
    ).toString("base64");
    const result = await s.complete(executor, { payload, signatureBase64 });
    expect(result.stage).toBe("requirements_review");
    expect(
      (await s.complete(executor, { payload, signatureBase64 })).stage,
    ).toBe("requirements_review");
    expect(
      (await s.get(requester, job.input.workflowKey)).artifacts,
    ).toHaveLength(1);
  });
  it("并发领取只有一个执行器拿到任务", async () => {
    const s = service();
    await s.create(requester, createCommand());
    const results = await Promise.all([
      s.claim(executor),
      s.claim({ ...executor, executorKey: randomUUID() }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("旧版审批失败不会写入批准或跳过关卡", async () => {
    const s = service();
    const flow = await s.create(requester, createCommand());
    const job = (await s.claim(executor))!;
    const payload: LifecycleCompletionPayload = {
      schemaVersion: 2,
      jobKey: job.jobKey,
      fencingToken: job.fencingToken!,
      inputDigest: job.inputDigest,
      result: { status: "succeeded", output },
    };
    await s.complete(executor, {
      payload,
      signatureBase64: sign(
        null,
        Buffer.from(canonicalLifecycleJson(payload)),
        pair.privateKey,
      ).toString("base64"),
    });
    await expect(
      s.decide(product, flow.workflowKey, {
        schemaVersion: 2,
        requestKey: randomUUID(),
        expectedVersion: flow.version,
        role: "product_owner",
        decision: "approve",
        reason: "审核通过",
      }),
    ).rejects.toThrow("更新");
    const current = await s.get(product, flow.workflowKey);
    expect(current.stage).toBe("requirements_review");
    expect(current.approvals).toHaveLength(0);
  });
});
