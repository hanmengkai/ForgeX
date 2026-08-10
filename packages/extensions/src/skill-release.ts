import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import { z } from "zod";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const semanticVersion = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/)
  .refine(
    (value) => value.split(".").map(Number).every(Number.isSafeInteger),
    "Skill 版本号超出安全范围",
  );
const humanLabel = z.string().trim().min(2).max(100);
const businessName = humanLabel.refine(
  (value) => !/^[a-z][a-z0-9_.-]*(?:\(\))?$/i.test(value),
  "请使用业务名称，不要只填写技术标识",
);
const sha256Hash = z.string().regex(/^[0-9a-f]{64}$/);

export const SkillPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    skillKey: internalKey,
    tenantKey: internalKey,
    projectKey: internalKey,
    version: semanticVersion,
    name: businessName,
    summary: z.string().trim().min(4).max(500),
    artifactHashAlgorithm: z.literal("sha256"),
    artifactHash: sha256Hash,
    artifactSizeBytes: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
    entrypoint: z.literal("SKILL.md"),
    compatibleBlueprints: z.array(humanLabel).max(20),
    requiredCapabilities: z.array(humanLabel).max(50),
    permissions: z
      .object({
        workspace: z.enum(["read_only", "write_scoped"]),
        network: z.enum(["none", "approved_destinations"]),
        commands: z.enum(["none", "sandboxed"]),
      })
      .strict(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      new Set(manifest.compatibleBlueprints).size !==
      manifest.compatibleBlueprints.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibleBlueprints"],
        message: "兼容方案不能重复",
      });
    }
    if (
      new Set(manifest.requiredCapabilities).size !==
      manifest.requiredCapabilities.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredCapabilities"],
        message: "所需能力不能重复",
      });
    }
  });

export type SkillPackageManifest = z.infer<typeof SkillPackageManifestSchema>;

export const SkillEvaluationPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluationKey: internalKey,
    tenantKey: internalKey,
    projectKey: internalKey,
    skillKey: internalKey,
    skillVersion: semanticVersion,
    artifactHashAlgorithm: z.literal("sha256"),
    artifactHash: sha256Hash,
    manifestHashAlgorithm: z.literal("sha256"),
    manifestHash: sha256Hash,
    evaluatorKey: internalKey,
    keyId: internalKey,
    suiteName: humanLabel,
    suiteRevision: z.number().int().min(1).max(1_000_000),
    producedAt: z.iso.datetime(),
    outcome: z.enum(["passed", "failed"]),
    score: z.number().int().min(0).max(100),
    scenarioCount: z.number().int().min(1).max(1_000),
    passedScenarioCount: z.number().int().min(0).max(1_000),
    criticalFailureCount: z.number().int().min(0).max(1_000),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (evaluation.passedScenarioCount > evaluation.scenarioCount) {
      context.addIssue({
        code: "custom",
        path: ["passedScenarioCount"],
        message: "通过场景数不能超过场景总数",
      });
    }
    if (evaluation.criticalFailureCount > evaluation.scenarioCount) {
      context.addIssue({
        code: "custom",
        path: ["criticalFailureCount"],
        message: "严重失败数不能超过场景总数",
      });
    }
    if (
      evaluation.outcome === "passed" &&
      (evaluation.passedScenarioCount !== evaluation.scenarioCount ||
        evaluation.criticalFailureCount !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "评测通过必须全部场景成功且没有严重失败",
      });
    }
  });

export type SkillEvaluationPayload = z.infer<
  typeof SkillEvaluationPayloadSchema
>;

const canonicalBase64Signature = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    try {
      const bytes = Buffer.from(value, "base64");
      if (bytes.length !== 64 || bytes.toString("base64") !== value) {
        context.addIssue({ code: "custom", message: "签名格式无效" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "签名格式无效" });
    }
  });

export const SignedSkillEvaluationSchema = z
  .object({
    payload: SkillEvaluationPayloadSchema,
    signature: canonicalBase64Signature,
  })
  .strict();

export type SignedSkillEvaluation = z.infer<typeof SignedSkillEvaluationSchema>;

