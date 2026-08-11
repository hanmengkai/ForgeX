import {
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  McpHealthAuthority,
  McpServerManifestSchema,
  McpServerRegistry,
  type McpHealthPayload,
  type McpServerManifest,
  type SignedMcpHealthAttestation,
  type TrustedMcpVerifier,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const serverKey = "33333333-3333-4333-8333-333333333333";
const verifierKey = "44444444-4444-4444-8444-444444444444";
const keyId = "55555555-5555-4555-8555-555555555555";
const bindingKey = "66666666-6666-4666-8666-666666666666";
const readToolKey = "77777777-7777-4777-8777-777777777777";
const writeToolKey = "88888888-8888-4888-8888-888888888888";
const actor = {
  actorKey: "99999999-9999-4999-8999-999999999999",
  actorName: "平台管理员",
};
const now = new Date("2026-08-10T09:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const verifier: TrustedMcpVerifier = {
  verifierKey,
  keyId,
  verifierName: "独立 MCP 探测器",
  publicKeyBase64: publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64"),
  scopes: [{ tenantKey, projectKey }],
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
  connectionBindingKey: bindingKey,
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
    {
      toolKey: writeToolKey,
      technicalName: "repository.create_delivery_branch",
      displayName: "创建交付分支",
      description: "在当前需求确认后创建隔离的交付分支",
      effect: "write",
      approval: "review_required",
      inputSchemaHashAlgorithm: "sha256",
      inputSchemaHash: "b".repeat(64),
    },
  ],
  publishedAt: "2026-08-10T08:00:00.000Z",
};

const healthPayload = (
  target: McpServerManifest = manifest,
  overrides: Partial<McpHealthPayload> = {},
): McpHealthPayload => ({
  schemaVersion: 1,
  attestationKey: randomUUID(),
  probeSequence: 1,
  previousAttestationKey: null,
  tenantKey: target.tenantKey,
  projectKey: target.projectKey,
  serverKey: target.serverKey,
  serverRevision: target.revision,
  manifestHashAlgorithm: "sha256",
  manifestHash: McpHealthAuthority.manifestHash(target),
  verifierKey,
  keyId,
  serverIdentityHashAlgorithm: "sha256",
  serverIdentityHash: "c".repeat(64),
  protocolVersion: target.protocolVersion,
  observedTools: target.tools.map((tool) => ({
    technicalName: tool.technicalName,
    inputSchemaHashAlgorithm: tool.inputSchemaHashAlgorithm,
    inputSchemaHash: tool.inputSchemaHash,
  })),
  status: "healthy",
  recoveryChallengeKey: null,
  producedAt: "2026-08-10T08:30:00.000Z",
  ...overrides,
});

const signHealth = (payload: McpHealthPayload): SignedMcpHealthAttestation => ({
  payload,
  signature: signPayload(
    null,
    Buffer.from(McpHealthAuthority.canonicalPayload(payload), "utf8"),
    privateKey,
  ).toString("base64"),
});

const authority = (
  clock: () => Date = () => new Date(now.getTime()),
  trusted: TrustedMcpVerifier[] = [verifier],
) =>
  new McpHealthAuthority({
    verifiers: trusted,
    clock,
    maxAttestationAgeMs: 24 * 60 * 60 * 1_000,
  });

const registry = (clock: () => Date = () => new Date(now.getTime())) =>
  new McpServerRegistry({
    tenantKey,
    projectKey,
    healthAuthority: authority(clock),
    clock,
  });

const signNextHealth = (
  target: McpServerRegistry,
  targetManifest: McpServerManifest = manifest,
  overrides: Partial<McpHealthPayload> = {},
): SignedMcpHealthAttestation =>
  signHealth(
    healthPayload(targetManifest, {
      ...target.getNextProbeBinding(
        targetManifest.serverKey,
        targetManifest.revision,
      ),
      ...overrides,
    }),
  );

const recordNextHealth = (
  target: McpServerRegistry,
  targetManifest: McpServerManifest = manifest,
  overrides: Partial<McpHealthPayload> = {},
) => target.recordHealth(signNextHealth(target, targetManifest, overrides));

