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
    await service.createRepository(
      administrator,
      firstProject.projectKey,
      {
        name: "控制面",
        gitUrl: "https://gitee.com/example/control-plane.git",
        localPath: "D:\\forgex\\control-plane",
        defaultBranch: "main",
      },
    );
    await service.createRepository(
      administrator,
      firstProject.projectKey,
      {
        name: "模型服务",
        gitUrl: "git@gitee.com:example/model-service.git",
        localPath: "/srv/forgex/model-service",
        defaultBranch: "master",
      },
    );

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
});