export interface SkillEvaluatorScope {
  tenantKey: string;
  projectKey: string;
}

export interface TrustedSkillEvaluator {
  evaluatorKey: string;
  keyId: string;
  evaluatorName: string;
  publicKeyBase64: string;
  scopes: SkillEvaluatorScope[];
  acceptNewEvaluations?: boolean;
}

export interface SkillEvaluationAuthorityOptions {
  evaluators: TrustedSkillEvaluator[];
  clock?: () => Date;
  maxEvaluationAgeMs?: number;
  maxFutureSkewMs?: number;
}

interface PreparedEvaluator {
  evaluatorKey: string;
  keyId: string;
  evaluatorName: string;
  publicKey: KeyObject;
  scopes: readonly Readonly<SkillEvaluatorScope>[];
  acceptNewEvaluations: boolean;
}

const verifiedEvaluationToken = Symbol("forgex-verified-skill-evaluation");

export class VerifiedSkillEvaluationReceipt {
  readonly #authentic = true;
  readonly #validUntilMs: number;
  readonly #maxFutureSkewMs: number;
  readonly payload: Readonly<SkillEvaluationPayload>;
  readonly signature: string;
  readonly evaluatorName: string;

  constructor(
    payload: SkillEvaluationPayload,
    signature: string,
    evaluatorName: string,
    validity: { validUntilMs: number; maxFutureSkewMs: number },
    token: typeof verifiedEvaluationToken,
  ) {
    if (token !== verifiedEvaluationToken) {
      throw new Error("Skill 评测必须经过受信任的 SkillEvaluationAuthority");
    }
    this.payload = Object.freeze(structuredClone(payload));
    this.signature = signature;
    this.evaluatorName = evaluatorName;
    this.#validUntilMs = validity.validUntilMs;
    this.#maxFutureSkewMs = validity.maxFutureSkewMs;
    Object.freeze(this);
  }

  static assertAuthentic(receipt: VerifiedSkillEvaluationReceipt): void {
    if (!receipt.#authentic) {
      throw new Error("Skill 评测不是由受信任的评测机构签发");
    }
  }

  static assertUsableAt(
    receipt: VerifiedSkillEvaluationReceipt,
    now: Date,
  ): void {
    VerifiedSkillEvaluationReceipt.assertAuthentic(receipt);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Skill 评测验证时间无效");
    const producedAtMs = Date.parse(receipt.payload.producedAt);
    if (producedAtMs > nowMs + receipt.#maxFutureSkewMs) {
      throw new Error("Skill 评测时间超出允许的未来偏差");
    }
    if (nowMs > receipt.#validUntilMs) {
      throw new Error("Skill 评测已经过期，请重新评测");
    }
  }
}

export class SkillEvaluationAuthority {
  readonly #evaluators = new Map<string, PreparedEvaluator>();
  readonly #clock: () => Date;
  readonly #maxEvaluationAgeMs: number;
  readonly #maxFutureSkewMs: number;

  constructor(options: SkillEvaluationAuthorityOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#maxEvaluationAgeMs =
      options.maxEvaluationAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.#maxEvaluationAgeMs) ||
      !Number.isSafeInteger(this.#maxFutureSkewMs) ||
      this.#maxEvaluationAgeMs < 1 ||
      this.#maxFutureSkewMs < 0
    ) {
      throw new Error("Skill 评测有效期配置无效");
    }
    if (options.evaluators.length > 100) {
      throw new Error("受信任 Skill 评测器最多配置 100 个");
    }
    for (const evaluator of options.evaluators) {
      const prepared = SkillEvaluationAuthority.#prepareEvaluator(evaluator);
      const key = SkillEvaluationAuthority.#lookupKey(
        prepared.evaluatorKey,
        prepared.keyId,
      );
      if (this.#evaluators.has(key)) {
        throw new Error("受信任 Skill 评测器的 evaluatorKey 与 keyId 不能重复");
      }
      this.#evaluators.set(key, prepared);
    }
  }

  static canonicalPayload(payload: SkillEvaluationPayload): string {
    const parsed = SkillEvaluationPayloadSchema.parse(payload);
    return JSON.stringify({
      schemaVersion: parsed.schemaVersion,
      evaluationKey: parsed.evaluationKey,
      tenantKey: parsed.tenantKey,
      projectKey: parsed.projectKey,
      skillKey: parsed.skillKey,
      skillVersion: parsed.skillVersion,
      artifactHashAlgorithm: parsed.artifactHashAlgorithm,
      artifactHash: parsed.artifactHash,
      manifestHashAlgorithm: parsed.manifestHashAlgorithm,
      manifestHash: parsed.manifestHash,
      evaluatorKey: parsed.evaluatorKey,
      keyId: parsed.keyId,
      suiteName: parsed.suiteName,
      suiteRevision: parsed.suiteRevision,
      producedAt: parsed.producedAt,
      outcome: parsed.outcome,
      score: parsed.score,
      scenarioCount: parsed.scenarioCount,
      passedScenarioCount: parsed.passedScenarioCount,
      criticalFailureCount: parsed.criticalFailureCount,
    });
  }

  static canonicalManifest(manifest: SkillPackageManifest): string {
    const parsed = SkillPackageManifestSchema.parse(manifest);
    return JSON.stringify({
      schemaVersion: parsed.schemaVersion,
      skillKey: parsed.skillKey,
      tenantKey: parsed.tenantKey,
      projectKey: parsed.projectKey,
      version: parsed.version,
      name: parsed.name,
      summary: parsed.summary,
      artifactHashAlgorithm: parsed.artifactHashAlgorithm,
      artifactHash: parsed.artifactHash,
      artifactSizeBytes: parsed.artifactSizeBytes,
      entrypoint: parsed.entrypoint,
      compatibleBlueprints: parsed.compatibleBlueprints,
      requiredCapabilities: parsed.requiredCapabilities,
      permissions: {
        workspace: parsed.permissions.workspace,
        network: parsed.permissions.network,
        commands: parsed.permissions.commands,
      },
      createdAt: parsed.createdAt,
    });
  }

  static manifestHash(manifest: SkillPackageManifest): string {
    return createHash("sha256")
      .update(SkillEvaluationAuthority.canonicalManifest(manifest), "utf8")
      .digest("hex");
  }

  verify(input: SignedSkillEvaluation): VerifiedSkillEvaluationReceipt {
    return this.#verify(input, true);
  }

  verifyPersisted(
    input: SignedSkillEvaluation,
  ): VerifiedSkillEvaluationReceipt {
    return this.#verify(input, false);
  }

  #verify(
    input: SignedSkillEvaluation,
    enforceCurrentFreshness: boolean,
  ): VerifiedSkillEvaluationReceipt {
    const parsed = SignedSkillEvaluationSchema.safeParse(input);
    if (!parsed.success) throw new Error("Skill 评测格式不完整或包含无效字段");
    const evaluator = this.#evaluators.get(
      SkillEvaluationAuthority.#lookupKey(
        parsed.data.payload.evaluatorKey,
        parsed.data.payload.keyId,
      ),
    );
    if (!evaluator) throw new Error("Skill 评测器或签名密钥不受信任");
    if (enforceCurrentFreshness && !evaluator.acceptNewEvaluations) {
      throw new Error("这个 Skill 评测密钥只用于核验历史评测");
    }
    if (
      !evaluator.scopes.some(
        (scope) =>
          scope.tenantKey === parsed.data.payload.tenantKey &&
          scope.projectKey === parsed.data.payload.projectKey,
      )
    ) {
      throw new Error("Skill 评测器无权验证这个租户或项目");
    }
    if (enforceCurrentFreshness) {
      this.#assertFresh(parsed.data.payload.producedAt);
    }
    const verified = verifySignature(
      null,
      Buffer.from(
        SkillEvaluationAuthority.canonicalPayload(parsed.data.payload),
        "utf8",
      ),
      evaluator.publicKey,
      Buffer.from(parsed.data.signature, "base64"),
    );
    if (!verified) throw new Error("Skill 评测签名无效");
    return new VerifiedSkillEvaluationReceipt(
      parsed.data.payload,
      parsed.data.signature,
      evaluator.evaluatorName,
      {
        validUntilMs:
          Date.parse(parsed.data.payload.producedAt) + this.#maxEvaluationAgeMs,
        maxFutureSkewMs: this.#maxFutureSkewMs,
      },
      verifiedEvaluationToken,
    );
  }

  #assertFresh(producedAt: string): void {
    const producedAtMs = Date.parse(producedAt);
    const nowMs = this.#clock().getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Skill 评测验证时间无效");
    if (producedAtMs > nowMs + this.#maxFutureSkewMs) {
      throw new Error("Skill 评测时间超出允许的未来偏差");
    }
    if (producedAtMs < nowMs - this.#maxEvaluationAgeMs) {
      throw new Error("Skill 评测已经过期，请重新评测");
    }
  }

  static #prepareEvaluator(
    evaluator: TrustedSkillEvaluator,
  ): PreparedEvaluator {
    const evaluatorKey = internalKey.parse(evaluator.evaluatorKey);
    const keyId = internalKey.parse(evaluator.keyId);
    const evaluatorName = humanLabel.parse(evaluator.evaluatorName);
    if (evaluator.scopes.length === 0 || evaluator.scopes.length > 100) {
      throw new Error("受信任 Skill 评测器需要 1 到 100 个授权范围");
    }
    if (
      evaluator.acceptNewEvaluations !== undefined &&
      typeof evaluator.acceptNewEvaluations !== "boolean"
    ) {
      throw new Error("受信任 Skill 评测器配置不完整");
    }
    const scopes = evaluator.scopes.map((scope) =>
      Object.freeze({
        tenantKey: internalKey.parse(scope.tenantKey),
        projectKey: internalKey.parse(scope.projectKey),
      }),
    );
    if (
      new Set(scopes.map((scope) => `${scope.tenantKey}:${scope.projectKey}`))
        .size !== scopes.length
    ) {
      throw new Error("受信任 Skill 评测器的授权范围不能重复");
    }
    let publicKey: KeyObject;
    try {
      const bytes = Buffer.from(evaluator.publicKeyBase64, "base64");
      if (bytes.toString("base64") !== evaluator.publicKeyBase64) {
        throw new Error("non-canonical-base64");
      }
      publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    } catch {
      throw new Error("受信任 Skill 评测器的 Ed25519 公钥无效");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("受信任 Skill 评测器必须使用 Ed25519 公钥");
    }
    return {
      evaluatorKey,
      keyId,
      evaluatorName,
      publicKey,
      scopes: Object.freeze(scopes),
      acceptNewEvaluations: evaluator.acceptNewEvaluations ?? true,
    };
  }

  static #lookupKey(evaluatorKey: string, keyId: string): string {
    return `${evaluatorKey.toLowerCase()}:${keyId.toLowerCase()}`;
  }
}

