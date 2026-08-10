import { describe, expect, it } from "vitest";

import { ExtensionCatalog, ExtensionCatalogEntrySchema } from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const knowledgeKey = "33333333-3333-4333-8333-333333333333";
const skillKey = "44444444-4444-4444-8444-444444444444";
const mcpKey = "55555555-5555-4555-8555-555555555555";

const knowledge = {
  schemaVersion: 1 as const,
  extensionKey: knowledgeKey,
  tenantKey,
  projectKey,
  revision: 1,
  kind: "knowledge" as const,
  name: "访客业务资料",
  summary: "物业访客预约的规则、术语和历史决策",
  status: "ready" as const,
  sourceCount: 12,
  classification: "team" as const,
  lastSyncedAt: "2026-08-10T06:00:00.000Z",
};

const skill = {
  schemaVersion: 1 as const,
  extensionKey: skillKey,
  tenantKey,
  projectKey,
  revision: 1,
  kind: "skill" as const,
  name: "需求风险检查",
  summary: "在进入开发前检查遗漏、歧义和高风险变更",
  status: "ready" as const,
  version: "1.3.0",
  compatibleBlueprints: ["Web 应用", "内部管理系统"],
  successRate: 94,
  evaluationCount: 126,
  updatedAt: "2026-08-10T06:00:00.000Z",
};

const mcp = {
  schemaVersion: 1 as const,
  extensionKey: mcpKey,
  tenantKey,
  projectKey,
  revision: 1,
  kind: "mcp" as const,
  name: "代码仓库工具",
  summary: "读取代码、创建交付分支并运行受控检查",
  status: "ready" as const,
  transport: "streamable_http" as const,
  capabilities: ["查看代码", "创建交付分支", "运行代码检查"],
  approvalMode: "automatic_read" as const,
  lastCheckedAt: "2026-08-10T06:00:00.000Z",
};

describe("ExtensionCatalog", () => {
  it("把知识、Skill 和 MCP 转成人能理解的三类能力", () => {
    const catalog = new ExtensionCatalog({ tenantKey, projectKey });
    catalog.publish(knowledge);
    catalog.publish(skill);
    catalog.publish(mcp);

    expect(catalog.listForPeople()).toEqual([
      {
        extensionKey: knowledgeKey,
        kind: "knowledge",
        view: {
          name: "访客业务资料",
          summary: "物业访客预约的规则、术语和历史决策",
          status: "可使用",
          detail: "已整理 12 份资料",
          supportingText: "项目成员可使用",
        },
      },
      {
        extensionKey: skillKey,
        kind: "skill",
        view: {
          name: "需求风险检查",
          summary: "在进入开发前检查遗漏、歧义和高风险变更",
          status: "可使用",
          detail: "版本 1.3.0 · 已验证 126 次",
          supportingText: "成功率 94%",
        },
      },
      {
        extensionKey: mcpKey,
        kind: "mcp",
        view: {
          name: "代码仓库工具",
          summary: "读取代码、创建交付分支并运行受控检查",
          status: "可使用",
          detail: "3 项业务能力",
          supportingText: "读取自动放行，变更需要确认",
        },
      },
    ]);
  });

  it("按租户和项目隔离，并阻止同版本覆盖或跳版本", () => {
    const catalog = new ExtensionCatalog({ tenantKey, projectKey });
    catalog.publish(knowledge);
    expect(() =>
      catalog.publish({ ...knowledge, summary: "被偷偷替换" }),
    ).toThrow("同一版本的扩展内容不能被覆盖");
    expect(() => catalog.publish({ ...knowledge, revision: 3 })).toThrow(
      "扩展版本必须连续发布",
    );
    expect(() =>
      catalog.publish({
        ...knowledge,
        extensionKey: "66666666-6666-4666-8666-666666666666",
        projectKey: "77777777-7777-4777-8777-777777777777",
      }),
    ).toThrow("扩展不属于当前租户和项目");
  });

  it("从持久化的最新版本恢复后仍能连续发布", () => {
    const catalog = ExtensionCatalog.restoreLatest({ tenantKey, projectKey }, [
      { ...knowledge, revision: 2, summary: "已经补充过一次的业务资料" },
    ]);

    catalog.publish({
      ...knowledge,
      revision: 3,
      summary: "已经补充过两次的业务资料",
    });
    catalog.publish(skill);

    expect(catalog.list()).toEqual([
      expect.objectContaining({ extensionKey: knowledgeKey, revision: 3 }),
      expect.objectContaining({ extensionKey: skillKey, revision: 1 }),
    ]);
  });

  it("恢复最新快照时仍拒绝跨范围和重复名称记录", () => {
    expect(() =>
      ExtensionCatalog.restoreLatest({ tenantKey, projectKey }, [
        knowledge,
        {
          ...knowledge,
          extensionKey: "66666666-6666-4666-8666-666666666666",
        },
      ]),
    ).toThrow("同一类扩展不能使用重复名称");
    expect(() =>
      ExtensionCatalog.restoreLatest({ tenantKey, projectKey }, [
        {
          ...knowledge,
          projectKey: "77777777-7777-4777-8777-777777777777",
        },
      ]),
    ).toThrow("扩展不属于当前租户和项目");
  });

  it("运行时契约拒绝未知字段、裸技术名和无界数组", () => {
    expect(
      ExtensionCatalogEntrySchema.safeParse({
        ...mcp,
        name: "execute_sql()",
      }).success,
    ).toBe(false);
    expect(
      ExtensionCatalogEntrySchema.safeParse({
        ...skill,
        compatibleBlueprints: Array.from(
          { length: 21 },
          (_, index) => `方案 ${index + 1}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      ExtensionCatalogEntrySchema.safeParse({ ...knowledge, secret: "token" })
        .success,
    ).toBe(false);
  });
});
