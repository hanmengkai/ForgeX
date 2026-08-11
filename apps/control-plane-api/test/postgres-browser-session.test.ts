import { describe, expect, it } from "vitest";

import { PostgresBrowserSessionManager } from "../src/postgres-browser-session.js";
import type { ProductionPostgresPool } from "../src/production.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const otherProjectKey = "33333333-3333-4333-8333-333333333333";
const repositoryKey = "44444444-4444-4444-8444-444444444444";
const actorKey = "55555555-5555-4555-8555-555555555555";
const realmA = "a".repeat(64);
const realmB = "b".repeat(64);

const principal = {
  actorKey,
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner" as const],
};

interface StoredSession {
  digest: string;
  tenantKey: string;
  projectKey: string;
  repositoryKey: string;
  authRealmRevision: string;
  actorKey: string;
  principal: unknown;
}

const createFakePool = (): ProductionPostgresPool => {
  const records: StoredSession[] = [];
  return {
    connect: async () => {
      throw new Error("此测试不应获取独立连接");
    },
    query: async (text, values = []) => {
      if (
        text === "DELETE FROM forgex_browser_sessions WHERE expires_at <= now()"
      ) {
        return { rows: [] };
      }
      if (text.startsWith("INSERT INTO forgex_browser_sessions")) {
        const [
          sessionDigest,
          storedTenantKey,
          storedProjectKey,
          storedRepositoryKey,
          authRealmRevision,
          storedActorKey,
          storedPrincipal,
        ] = values as string[];
        const existing = records.findIndex(
          (record) =>
            record.tenantKey === storedTenantKey &&
            record.projectKey === storedProjectKey &&
            record.repositoryKey === storedRepositoryKey &&
            record.actorKey === storedActorKey,
        );
        const next: StoredSession = {
          digest: sessionDigest!,
          tenantKey: storedTenantKey!,
          projectKey: storedProjectKey!,
          repositoryKey: storedRepositoryKey!,
          authRealmRevision: authRealmRevision!,
          actorKey: storedActorKey!,
          principal: JSON.parse(storedPrincipal!) as unknown,
        };
        if (existing >= 0) records.splice(existing, 1, next);
        else records.push(next);
        return { rows: [] };
      }
      if (text.startsWith("SELECT principal")) {
        const [sessionDigest, storedProjectKey, storedRepositoryKey, realm] =
          values as string[];
        const record = records.find(
          (candidate) =>
            candidate.digest === sessionDigest &&
            candidate.projectKey === storedProjectKey &&
            candidate.repositoryKey === storedRepositoryKey &&
            candidate.authRealmRevision === realm,
        );
        return { rows: record ? [{ principal: record.principal }] : [] };
      }
      if (
        text.startsWith(
          "DELETE FROM forgex_browser_sessions WHERE tenant_key = $1",
        )
      ) {
        const [
          storedTenantKey,
          storedActorKey,
          storedProjectKey,
          storedRepositoryKey,
        ] = values as string[];
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const candidate = records[index];
          if (!candidate) continue;
          if (
            candidate.tenantKey === storedTenantKey &&
            candidate.actorKey === storedActorKey &&
            candidate.projectKey === storedProjectKey &&
            candidate.repositoryKey === storedRepositoryKey
          ) {
            records.splice(index, 1);
          }
        }
        return { rows: [] };
      }
      if (text.startsWith("DELETE FROM forgex_browser_sessions")) {
        const [sessionDigest, storedProjectKey, storedRepositoryKey, realm] =
          values as string[];
        const index = records.findIndex(
          (candidate) =>
            candidate.digest === sessionDigest &&
            candidate.projectKey === storedProjectKey &&
            candidate.repositoryKey === storedRepositoryKey &&
            candidate.authRealmRevision === realm,
        );
        if (index >= 0) records.splice(index, 1);
        return { rows: [] };
      }
      throw new Error(`未预期的 SQL: ${text}`);
    },
  };
};

describe("PostgreSQL 浏览器会话", () => {
  it("按项目、仓库和授权配置版本隔离，并且每人只保留最新会话", async () => {
    const pool = createFakePool();
    const sessions = new PostgresBrowserSessionManager(pool, {
      projectKey,
      repositoryKey,
      authRealmRevision: realmA,
    });
    const otherProject = new PostgresBrowserSessionManager(pool, {
      projectKey: otherProjectKey,
      repositoryKey,
      authRealmRevision: realmA,
    });
    const changedRealm = new PostgresBrowserSessionManager(pool, {
      projectKey,
      repositoryKey,
      authRealmRevision: realmB,
    });

    const first = await sessions.create(principal, 3_600);
    await expect(sessions.authenticate(first)).resolves.toEqual(principal);
    await expect(otherProject.authenticate(first)).resolves.toBeNull();
    await expect(changedRealm.authenticate(first)).resolves.toBeNull();
    await otherProject.revoke(first);
    await expect(sessions.authenticate(first)).resolves.toEqual(principal);

    const second = await sessions.create(principal, 3_600);
    await expect(sessions.authenticate(first)).resolves.toBeNull();
    await expect(sessions.authenticate(second)).resolves.toEqual(principal);

    await sessions.revokePrincipal(tenantKey, actorKey);
    await expect(sessions.authenticate(second)).resolves.toBeNull();
  });
});