interface SkillRelease {
  manifest: SkillPackageManifest;
  evaluations: Map<
    string,
    {
      signed: SignedSkillEvaluation;
      receipt: VerifiedSkillEvaluationReceipt;
    }
  >;
}

interface RegisteredSkill {
  name: string;
  releases: Map<string, SkillRelease>;
  activeVersion: string | null;
}

export interface SkillActivationActor {
  actorKey: string;
  actorName: string;
}

export const SkillActivationRecordSchema = z
  .object({
    action: z.enum(["activated", "rolled_back"]),
    actorKey: internalKey,
    actorName: humanLabel,
    skillKey: internalKey,
    version: semanticVersion,
    evaluationKey: internalKey,
    recordedAt: z.iso.datetime(),
  })
  .strict();

export type SkillActivationRecord = z.infer<typeof SkillActivationRecordSchema>;

const SkillRegistryReleaseSnapshotSchema = z
  .object({
    manifest: SkillPackageManifestSchema,
    evaluations: z.array(SignedSkillEvaluationSchema).max(5),
  })
  .strict();

const SkillRegistryItemSnapshotSchema = z
  .object({
    skillKey: internalKey,
    activeVersion: semanticVersion.nullable(),
    releases: z.array(SkillRegistryReleaseSnapshotSchema).min(1).max(20),
  })
  .strict();

