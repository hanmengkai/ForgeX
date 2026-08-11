import { describe, expect, it } from "vitest";

import {
  InMemoryExtensionCatalogRepository,
  InMemoryKnowledgeBaseRepository,
  InMemoryMcpInputSchemaStore,
  InMemoryMcpInvocationRepository,
  InMemoryMcpRegistryRepository,
  InMemoryPlatformConfigurationRepository,
  InMemoryPreviewArtifactStore,
  InMemoryRequirementRepository,
  InMemorySkillArtifactStore,
  InMemorySkillRegistryRepository,
  InMemoryWorkerFleetRepository,
  type AuthenticatedPrincipal,
  type SessionAuthenticator,
} from "@forgex/application";
import { EvidenceAuthority } from "@forgex/domain";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";

import { buildControlPlaneApi } from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const principals = new Map<string, AuthenticatedPrincipal>([
  [
    "admin-session",
    {
      actorKey: "33333333-3333-4333-8333-333333333333",
      actorName: "超级管理员",
      tenantKey,
      roles: ["administrator"],
    },
  ],
  [
    "member-session",
    {
      actorKey: "44444444-4444-4444-8444-444444444444",
      actorName: "产品负责人",
      tenantKey,
      roles: ["product_owner"],
    },
  ],
]);

const createApp = () => {
  const authenticator: SessionAuthenticator = {
    authenticate: async (authorization) =>
      authorization?.startsWith("Bearer ")
        ? (principals.get(authorization.slice("Bearer ".length)) ?? null)
        : null,
  };
  return buildControlPlaneApi({
    authenticator,
    runnerAuthenticator: { authenticate: async () => null },
    evidenceAuthority: new EvidenceAuthority({ runners: [] }),
    extensionCatalogRepository: new InMemoryExtensionCatalogRepository(),
    knowledgeBaseRepository: new InMemoryKnowledgeBaseRepository(),
    mcpRegistryRepository: new InMemoryMcpRegistryRepository(),
    mcpHealthAuthority: new McpHealthAuthority({ verifiers: [] }),
    mcpInputSchemaStore: new InMemoryMcpInputSchemaStore(),
    mcpInvocationRepository: new InMemoryMcpInvocationRepository(),
    skillRegistryRepository: new InMemorySkillRegistryRepository(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    skillEvaluationAuthority: new SkillEvaluationAuthority({ evaluators: [] }),
    requirementRepository: new InMemoryRequirementRepository(),
    previewArtifactStore: new InMemoryPreviewArtifactStore(),
    workerFleetRepository: new InMemoryWorkerFleetRepository(),
    platformConfigurationRepository:
      new InMemoryPlatformConfigurationRepository(),
    projectKey,
    repositoryKey: projectKey,
  });
};

describe("平台资源配置 API", () => {
  it("超级管理员可通过版本化 API 创建客户、项目和多个仓库", async () => {
    const app = createApp();
    const headers = { authorization: "Bearer admin-session" };
    const customer = await app.inject({
      method: "POST",
      url: "/api/v1/platform/customers",
      headers,
      payload: {
        schemaVersion: 1,
        name: "保险事业群",
        summary: "负责保险客户的智能交付项目",
      },
    });
    expect(customer.statusCode).toBe(201);
    const createProjectUrl = customer.json().data.links.actions.createProject;

    const project = await app.inject({
      method: "POST",
      url: createProjectUrl,
      headers,
      payload: {
        schemaVersion: 1,
        name: "智能质检平台",
        summary: "管理质检规则与模型交付",
      },
    });
    expect(project.statusCode).toBe(201);
    const createRepositoryUrl =
      project.json().data.links.actions.createRepository;

    const invalidRepository = await app.inject({
      method: "POST",
      url: createRepositoryUrl,
      headers,
      payload: {
        schemaVersion: 1,
        name: "相对路径仓库",
        gitUrl: "https://gitee.com/example/invalid.git",
        localPath: "./invalid",
        defaultBranch: "main",
      },
    });
    expect(invalidRepository.statusCode).toBe(422);
    expect(invalidRepository.json()).toMatchObject({
      error: {
        code: "validation_error",
        details: [
          {
            field: "localPath",
            message: "本地路径必须是 Windows、UNC 或 Linux 绝对路径",
          },
        ],
      },
    });

    for (const repository of [
      {
        name: "控制面",
        gitUrl: "https://gitee.com/example/control-plane.git",
        localPath: "D:\\forgex\\control-plane",
        defaultBranch: "main",
      },
      {
        name: "模型服务",
        gitUrl: "git@gitee.com:example/model-service.git",
        localPath: "/srv/forgex/model-service",
        defaultBranch: "master",
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: createRepositoryUrl,
        headers,
        payload: { schemaVersion: 1, ...repository },
      });
      expect(response.statusCode).toBe(201);
    }

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/platform/customers",
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0].projects[0].repositories).toHaveLength(2);
    expect(listed.body).not.toContain("tenantKey");
    await app.close();
  });

  it("普通成员不能读取平台资源配置", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/platform/customers",
      headers: { authorization: "Bearer member-session" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "platform_configuration_admin_required" },
    });
    await app.close();
  });
});
