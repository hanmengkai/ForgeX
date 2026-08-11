import { describe, expect, it } from "vitest";

import {
  AccountAdministrationService,
  ApplicationError,
  InMemoryAccountRepository,
  type AuthenticatedPrincipal,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const adminKey = "22222222-2222-4222-8222-222222222222";
const memberKey = "33333333-3333-4333-8333-333333333333";

const administrator: AuthenticatedPrincipal = {
  actorKey: adminKey,
  actorName: "超级管理员",
  username: "super.admin",
  tenantKey,
  roles: ["administrator"],
};

const repository = () =>
  new InMemoryAccountRepository([
    {
      accountKey: adminKey,
      tenantKey,
      username: "super.admin",
      actorName: "超级管理员",
      roles: ["administrator"],
      password: "Admin-Password-2026!",
      enabled: true,
      revision: 1,
    },
    {
      accountKey: memberKey,
      tenantKey,
      username: "product.owner",
      actorName: "产品负责人",
      roles: ["product_owner"],
      password: "Owner-Password-2026!",
      enabled: true,
      revision: 1,
    },
  ]);

describe("平台账号管理", () => {
  it("使用账号密码认证，且停用账号和错误密码不能建立会话", async () => {
    const accounts = repository();
    const service = new AccountAdministrationService(accounts);

    await expect(
      service.authenticate({
        username: "product.owner",
        password: "Owner-Password-2026!",
      }),
    ).resolves.toMatchObject({
      actorName: "产品负责人",
      username: "product.owner",
      roles: ["product_owner"],
    });
    await expect(
      service.authenticate({
        username: "product.owner",
        password: "wrong-password",
      }),
    ).resolves.toBeNull();

    await accounts.update(tenantKey, memberKey, {
      expectedRevision: 1,
      actorName: "产品负责人",
      roles: ["product_owner"],
      enabled: false,
    });
    await expect(
      service.authenticate({
        username: "product.owner",
        password: "Owner-Password-2026!",
      }),
    ).resolves.toBeNull();
  });

  it("超级管理员可以创建、查看、修改和删除同租户账号", async () => {
    const service = new AccountAdministrationService(repository());
    const created = await service.create(administrator, {
      username: "developer.one",
      actorName: "研发一号",
      roles: ["developer"],
      password: "Developer-Password-2026!",
    });
    expect(created).toMatchObject({
      username: "developer.one",
      actorName: "研发一号",
      enabled: true,
      revision: 1,
    });
    expect(JSON.stringify(created)).not.toContain("password");

    const listed = await service.list(administrator);
    expect(listed.map((account) => account.username)).toEqual([
      "developer.one",
      "product.owner",
      "super.admin",
    ]);

    const updated = await service.update(administrator, created.accountKey, {
      expectedRevision: 1,
      actorName: "高级研发",
      roles: ["developer", "requirement_analyst"],
      enabled: false,
    });
    expect(updated).toMatchObject({
      actorName: "高级研发",
      enabled: false,
      revision: 2,
    });

    await service.delete(administrator, created.accountKey, {
      expectedRevision: 2,
    });
    expect(
      (await service.list(administrator)).map((item) => item.username),
    ).not.toContain("developer.one");
  });

  it("普通成员不能管理账号，且不能删除最后一个可用管理员", async () => {
    const service = new AccountAdministrationService(repository());
    const productOwner: AuthenticatedPrincipal = {
      actorKey: memberKey,
      actorName: "产品负责人",
      username: "product.owner",
      tenantKey,
      roles: ["product_owner"],
    };

    await expect(service.list(productOwner)).rejects.toMatchObject({
      statusCode: 403,
      code: "account_admin_required",
    } satisfies Partial<ApplicationError>);
    await expect(
      service.delete(administrator, adminKey, { expectedRevision: 1 }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "last_administrator",
    } satisfies Partial<ApplicationError>);
  });
});
