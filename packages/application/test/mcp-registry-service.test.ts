import {
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  McpHealthAuthority,
  type McpHealthPayload,
  type McpServerManifest,
} from "@forgex/extensions";

import {
  InMemoryMcpRegistryRepository,
  McpRegistryApplicationService,
  type AuthenticatedPrincipal,
  type McpRegistryRepository,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const serverKey = "33333333-3333-4333-8333-333333333333";
const verifierKey = "44444444-4444-4444-8444-444444444444";
const keyId = "55555555-5555-4555-8555-555555555555";
const readToolKey = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-08-10T09:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const administrator: AuthenticatedPrincipal = {
  actorKey: "77777777-7777-4777-8777-777777777777",
  actorName: "平台管理员",
  tenantKey,
  roles: ["administrator"],
};
const developer: AuthenticatedPrincipal = {
  actorKey: "88888888-8888-4888-8888-888888888888",
  actorName: "初级研发",
  tenantKey,
  roles: ["developer"],
};

const manifest: McpServerManifest = {
  schemaVersion: 1,
  serverKey,
  tenantKey,
  projectKey,
  revision: 1,
  name: "代码仓库工具",
  summary: "读取项目结构并在确认后创建交付分支",
  transport: "stdio",
  connectionBindingKey: "99999999-9999-4999-8999-999999999999",
  protocolVersion: "2025-06-18",
  tools: [
    {
      toolKey: readToolKey,
      technicalName: "repository.read_structure",
      displayName: "读取项目结构",
      description: "读取目录与受版本控制文件的结构摘要",
      effect: "read",
      approval: "automatic",
      inputSchemaHashAlgorithm: "sha256",
      inputSchemaHash: "a".repeat(64),
    },
  ],
  publishedAt: "2026-08-10T08:00:00.000Z",
};

const authority = (acceptNewAttestations = true) =>
  new McpHealthAuthority({
    verifiers: [
      {
        verifierKey,
        keyId,
        verifierName: "独立 MCP 探测器",
        publicKeyBase64: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        scopes: [{ tenantKey, projectKey }],
        acceptNewAttestations,
      },
    ],
    clock: () => new Date(now.getTime()),
  });

const healthPayload = (
  overrides: Partial<McpHealthPayload> = {},
): McpHealthPayload => ({
  schemaVersion: 1,
  attestationKey: randomUUID(),
  probeSequence: 1,
  previousAttestationKey: null,
  tenantKey,
  projectKey,
  serverKey,
  serverRevision: 1,
  manifestHashAlgorithm: "sha256",
  manifestHash: McpHealthAuthority.manifestHash(manifest),
  verifierKey,
  keyId,
  serverIdentityHashAlgorithm: "sha256",
  serverIdentityHash: "b".repeat(64),
  protocolVersion: manifest.protocolVersion,
  observedTools: manifest.tools.map((tool) => ({
    technicalName: tool.technicalName,
    inputSchemaHashAlgorithm: tool.inputSchemaHashAlgorithm,
    inputSchemaHash: tool.inputSchemaHash,
  })),
  status: "healthy",
  recoveryChallengeKey: null,
  producedAt: "2026-08-10T08:30:00.000Z",
  ...overrides,
});

const signedHealth = (overrides: Partial<McpHealthPayload> = {}) => {
  const payload = healthPayload(overrides);
  return {
    payload,
    signature: signPayload(
      null,
      Buffer.from(McpHealthAuthority.canonicalPayload(payload), "utf8"),
      privateKey,
    ).toString("base64"),
  };
};

const createService = (
  repository: McpRegistryRepository = new InMemoryMcpRegistryRepository(),
  healthAuthority = authority(),
) => ({
  repository,
  service: new McpRegistryApplicationService({
    repository,
    healthAuthority,
    projectKey,
    clock: () => new Date(now.getTime()),
  }),
});

const signedNextHealth = async (
  service: McpRegistryApplicationService,
  overrides: Partial<McpHealthPayload> = {},
) =>
  signedHealth({
    ...(await service.getNextProbeBinding(tenantKey, serverKey, 1)),
    ...overrides,
  });

describe("McpRegistryApplicationService", () => {
  it("由管理员发布和启用，向成员只返回人性化能力状态", async () => {
    const { service, repository } = createService();
    await service.publish(administrator, manifest);
    await expect(service.listForPeople(developer)).resolves.toEqual([
      expect.objectContaining({ name: "代码仓库工具", status: "等待验证" }),
    ]);

    await service.recordHealth(tenantKey, await signedNextHealth(service));
    await service.enable(administrator, serverKey, 1);

    await expect(service.listItemsForPeople(developer)).resolves.toEqual([
      {
        serverKey,
        view: {
          name: "代码仓库工具",
          summary: "读取项目结构并在确认后创建交付分支",
          status: "可使用",
          detail: "1 项业务能力",
          supportingText: "读取可自动运行",
        },
      },
    ]);
    await expect(
      service.getEnabledToolForInvocation(tenantKey, serverKey, readToolKey),
    ).resolves.toMatchObject({
      manifest: { connectionBindingKey: manifest.connectionBindingKey },
      tool: { technicalName: "repository.read_structure" },
    });
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        action: "enabled",
        actorName: "平台管理员",
        serverKey,
        revision: 1,
      }),
    ]);

    await service.disable(administrator, serverKey);
    await expect(
      service.getEnabledToolForInvocation(tenantKey, serverKey, readToolKey),
    ).resolves.toBeNull();
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({ action: "disabled", serverKey }),
      expect.objectContaining({ action: "enabled", serverKey }),
    ]);
  });

  it("拒绝普通成员发布或启用，也拒绝跨范围清单", async () => {
    const { service } = createService();
    await expect(service.publish(developer, manifest)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      service.publish(administrator, {
        ...manifest,
        projectKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({ code: "mcp_scope_mismatch" });
  });

  it("拒绝在 MCP 清单文案中保存明文凭据且仓储保持为空", async () => {
    const { service } = createService();

    await expect(
      service.publish(administrator, {
        ...manifest,
        summary:
          '业务连接说明 client_secret = "actual-production-secret-123456"',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "mcp_credential_detected",
    });
    await expect(service.listForPeople(developer)).resolves.toEqual([]);
  });

  it("失败探测原子停用并审计，只有签回恢复挑战后管理员才能重新启用", async () => {
    const { service, repository } = createService();
    await service.publish(administrator, manifest);
    await service.recordHealth(tenantKey, await signedNextHealth(service));
    await service.enable(administrator, serverKey, 1);

    const failure = await service.recordHealth(
      tenantKey,
      await signedNextHealth(service, {
        status: "unhealthy",
        producedAt: "2026-08-10T08:31:00.000Z",
      }),
    );
    expect(failure.recoveryChallengeKey).not.toBeNull();
    await expect(
      service.getEnabledToolForInvocation(tenantKey, serverKey, readToolKey),
    ).resolves.toBeNull();
    await expect(service.enable(administrator, serverKey, 1)).rejects.toThrow(
      "MCP 熔断后需要携带恢复挑战的新健康探测",
    );
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        action: "health_disabled",
        actorKey: verifierKey,
        actorName: "独立 MCP 探测器",
      }),
      expect.objectContaining({ action: "enabled" }),
    ]);

    await service.recordHealth(
      tenantKey,
      await signedNextHealth(service, {
        recoveryChallengeKey: failure.recoveryChallengeKey,
        producedAt: "2026-08-10T08:32:00.000Z",
      }),
    );
    await service.enable(administrator, serverKey, 1);
    await expect(
      service.getEnabledToolForInvocation(tenantKey, serverKey, readToolKey),
    ).resolves.not.toBeNull();
  });

  it("自动熔断审计写入失败时回滚停用状态", async () => {
    const { service, repository } = createService();
    await service.publish(administrator, manifest);
    await service.recordHealth(tenantKey, await signedNextHealth(service));
    await service.enable(administrator, serverKey, 1);
    const failingRepository: McpRegistryRepository = {
      transaction: (tenant, project, operation) =>
        repository.transaction(tenant, project, (transaction) =>
          operation({
            ...transaction,
            appendAudit: () => {
              throw new Error("审计存储暂时不可用");
            },
          }),
        ),
      listAudit: (tenant, project, limit) =>
        repository.listAudit(tenant, project, limit),
    };
    const failingService = createService(failingRepository).service;

    await expect(
      failingService.recordHealth(
        tenantKey,
        await signedNextHealth(failingService, {
          status: "unhealthy",
          producedAt: "2026-08-10T08:31:00.000Z",
        }),
      ),
    ).rejects.toThrow("审计存储暂时不可用");
    await expect(
      service.getEnabledToolForInvocation(tenantKey, serverKey, readToolKey),
    ).resolves.not.toBeNull();
  });

  it("并发启用同一版本保持幂等且只写一条审计", async () => {
    const { service, repository } = createService();
    await service.publish(administrator, manifest);
    await service.recordHealth(tenantKey, await signedNextHealth(service));

    await Promise.all([
      service.enable(administrator, serverKey, 1),
      service.enable(administrator, serverKey, 1),
    ]);

    await expect(
      repository.listAudit(tenantKey, projectKey),
    ).resolves.toHaveLength(1);
  });

  it("服务重启后使用退役公钥恢复历史状态但不能接收新探测", async () => {
    const repository = new InMemoryMcpRegistryRepository();
    const first = createService(repository).service;
    await first.publish(administrator, manifest);
    await first.recordHealth(tenantKey, await signedNextHealth(first));
    await first.enable(administrator, serverKey, 1);

    const restarted = createService(repository, authority(false)).service;
    await expect(restarted.listForPeople(developer)).resolves.toEqual([
      expect.objectContaining({ status: "可使用" }),
    ]);
    await expect(
      restarted.recordHealth(tenantKey, await signedNextHealth(restarted)),
    ).rejects.toThrow("只用于核验历史探测");
  });
});