describe("McpServerRegistry", () => {
  it("只有身份和能力都匹配可信探测结果的服务器才能启用", () => {
    const target = registry();
    target.publish(manifest);
    expect(() => target.enable({ serverKey, revision: 1, actor })).toThrow(
      "MCP 服务器尚未通过可信探测",
    );

    recordNextHealth(target);
    target.enable({ serverKey, revision: 1, actor });

    expect(target.listForPeople()).toEqual([
      {
        name: "代码仓库工具",
        summary: "读取项目结构并在确认后创建交付分支",
        status: "可使用",
        detail: "2 项业务能力",
        supportingText: "读取可自动运行，变更前需要确认",
      },
    ]);
    expect(target.getEnabledTool(serverKey, readToolKey)).toMatchObject({
      manifest: {
        connectionBindingKey: bindingKey,
        transport: "stdio",
      },
      tool: {
        technicalName: "repository.read_structure",
        effect: "read",
        approval: "automatic",
      },
    });
    expect(JSON.stringify(target.listForPeople())).not.toContain(bindingKey);
    expect(JSON.stringify(target.listForPeople())).not.toContain("stdio");
    expect(JSON.stringify(target.listForPeople())).not.toContain(
      "repository.read_structure",
    );
  });

  it("管理员可以立即停用已经启用的 MCP 服务器", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target);
    target.enable({ serverKey, revision: 1, actor });

    expect(target.disable({ serverKey, actor })).toMatchObject({
      action: "disabled",
      serverKey,
      revision: 1,
    });
    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
    expect(target.listForPeople()[0]).toMatchObject({ status: "需要处理" });
    expect(target.disable({ serverKey, actor })).toBeNull();
    const restored = McpServerRegistry.fromSnapshot(target.snapshot(), {
      tenantKey,
      projectKey,
      healthAuthority: authority(),
    });
    expect(restored.getEnabledTool(serverKey, readToolKey)).toBeNull();
  });

  it("拒绝把写入或外部动作配置为自动放行", () => {
    for (const effect of ["write", "external_action"] as const) {
      expect(() =>
        McpServerManifestSchema.parse({
          ...manifest,
          tools: [
            {
              ...manifest.tools[1]!,
              effect,
              approval: "automatic",
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("拒绝在普通成员可见的 MCP 说明中使用隐藏控制字符", () => {
    for (const candidate of [
      { ...manifest, summary: "安全服务\u202Ecod.exe" },
      {
        ...manifest,
        tools: [
          {
            ...manifest.tools[0]!,
            description: "读取安全目标\u200B后返回业务摘要",
          },
        ],
      },
    ]) {
      expect(() => McpServerManifestSchema.parse(candidate)).toThrow(
        "业务说明不能包含隐藏控制字符",
      );
    }
  });

  it("拒绝能力漂移、失败、跨范围、篡改或过期的探测结果", () => {
    const target = registry();
    target.publish(manifest);

    for (const payload of [
      healthPayload(manifest, {
        observedTools: [
          {
            ...healthPayload().observedTools[0]!,
            inputSchemaHash: "d".repeat(64),
          },
        ],
      }),
      healthPayload(manifest, {
        projectKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ]) {
      expect(() => target.recordHealth(signHealth(payload))).toThrow();
    }

    const genuine = signHealth(healthPayload());
    expect(() =>
      target.recordHealth({
        ...genuine,
        payload: { ...genuine.payload, serverIdentityHash: "e".repeat(64) },
      }),
    ).toThrow("MCP 探测签名无效");

    let current = now.getTime();
    const expiring = registry(() => new Date(current));
    expiring.publish(manifest);
    expiring.recordHealth(genuine);
    current += 25 * 60 * 60 * 1_000;
    expect(() => expiring.enable({ serverKey, revision: 1, actor })).toThrow(
      "MCP 探测已经过期",
    );
  });

  it("已持久化的完全相同探测在过期后仍可幂等确认，但新探测仍拒绝过期", () => {
    let current = now.getTime();
    const target = registry(() => new Date(current));
    target.publish(manifest);
    const recorded = signNextHealth(target, manifest, {
      producedAt: new Date(current).toISOString(),
    });
    const first = target.recordHealth(recorded);
    current += 25 * 60 * 60 * 1_000;

    expect(target.recordHealth(recorded)).toEqual(first);
    expect(() =>
      target.recordHealth(
        signNextHealth(target, manifest, {
          producedAt: new Date(current - 25 * 60 * 60 * 1_000).toISOString(),
        }),
      ),
    ).toThrow("MCP 探测已经过期");
  });

  it("可信失败探测即使观测到身份、协议、能力漂移或完全不可达也会先停用", () => {
    const failures: Partial<McpHealthPayload>[] = [
      {
        status: "unhealthy",
        serverIdentityHash: "d".repeat(64),
        producedAt: "2026-08-10T08:31:00.000Z",
      },
      {
        status: "unhealthy",
        protocolVersion: "2025-03-26",
        producedAt: "2026-08-10T08:31:00.000Z",
      },
      {
        status: "unhealthy",
        observedTools: [
          {
            ...healthPayload().observedTools[0]!,
            inputSchemaHash: "d".repeat(64),
          },
        ],
        producedAt: "2026-08-10T08:31:00.000Z",
      },
      {
        status: "unhealthy",
        observedTools: [],
        producedAt: "2026-08-10T08:31:00.000Z",
      },
    ];

    for (const failure of failures) {
      const target = registry();
      target.publish(manifest);
      recordNextHealth(target);
      target.enable({ serverKey, revision: 1, actor });

      expect(() => recordNextHealth(target, manifest, failure)).not.toThrow();
      expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
      expect(target.getRecoveryChallenge(serverKey, 1)).not.toBeNull();
    }
  });

  it("失败探测立即停用服务器，后续健康探测需要管理员重新启用", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target);
    target.enable({ serverKey, revision: 1, actor });

    recordNextHealth(target, manifest, {
      status: "unhealthy",
      producedAt: "2026-08-10T08:30:00.000Z",
    });
    expect(target.listForPeople()[0]).toMatchObject({ status: "需要处理" });
    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
    const recoveryChallengeKey = target.getRecoveryChallenge(serverKey, 1);
    expect(recoveryChallengeKey).not.toBeNull();
    const failedSnapshot = target.snapshot();
    const failedRestored = McpServerRegistry.fromSnapshot(failedSnapshot, {
      tenantKey,
      projectKey,
      healthAuthority: authority(),
      clock: () => new Date(now.getTime()),
    });
    expect(failedRestored.getEnabledTool(serverKey, readToolKey)).toBeNull();

    for (let minute = 41; minute <= 50; minute += 1) {
      recordNextHealth(target, manifest, {
        producedAt: `2026-08-10T08:${minute}:00.000Z`,
        recoveryChallengeKey: minute === 50 ? recoveryChallengeKey : null,
      });
    }
    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
    expect(target.enable({ serverKey, revision: 1, actor })).toMatchObject({
      action: "enabled",
    });
    expect(target.getEnabledTool(serverKey, readToolKey)).not.toBeNull();
    expect(target.getRecoveryChallenge(serverKey, 1)).toBeNull();
    expect(
      target.snapshot().servers[0]!.releases[0]!.attestations.length,
    ).toBeLessThanOrEqual(5);
    const restoredAfterWindow = McpServerRegistry.fromSnapshot(
      target.snapshot(),
      {
        tenantKey,
        projectKey,
        healthAuthority: authority(),
        clock: () => new Date(now.getTime()),
      },
    );
    expect(
      restoredAfterWindow.getEnabledTool(serverKey, readToolKey),
    ).not.toBeNull();
    target.disable({ serverKey, actor });
    expect(target.getRecoveryChallenge(serverKey, 1)).toBeNull();
  });

  it("同一时间戳的失败探测不会被健康探测窗口淘汰", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target);
    target.enable({ serverKey, revision: 1, actor });
    recordNextHealth(target, manifest, { status: "unhealthy" });
    const recoveryChallengeKey = target.getRecoveryChallenge(serverKey, 1);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      recordNextHealth(target);
    }

    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
    expect(() => target.enable({ serverKey, revision: 1, actor })).toThrow(
      "MCP 熔断后需要携带恢复挑战的新健康探测",
    );

    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:31:00.000Z",
      recoveryChallengeKey,
    });
    target.enable({ serverKey, revision: 1, actor });
    expect(target.getEnabledTool(serverKey, readToolKey)).not.toBeNull();
  });

  it("熔断恢复后清除活动挑战且不会让后续人工停用被健康续期重新启用", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target);
    target.enable({ serverKey, revision: 1, actor });
    recordNextHealth(target, manifest, { status: "unhealthy" });
    const recoveryChallengeKey = target.getRecoveryChallenge(serverKey, 1);
    expect(recoveryChallengeKey).not.toBeNull();
    const recoveryHealth = signNextHealth(target, manifest, {
      recoveryChallengeKey,
      producedAt: "2026-08-10T08:31:00.000Z",
    });
    expect(target.recordHealth(recoveryHealth)).toMatchObject({
      recoveryChallengeKey,
    });
    target.recover({
      serverKey,
      revision: 1,
      attestationKey: recoveryHealth.payload.attestationKey,
      actor,
    });

    expect(target.getRecoveryChallenge(serverKey, 1)).toBeNull();
    expect(target.recordHealth(recoveryHealth)).toMatchObject({
      recoveryChallengeKey,
      previousAttestationKey: recoveryHealth.payload.attestationKey,
    });
    target.disable({ serverKey, actor });
    expect(target.getRecoveryChallenge(serverKey, 1)).toBeNull();
    expect(
      target.recover({
        serverKey,
        revision: 1,
        attestationKey: recoveryHealth.payload.attestationKey,
        actor,
      }),
    ).toBeNull();
    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
  });

  it("后来收到的失败探测会覆盖允许偏差内的未来健康时间，并在重启后保持阻断", () => {
    let current = Date.parse("2026-08-10T08:30:00.000Z");
    const clock = () => new Date(current);
    const target = registry(clock);
    target.publish(manifest);
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:35:00.000Z",
    });
    target.enable({ serverKey, revision: 1, actor });

    current = Date.parse("2026-08-10T08:31:00.000Z");
    recordNextHealth(target, manifest, {
      status: "unhealthy",
      producedAt: "2026-08-10T08:31:00.000Z",
    });

    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
    const recoveryChallengeKey = target.getRecoveryChallenge(serverKey, 1);
    expect(() => target.enable({ serverKey, revision: 1, actor })).toThrow(
      "MCP 熔断后需要携带恢复挑战的新健康探测",
    );
    const restored = McpServerRegistry.fromSnapshot(target.snapshot(), {
      tenantKey,
      projectKey,
      healthAuthority: authority(clock),
      clock,
    });
    expect(restored.getEnabledTool(serverKey, readToolKey)).toBeNull();

    recordNextHealth(restored, manifest, {
      producedAt: "2026-08-10T08:20:00.000Z",
    });
    expect(restored.getEnabledTool(serverKey, readToolKey)).toBeNull();

    current = Date.parse("2026-08-10T08:36:00.000Z");
    recordNextHealth(restored, manifest, {
      producedAt: "2026-08-10T08:36:00.000Z",
      recoveryChallengeKey,
    });
    expect(restored.getEnabledTool(serverKey, readToolKey)).toBeNull();
    restored.enable({ serverKey, revision: 1, actor });
    expect(restored.getEnabledTool(serverKey, readToolKey)).not.toBeNull();
  });

  it("旧健康探测被淘汰后重放也不能自动解除失败熔断", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:20:00.000Z",
    });
    target.enable({ serverKey, revision: 1, actor });
    const replayedHealthy = signNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:25:00.000Z",
    });
    target.recordHealth(replayedHealthy);
    for (let minute = 31; minute <= 35; minute += 1) {
      recordNextHealth(target, manifest, {
        status: "unhealthy",
        producedAt: `2026-08-10T08:${minute}:00.000Z`,
      });
    }
    expect(
      target
        .snapshot()
        .servers[0]!.releases[0]!.attestations.some(
          (signed) =>
            signed.payload.attestationKey ===
            replayedHealthy.payload.attestationKey,
        ),
    ).toBe(false);
    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();

    expect(() => target.recordHealth(replayedHealthy)).toThrow(
      "MCP 探测没有接续当前可信探测链",
    );
    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
  });

  it("旧失败探测在恢复并淘汰后重放也不能再次触发停用", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:20:00.000Z",
    });
    target.enable({ serverKey, revision: 1, actor });

    const replayedFailure = signNextHealth(target, manifest, {
      status: "unhealthy",
      producedAt: "2026-08-10T08:21:00.000Z",
    });
    target.recordHealth(replayedFailure);
    const firstChallenge = target.getRecoveryChallenge(serverKey, 1);
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:22:00.000Z",
      recoveryChallengeKey: firstChallenge,
    });
    target.enable({ serverKey, revision: 1, actor });

    recordNextHealth(target, manifest, {
      status: "unhealthy",
      producedAt: "2026-08-10T08:23:00.000Z",
    });
    const secondChallenge = target.getRecoveryChallenge(serverKey, 1);
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:24:00.000Z",
      recoveryChallengeKey: secondChallenge,
    });
    target.enable({ serverKey, revision: 1, actor });
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:25:00.000Z",
    });
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:26:00.000Z",
    });
    expect(
      target
        .snapshot()
        .servers[0]!.releases[0]!.attestations.some(
          (signed) =>
            signed.payload.attestationKey ===
            replayedFailure.payload.attestationKey,
        ),
    ).toBe(false);

    expect(() => target.recordHealth(replayedFailure)).toThrow(
      "MCP 探测没有接续当前可信探测链",
    );
    expect(target.getEnabledTool(serverKey, readToolKey)).not.toBeNull();
  });

  it("单版本保护槽全部占用时新的失败探测仍会优先熔断", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:00:00.000Z",
    });
    target.enable({ serverKey, revision: 1, actor });
    recordNextHealth(target, manifest, {
      status: "unhealthy",
      producedAt: "2026-08-10T08:10:00.000Z",
    });
    const recoveryChallengeKey = target.getRecoveryChallenge(serverKey, 1);
    recordNextHealth(target, manifest, {
      recoveryChallengeKey,
      producedAt: "2026-08-10T08:11:00.000Z",
    });
    target.enable({ serverKey, revision: 1, actor });
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:35:00.000Z",
    });
    recordNextHealth(target, manifest, {
      producedAt: "2026-08-10T08:12:00.000Z",
    });
    expect(
      target.snapshot().servers[0]!.releases[0]!.attestations,
    ).toHaveLength(5);

    expect(() =>
      recordNextHealth(target, manifest, {
        status: "unhealthy",
        producedAt: "2026-08-10T08:13:00.000Z",
      }),
    ).not.toThrow();
    expect(target.getEnabledTool(serverKey, readToolKey)).toBeNull();
    expect(() =>
      McpServerRegistry.fromSnapshot(target.snapshot(), {
        tenantKey,
        projectKey,
        healthAuthority: authority(),
        clock: () => new Date(now.getTime()),
      }),
    ).not.toThrow();
  });

  it("重启后用退役公钥重验状态，并拒绝清单或启用审计被改写", () => {
    const target = registry();
    target.publish(manifest);
    recordNextHealth(target);
    target.enable({ serverKey, revision: 1, actor });
    const snapshot = target.snapshot();
    const historicalAuthority = authority(
      () => new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      [{ ...verifier, acceptNewAttestations: false }],
    );

    const restored = McpServerRegistry.fromSnapshot(snapshot, {
      tenantKey,
      projectKey,
      healthAuthority: historicalAuthority,
      clock: () => new Date(now.getTime()),
    });
    expect(restored.listForPeople()[0]).toMatchObject({ status: "可使用" });
    expect(() => restored.recordHealth(signHealth(healthPayload()))).toThrow(
      "只用于核验历史探测",
    );

    const release = snapshot.servers[0]!.releases[0]!;
    expect(() =>
      McpServerRegistry.fromSnapshot(
        {
          ...snapshot,
          servers: [
            {
              ...snapshot.servers[0]!,
              releases: [
                {
                  ...release,
                  manifest: {
                    ...release.manifest,
                    tools: release.manifest.tools.map((tool) => ({
                      ...tool,
                      approval: "review_required" as const,
                    })),
                  },
                },
              ],
            },
          ],
        },
        {
          tenantKey,
          projectKey,
          healthAuthority: historicalAuthority,
        },
      ),
    ).toThrow();
    expect(() =>
      McpServerRegistry.fromSnapshot(
        { ...snapshot, enableRecords: [] },
        {
          tenantKey,
          projectKey,
          healthAuthority: historicalAuthority,
        },
      ),
    ).toThrow();
    expect(() =>
      McpServerRegistry.fromSnapshot(
        {
          ...snapshot,
          servers: snapshot.servers.map((server) => ({
            ...server,
            releases: server.releases.map((release) => ({
              ...release,
              probeHeadAttestationKey: null,
            })),
          })),
        },
        {
          tenantKey,
          projectKey,
          healthAuthority: historicalAuthority,
        },
      ),
    ).toThrow("MCP 快照的探测链头与签名探测不一致");
    expect(() =>
      McpServerRegistry.fromSnapshot(
        {
          ...snapshot,
          enableRecords: snapshot.enableRecords.map((record) => ({
            ...record,
            action: "disabled" as const,
          })),
        },
        {
          tenantKey,
          projectKey,
          healthAuthority: historicalAuthority,
        },
      ),
    ).toThrow("MCP 当前启用记录不能是停用操作");
  });

  it("达到项目版本容量后拒绝新服务器且不留下半条记录", () => {
    const target = registry();
    for (let serverIndex = 0; serverIndex < 25; serverIndex += 1) {
      const currentServerKey = randomUUID();
      const base = {
        ...manifest,
        serverKey: currentServerKey,
        connectionBindingKey: randomUUID(),
        name: `仓库业务工具 ${serverIndex + 1}`,
        tools: manifest.tools.map((tool) => ({
          ...tool,
          toolKey: randomUUID(),
        })),
      };
      for (let revision = 1; revision <= 20; revision += 1) {
        target.publish({ ...base, revision });
      }
    }

    expect(() =>
      target.publish({
        ...manifest,
        serverKey: randomUUID(),
        connectionBindingKey: randomUUID(),
        name: "额外仓库工具",
        tools: manifest.tools.map((tool) => ({
          ...tool,
          toolKey: randomUUID(),
        })),
      }),
    ).toThrow("同一项目最多保留 500 个 MCP 服务器版本");
    expect(target.snapshot().servers).toHaveLength(25);
  });

  it("探测历史达到全局窗口后淘汰未被启用记录引用的旧探测", () => {
    const target = registry();
    const identityAnchor = {
      ...manifest,
      serverKey: randomUUID(),
      connectionBindingKey: randomUUID(),
      name: "身份锚定工具",
      tools: manifest.tools.map((tool) => ({
        ...tool,
        toolKey: randomUUID(),
      })),
    };
    target.publish(identityAnchor);
    recordNextHealth(target, identityAnchor, {
      producedAt: "2026-08-10T08:00:00.000Z",
    });
    target.enable({
      serverKey: identityAnchor.serverKey,
      revision: 1,
      actor,
    });
    recordNextHealth(target, identityAnchor, {
      status: "unhealthy",
      producedAt: "2026-08-10T08:10:00.000Z",
    });
    expect(
      target.getEnabledTool(
        identityAnchor.serverKey,
        identityAnchor.tools[0]!.toolKey,
      ),
    ).toBeNull();
    for (let serverIndex = 0; serverIndex < 10; serverIndex += 1) {
      const base = {
        ...manifest,
        serverKey: randomUUID(),
        connectionBindingKey: randomUUID(),
        name: `持续探测工具 ${serverIndex + 1}`,
        tools: manifest.tools.map((tool) => ({
          ...tool,
          toolKey: randomUUID(),
        })),
      };
      for (let revision = 1; revision <= 20; revision += 1) {
        const release = { ...base, revision };
        target.publish(release);
        const attempts = serverIndex === 9 && revision === 20 ? 3 : 5;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          recordNextHealth(target, release);
        }
      }
    }
    const additional = {
      ...manifest,
      serverKey: randomUUID(),
      connectionBindingKey: randomUUID(),
      name: "新增持续探测工具",
      tools: manifest.tools.map((tool) => ({
        ...tool,
        toolKey: randomUUID(),
      })),
    };
    target.publish(additional);

    expect(() => recordNextHealth(target, additional)).not.toThrow();
    target.enable({
      serverKey: additional.serverKey,
      revision: 1,
      actor,
    });
    expect(() =>
      recordNextHealth(target, additional, {
        status: "unhealthy",
        producedAt: "2026-08-10T08:31:00.000Z",
      }),
    ).not.toThrow();
    expect(
      target.getEnabledTool(additional.serverKey, additional.tools[0]!.toolKey),
    ).toBeNull();
    const retained = target
      .snapshot()
      .servers.flatMap((server) => server.releases)
      .reduce((total, release) => total + release.attestations.length, 0);
    expect(retained).toBeLessThanOrEqual(1_000);
    expect(
      target.getEnabledTool(
        identityAnchor.serverKey,
        identityAnchor.tools[0]!.toolKey,
      ),
    ).toBeNull();
    expect(
      target
        .snapshot()
        .servers.find((server) => server.serverKey === identityAnchor.serverKey)
        ?.releases[0]?.attestations,
    ).toHaveLength(2);
    const restored = McpServerRegistry.fromSnapshot(target.snapshot(), {
      tenantKey,
      projectKey,
      healthAuthority: authority(),
      clock: () => new Date(now.getTime()),
    });
    expect(() =>
      recordNextHealth(restored, identityAnchor, {
        serverIdentityHash: "d".repeat(64),
        recoveryChallengeKey: restored.getRecoveryChallenge(
          identityAnchor.serverKey,
          1,
        ),
        producedAt: "2026-08-10T08:40:00.000Z",
      }),
    ).toThrow("MCP 服务器身份与历史可信身份不一致");
  });
});
