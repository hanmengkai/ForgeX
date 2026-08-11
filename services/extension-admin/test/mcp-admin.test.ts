import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalizeMcpInputSchema } from "@forgex/application";
import { McpHealthAuthority } from "@forgex/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpReleaseInputSchema,
  bootstrapExtensionAdmin,
  prepareMcpHealthRefresh,
  prepareMcpRelease,
  publishPreparedMcpHealthRefresh,
  publishPreparedMcpRelease,
} from "../src/index.js";

const tenantKey = "10000000-0000-4000-8000-000000000001";
const projectKey = "20000000-0000-4000-8000-000000000002";
const connectionBindingKey = "30000000-0000-4000-8000-000000000003";
const serverKey = "40000000-0000-4000-8000-000000000004";
const toolKey = "50000000-0000-4000-8000-000000000005";
const roots: string[] = [];

const inputSchema = {
  type: "object",
  properties: {
    recipient: {
      type: "string",
      title: "通知对象",
      writeOnly: false,
      minLength: 2,
      maxLength: 100,
    },
  },
  required: ["recipient"],
  additionalProperties: false,
};

const fixture = async () => {
  const root = path.join(
    os.homedir(),
    `.forgex-mcp-admin-${crypto.randomUUID()}`,
  );
  roots.push(root);
  const outputDirectory = path.join(root, "admin");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const administratorSessionKeyPath = path.join(root, "administrator.key");
  await writeFile(administratorSessionKeyPath, "administrator-session-key\n", {
    mode: 0o600,
  });
  const generated = await bootstrapExtensionAdmin(
    {
      schemaVersion: 1,
      administratorName: "扩展管理员一号",
      controlPlaneUrl: "https://forgex.example.test",
      administratorSessionKeyPath,
      scope: { tenantKey, projectKey },
      requestTimeoutMs: 5_000,
    },
    {
      outputDirectory,
      assertPrivatePath: async () => undefined,
    },
  );
  return { root, outputDirectory, generated };
};

