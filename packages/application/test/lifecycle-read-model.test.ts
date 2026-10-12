import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  LifecycleService,
  InMemoryLifecycleRepository,
} from "../src/lifecycle-service.js";
import { LifecycleWorkflow } from "@forgex/domain";
describe("交付材料结构化阅读模型", () => {
  it("设计正文和前版差异提供版本化段落，需求方不能读取内部设计", async () => {
    const tenantKey = randomUUID(),
      projectKey = randomUUID(),
      repositoryKey = randomUUID(),
      actorKey = randomUUID();
    const flow = LifecycleWorkflow.create({
      tenantKey,
      projectKey,
      repositoryKey,
      requesterKey: actorKey,
      createdBy: actorKey,
      title: "预约",
      brief: "业务需求",
    });
    const snapshot = flow.toSnapshot(),
      oldKey = randomUUID(),
      newKey = randomUUID();
    const artifact = (artifactKey: string, architecture: string) => ({
      artifactKey,
      jobKey: randomUUID(),
      executorKey: randomUUID(),
      createdAt: new Date().toISOString(),
      contentDigest: "a".repeat(64),
      output: {
        kind: "design" as const,
        summary: "设计方案",
        architecture,
        interfaces: ["POST /appointments"],
        migrations: [],
        testStrategy: ["验证幂等"],
        rolloutPlan: "先测试再发布",
      },
    });
    snapshot.artifacts = [
      artifact(oldKey, "内存存储"),
      artifact(newKey, "文件持久化"),
    ];
    snapshot.current.design = newKey;
    const repository = new InMemoryLifecycleRepository();
    await repository.transaction(tenantKey, (s) => s.workflows.push(snapshot));
    const service = new LifecycleService(repository, {
      projectKey,
      repositoryKey,
    });
    const principal = {
      tenantKey,
      actorKey,
      actorName: "研发",
      username: "developer",
      roles: ["developer" as const],
    };
    const view = await service.get(principal, snapshot.workflowKey),
      document = view.artifacts[0]!.document;
    expect(document?.schemaVersion).toBe(1);
    expect(document?.sections[0]).toMatchObject({
      title: "架构设计",
      paragraphs: ["文件持久化"],
    });
    expect(document?.changes?.added).toContain("架构设计：文件持久化");
    expect(document?.changes?.removed).toContain("架构设计：内存存储");
    expect(
      (
        await service.get(
          { ...principal, roles: ["requester"] },
          snapshot.workflowKey,
        )
      ).artifacts,
    ).toHaveLength(0);
  });
});
