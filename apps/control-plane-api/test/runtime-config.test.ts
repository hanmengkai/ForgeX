import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ControlPlaneRuntimeConfigSchema,
  HashedRunnerSessionAuthenticator,
  HashedSessionAuthenticator,
  loadControlPlaneRuntimeConfig,
  requireDatabaseUrl,
} from "../src/runtime-config.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const repositoryKey = "33333333-3333-4333-8333-333333333333";
const actorKey = "44444444-4444-4444-8444-444444444444";
const runnerKey = "55555555-5555-4555-8555-555555555555";
const keyId = "66666666-6666-4666-8666-666666666666";
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("Control Plane 运行配置", () => {
  it("从文件加载严格配置并拒绝缺失或非 PostgreSQL 数据库地址", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgex-control-plane-"));
    const path = join(directory, "runtime.json");
    const config = {
      schemaVersion: 1,
      host: "0.0.0.0",
      port: 3000,
      projectKey,
      repositoryKey,
      sessions: [
        {
          tokenSha256: digest("people-session-token-with-enough-entropy"),
          principal: {
            actorKey,
            actorName: "产品负责人",
            tenantKey,
            roles: ["product_owner"],
          },
        },
      ],
      runnerSessions: [],
      trustedRunners: [],
      skillEvaluators: [],
      mcpVerifiers: [],
    };
    await writeFile(path, JSON.stringify(config), "utf8");

    await expect(loadControlPlaneRuntimeConfig(path)).resolves.toMatchObject({
      host: "0.0.0.0",
      projectKey,
    });
    expect(() => requireDatabaseUrl({})).toThrow("FORGEX_DATABASE_URL");
    expect(() =>
      requireDatabaseUrl({ FORGEX_DATABASE_URL: "https://example.test/db" }),
    ).toThrow("PostgreSQL");
    expect(
      requireDatabaseUrl({
        FORGEX_DATABASE_URL: "postgresql://user:secret@db:5432/forgex",
      }),
    ).toBe("postgresql://user:secret@db:5432/forgex");
    await rm(directory, { recursive: true, force: true });
  });

  it("只用令牌摘要认证人员和 Runner，不把明文令牌放进配置", async () => {
    const peopleToken = "people-session-token-with-enough-entropy";
    const runnerToken = "runner-session-token-with-enough-entropy";
    const people = new HashedSessionAuthenticator([
      {
        tokenSha256: digest(peopleToken),
        principal: {
          actorKey,
          actorName: "产品负责人",
          tenantKey,
          roles: ["product_owner"],
        },
      },
    ]);
    const runners = new HashedRunnerSessionAuthenticator([
      {
        tokenSha256: digest(runnerToken),
        runner: { tenantKey, runnerKey, keyId },
      },
    ]);

    await expect(
      people.authenticate(`Bearer ${peopleToken}`),
    ).resolves.toMatchObject({ actorName: "产品负责人" });
    await expect(
      runners.authenticate(`Runner ${runnerToken}`),
    ).resolves.toEqual({ tenantKey, runnerKey, keyId });
    await expect(people.authenticate(`Bearer ${runnerToken}`)).resolves.toBeNull();
    await expect(runners.authenticate(`Runner ${peopleToken}`)).resolves.toBeNull();
  });

  it("拒绝重复令牌摘要、明文令牌和不完整的部署范围", () => {
    const tokenSha256 = digest("same-token-with-enough-entropy");
    expect(
      () =>
        new HashedSessionAuthenticator([
          {
            tokenSha256,
            principal: {
              actorKey,
              actorName: "产品负责人",
              tenantKey,
              roles: ["product_owner"],
            },
          },
          {
            tokenSha256,
            principal: {
              actorKey: runnerKey,
              actorName: "需求分析师",
              tenantKey,
              roles: ["requirement_analyst"],
            },
          },
        ]),
    ).toThrow("不能重复");

    expect(
      ControlPlaneRuntimeConfigSchema.safeParse({
        schemaVersion: 1,
        host: "0.0.0.0",
        port: 3000,
        projectKey,
        repositoryKey,
        sessions: [],
        runnerSessions: [],
        trustedRunners: [],
        skillEvaluators: [],
        mcpVerifiers: [],
        token: "plaintext-must-not-be-accepted",
      }).success,
    ).toBe(false);
  });
});
