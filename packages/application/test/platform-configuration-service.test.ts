import { describe, expect, it } from "vitest";

import {
  ApplicationError,
  InMemoryPlatformConfigurationRepository,
  PlatformConfigurationService,
  type AuthenticatedPrincipal,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const administrator: AuthenticatedPrincipal = {
  actorKey: "22222222-2222-4222-8222-222222222222",
  actorName: "超级管理员",
  username: "super.admin",
  tenantKey,
  roles: ["administrator"],
};
const member: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "产品负责人",
  username: "product.owner",
  tenantKey,
  roles: ["product_owner"],
};

describe("客户、项目与代码仓库配置", () => {
  it("超级管理员可配置多个客户、项目和仓库路径", async () => {
    const service = new PlatformConfigurationService(
      new InMemoryPlatformConfigurationRepository(),
    );
    const customer = await service.createCustomer(administrator, {
      name: "保险事业群",
      summary: "负责保险客户的智能交付项目",
    });
    const firstProject = await service.createProject(
      administrator,
      customer.customerKey,
      { name: "智能质检平台", summary: "管理质检规则与模型交付" },
    );
    await service.createProject(administrator, customer.customerKey, {
      name: "营销视频平台",
      summary: "管理营销视频的需求与交付",
    });
    await service.createRepository(administrator, firstProject.projectKey, {
      name: "控制面",
      gitUrl: "https://gitee.com/example/control-plane.git",
      localPath: "D:\\forgex\\control-plane",
      defaultBranch: "main",
    });
    await service.createRepository(administrator, firstProject.projectKey, {
      name: "模型服务",
      gitUrl: "git@gitee.com:example/model-service.git",
      localPath: "/srv/forgex/model-service",
      defaultBranch: "master",
    });

    const overview = await service.list(administrator);

    expect(overview).toHaveLength(1);
    expect(overview[0]?.projects).toHaveLength(2);
    expect(overview[0]?.projects[0]?.repositories).toHaveLength(2);
    expect(overview[0]?.projects[0]?.repositories[0]).toMatchObject({
      name: "控制面",
      gitUrl: "https://gitee.com/example/control-plane.git",
      localPath: "D:\\forgex\\control-plane",
      defaultBranch: "main",
    });
  });

  it("配置支持修订检查，且普通成员不能读写平台资源", async () => {
    const service = new PlatformConfigurationService(
      new InMemoryPlatformConfigurationRepository(),
    );
    const customer = await service.createCustomer(administrator, {
      name: "零售事业群",
      summary: "负责零售客户项目",
    });

    await expect(service.list(member)).rejects.toMatchObject({
      statusCode: 403,
      code: "platform_configuration_admin_required",
    } satisfies Partial<ApplicationError>);
    await service.updateCustomer(administrator, customer.customerKey, {
      expectedRevision: 1,
      name: "零售与消费事业群",
      summary: "负责零售与消费行业客户项目",
      enabled: true,
    });
    await expect(
      service.updateCustomer(administrator, customer.customerKey, {
        expectedRevision: 1,
        name: "过期修改",
        summary: "这个修改使用了过期版本",
        enabled: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "platform_configuration_revision_conflict",
    } satisfies Partial<ApplicationError>);
  });

  it("完整支持资源改名、冲突保护和按层级安全删除", async () => {
    const service = new PlatformConfigurationService(
      new InMemoryPlatformConfigurationRepository(),
    );
    const customer = await service.createCustomer(administrator, {
      name: "制造事业群",
      summary: "负责制造客户项目",
    });
    const otherCustomer = await service.createCustomer(administrator, {
      name: "金融事业群",
      summary: "负责金融客户项目",
    });

    await expect(
      service.updateCustomer(administrator, customer.customerKey, {
        expectedRevision: 1,
        name: otherCustomer.name,
        summary: customer.summary,
        enabled: true,
      }),
    ).rejects.toMatchObject({
      code: "platform_configuration_conflict",
    } satisfies Partial<ApplicationError>);

    const project = await service.createProject(
      administrator,
      customer.customerKey,
      { name: "设备平台", summary: "负责设备交付" },
    );
    const otherProject = await service.createProject(
      administrator,
      customer.customerKey,
      { name: "数据平台", summary: "负责数据交付" },
    );
    await expect(
      service.createProject(administrator, customer.customerKey, {
        name: project.name,
        summary: "重复项目",
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });
    await expect(
      service.updateProject(administrator, project.projectKey, {
        expectedRevision: 1,
        name: otherProject.name,
        summary: project.summary,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });

    const repository = await service.createRepository(
      administrator,
      project.projectKey,
      {
        name: "Web 控制台",
        gitUrl: "https://gitee.com/example/web.git",
        localPath: "D:\\forgex\\web",
        defaultBranch: "main",
      },
    );
    const otherRepository = await service.createRepository(
      administrator,
      project.projectKey,
      {
        name: "API 服务",
        gitUrl: "git@gitee.com:example/api.git",
        localPath: "/srv/forgex/api",
        defaultBranch: "master",
      },
    );
    await expect(
      service.createRepository(administrator, project.projectKey, {
        name: "重复路径",
        gitUrl: "https://gitee.com/example/duplicate.git",
        localPath: "d:\\FORGEX\\WEB",
        defaultBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });
    await expect(
      service.updateRepository(administrator, repository.repositoryKey, {
        expectedRevision: 1,
        name: otherRepository.name,
        gitUrl: repository.gitUrl,
        localPath: repository.localPath,
        defaultBranch: "main",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });

    await expect(
      service.deleteCustomer(administrator, customer.customerKey, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });
    await expect(
      service.deleteProject(administrator, project.projectKey, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "platform_configuration_conflict" });

    const updatedRepository = await service.updateRepository(
      administrator,
      repository.repositoryKey,
      {
        expectedRevision: 1,
        name: "前端控制台",
        gitUrl: repository.gitUrl,
        localPath: repository.localPath,
        defaultBranch: "release",
        enabled: false,
      },
    );
    expect(updatedRepository).toMatchObject({ revision: 2, enabled: false });
    await expect(
      service.deleteRepository(administrator, repository.repositoryKey, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "platform_configuration_revision_conflict",
    });
    await service.deleteRepository(administrator, repository.repositoryKey, {
      expectedRevision: 2,
    });
    await service.deleteRepository(
      administrator,
      otherRepository.repositoryKey,
      { expectedRevision: 1 },
    );

    const updatedProject = await service.updateProject(
      administrator,
      project.projectKey,
      {
        expectedRevision: 1,
        name: "智能设备平台",
        summary: "负责智能设备交付",
        enabled: false,
      },
    );
    expect(updatedProject.revision).toBe(2);
    await expect(
      service.deleteProject(administrator, project.projectKey, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "platform_configuration_revision_conflict",
    });
    await service.deleteProject(administrator, project.projectKey, {
      expectedRevision: 2,
    });
    await service.deleteProject(administrator, otherProject.projectKey, {
      expectedRevision: 1,
    });

    const updatedCustomer = await service.updateCustomer(
      administrator,
      customer.customerKey,
      {
        expectedRevision: 1,
        name: "智能制造事业群",
        summary: "负责智能制造客户项目",
        enabled: false,
      },
    );
    expect(updatedCustomer.revision).toBe(2);
    await expect(
      service.deleteCustomer(administrator, customer.customerKey, {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({
      code: "platform_configuration_revision_conflict",
    });
    await service.deleteCustomer(administrator, customer.customerKey, {
      expectedRevision: 2,
    });
    expect(await service.list(administrator)).toHaveLength(1);
  });
});
