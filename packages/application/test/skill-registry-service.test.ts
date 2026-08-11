import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SkillPackageCodec,
  SkillEvaluationAuthority,
  type SkillEvaluationPayload,
  type SkillPackageManifest,
} from "@forgex/extensions";

import {
  InMemorySkillArtifactStore,
  InMemorySkillRegistryRepository,
  SkillRegistryApplicationService,
  type AuthenticatedPrincipal,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const skillKey = "33333333-3333-4333-8333-333333333333";
const evaluatorKey = "44444444-4444-4444-8444-444444444444";
const keyId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-08-10T08:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const artifactBytes = SkillPackageCodec.encode({
  schemaVersion: 1,
  instructions: "# 需求风险检查\n\n在开发前检查需求遗漏、歧义和高风险变更。",
  resources: [],
});

const administrator: AuthenticatedPrincipal = {
  actorKey: "66666666-6666-4666-8666-666666666666",
  actorName: "平台管理员",
  tenantKey,
  roles: ["administrator"],
};
const developer: AuthenticatedPrincipal = {
  actorKey: "77777777-7777-4777-8777-777777777777",
  actorName: "初级研发",
  tenantKey,
  roles: ["developer"],
};

const manifest: SkillPackageManifest = {
  schemaVersion: 1,
  skillKey,
  tenantKey,
  projectKey,
  version: "1.0.0",
  name: "需求风险检查",
  summary: "在进入开发前检查遗漏、歧义和高风险变更",
  artifactHashAlgorithm: "sha256",
  artifactHash: createHash("sha256").update(artifactBytes).digest("hex"),
  artifactSizeBytes: artifactBytes.byteLength,
  entrypoint: "SKILL.md",
  compatibleBlueprints: ["Web 应用"],
  requiredCapabilities: ["读取项目文件"],
  permissions: {
    workspace: "read_only",
    network: "none",
    commands: "none",
  },
  createdAt: "2026-08-10T07:00:00.000Z",
};

const evaluationPayload = (): SkillEvaluationPayload => ({
  schemaVersion: 1,
  evaluationKey: randomUUID(),
  tenantKey,
  projectKey,
  skillKey,
  skillVersion: "1.0.0",
  artifactHashAlgorithm: "sha256",
  artifactHash: manifest.artifactHash,
  manifestHashAlgorithm: "sha256",
  manifestHash: SkillEvaluationAuthority.manifestHash(manifest),
  evaluatorKey,
  keyId,
  suiteName: "ForgeX 基础交付评测",
  suiteRevision: 1,
  producedAt: "2026-08-10T07:30:00.000Z",
  outcome: "passed",
  score: 96,
  scenarioCount: 8,
  passedScenarioCount: 8,
  criticalFailureCount: 0,
});

const authority = (acceptNewEvaluations = true) =>
  new SkillEvaluationAuthority({
    evaluators: [
      {
        evaluatorKey,
        keyId,
        evaluatorName: "独立 Skill 评测器",
        publicKeyBase64: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        scopes: [{ tenantKey, projectKey }],
        acceptNewEvaluations,
      },
    ],
    clock: () => new Date(now.getTime()),
  });

const signedEvaluation = () => {
  const payload = evaluationPayload();
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(SkillEvaluationAuthority.canonicalPayload(payload), "utf8"),
      privateKey,
    ).toString("base64"),
  };
};

const createService = (
  repository = new InMemorySkillRegistryRepository(),
  evaluationAuthority = authority(),
  artifactStore = new InMemorySkillArtifactStore(),
) => ({
  repository,
  artifactStore,
  service: new SkillRegistryApplicationService({
    repository,
    artifactStore,
    projectKey,
    evaluationAuthority,
    clock: () => new Date(now.getTime()),
  }),
});