export const SkillRegistrySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    tenantKey: internalKey,
    projectKey: internalKey,
    skills: z.array(SkillRegistryItemSnapshotSchema).max(100),
    activationRecords: z.array(SkillActivationRecordSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const releaseCount = snapshot.skills.reduce(
      (total, skill) => total + skill.releases.length,
      0,
    );
    const evaluationCount = snapshot.skills.reduce(
      (total, skill) =>
        total +
        skill.releases.reduce(
          (releaseTotal, release) => releaseTotal + release.evaluations.length,
          0,
        ),
      0,
    );
    if (releaseCount > 500) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "Skill 快照最多保留 500 个版本",
      });
    }
    if (evaluationCount > 1_000) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "Skill 快照最多保留 1000 次评测",
      });
    }
  });

export type SkillRegistrySnapshot = z.infer<typeof SkillRegistrySnapshotSchema>;

export interface SkillRegistryOptions {
  tenantKey: string;
  projectKey: string;
  evaluationAuthority: SkillEvaluationAuthority;
  clock?: () => Date;
}

export interface SkillPeopleView {
  name: string;
  summary: string;
  status: "可使用" | "等待验证";
  activeVersion: string | null;
  quality: string;
  safety: string;
}

export interface SkillRegistryItemForPeople {
  skillKey: string;
  view: SkillPeopleView;
}

const MAX_SKILLS = 100;
const MAX_RELEASES_PER_SKILL = 20;
const MAX_EVALUATIONS_PER_RELEASE = 5;
const MAX_TOTAL_RELEASES = 500;
const MAX_TOTAL_EVALUATIONS = 1_000;
const MINIMUM_ACTIVATION_SCORE = 80;
const MINIMUM_ACTIVATION_SCENARIOS = 5;

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
};

const safetyForPeople = (
  permissions: SkillPackageManifest["permissions"],
): string => {
  const workspace =
    permissions.workspace === "read_only" ? "只读项目文件" : "限定工作区写入";
  const network =
    permissions.network === "none" ? "不访问网络" : "仅访问获批网络";
  const commands =
    permissions.commands === "none" ? "不运行命令" : "命令在沙箱运行";
  return `${workspace} · ${network} · ${commands}`;
};

export class SkillRegistry {
  readonly #tenantKey: string;
  readonly #projectKey: string;
  readonly #evaluationAuthority: SkillEvaluationAuthority;
  readonly #clock: () => Date;
  readonly #skills = new Map<string, RegisteredSkill>();
  readonly #evaluationKeys = new Map<string, string>();
  readonly #currentActivations = new Map<string, SkillActivationRecord>();

  constructor(options: SkillRegistryOptions) {
    this.#tenantKey = internalKey.parse(options.tenantKey);
    this.#projectKey = internalKey.parse(options.projectKey);
    this.#evaluationAuthority = options.evaluationAuthority;
    this.#clock = options.clock ?? (() => new Date());
  }

  static fromSnapshot(
    input: SkillRegistrySnapshot,
    options: SkillRegistryOptions,
  ): SkillRegistry {
    const snapshot = SkillRegistrySnapshotSchema.parse(input);
    const registry = new SkillRegistry(options);
    registry.#assertScope(snapshot.tenantKey, snapshot.projectKey);
    const snapshotSkillKeys = new Set<string>();
    for (const item of snapshot.skills) {
      if (snapshotSkillKeys.has(item.skillKey)) {
        throw new Error("Skill 快照不能包含重复 Skill");
      }
      snapshotSkillKeys.add(item.skillKey);
      const snapshotVersions = new Set<string>();
      const snapshotEvaluationKeys = new Set<string>();
      const releases = [...item.releases].sort((left, right) =>
        compareVersions(left.manifest.version, right.manifest.version),
      );
      for (const release of releases) {
        if (snapshotVersions.has(release.manifest.version)) {
          throw new Error("Skill 快照不能包含重复版本");
        }
        snapshotVersions.add(release.manifest.version);
        if (release.manifest.skillKey !== item.skillKey) {
          throw new Error("Skill 快照中的版本不属于对应 Skill");
        }
        registry.publish(release.manifest);
        for (const signed of release.evaluations) {
          if (snapshotEvaluationKeys.has(signed.payload.evaluationKey)) {
            throw new Error("Skill 快照不能包含重复评测");
          }
          snapshotEvaluationKeys.add(signed.payload.evaluationKey);
          registry.#recordVerifiedEvaluation(
            signed,
            options.evaluationAuthority.verifyPersisted(signed),
          );
        }
      }
    }

