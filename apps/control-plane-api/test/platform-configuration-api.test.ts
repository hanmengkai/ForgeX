import { describe, expect, it } from "vitest";

import {
  InMemoryExtensionCatalogRepository,
  InMemoryKnowledgeBaseRepository,
  InMemoryMcpInputSchemaStore,
  InMemoryMcpInvocationRepository,
  InMemoryMcpRegistryRepository,
  InMemoryPlatformConfigurationRepository,
  InMemoryProjectInitializationRepository,
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
    projectInitializationRepository:
      new InMemoryProjectInitializationRepository(),
    projectKey,
    repositoryKey: projectKey,
  });
};

describe("平台资源配置 API", () => {
  it("项目初始化通过显式幂等入口执行，页面读取不会隐式初始化", async () => {
    const app = createApp();
    const adminHeaders = { authorization: "Bearer admin-session" };
    const memberHeaders = { authorization: "Bearer member-session" };
    const customer = await app.inject({
      method: "POST",
      url: "/api/v1/platform/customers",
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        name: "个人项目",
        summary: "管理个人研发项目与标准 AI 交付准备",
      },
    });
    const project = await app.inject({
      method: "POST",
      url: customer.json().data.links.actions.createProject,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        name: "手串配置工具",
        summary: "用于搭配和预览手串的个人项目",
      },
    });
    const initializationUrl = project.json().data.links.initialization;
    const scopedExtensionsUrl = project.json().data.links.extensions;

    expect(initializationUrl).toMatch(
      /^\/api\/v1\/platform\/projects\/[0-9a-f-]+\/initialization$/u,
    );
    expect(project.json().data.links.actions.initialize).toBe(
      initializationUrl,
    );
    expect(scopedExtensionsUrl).toMatch(
      /^\/api\/v1\/projects\/[0-9a-f-]+\/extensions$/u,
    );

    const before = await app.inject({
      method: "GET",
      url: initializationUrl,
      headers: memberHeaders,
    });
    const repeatedRead = await app.inject({
      method: "GET",
      url: initializationUrl,
      headers: memberHeaders,
    });
    expect(before.statusCode).toBe(200);
    expect(repeatedRead.json()).toEqual(before.json());
    expect(before.json()).toMatchObject({
      data: {
        status: "not_started",
        preset: { key: "standard-delivery", version: 1 },
        tasks: [
          { key: "knowledge", status: "action_required" },
          { key: "skill", status: "action_required" },
          { key: "mcp", status: "action_required" },
        ],
        links: { actions: {} },
      },
    });

    const denied = await app.inject({
      method: "PUT",
      url: initializationUrl,
      headers: memberHeaders,
      payload: {
        schemaVersion: 1,
        presetKey: "standard-delivery",
        presetVersion: 1,
        requestKey: "55555555-5555-4555-8555-555555555555",
      },
    });
    expect(denied.statusCode).toBe(403);

    const initialized = await app.inject({
      method: "PUT",
      url: initializationUrl,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        presetKey: "standard-delivery",
        presetVersion: 1,
        requestKey: "55555555-5555-4555-8555-555555555555",
      },
    });
    const replay = await app.inject({
      method: "PUT",
      url: initializationUrl,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        presetKey: "standard-delivery",
        presetVersion: 1,
        requestKey: "66666666-6666-4666-8666-666666666666",
      },
    });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.json().data.status).toBe("action_required");
    expect(replay.json().data.record).toEqual(initialized.json().data.record);

    const extensions = await app.inject({
      method: "GET",
      url: scopedExtensionsUrl,
      headers: memberHeaders,
    });
    expect(extensions.statusCode).toBe(200);
    expect(extensions.json()).toMatchObject({
      data: { businessKnowledge: [], teamCapabilities: [], externalTools: [] },
    });
    expect(extensions.json().data.links.actions).toEqual({});

    const disabledProject = await app.inject({
      method: "PATCH",
      url: project.json().data.links.self,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        expectedRevision: 1,
        name: "手串配置工具",
        summary: "用于搭配和预览手串的个人项目",
        enabled: false,
      },
    });
    expect(disabledProject.statusCode).toBe(200);
    expect(
      await app.inject({
        method: "GET",
        url: initializationUrl,
        headers: adminHeaders,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      await app.inject({
        method: "GET",
        url: scopedExtensionsUrl,
        headers: adminHeaders,
      }),
    ).toMatchObject({ statusCode: 200 });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/platform/projects/77777777-7777-4777-8777-777777777777/initialization",
      headers: memberHeaders,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("普通成员可选择启用的客户项目仓库，并按项目隔离创建与查询需求", async () => {
    const app = createApp();
    const adminHeaders = { authorization: "Bearer admin-session" };
    const memberHeaders = { authorization: "Bearer member-session" };
    const customer = await app.inject({
      method: "POST",
      url: "/api/v1/platform/customers",
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        name: "保险客户",
        summary: "承载保险客户的多个交付项目",
      },
    });
    const createProjectUrl = customer.json().data.links.actions.createProject;
    const firstProject = await app.inject({
      method: "POST",
      url: createProjectUrl,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        name: "智能质检",
        summary: "保险双录质量检查项目",
      },
    });
    const secondProject = await app.inject({
      method: "POST",
      url: createProjectUrl,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        name: "营销视频",
        summary: "营销视频生成与管理项目",
      },
    });
    const firstRepository = await app.inject({
      method: "POST",
      url: firstProject.json().data.links.actions.createRepository,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        name: "控制面",
        gitUrl: "https://gitee.com/example/quality-control.git",
        localPath: "/data/work/quality-control",
        defaultBranch: "master",
      },
    });
    await app.inject({
      method: "POST",
      url: secondProject.json().data.links.actions.createRepository,
      headers: adminHeaders,
      payload: {
        schemaVersion: 1,
        name: "视频服务",
        gitUrl: "https://gitee.com/example/video-service.git",
        localPath: "/data/work/video-service",
        defaultBranch: "main",
      },
    });

    const contexts = await app.inject({
      method: "GET",
      url: "/api/v1/requirement-contexts",
      headers: memberHeaders,
    });
    expect(contexts.statusCode).toBe(200);
    expect(contexts.json()).toMatchObject({
      data: [
        {
          name: "保险客户",
          projects: [
            {
              name: "智能质检",
              repositories: [
                {
                  name: "控制面",
                  links: {
                    actions: {
                      createRequirement: expect.stringMatching(
                        /^\/api\/v1\/projects\/[0-9a-f-]+\/repositories\/[0-9a-f-]+\/requirements$/u,
                      ),
                    },
                  },
                },
              ],
              links: {
                requirements: expect.stringMatching(
                  /^\/api\/v1\/projects\/[0-9a-f-]+\/requirements$/u,
                ),
              },
            },
            { name: "营销视频" },
          ],
        },
      ],
    });
    expect(contexts.body).not.toContain("projectKey");
    expect(contexts.body).not.toContain("repositoryKey");
    expect(contexts.body).not.toContain("localPath");
    expect(contexts.body).not.toContain("gitUrl");

    const quality = contexts.json().data[0].projects[0];
    const video = contexts.json().data[0].projects[1];
    const created = await app.inject({
      method: "POST",
      url: quality.repositories[0].links.actions.createRequirement,
      headers: memberHeaders,
      payload: {
        schemaVersion: 1,
        title: "保单质检规则",
        goal: "让质检人员可以按保险项目管理规则",
        userStories: [],
        acceptanceCriteria: [
          {
            title: "项目内可见",
            description: "需求只出现在所属项目列表中",
            priority: "must",
          },
        ],
        openQuestions: [],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toMatch(
      /^\/api\/v1\/projects\/[0-9a-f-]+\/requirements\/[0-9a-f-]+$/u,
    );

    const qualityRequirements = await app.inject({
      method: "GET",
      url: quality.links.requirements,
      headers: memberHeaders,
    });
    const videoRequirements = await app.inject({
      method: "GET",
      url: video.links.requirements,
      headers: memberHeaders,
    });
    expect(qualityRequirements.json().data).toHaveLength(1);
    expect(qualityRequirements.json().data[0].links.self).toBe(
      created.headers.location,
    );
    expect(videoRequirements.json().data).toHaveLength(0);

    const detail = await app.inject({
      method: "GET",
      url: created.headers.location!,
      headers: memberHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.spec.title).toBe("保单质检规则");
    const revised = await app.inject({
      method: "POST",
      url: `${created.headers.location}/revisions`,
      headers: memberHeaders,
      payload: {
        schemaVersion: 1,
        expectedRevision: 1,
        spec: {
          ...detail.json().data.spec,
          goal: "让质检人员按保险项目维护并交付质检规则",
        },
      },
    });
    expect(revised.statusCode).toBe(200);
    const revisions = await app.inject({
      method: "GET",
      url: `${created.headers.location}/revisions`,
      headers: memberHeaders,
    });
    expect(revisions.json().data).toHaveLength(2);
    expect(
      await app.inject({
        method: "POST",
        url: `${created.headers.location}/submit-confirmation`,
        headers: memberHeaders,
        payload: {},
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      await app.inject({
        method: "POST",
        url: `${created.headers.location}/confirm`,
        headers: memberHeaders,
        payload: {},
      }),
    ).toMatchObject({ statusCode: 200 });
    const delivery = await app.inject({
      method: "POST",
      url: `${created.headers.location}/start-delivery`,
      headers: memberHeaders,
      payload: { schemaVersion: 1, requiredCapabilities: [] },
    });
    expect(delivery.statusCode).toBe(202);
    expect(delivery.json()).toMatchObject({
      data: { status: "等待空闲设备" },
    });
    const previewBeforeVerification = await app.inject({
      method: "GET",
      url: `${created.headers.location}/preview`,
      headers: memberHeaders,
    });
    expect(previewBeforeVerification.statusCode).toBe(409);
    expect(previewBeforeVerification.json()).toMatchObject({
      error: { code: "preview_not_ready" },
    });
    const acceptBeforeVerification = await app.inject({
      method: "POST",
      url: `${created.headers.location}/accept`,
      headers: memberHeaders,
      payload: {},
    });
    expect(acceptBeforeVerification.statusCode).toBe(409);
    expect(acceptBeforeVerification.json()).toMatchObject({
      error: { code: "requirement_state_conflict" },
    });

    const wrongProjectCreateUrl =
      `${video.links.requirements.replace(/\/requirements$/u, "")}` +
      `/repositories/${firstRepository.json().data.links.self.split("/").at(-1)}/requirements`;
    const mismatched = await app.inject({
      method: "POST",
      url: wrongProjectCreateUrl,
      headers: memberHeaders,
      payload: {
        schemaVersion: 1,
        title: "跨项目需求",
        goal: "验证仓库不能跨项目绑定",
        userStories: [],
        acceptanceCriteria: [
          {
            title: "拒绝跨项目",
            description: "服务端校验仓库真实归属",
            priority: "must",
          },
        ],
        openQuestions: [],
      },
    });
    expect(mismatched.statusCode).toBe(404);
    expect(mismatched.json()).toMatchObject({
      error: { code: "requirement_context_not_found" },
    });
    await app.close();
  });

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