const releaseInput = () =>
  McpReleaseInputSchema.parse({
    schemaVersion: 1,
    serverKey,
    revision: 1,
    name: "团队通知服务",
    summary: "通过客户设备上的本地连接发送团队业务通知",
    connection: {
      schemaVersion: 1,
      connectionBindingKey,
      transport: "streamable_http",
      url: "http://127.0.0.1:3210/mcp",
      headers: { Authorization: "Bearer local-secret-marker" },
      allowedTools: ["notifications.send"],
      timeoutMs: 30_000,
    },
    tools: [
      {
        toolKey,
        technicalName: "notifications.send",
        displayName: "发送团队通知",
        description: "向指定团队成员发送一条业务通知",
        effect: "external_action",
        approval: "review_required",
      },
    ],
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MCP extension admin", () => {
  it("只用真实只读探测生成不含本地凭据的规范发布包与可验签健康证明", async () => {
    const setup = await fixture();
    const outputPath = path.join(setup.outputDirectory, "mcp-release.json");
    const clock = () => new Date("2026-08-11T02:00:00.000Z");
    const probe = vi.fn(async () => ({
      protocolVersion: "2025-06-18",
      serverIdentity: { name: "team-notifications", version: "2.4.0" },
      tools: [{ technicalName: "notifications.send", inputSchema }],
    }));

    const bundle = await prepareMcpRelease(releaseInput(), {
      configPath: setup.generated.configPath,
      outputPath,
      probe,
      clock,
      assertPrivatePath: async () => undefined,
    });

    expect(probe).toHaveBeenCalledOnce();
    const persisted = await readFile(outputPath, "utf8");
    expect(persisted).not.toContain("local-secret-marker");
    expect(persisted).not.toContain("Authorization");
    expect(bundle.manifest).toMatchObject({
      serverKey,
      tenantKey,
      projectKey,
      revision: 1,
      transport: "streamable_http",
      connectionBindingKey,
      protocolVersion: "2025-06-18",
      publishedAt: clock().toISOString(),
      tools: [
        {
          toolKey,
          technicalName: "notifications.send",
          inputSchemaHash: canonicalizeMcpInputSchema(inputSchema).hash,
        },
      ],
    });
    expect(bundle.inputSchemas).toEqual([
      {
        toolKey,
        schema: canonicalizeMcpInputSchema(inputSchema).schema,
      },
    ]);
    expect(bundle.health.payload).toMatchObject({
      tenantKey,
      projectKey,
      serverKey,
      serverRevision: 1,
      probeSequence: 1,
      previousAttestationKey: null,
      protocolVersion: "2025-06-18",
      status: "healthy",
      producedAt: clock().toISOString(),
      serverIdentityHash: createHash("sha256")
        .update(
          JSON.stringify({ name: "team-notifications", version: "2.4.0" }),
          "utf8",
        )
        .digest("hex"),
    });

    const fragment = JSON.parse(
      await readFile(setup.generated.controlPlaneFragmentPath, "utf8"),
    ) as {
      mcpVerifiers: ConstructorParameters<
        typeof McpHealthAuthority
      >[0]["verifiers"];
    };
    const authority = new McpHealthAuthority({
      verifiers: fragment.mcpVerifiers,
      clock,
    });
    expect(authority.verify(bundle.health).payload.attestationKey).toBe(
      bundle.health.payload.attestationKey,
    );
  });

  it("按发布、健康登记、启用顺序发送同一个不可变发布包并校验健康链", async () => {
    const setup = await fixture();
    const bundle = await prepareMcpRelease(releaseInput(), {
      configPath: setup.generated.configPath,
      outputPath: path.join(setup.outputDirectory, "mcp-release.json"),
      probe: async () => ({
        protocolVersion: "2025-06-18",
        serverIdentity: { name: "team-notifications", version: "2.4.0" },
        tools: [{ technicalName: "notifications.send", inputSchema }],
      }),
      clock: () => new Date("2026-08-11T02:00:00.000Z"),
      assertPrivatePath: async () => undefined,
    });
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, body: JSON.parse(String(init?.body)) as unknown });
        if (url.endsWith("/health")) {
          return new Response(
            JSON.stringify({
              data: {
                recoveryChallengeKey: null,
                nextProbeSequence: 2,
                previousAttestationKey: bundle.health.payload.attestationKey,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const publishing = url.endsWith("/extensions/mcp");
        return new Response(publishing ? "" : null, {
          status: publishing ? 201 : 204,
          ...(publishing
            ? { headers: { location: `/api/v1/extensions/mcp/${serverKey}` } }
            : {}),
        });
      },
    );

    await expect(
      publishPreparedMcpRelease({
        configPath: setup.generated.configPath,
        bundle,
        fetcher,
        assertPrivatePath: async () => undefined,
      }),
    ).resolves.toEqual({ status: "enabled", serverKey, revision: 1 });

    expect(requests.map((request) => request.url)).toEqual([
      "https://forgex.example.test/api/v1/extensions/mcp",
      `https://forgex.example.test/api/v1/extensions/mcp/${serverKey}/health`,
      `https://forgex.example.test/api/v1/extensions/mcp/${serverKey}/revisions/1/enable`,
    ]);
    expect(requests[0]?.body).toEqual({
      schemaVersion: 1,
      manifest: bundle.manifest,
      inputSchemas: bundle.inputSchemas,
    });
    expect(requests[1]?.body).toEqual({
      schemaVersion: 1,
      health: bundle.health,
    });
  });

  it("按服务端链头重新探测并生成可安全重试的健康续期包", async () => {
    const setup = await fixture();
    const source = await prepareMcpRelease(releaseInput(), {
      configPath: setup.generated.configPath,
      outputPath: path.join(setup.outputDirectory, "mcp-release.json"),
      probe: async () => ({
        protocolVersion: "2025-06-18",
        serverIdentity: { name: "team-notifications", version: "2.4.0" },
        tools: [{ technicalName: "notifications.send", inputSchema }],
      }),
      clock: () => new Date("2026-08-11T02:00:00.000Z"),
      assertPrivatePath: async () => undefined,
    });
    const outputPath = path.join(setup.outputDirectory, "mcp-health.json");
    const nextProbe = {
      probeSequence: 2,
      previousAttestationKey: source.health.payload.attestationKey,
      recoveryChallengeKey: null,
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: nextProbe }), { status: 200 }),
    );

    const refresh = await prepareMcpHealthRefresh(releaseInput(), {
      configPath: setup.generated.configPath,
      sourceBundle: source,
      outputPath,
      probe: async () => ({
        protocolVersion: "2025-06-18",
        serverIdentity: { name: "team-notifications", version: "2.4.0" },
        tools: [{ technicalName: "notifications.send", inputSchema }],
      }),
      fetcher,
      clock: () => new Date("2026-08-11T08:00:00.000Z"),
      assertPrivatePath: async () => undefined,
    });

    expect(fetcher).toHaveBeenCalledWith(
      `https://forgex.example.test/api/v1/extensions/mcp/${serverKey}/revisions/1/probe-binding`,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(refresh).not.toHaveProperty("reenableAfterHealth");
    expect(refresh.health.payload).toMatchObject({
      probeSequence: 2,
      previousAttestationKey: source.health.payload.attestationKey,
      recoveryChallengeKey: null,
      serverIdentityHash: source.health.payload.serverIdentityHash,
      protocolVersion: source.manifest.protocolVersion,
      producedAt: "2026-08-11T08:00:00.000Z",
    });
    expect(await readFile(outputPath, "utf8")).not.toContain(
      "local-secret-marker",
    );

    const fragment = JSON.parse(
      await readFile(setup.generated.controlPlaneFragmentPath, "utf8"),
    ) as {
      mcpVerifiers: ConstructorParameters<
        typeof McpHealthAuthority
      >[0]["verifiers"];
    };
    const authority = new McpHealthAuthority({
      verifiers: fragment.mcpVerifiers,
      clock: () => new Date("2026-08-11T08:00:01.000Z"),
    });
    expect(authority.verify(refresh.health).payload.attestationKey).toBe(
      refresh.health.payload.attestationKey,
    );
  });

  it("发布普通续期只登记健康，熔断恢复续期才重新启用", async () => {
    const setup = await fixture();
    const source = await prepareMcpRelease(releaseInput(), {
      configPath: setup.generated.configPath,
      outputPath: path.join(setup.outputDirectory, "mcp-release.json"),
      probe: async () => ({
        protocolVersion: "2025-06-18",
        serverIdentity: { name: "team-notifications", version: "2.4.0" },
        tools: [{ technicalName: "notifications.send", inputSchema }],
      }),
      assertPrivatePath: async () => undefined,
    });
    const prepare = async (recoveryChallengeKey: string | null) =>
      prepareMcpHealthRefresh(releaseInput(), {
        configPath: setup.generated.configPath,
        sourceBundle: source,
        outputPath: path.join(
          setup.outputDirectory,
          `health-${recoveryChallengeKey ?? "routine"}.json`,
        ),
        probe: async () => ({
          protocolVersion: "2025-06-18",
          serverIdentity: { name: "team-notifications", version: "2.4.0" },
          tools: [{ technicalName: "notifications.send", inputSchema }],
        }),
        fetcher: async () =>
          new Response(
            JSON.stringify({
              data: {
                probeSequence: 2,
                previousAttestationKey: source.health.payload.attestationKey,
                recoveryChallengeKey,
              },
            }),
            { status: 200 },
          ),
        assertPrivatePath: async () => undefined,
      });

    const routine = await prepare(null);
    const routineUrls: string[] = [];
    await publishPreparedMcpHealthRefresh({
      configPath: setup.generated.configPath,
      bundle: routine,
      fetcher: async (input) => {
        routineUrls.push(String(input));
        return new Response(
          JSON.stringify({
            data: {
              recoveryChallengeKey: null,
              nextProbeSequence: 3,
              previousAttestationKey: routine.health.payload.attestationKey,
            },
          }),
          { status: 200 },
        );
      },
      assertPrivatePath: async () => undefined,
    });
    expect(routineUrls).toEqual([
      `https://forgex.example.test/api/v1/extensions/mcp/${serverKey}/health`,
    ]);

    const recoveryChallengeKey = "60000000-0000-4000-8000-000000000006";
    const recovery = await prepare(recoveryChallengeKey);
    const recoveryRequests: Array<{ url: string; body: unknown }> = [];
    await publishPreparedMcpHealthRefresh({
      configPath: setup.generated.configPath,
      bundle: recovery,
      fetcher: async (input, init) => {
        const url = String(input);
        recoveryRequests.push({
          url,
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return url.endsWith("/recover")
          ? new Response(null, { status: 204 })
          : new Response(
              JSON.stringify({
                data: {
                  recoveryChallengeKey,
                  nextProbeSequence: 3,
                  previousAttestationKey:
                    recovery.health.payload.attestationKey,
                },
              }),
              { status: 200 },
            );
      },
      assertPrivatePath: async () => undefined,
    });
    expect(recoveryRequests.map((request) => request.url)).toEqual([
      `https://forgex.example.test/api/v1/extensions/mcp/${serverKey}/health`,
      `https://forgex.example.test/api/v1/extensions/mcp/${serverKey}/revisions/1/recover`,
    ]);
    expect(recoveryRequests[1]?.body).toEqual({
      schemaVersion: 1,
      attestationKey: recovery.health.payload.attestationKey,
    });

    const tamperedFetcher = vi.fn();
    await expect(
      publishPreparedMcpHealthRefresh({
        configPath: setup.generated.configPath,
        bundle: { ...routine, reenableAfterHealth: true } as never,
        fetcher: tamperedFetcher,
        assertPrivatePath: async () => undefined,
      }),
    ).rejects.toThrow();
    await expect(
      publishPreparedMcpHealthRefresh({
        configPath: setup.generated.configPath,
        bundle: { ...recovery, reenableAfterHealth: false } as never,
        fetcher: tamperedFetcher,
        assertPrivatePath: async () => undefined,
      }),
    ).rejects.toThrow();
    expect(tamperedFetcher).not.toHaveBeenCalled();
  });

  it("健康续期在服务身份、协议或 Schema 漂移时不签名也不写包", async () => {
    const setup = await fixture();
    const source = await prepareMcpRelease(releaseInput(), {
      configPath: setup.generated.configPath,
      outputPath: path.join(setup.outputDirectory, "mcp-release.json"),
      probe: async () => ({
        protocolVersion: "2025-06-18",
        serverIdentity: { name: "team-notifications", version: "2.4.0" },
        tools: [{ technicalName: "notifications.send", inputSchema }],
      }),
      assertPrivatePath: async () => undefined,
    });
    const outputPath = path.join(setup.outputDirectory, "drifted-health.json");
    const common = {
      configPath: setup.generated.configPath,
      sourceBundle: source,
      outputPath,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            data: {
              probeSequence: 2,
              previousAttestationKey: source.health.payload.attestationKey,
              recoveryChallengeKey: null,
            },
          }),
          { status: 200 },
        ),
      assertPrivatePath: async () => undefined,
    };

    await expect(
      prepareMcpHealthRefresh(releaseInput(), {
        ...common,
        probe: async () => ({
          protocolVersion: "2025-06-18",
          serverIdentity: { name: "replacement-server", version: "1.0.0" },
          tools: [{ technicalName: "notifications.send", inputSchema }],
        }),
      }),
    ).rejects.toThrow("身份");
    await expect(readFile(outputPath, "utf8")).rejects.toThrow();
  });

  it("工具元数据与实际清单不一致或 Schema 含凭据时在写包前失败", async () => {
    const setup = await fixture();
    const outputPath = path.join(setup.outputDirectory, "invalid.json");
    const common = {
      configPath: setup.generated.configPath,
      outputPath,
      assertPrivatePath: async () => undefined,
    };

    await expect(
      prepareMcpRelease(releaseInput(), {
        ...common,
        probe: async () => ({
          protocolVersion: "2025-06-18",
          serverIdentity: { name: "team-notifications", version: "2.4.0" },
          tools: [{ technicalName: "different.tool", inputSchema }],
        }),
      }),
    ).rejects.toThrow("工具");

    await expect(
      prepareMcpRelease(releaseInput(), {
        ...common,
        probe: async () => ({
          protocolVersion: "2025-06-18",
          serverIdentity: { name: "team-notifications", version: "2.4.0" },
          tools: [
            {
              technicalName: "notifications.send",
              inputSchema: {
                ...inputSchema,
                description: 'apiKey="actual-production-secret"',
              },
            },
          ],
        }),
      }),
    ).rejects.toThrow("凭据");
  });

  it("控制面超限或敏感错误响应只返回固定本地错误", async () => {
    const setup = await fixture();
    const bundle = await prepareMcpRelease(releaseInput(), {
      configPath: setup.generated.configPath,
      outputPath: path.join(setup.outputDirectory, "mcp-release.json"),
      probe: async () => ({
        protocolVersion: "2025-06-18",
        serverIdentity: { name: "team-notifications", version: "2.4.0" },
        tools: [{ technicalName: "notifications.send", inputSchema }],
      }),
      assertPrivatePath: async () => undefined,
    });
    const marker = "Authorization: Bearer remote-secret-marker";
    const error = await publishPreparedMcpRelease({
      configPath: setup.generated.configPath,
      bundle,
      fetcher: async () =>
        new Response(`${marker}${"x".repeat(1_048_576)}`, { status: 500 }),
      assertPrivatePath: async () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("同一个发布包");
    expect(String(error)).not.toContain(marker);

    let requestNumber = 0;
    const malformed = await publishPreparedMcpRelease({
      configPath: setup.generated.configPath,
      bundle,
      fetcher: async (input) => {
        requestNumber += 1;
        if (requestNumber === 1) {
          return new Response("", {
            status: 201,
            headers: { location: `/api/v1/extensions/mcp/${serverKey}` },
          });
        }
        return new Response(JSON.stringify({ [marker]: true }), {
          status: 200,
        });
      },
      assertPrivatePath: async () => undefined,
    }).catch((caught: unknown) => caught);
    expect(malformed).toMatchObject({
      message: "控制面返回了无效的 MCP 健康链结果",
    });
    expect(String(malformed)).not.toContain(marker);
  });
});
