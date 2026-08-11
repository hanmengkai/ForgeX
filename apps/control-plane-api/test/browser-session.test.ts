import { describe, expect, it } from "vitest";

import { InMemoryBrowserSessionManager } from "../src/browser-session.js";

const principal = {
  actorKey: "44444444-4444-4444-8444-444444444444",
  actorName: "产品负责人",
  tenantKey: "11111111-1111-4111-8111-111111111111",
  roles: ["product_owner" as const],
};

describe("浏览器服务端会话", () => {
  it("只保存随机会话摘要，并在注销或服务端到期后拒绝旧 Cookie", async () => {
    let now = new Date("2026-08-11T00:00:00.000Z");
    const sessions = new InMemoryBrowserSessionManager({ clock: () => now });
    const token = await sessions.create(principal, 60);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(sessions.authenticate(token)).resolves.toEqual(principal);
    await sessions.revoke(token);
    await expect(sessions.authenticate(token)).resolves.toBeNull();

    const expiring = await sessions.create(principal, 60);
    now = new Date("2026-08-11T00:01:01.000Z");
    await expect(sessions.authenticate(expiring)).resolves.toBeNull();
  });

  it("同一人员重新登录后只保留最新会话", async () => {
    const sessions = new InMemoryBrowserSessionManager();
    const first = await sessions.create(principal, 60);
    const second = await sessions.create(principal, 60);

    await expect(sessions.authenticate(first)).resolves.toBeNull();
    await expect(sessions.authenticate(second)).resolves.toEqual(principal);
  });

  it("账号权限变化后可按租户和人员撤销现有会话", async () => {
    const sessions = new InMemoryBrowserSessionManager();
    const token = await sessions.create(principal, 60);

    await sessions.revokePrincipal(principal.tenantKey, principal.actorKey);

    await expect(sessions.authenticate(token)).resolves.toBeNull();
  });
});