describe("SkillRegistryApplicationService", () => {
  it("由管理员发布和激活，通过独立评测后向成员返回人性化状态", async () => {
    const { repository, service } = createService();

    await service.publish(administrator, manifest, artifactBytes);
    await service.recordEvaluation(tenantKey, signedEvaluation());
    await service.activate(administrator, skillKey, "1.0.0");

    await expect(service.listForPeople(developer)).resolves.toEqual([
      expect.objectContaining({
        name: "需求风险检查",
        status: "可使用",
        activeVersion: "1.0.0",
      }),
    ]);
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual([
      expect.objectContaining({
        action: "activated",
        actorKey: administrator.actorKey,
        actorName: administrator.actorName,
        skillKey,
        version: "1.0.0",
      }),
    ]);
    await expect(
      service.getActiveForExecution(tenantKey, projectKey, skillKey),
    ).resolves.toEqual({
      manifest,
      bytes: Uint8Array.from(artifactBytes),
    });
  });

  it("租户级 Worker 可从当前服务精确读取另一项目绑定的 Skill 版本", async () => {
    const otherProjectKey = "88888888-8888-4888-8888-888888888888";
    const repository = new InMemorySkillRegistryRepository();
    const artifactStore = new InMemorySkillArtifactStore();
    const sharedAuthority = new SkillEvaluationAuthority({
      evaluators: [
        {
          evaluatorKey,
          keyId,
          evaluatorName: "独立 Skill 评测器",
          publicKeyBase64: publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
          scopes: [
            { tenantKey, projectKey },
            { tenantKey, projectKey: otherProjectKey },
          ],
        },
      ],
      clock: () => new Date(now.getTime()),
    });
    const currentProject = new SkillRegistryApplicationService({
      repository,
      artifactStore,
      projectKey,
      evaluationAuthority: sharedAuthority,
      clock: () => new Date(now.getTime()),
    });
    const otherProject = new SkillRegistryApplicationService({
      repository,
      artifactStore,
      projectKey: otherProjectKey,
      evaluationAuthority: sharedAuthority,
      clock: () => new Date(now.getTime()),
    });
    const otherManifest = { ...manifest, projectKey: otherProjectKey };
    const payload = {
      ...evaluationPayload(),
      projectKey: otherProjectKey,
      manifestHash: SkillEvaluationAuthority.manifestHash(otherManifest),
    };
    const evaluation = {
      payload,
      signature: sign(
        null,
        Buffer.from(SkillEvaluationAuthority.canonicalPayload(payload), "utf8"),
        privateKey,
      ).toString("base64"),
    };

    await currentProject.publish(administrator, manifest, artifactBytes);
    await otherProject.publish(administrator, otherManifest, artifactBytes);
    await otherProject.recordEvaluation(tenantKey, evaluation);
    await otherProject.activate(administrator, skillKey, "1.0.0");

    await expect(
      currentProject.getVersionForExecution(
        tenantKey,
        otherProjectKey,
        skillKey,
        "1.0.0",
      ),
    ).resolves.toEqual({
      manifest: otherManifest,
      bytes: Uint8Array.from(artifactBytes),
    });
  });

  it("普通成员不能发布或切换 Skill", async () => {
    const { service } = createService();

    await expect(
      service.publish(developer, manifest, artifactBytes),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "skill_admin_required",
    });
    await expect(
      service.activate(developer, skillKey, "1.0.0"),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "skill_admin_required",
    });
  });

  it("拒绝在 Skill 清单、指令或资源中保存明文凭据", async () => {
    const { service } = createService();
    const instructionSecret = SkillPackageCodec.encode({
      schemaVersion: 1,
      instructions:
        '# 团队交付规范\n\n执行前使用 password = "correct horse battery staple" 登录。',
      resources: [],
    });
    const resourceSecret = SkillPackageCodec.encode({
      schemaVersion: 1,
      instructions: "# 团队交付规范\n\n执行前阅读项目内的规范资源。",
      resources: [
        {
          path: "references/access.md",
          mediaType: "text/markdown",
          encoding: "utf8",
          content: "api_key = actual-example-production-secret-123456",
        },
      ],
    });
    const cases = [
      {
        bytes: artifactBytes,
        manifest: {
          ...manifest,
          summary:
            "团队规范 client_secret = actual-example-production-secret-123456",
        },
      },
      { bytes: instructionSecret, manifest },
      { bytes: resourceSecret, manifest },
    ].map(({ bytes, manifest: candidate }) => ({
      bytes,
      manifest: {
        ...candidate,
        artifactHash: createHash("sha256").update(bytes).digest("hex"),
        artifactSizeBytes: bytes.byteLength,
      },
    }));

    for (const candidate of cases) {
      await expect(
        service.publish(administrator, candidate.manifest, candidate.bytes),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: "skill_credential_detected",
      });
    }
    const executableResource = SkillPackageCodec.encode({
      schemaVersion: 1,
      instructions:
        "# 团队交付规范\n\n执行前读取包内说明，但不允许直接运行包内脚本。",
      resources: [
        {
          path: "scripts/check.mjs",
          mediaType: "application/javascript",
          encoding: "utf8",
          content: "process.exit(0);",
        },
      ],
    });
    await expect(
      service.publish(
        administrator,
        {
          ...manifest,
          artifactHash: createHash("sha256")
            .update(executableResource)
            .digest("hex"),
          artifactSizeBytes: executableResource.byteLength,
        },
        executableResource,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "skill_resource_unsupported",
    });
    await expect(service.listForPeople(developer)).resolves.toEqual([]);
  });

  it("同一版本的并发激活保持幂等且只写一条审计", async () => {
    const { repository, service } = createService();
    await service.publish(administrator, manifest, artifactBytes);
    await service.recordEvaluation(tenantKey, signedEvaluation());

    await Promise.all([
      service.activate(administrator, skillKey, "1.0.0"),
      service.activate(administrator, skillKey, "1.0.0"),
    ]);

    await expect(
      repository.listAudit(tenantKey, projectKey),
    ).resolves.toHaveLength(1);
  });

  it("失败的激活不会修改快照或写入审计", async () => {
    const { repository, service } = createService();
    await service.publish(administrator, manifest, artifactBytes);

    await expect(
      service.activate(administrator, skillKey, "1.0.0"),
    ).rejects.toThrow("Skill 尚未通过独立评测");

    await expect(service.listForPeople(developer)).resolves.toEqual([
      expect.objectContaining({ status: "等待验证", activeVersion: null }),
    ]);
    await expect(repository.listAudit(tenantKey, projectKey)).resolves.toEqual(
      [],
    );
  });

  it("制品校验失败时不发布，执行读取也不会掩盖缺失制品", async () => {
    const repository = new InMemorySkillRegistryRepository();
    const artifactStore = new InMemorySkillArtifactStore();
    const service = createService(
      repository,
      authority(),
      artifactStore,
    ).service;

    await expect(
      service.publish(administrator, manifest, artifactBytes.slice(1)),
    ).rejects.toThrow("Skill 制品大小与清单不一致");
    await expect(service.listForPeople(developer)).resolves.toEqual([]);

    await service.publish(administrator, manifest, artifactBytes);
    await service.recordEvaluation(tenantKey, signedEvaluation());
    await service.activate(administrator, skillKey, "1.0.0");
    const missingArtifactService = createService(
      repository,
      authority(false),
      new InMemorySkillArtifactStore(),
    ).service;
    await expect(
      missingArtifactService.getActiveForExecution(
        tenantKey,
        projectKey,
        skillKey,
      ),
    ).rejects.toThrow("已经激活的 Skill 缺少对应制品");
  });

  it("服务重启后使用退役公钥恢复历史状态，但不能接收新评测", async () => {
    const repository = new InMemorySkillRegistryRepository();
    const artifactStore = new InMemorySkillArtifactStore();
    const first = createService(repository, authority(), artifactStore).service;
    await first.publish(administrator, manifest, artifactBytes);
    await first.recordEvaluation(tenantKey, signedEvaluation());
    await first.activate(administrator, skillKey, "1.0.0");
    const restarted = createService(
      repository,
      authority(false),
      artifactStore,
    ).service;

    await expect(restarted.listForPeople(developer)).resolves.toEqual([
      expect.objectContaining({ status: "可使用", activeVersion: "1.0.0" }),
    ]);
    await expect(
      restarted.recordEvaluation(tenantKey, signedEvaluation()),
    ).rejects.toThrow("这个 Skill 评测密钥只用于核验历史评测");
  });
});
