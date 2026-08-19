import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import {
  EvidencePayloadSchema,
  SignedEvidenceSchema,
  type EvidenceCheck,
  type EvidencePayload,
  type SignedEvidence,
} from "@forgex/contracts";

export type { EvidenceCheck, EvidencePayload, SignedEvidence };

export interface RunnerScope {
  tenantKey: string;
  projectKey: string;
  repositoryKey: string;
}

export interface TrustedRunner {
  runnerKey: string;
  keyId: string;
  runnerName: string;
  publicKeyBase64: string;
  scopes: RunnerScope[];
  acceptNewEvidence?: boolean;
}

export interface EvidenceAuthorityOptions {
  runners: TrustedRunner[];
  clock?: () => Date;
  maxEvidenceAgeMs?: number;
  maxFutureSkewMs?: number;
}

interface PreparedRunner {
  runnerKey: string;
  keyId: string;
  runnerName: string;
  publicKey: KeyObject;
  scopes: readonly Readonly<RunnerScope>[];
  acceptNewEvidence: boolean;
}

export interface AuthorizedRunnerIdentity {
  runnerKey: string;
  keyId: string;
  runnerName: string;
}

const verificationToken = Symbol("forgex-verified-evidence");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class VerifiedEvidenceReceipt {
  readonly #authentic = true;
  readonly #validUntilMs: number;
  readonly #maxFutureSkewMs: number;
  readonly evidenceKey: string;
  readonly tenantKey: string;
  readonly projectKey: string;
  readonly repositoryKey: string;
  readonly requirementKey: string;
  readonly requirementRevision: number;
  readonly gitHashAlgorithm: "sha1" | "sha256";
  readonly commitSha: string;
  readonly runnerKey: string;
  readonly keyId: string;
  readonly runnerName: string;
  readonly producedAt: string;
  readonly artifactHashAlgorithm: "sha256";
  readonly artifactHash: string;
  readonly checks: readonly Readonly<EvidenceCheck>[];
  readonly manualCriterionKeys: readonly string[];
  readonly signature: string;

  constructor(
    payload: EvidencePayload,
    signature: string,
    runnerName: string,
    validity: { validUntilMs: number; maxFutureSkewMs: number },
    token: typeof verificationToken,
  ) {
    if (token !== verificationToken) {
      throw new Error("验证证据必须经过受信任的 EvidenceAuthority");
    }
    this.evidenceKey = payload.evidenceKey;
    this.tenantKey = payload.tenantKey;
    this.projectKey = payload.projectKey;
    this.repositoryKey = payload.repositoryKey;
    this.requirementKey = payload.requirementKey;
    this.requirementRevision = payload.requirementRevision;
    this.gitHashAlgorithm = payload.gitHashAlgorithm;
    this.commitSha = payload.commitSha;
    this.runnerKey = payload.runnerKey;
    this.keyId = payload.keyId;
    this.runnerName = runnerName;
    this.producedAt = payload.producedAt;
    this.artifactHashAlgorithm = payload.artifactHashAlgorithm;
    this.artifactHash = payload.artifactHash;
    this.checks = Object.freeze(
      payload.checks.map((check) => Object.freeze({ ...check })),
    );
    this.manualCriterionKeys = Object.freeze([
      ...(payload.manualCriterionKeys ?? []),
    ]);
    this.signature = signature;
    this.#validUntilMs = validity.validUntilMs;
    this.#maxFutureSkewMs = validity.maxFutureSkewMs;
    Object.freeze(this);
  }

  static assertAuthentic(receipt: VerifiedEvidenceReceipt): void {
    if (!receipt.#authentic) {
      throw new Error("验证证据不是由受信任的 EvidenceAuthority 签发");
    }
  }

  static assertUsableAt(receipt: VerifiedEvidenceReceipt, now: Date): void {
    VerifiedEvidenceReceipt.assertAuthentic(receipt);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("证据验证时间无效");
    }
    const producedAtMs = Date.parse(receipt.producedAt);
    if (producedAtMs > nowMs + receipt.#maxFutureSkewMs) {
      throw new Error("证据产生时间超出允许的未来偏差");
    }
    if (nowMs > receipt.#validUntilMs) {
      throw new Error("验证证据已经过期，请重新执行独立验证");
    }
  }
}

export class EvidenceAuthority {
  readonly #trustedRunners = new Map<string, PreparedRunner>();
  readonly #clock: () => Date;
  readonly #maxEvidenceAgeMs: number;
  readonly #maxFutureSkewMs: number;

