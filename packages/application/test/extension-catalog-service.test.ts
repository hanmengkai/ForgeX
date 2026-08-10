import { describe, expect, it } from "vitest";

import {
  ExtensionCatalogApplicationService,
  InMemoryExtensionCatalogRepository,
  type AuthenticatedPrincipal,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const principal: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "初级研发",
  tenantKey,
  roles: ["developer"],
};

describe("ExtensionCatalogApplicationService", () => {
  it("按项目返回三类人性化扩展，并只用链接承载内部标识", async () => {
    const repository = new InMemoryExtensionCatalogRepository();
    await repository.publish({
      schemaVersion: 1,
      extensionKey: "44444444-4444-4444-8444-444444444444",
      tenantKey,
      projectKey,
      revision: 1,
      kind: "mcp",
      name: "代码仓库工具",
      summary: "读取代码、创建交付分支并运行受控检查",
      status: "ready",
      transport: "stdio",
      capabilities: ["查看代码", "创建交付分支"],
      approvalMode: "always_review",
      lastCheckedAt: null,
    });
    const service = new ExtensionCatalogApplicationService({
      repository,
      projectKey,
    });

    const overview = await service.overviewForPeople(principal);

    expect(overview).toEqual({
      businessKnowledge: [],
      teamCapabilities: [],
      externalTools: [
        {
          name: "代码仓库工具",
          summary: "读取代码、创建交付分支并运行受控检查",
          status: "可使用",
          detail: "2 项业务能力",
          supportingText: "每次使用前都要确认",
          links: {
            self: "/api/v1/extensions/44444444-4444-4444-8444-444444444444",
          },
        },
      ],
    });
    expect(JSON.stringify(overview)).not.toContain("stdio");
    expect(JSON.stringify(overview)).not.toContain("extensionKey");
  });

  it("同一共享仓储不会把其他租户或项目的扩展混入当前目录", async () => {
    const repository = new InMemoryExtensionCatalogRepository();
    const entry = {
      schemaVersion: 1 as const,
      extensionKey: "44444444-4444-4444-8444-444444444444",
      tenantKey,
      projectKey,
      revision: 1,
      kind: "knowledge" as const,
      name: "访客业务资料",
      summary: "物业访客预约的规则和历史决策",
      status: "ready" as const,
      sourceCount: 3,
      classification: "team" as const,
      lastSyncedAt: null,
    };
    await repository.publish(entry);
    await repository.publish({
      ...entry,
      extensionKey: "55555555-5555-4555-8555-555555555555",
      projectKey: "66666666-6666-4666-8666-666666666666",
      name: "另一个项目资料",
    });
    const service = new ExtensionCatalogApplicationService({
      repository,
      projectKey,
    });

    await expect(service.overviewForPeople(principal)).resolves.toMatchObject({
      businessKnowledge: [{ name: "访客业务资料" }],
    });
  });

  it("一次无效发布不会阻塞同项目后续的有效扩展", async () => {
    const repository = new InMemoryExtensionCatalogRepository();
    const valid = {
      schemaVersion: 1 as const,
      extensionKey: "44444444-4444-4444-8444-444444444444",
      tenantKey,
      projectKey,
      revision: 1,
      kind: "knowledge" as const,
      name: "访客业务资料",
      summary: "物业访客预约的规则和历史决策",
      status: "ready" as const,
      sourceCount: 3,
      classification: "team" as const,
      lastSyncedAt: null,
    };

    await expect(repository.publish({ ...valid, revision: 2 })).rejects.toThrow(
      "扩展必须从第一个版本开始发布",
    );
    await expect(repository.publish(valid)).resolves.toBeUndefined();
    await expect(repository.list(tenantKey, projectKey)).resolves.toHaveLength(
      1,
    );
  });

  it("保存最新版本后仍能继续升级并发布同项目的其他扩展", async () => {
    const repository = new InMemoryExtensionCatalogRepository();
    const knowledge = {
      schemaVersion: 1 as const,
      extensionKey: "44444444-4444-4444-8444-444444444444",
      tenantKey,
      projectKey,
      revision: 1,
      kind: "knowledge" as const,
      name: "访客业务资料",
      summary: "物业访客预约的规则和历史决策",
      status: "ready" as const,
      sourceCount: 3,
      classification: "team" as const,
      lastSyncedAt: null,
    };

    await repository.publish(knowledge);
    await repository.publish({ ...knowledge, revision: 2, sourceCount: 4 });
    await repository.publish({ ...knowledge, revision: 3, sourceCount: 5 });
    await repository.publish({
      ...knowledge,
      extensionKey: "55555555-5555-4555-8555-555555555555",
      name: "交付规范资料",
      revision: 1,
    });

    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revision: 3, sourceCount: 5 }),
        expect.objectContaining({ revision: 1, name: "交付规范资料" }),
      ]),
    );
    const service = new ExtensionCatalogApplicationService({
      repository,
      projectKey,
    });
    await expect(service.overviewForPeople(principal)).resolves.toMatchObject({
      businessKnowledge: [
        { name: "交付规范资料" },
        { name: "访客业务资料", detail: "已整理 5 份资料" },
      ],
    });
  });

  it("并发发布同一版本保持幂等，冲突内容只有一份能生效", async () => {
    const repository = new InMemoryExtensionCatalogRepository();
    const base = {
      schemaVersion: 1 as const,
      extensionKey: "44444444-4444-4444-8444-444444444444",
      tenantKey,
      projectKey,
      revision: 1,
      kind: "knowledge" as const,
      name: "访客业务资料",
      summary: "物业访客预约的规则和历史决策",
      status: "ready" as const,
      sourceCount: 3,
      classification: "team" as const,
      lastSyncedAt: null,
    };
    await repository.publish(base);
    const revisionTwo = { ...base, revision: 2, sourceCount: 4 };

    await expect(
      Promise.all([
        repository.publish(revisionTwo),
        repository.publish(revisionTwo),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    const conflicting = await Promise.allSettled([
      repository.publish({ ...base, revision: 3, sourceCount: 5 }),
      repository.publish({ ...base, revision: 3, sourceCount: 6 }),
    ]);
    expect(
      conflicting.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      conflicting.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(repository.list(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({ revision: 3, sourceCount: 5 }),
    ]);
  });
});