    const restoredActiveVersions = new Map<string, string>();
    for (const record of snapshot.activationRecords) {
      if (restoredActiveVersions.has(record.skillKey)) {
        throw new Error("Skill 快照不能包含重复的当前激活记录");
      }
      const skill = registry.#skills.get(record.skillKey);
      const release = skill?.releases.get(record.version);
      const evaluation = release?.evaluations.get(record.evaluationKey);
      if (
        !skill ||
        !release ||
        !evaluation ||
        !registry.#passesActivationPolicy(evaluation.receipt)
      ) {
        throw new Error("Skill 激活审计没有绑定通过评测的包版本");
      }
      restoredActiveVersions.set(record.skillKey, record.version);
      registry.#currentActivations.set(
        record.skillKey,
        structuredClone(record),
      );
    }

    for (const item of snapshot.skills) {
      const restoredVersion = restoredActiveVersions.get(item.skillKey) ?? null;
      if (item.activeVersion !== restoredVersion) {
        throw new Error("Skill 快照的当前版本与激活审计不一致");
      }
      const skill = registry.#skills.get(item.skillKey)!;
      skill.activeVersion = restoredVersion;
    }
    return registry;
  }

  publish(input: SkillPackageManifest): void {
    const manifest = SkillPackageManifestSchema.parse(input);
    this.#assertScope(manifest.tenantKey, manifest.projectKey);
    let skill = this.#skills.get(manifest.skillKey);
    if (!skill) {
      if (this.#skills.size >= MAX_SKILLS) {
        throw new Error("同一项目最多管理 100 个 Skill");
      }
      const duplicateName = [...this.#skills.values()].some(
        (candidate) =>
          candidate.name.toLowerCase() === manifest.name.toLowerCase(),
      );
      if (duplicateName) throw new Error("Skill 业务名称不能重复");
      skill = {
        name: manifest.name,
        releases: new Map(),
        activeVersion: null,
      };
    } else if (skill.name !== manifest.name) {
      throw new Error("同一个 Skill 不能更改业务名称");
    }

    const existing = skill.releases.get(manifest.version);
    if (existing) {
      if (JSON.stringify(existing.manifest) === JSON.stringify(manifest))
        return;
      throw new Error("同一版本的 Skill 包不能被覆盖");
    }
    if (skill.releases.size >= MAX_RELEASES_PER_SKILL) {
      throw new Error("同一个 Skill 最多保留 20 个版本");
    }
    const totalReleases = [...this.#skills.values()].reduce(
      (total, candidate) => total + candidate.releases.size,
      0,
    );
    if (totalReleases >= MAX_TOTAL_RELEASES) {
      throw new Error("同一项目最多保留 500 个 Skill 版本");
    }
    const latestVersion = [...skill.releases.keys()]
      .sort(compareVersions)
      .at(-1);
    if (
      latestVersion &&
      compareVersions(manifest.version, latestVersion) <= 0
    ) {
      throw new Error("Skill 版本必须向前发布");
    }
    if (!this.#skills.has(manifest.skillKey)) {
      this.#skills.set(manifest.skillKey, skill);
    }
    skill.releases.set(manifest.version, {
      manifest: structuredClone(manifest),
      evaluations: new Map(),
    });
  }

  recordEvaluation(input: SignedSkillEvaluation): void {
    const receipt = this.#evaluationAuthority.verify(input);
    this.#recordVerifiedEvaluation(
      {
        payload: structuredClone(receipt.payload),
        signature: receipt.signature,
      },
      receipt,
    );
  }

  #recordVerifiedEvaluation(
    input: SignedSkillEvaluation,
    receipt: VerifiedSkillEvaluationReceipt,
  ): void {
    VerifiedSkillEvaluationReceipt.assertAuthentic(receipt);
    const payload = receipt.payload;
    this.#assertScope(payload.tenantKey, payload.projectKey);
    const release = this.#skills
      .get(payload.skillKey)
      ?.releases.get(payload.skillVersion);
    if (!release) throw new Error("找不到 Skill 评测对应的包版本");
    if (
      payload.artifactHashAlgorithm !==
        release.manifest.artifactHashAlgorithm ||
      payload.artifactHash !== release.manifest.artifactHash ||
      payload.manifestHashAlgorithm !== "sha256" ||
      payload.manifestHash !==
        SkillEvaluationAuthority.manifestHash(release.manifest)
    ) {
      throw new Error("Skill 评测没有绑定当前包制品");
    }
    const canonicalSigned = JSON.stringify(
      SignedSkillEvaluationSchema.parse(input),
    );
    const known = this.#evaluationKeys.get(payload.evaluationKey);
    if (known) {
      if (known === canonicalSigned) return;
      throw new Error("同一个 Skill 评测标识不能绑定不同内容");
    }
    if (release.evaluations.size >= MAX_EVALUATIONS_PER_RELEASE) {
      throw new Error("同一个 Skill 版本最多保留 5 次评测");
    }
    const totalEvaluations = [...this.#skills.values()].reduce(
      (skillTotal, skill) =>
        skillTotal +
        [...skill.releases.values()].reduce(
          (releaseTotal, candidate) =>
            releaseTotal + candidate.evaluations.size,
          0,
        ),
      0,
    );
    if (totalEvaluations >= MAX_TOTAL_EVALUATIONS) {
      throw new Error("同一项目最多保留 1000 次 Skill 评测");
    }
    this.#evaluationKeys.set(payload.evaluationKey, canonicalSigned);
    release.evaluations.set(payload.evaluationKey, {
      signed: {
        payload: structuredClone(receipt.payload),
        signature: receipt.signature,
      },
      receipt,
    });
  }

  activate(command: {
    skillKey: string;
    version: string;
    actor: SkillActivationActor;
  }): SkillActivationRecord | null {
    const skillKey = internalKey.parse(command.skillKey);
    const version = semanticVersion.parse(command.version);
    const actor = z
      .object({ actorKey: internalKey, actorName: humanLabel })
      .strict()
      .parse(command.actor);
    const skill = this.#skills.get(skillKey);
    const release = skill?.releases.get(version);
    if (!skill || !release) throw new Error("找不到要激活的 Skill 版本");
    if (skill.activeVersion === version) return null;
    const evaluation = [...release.evaluations.values()]
      .filter(({ receipt }) => this.#passesActivationPolicy(receipt))
      .sort((left, right) =>
        left.receipt.payload.producedAt < right.receipt.payload.producedAt
          ? 1
          : left.receipt.payload.producedAt > right.receipt.payload.producedAt
            ? -1
            : 0,
      )[0];
    if (!evaluation) throw new Error("Skill 尚未通过独立评测");
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Skill 激活时间无效");
    }
    VerifiedSkillEvaluationReceipt.assertUsableAt(evaluation.receipt, now);
    const previousVersion = skill.activeVersion;
    const record: SkillActivationRecord = {
      action:
        previousVersion && compareVersions(version, previousVersion) < 0
          ? "rolled_back"
          : "activated",
      actorKey: actor.actorKey,
      actorName: actor.actorName,
      skillKey,
      version,
      evaluationKey: evaluation.receipt.payload.evaluationKey,
      recordedAt: now.toISOString(),
    };
    skill.activeVersion = version;
    this.#currentActivations.set(skillKey, record);
    return structuredClone(record);
  }

  getActive(skillKeyInput: string): SkillPackageManifest | null {
    const skillKey = internalKey.parse(skillKeyInput);
    const skill = this.#skills.get(skillKey);
    if (!skill?.activeVersion) return null;
    const manifest = skill.releases.get(skill.activeVersion)?.manifest;
    return manifest ? structuredClone(manifest) : null;
  }

  getVersion(
    skillKeyInput: string,
    versionInput: string,
  ): SkillPackageManifest | null {
    const skillKey = internalKey.parse(skillKeyInput);
    const version = semanticVersion.parse(versionInput);
    const manifest = this.#skills
      .get(skillKey)
      ?.releases.get(version)?.manifest;
    return manifest ? structuredClone(manifest) : null;
  }

  listForPeople(): SkillPeopleView[] {
    return this.listItemsForPeople().map((item) => item.view);
  }

  listItemsForPeople(): SkillRegistryItemForPeople[] {
    return [...this.#skills.entries()]
      .map(([skillKey, skill]) => {
        const latest = [...skill.releases.values()].sort((left, right) =>
          compareVersions(right.manifest.version, left.manifest.version),
        )[0]!;
        const displayed = skill.activeVersion
          ? skill.releases.get(skill.activeVersion)!
          : latest;
        const passing = [...displayed.evaluations.values()]
          .filter(({ receipt }) => this.#passesActivationPolicy(receipt))
          .sort((left, right) =>
            left.receipt.payload.producedAt < right.receipt.payload.producedAt
              ? 1
              : -1,
          )[0];
        return {
          skillKey,
          view: {
            name: displayed.manifest.name,
            summary: displayed.manifest.summary,
            status: skill.activeVersion
              ? ("可使用" as const)
              : ("等待验证" as const),
            activeVersion: skill.activeVersion,
            quality: passing
              ? `通过 ${passing.receipt.payload.scenarioCount} 个场景，评分 ${passing.receipt.payload.score}`
              : displayed.evaluations.size > 0
                ? "最近一次评测未通过"
                : "等待独立评测",
            safety: safetyForPeople(displayed.manifest.permissions),
          },
        };
      })
      .sort((left, right) =>
        left.view.name < right.view.name
          ? -1
          : left.view.name > right.view.name
            ? 1
            : 0,
      );
  }

  listActivationRecords(): SkillActivationRecord[] {
    return [...this.#currentActivations.values()]
      .sort((left, right) =>
        left.skillKey < right.skillKey
          ? -1
          : left.skillKey > right.skillKey
            ? 1
            : 0,
      )
      .map((record) => structuredClone(record));
  }

  snapshot(): SkillRegistrySnapshot {
    return {
      schemaVersion: 1,
      tenantKey: this.#tenantKey,
      projectKey: this.#projectKey,
      skills: [...this.#skills.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([skillKey, skill]) => ({
          skillKey,
          activeVersion: skill.activeVersion,
          releases: [...skill.releases.values()]
            .sort((left, right) =>
              compareVersions(left.manifest.version, right.manifest.version),
            )
            .map((release) => ({
              manifest: structuredClone(release.manifest),
              evaluations: [...release.evaluations.values()]
                .sort((left, right) =>
                  left.receipt.payload.evaluationKey <
                  right.receipt.payload.evaluationKey
                    ? -1
                    : 1,
                )
                .map(({ signed }) => structuredClone(signed)),
            })),
        })),
      activationRecords: this.listActivationRecords(),
    };
  }

  #assertScope(tenantKey: string, projectKey: string): void {
    if (tenantKey !== this.#tenantKey || projectKey !== this.#projectKey) {
      throw new Error("Skill 不属于当前租户和项目");
    }
  }

  #passesActivationPolicy(receipt: VerifiedSkillEvaluationReceipt): boolean {
    return (
      receipt.payload.outcome === "passed" &&
      receipt.payload.score >= MINIMUM_ACTIVATION_SCORE &&
      receipt.payload.scenarioCount >= MINIMUM_ACTIVATION_SCENARIOS &&
      receipt.payload.passedScenarioCount === receipt.payload.scenarioCount &&
      receipt.payload.criticalFailureCount === 0
    );
  }
}
