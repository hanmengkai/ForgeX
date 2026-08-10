import {
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SkillEvaluationAuthority,
  SkillRegistry,
  type SignedSkillEvaluation,
  type SkillEvaluationPayload,
  type SkillPackageManifest,
  type TrustedSkillEvaluator,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const skillKey = "33333333-3333-4333-8333-333333333333";
const evaluatorKey = "44444444-4444-4444-8444-444444444444";
const evaluatorKeyId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-08-10T08:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const trustedEvaluator: TrustedSkillEvaluator = {
  evaluatorKey,
  keyId: evaluatorKeyId,
  evaluatorName: "独立 Skill 评测器",
  publicKeyBase64: publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64"),
  scopes: [{ tenantKey, projectKey }],
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
  artifactHash: "a".repeat(64),
  artifactSizeBytes: 12_800,
  entrypoint: "SKILL.md",
  compatibleBlueprints: ["Web 应用", "内部管理系统"],
  requiredCapabilities: ["读取项目文件", "运行代码检查"],
  permissions: {
    workspace: "write_scoped",
    network: "approved_destinations",
    commands: "sandboxed",
  },
  createdAt: "2026-08-10T07:00:00.000Z",
};

const evaluationPayload = (
  target: SkillPackageManifest = manifest,
  overrides: Partial<SkillEvaluationPayload> = {},
): SkillEvaluationPayload => ({
  schemaVersion: 1,
  evaluationKey: randomUUID(),
  tenantKey: target.tenantKey,
  projectKey: target.projectKey,
  skillKey: target.skillKey,
  skillVersion: target.version,
  artifactHashAlgorithm: target.artifactHashAlgorithm,
  artifactHash: target.artifactHash,
  manifestHashAlgorithm: "sha256",
  manifestHash: SkillEvaluationAuthority.manifestHash(target),
  evaluatorKey,
  keyId: evaluatorKeyId,
  suiteName: "ForgeX 基础交付评测",
  suiteRevision: 1,
  producedAt: "2026-08-10T07:30:00.000Z",
  outcome: "passed",
  score: 96,
  scenarioCount: 8,
  passedScenarioCount: 8,
  criticalFailureCount: 0,
  ...overrides,
});

describe("SkillRegistry 清单完整性", () => {
  it("拒绝提升权限或改写能力声明的快照", () => {
    const registry = createRegistry();
    registry.publish(manifest);
    registry.recordEvaluation(signEvaluation(evaluationPayload()));
    registry.activate({ skillKey, version: "1.0.0", actor });
    const snapshot = registry.snapshot();
    const release = snapshot.skills[0]!.releases[0]!;

    for (const changedManifest of [
      {
        ...release.manifest,
        permissions: {
          workspace: "read_only" as const,
          network: "none" as const,
          commands: "none" as const,
        },
      },
      {
        ...release.manifest,
        requiredCapabilities: [
          "read project files",
          "execute arbitrary commands",
        ],
      },
    ]) {
      expect(() =>
        SkillRegistry.fromSnapshot(
          {
            ...snapshot,
            skills: [
              {
                ...snapshot.skills[0]!,
                releases: [{ ...release, manifest: changedManifest }],
              },
            ],
          },
          {
            tenantKey,
            projectKey,
            evaluationAuthority: new SkillEvaluationAuthority({
              evaluators: [trustedEvaluator],
              clock: () => new Date(now.getTime()),
            }),
            clock: () => new Date(now.getTime()),
          },
        ),
      ).toThrow();
    }
  });
});

const signEvaluation = (
  payload: SkillEvaluationPayload,
): SignedSkillEvaluation => ({
  payload,
  signature: signPayload(
    null,
    Buffer.from(SkillEvaluationAuthority.canonicalPayload(payload), "utf8"),
    privateKey,
  ).toString("base64"),
});

const createRegistry = (clock: () => Date = () => new Date(now.getTime())) =>
  new SkillRegistry({
    tenantKey,
    projectKey,
    evaluationAuthority: new SkillEvaluationAuthority({
      evaluators: [trustedEvaluator],
      clock,
      maxEvaluationAgeMs: 24 * 60 * 60 * 1_000,
    }),
    clock,
  });

const actor = {
  actorKey: "66666666-6666-4666-8666-666666666666",
  actorName: "平台管理员",
};

describe("SkillRegistry", () => {
  it("只有绑定具体制品并通过独立评测的 Skill 才能激活", () => {
    const registry = createRegistry();
    registry.publish(manifest);

    expect(() =>
      registry.activate({ skillKey, version: "1.0.0", actor }),
    ).toThrow("Skill 尚未通过独立评测");

    registry.recordEvaluation(signEvaluation(evaluationPayload()));
    registry.activate({ skillKey, version: "1.0.0", actor });

    expect(registry.getActive(skillKey)).toEqual(manifest);
    expect(registry.listForPeople()).toEqual([
      {
        name: "需求风险检查",
        summary: "在进入开发前检查遗漏、歧义和高风险变更",
        status: "可使用",
        activeVersion: "1.0.0",
        quality: "通过 8 个场景，评分 96",
        safety: "限定工作区写入 · 仅访问获批网络 · 命令在沙箱运行",
      },
    ]);
    expect(registry.listActivationRecords()).toEqual([
      {
        action: "activated",
        actorKey: actor.actorKey,
        actorName: actor.actorName,
        skillKey,
        version: "1.0.0",
        evaluationKey: expect.any(String),
        recordedAt: now.toISOString(),
      },
    ]);
  });

  it("连续发布新版本，并允许回滚到仍然通过评测的旧版本", () => {
    const registry = createRegistry();
    registry.publish(manifest);
    registry.recordEvaluation(signEvaluation(evaluationPayload()));
    registry.activate({ skillKey, version: "1.0.0", actor });
    const next = {
      ...manifest,
      version: "1.1.0",
      artifactHash: "b".repeat(64),
      createdAt: "2026-08-10T07:10:00.000Z",
    };
    registry.publish(next);
    registry.recordEvaluation(signEvaluation(evaluationPayload(next)));
    registry.activate({ skillKey, version: "1.1.0", actor });

    registry.activate({ skillKey, version: "1.0.0", actor });

    expect(registry.getActive(skillKey)?.version).toBe("1.0.0");
    expect(registry.listActivationRecords().at(-1)).toMatchObject({
      action: "rolled_back",
      version: "1.0.0",
    });
  });

  it("拒绝覆盖版本、倒序发布和改变 Skill 身份", () => {
    const registry = createRegistry();
    registry.publish(manifest);
    expect(() =>
      registry.publish({ ...manifest, summary: "内容被覆盖" }),
    ).toThrow("同一版本的 Skill 包不能被覆盖");
    expect(() => registry.publish({ ...manifest, version: "0.9.0" })).toThrow(
      "Skill 版本必须向前发布",
    );
    expect(() =>
      registry.publish({
        ...manifest,
        version: "1.1.0",
        name: "另一个业务能力",
      }),
    ).toThrow("同一个 Skill 不能更改业务名称");
  });

  it("拒绝被篡改、跨范围、失败或已经过期的评测", () => {
    let current = now.getTime();
    const registry = createRegistry(() => new Date(current));
    registry.publish(manifest);
    const genuine = signEvaluation(evaluationPayload());

    expect(() =>
      registry.recordEvaluation({
        ...genuine,
        payload: { ...genuine.payload, score: 100 },
      }),
    ).toThrow("Skill 评测签名无效");
    expect(() =>
      registry.recordEvaluation(
        signEvaluation(
          evaluationPayload(manifest, {
            projectKey: "77777777-7777-4777-8777-777777777777",
          }),
        ),
      ),
    ).toThrow("Skill 评测器无权验证这个租户或项目");
    registry.recordEvaluation(
      signEvaluation(
        evaluationPayload(manifest, {
          outcome: "failed",
          score: 70,
          passedScenarioCount: 7,
          criticalFailureCount: 1,
        }),
      ),
    );
    expect(() =>
      registry.activate({ skillKey, version: "1.0.0", actor }),
    ).toThrow("Skill 尚未通过独立评测");

    const freshRegistry = createRegistry(() => new Date(current));
    freshRegistry.publish(manifest);
    freshRegistry.recordEvaluation(genuine);
    current += 25 * 60 * 60 * 1_000;
    expect(() =>
      freshRegistry.activate({ skillKey, version: "1.0.0", actor }),
    ).toThrow("Skill 评测已经过期");
  });

  it("重启后用历史公钥重验快照，并保持激活审计与版本绑定", () => {
    const registry = createRegistry();
    registry.publish(manifest);
    registry.recordEvaluation(signEvaluation(evaluationPayload()));
    registry.activate({ skillKey, version: "1.0.0", actor });
    const snapshot = registry.snapshot();
    const historicalAuthority = new SkillEvaluationAuthority({
      evaluators: [
        {
          ...trustedEvaluator,
          acceptNewEvaluations: false,
        },
      ],
      clock: () => new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      maxEvaluationAgeMs: 24 * 60 * 60 * 1_000,
    });

    const restored = SkillRegistry.fromSnapshot(snapshot, {
      tenantKey,
      projectKey,
      evaluationAuthority: historicalAuthority,
      clock: () => new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
    });

    expect(restored.getActive(skillKey)).toEqual(manifest);
    expect(() =>
      restored.recordEvaluation(signEvaluation(evaluationPayload())),
    ).toThrow("这个 Skill 评测密钥只用于核验历史评测");

    expect(() =>
      SkillRegistry.fromSnapshot(
        {
          ...snapshot,
          skills: snapshot.skills.map((item) => ({
            ...item,
            activeVersion: null,
          })),
        },
        {
          tenantKey,
          projectKey,
          evaluationAuthority: historicalAuthority,
        },
      ),
    ).toThrow("Skill 快照的当前版本与激活审计不一致");

    const genuineSignature =
      snapshot.skills[0]!.releases[0]!.evaluations[0]!.signature;
    expect(() =>
      SkillRegistry.fromSnapshot(
        {
          ...snapshot,
          skills: [
            {
              ...snapshot.skills[0]!,
              releases: [
                {
                  ...snapshot.skills[0]!.releases[0]!,
                  evaluations: [
                    {
                      ...snapshot.skills[0]!.releases[0]!.evaluations[0]!,
                      signature: `${genuineSignature[0] === "A" ? "B" : "A"}${genuineSignature.slice(1)}`,
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          tenantKey,
          projectKey,
          evaluationAuthority: historicalAuthority,
        },
      ),
    ).toThrow("Skill 评测签名无效");
  });
});
