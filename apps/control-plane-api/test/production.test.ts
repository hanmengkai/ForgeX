import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ControlPlaneRuntimeConfigSchema } from "../src/runtime-config.js";
import { createProductionControlPlane } from "../src/production.js";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("Control Plane 生产装配", () => {
  it("把严格运行配置、PostgreSQL 仓储、认证器和就绪检查装配成可监听服务", async () => {
    const token = "production-session-token-with-enough-entropy";
    const config = ControlPlaneRuntimeConfigSchema.parse({
      schemaVersion: 1,
      host: "127.0.0.1",
      port: 3000,
      projectKey: "22222222-2222-4222-8222-222222222222",
      repositoryKey: "33333333-3333-4333-8333-333333333333",
      sessions: [
        {
          tokenSha256: digest(token),
          principal: {
            actorKey: "44444444-4444-4444-8444-444444444444",
            actorName: "产品负责人",
            tenantKey: "11111111-1111-4111-8111-111111111111",
            roles: ["product_owner"],
          },
        },
      ],
      runnerSessions: [],
      trustedRunners: [],
      skillEvaluators: [],
      mcpVerifiers: [],
    });
    const migration = {
      version: "0014",
      name: "browser_sessions",
      sql: "CREATE TABLE browser_sessions(id text);",
    };
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            version: migration.version,
            name: migration.name,
            checksum: digest(migration.sql),
          },
        ],
      }),
      release: vi.fn(),
    };
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query,
    };

    const app = createProductionControlPlane({
      config,
      authRealmRevision: digest("production-auth-realm"),
      migrations: [migration],
      pool,
      serviceVersion: "0.1.0-test",
    });
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.json()).toMatchObject({
      service: "forgex-control-plane",
      version: "0.1.0-test",
    });
    expect(ready.statusCode).toBe(200);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("forgex_schema_migrations"),
    );
    await app.close();
  });
});