  constructor(options: EvidenceAuthorityOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? 24 * 60 * 60 * 1_000;
    this.#maxFutureSkewMs = options.maxFutureSkewMs ?? 5 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.#maxEvidenceAgeMs) ||
      !Number.isSafeInteger(this.#maxFutureSkewMs) ||
      this.#maxEvidenceAgeMs < 1 ||
      this.#maxFutureSkewMs < 0
    ) {
      throw new Error("证据有效期配置无效");
    }

    for (const runner of options.runners) {
      const prepared = EvidenceAuthority.#prepareRunner(runner);
      const lookupKey = EvidenceAuthority.#runnerLookupKey(
        prepared.runnerKey,
        prepared.keyId,
      );
      if (this.#trustedRunners.has(lookupKey)) {
        throw new Error("受信任 Runner 的 runnerKey 与 keyId 不能重复");
      }
      this.#trustedRunners.set(lookupKey, prepared);
    }
  }

  static canonicalPayload(payload: EvidencePayload): string {
    const parsed = EvidencePayloadSchema.parse(payload);
    return JSON.stringify({
      schemaVersion: parsed.schemaVersion,
      evidenceKey: parsed.evidenceKey,
      tenantKey: parsed.tenantKey,
      projectKey: parsed.projectKey,
      repositoryKey: parsed.repositoryKey,
      requirementKey: parsed.requirementKey,
      requirementRevision: parsed.requirementRevision,
      gitHashAlgorithm: parsed.gitHashAlgorithm,
      commitSha: parsed.commitSha,
      runnerKey: parsed.runnerKey,
      keyId: parsed.keyId,
      producedAt: parsed.producedAt,
      artifactHashAlgorithm: parsed.artifactHashAlgorithm,
      artifactHash: parsed.artifactHash,
      checks: [...parsed.checks]
        .sort((left, right) =>
          left.criterionKey < right.criterionKey
            ? -1
            : left.criterionKey > right.criterionKey
              ? 1
              : 0,
        )
        .map((check) => ({
          criterionKey: check.criterionKey,
          status: check.status,
          testRunKey: check.testRunKey,
        })),
      ...(parsed.manualCriterionKeys
        ? {
            manualCriterionKeys: [...parsed.manualCriterionKeys].sort(),
          }
        : {}),
    });
  }

  verify(input: SignedEvidence): VerifiedEvidenceReceipt {
    return this.#verify(input, true);
  }

  verifyPersisted(input: SignedEvidence): VerifiedEvidenceReceipt {
    return this.#verify(input, false);
  }

  authorizeRunner(
    identity: { runnerKey: string; keyId: string },
    scope: RunnerScope,
  ): AuthorizedRunnerIdentity {
    return this.#authorizeRunner(identity, scope, true);
  }

  authorizeRunnerForHistoricalRecord(
    identity: { runnerKey: string; keyId: string },
    scope: RunnerScope,
  ): AuthorizedRunnerIdentity {
    return this.#authorizeRunner(identity, scope, false);
  }

  #authorizeRunner(
    identity: { runnerKey: string; keyId: string },
    scope: RunnerScope,
    requireActiveKey: boolean,
  ): AuthorizedRunnerIdentity {
    const runnerKey = identity.runnerKey.trim().toLowerCase();
    const keyId = identity.keyId.trim().toLowerCase();
    const runner = this.#trustedRunners.get(
      EvidenceAuthority.#runnerLookupKey(runnerKey, keyId),
    );
    if (!runner || (requireActiveKey && !runner.acceptNewEvidence)) {
      throw new Error("Runner 身份或签名密钥不受信任");
    }
    const normalizedScope = {
      tenantKey: scope.tenantKey.trim().toLowerCase(),
      projectKey: scope.projectKey.trim().toLowerCase(),
      repositoryKey: scope.repositoryKey.trim().toLowerCase(),
    };
    if (
      !runner.scopes.some(
        (allowed) =>
          allowed.tenantKey === normalizedScope.tenantKey &&
          allowed.projectKey === normalizedScope.projectKey &&
          allowed.repositoryKey === normalizedScope.repositoryKey,
      )
    ) {
      throw new Error("独立 Runner 无权访问这个租户、项目或代码仓库");
    }
    return Object.freeze({ runnerKey, keyId, runnerName: runner.runnerName });
  }

  #verify(
    input: SignedEvidence,
    enforceCurrentFreshness: boolean,
  ): VerifiedEvidenceReceipt {
    const parsed = SignedEvidenceSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("证据格式不完整或包含无效字段");
    }

    const runner = this.#trustedRunners.get(
      EvidenceAuthority.#runnerLookupKey(
        parsed.data.payload.runnerKey,
        parsed.data.payload.keyId,
      ),
    );
    if (!runner) {
      throw new Error("证据执行者或签名密钥不受信任");
    }
    if (enforceCurrentFreshness && !runner.acceptNewEvidence) {
      throw new Error("这个 Runner 密钥只用于核验历史证据");
    }
    if (
      !runner.scopes.some(
        (scope) =>
          scope.tenantKey === parsed.data.payload.tenantKey &&
          scope.projectKey === parsed.data.payload.projectKey &&
          scope.repositoryKey === parsed.data.payload.repositoryKey,
      )
    ) {
      throw new Error("独立 Runner 无权验证这个租户、项目或代码仓库");
    }

    if (enforceCurrentFreshness) {
      this.#assertFresh(parsed.data.payload.producedAt);
    }
    const verified = verifySignature(
      null,
      Buffer.from(
        EvidenceAuthority.canonicalPayload(parsed.data.payload),
        "utf8",
      ),
      runner.publicKey,
      Buffer.from(parsed.data.signature, "base64"),
    );
    if (!verified) {
      throw new Error("证据签名无效");
    }

    return new VerifiedEvidenceReceipt(
      parsed.data.payload,
      parsed.data.signature,
      runner.runnerName,
      {
        validUntilMs:
          Date.parse(parsed.data.payload.producedAt) + this.#maxEvidenceAgeMs,
        maxFutureSkewMs: this.#maxFutureSkewMs,
      },
      verificationToken,
    );
  }

  #assertFresh(producedAt: string): void {
    const producedAtMs = Date.parse(producedAt);
    const nowMs = this.#clock().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("证据验证时间无效");
    }
    if (producedAtMs > nowMs + this.#maxFutureSkewMs) {
      throw new Error("证据产生时间超出允许的未来偏差");
    }
    if (producedAtMs < nowMs - this.#maxEvidenceAgeMs) {
      throw new Error("验证证据已经过期，请重新执行独立验证");
    }
  }

  static #prepareRunner(runner: TrustedRunner): PreparedRunner {
    const runnerKey = runner.runnerKey.trim().toLowerCase();
    const keyId = runner.keyId.trim().toLowerCase();
    const runnerName = runner.runnerName.trim();
    if (
      !uuidPattern.test(runnerKey) ||
      !uuidPattern.test(keyId) ||
      !runnerName ||
      runner.scopes.length === 0 ||
      (runner.acceptNewEvidence !== undefined &&
        typeof runner.acceptNewEvidence !== "boolean")
    ) {
      throw new Error("受信任 Runner 配置不完整");
    }
    const scopes = runner.scopes.map((scope) => {
      if (
        !uuidPattern.test(scope.tenantKey) ||
        !uuidPattern.test(scope.projectKey) ||
        !uuidPattern.test(scope.repositoryKey)
      ) {
        throw new Error("受信任 Runner 的授权范围无效");
      }
      return Object.freeze({
        tenantKey: scope.tenantKey.toLowerCase(),
        projectKey: scope.projectKey.toLowerCase(),
        repositoryKey: scope.repositoryKey.toLowerCase(),
      });
    });

    let publicKey: KeyObject;
    try {
      const publicKeyBytes = Buffer.from(runner.publicKeyBase64, "base64");
      if (publicKeyBytes.toString("base64") !== runner.publicKeyBase64) {
        throw new Error("non-canonical-base64");
      }
      publicKey = createPublicKey({
        key: publicKeyBytes,
        format: "der",
        type: "spki",
      });
    } catch {
      throw new Error("受信任 Runner 的 Ed25519 公钥无效");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("受信任 Runner 必须使用 Ed25519 公钥");
    }

    return {
      runnerKey,
      keyId,
      runnerName,
      publicKey,
      scopes: Object.freeze(scopes),
      acceptNewEvidence: runner.acceptNewEvidence ?? true,
    };
  }

  static #runnerLookupKey(runnerKey: string, keyId: string): string {
    return `${runnerKey.toLowerCase()}:${keyId.toLowerCase()}`;
  }
}
