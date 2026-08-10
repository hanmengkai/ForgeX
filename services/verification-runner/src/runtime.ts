import { createHash, randomUUID } from "node:crypto";

import {
  EvidencePayloadSchema,
  type EvidenceCheck,
  type SignedEvidence,
} from "@forgex/contracts";

import {
  VerificationArtifactJournalEntrySchema,
  assertVerificationJournalIntegrity,
  verificationArtifactEntry,
  verificationSignedEntry,
  type VerificationArtifactJournalEntry,
  type VerificationJournal,
  type VerificationJournalEntry,
} from "./journal.js";
import {
  VerificationResultSchema,
  VerificationRunnerScopeSchema,
  VerificationRunnerTargetSchema,
  type VerificationEngine,
  type VerificationRunnerScope,
  type VerificationRunnerTarget,
} from "./model.js";
import type { RunnerEvidenceSigner } from "./signer.js";

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export interface VerificationRunnerControlPlane {
  listPending(): Promise<VerificationRunnerTarget[]>;
  publishPreview(
    target: VerificationRunnerTarget,
    content: Uint8Array,
    artifactHash: string,
  ): Promise<void>;
  submitEvidence(evidence: SignedEvidence): Promise<void>;
}

export interface VerificationRunnerRuntimeOptions {
  scope: VerificationRunnerScope;
  controlPlane: VerificationRunnerControlPlane;
  verifier: VerificationEngine;
  signer: RunnerEvidenceSigner;
  journal: VerificationJournal;
  clock?: () => Date;
  createEvidenceKey?: () => string;
  journalIntegrityKey: Uint8Array;
  maxArtifactRecoveryAgeMs?: number;
}

export class VerificationRunnerRuntime {
  readonly #scope: VerificationRunnerScope;
  readonly #controlPlane: VerificationRunnerControlPlane;
  readonly #verifier: VerificationEngine;
  readonly #signer: RunnerEvidenceSigner;
  readonly #journal: VerificationJournal;
  readonly #clock: () => Date;
  readonly #createEvidenceKey: () => string;
  readonly #journalIntegrityKey: Uint8Array;
  readonly #maxArtifactRecoveryAgeMs: number;
  #running = false;

  constructor(options: VerificationRunnerRuntimeOptions) {
    this.#scope = VerificationRunnerScopeSchema.parse(options.scope);
    this.#controlPlane = options.controlPlane;
    this.#verifier = options.verifier;
    this.#signer = options.signer;
    this.#journal = options.journal;
    this.#clock = options.clock ?? (() => new Date());
    this.#createEvidenceKey = options.createEvidenceKey ?? randomUUID;
    if (
      !(options.journalIntegrityKey instanceof Uint8Array) ||
      options.journalIntegrityKey.byteLength < 32 ||
      options.journalIntegrityKey.byteLength > 128
    ) {
      throw new Error("Runner 日志完整性密钥必须包含 32 至 128 字节");
    }
    this.#journalIntegrityKey = options.journalIntegrityKey.slice();
    this.#maxArtifactRecoveryAgeMs =
      options.maxArtifactRecoveryAgeMs ?? 10 * 60_000;
    if (
      !Number.isSafeInteger(this.#maxArtifactRecoveryAgeMs) ||
      this.#maxArtifactRecoveryAgeMs < 1_000 ||
      this.#maxArtifactRecoveryAgeMs > 24 * 60 * 60_000
    ) {
      throw new Error("Runner Preview 恢复窗口配置无效");
    }
  }

  async runOnce(): Promise<
    | { kind: "idle" }
    | { kind: "verification_failed"; title: string }
    | { kind: "submitted"; title: string }
  > {
    if (this.#running) {
      throw new Error("独立 Runner 正在处理另一项验证任务");
    }
    this.#running = true;
    try {
      return await this.#runOnce();
    } finally {
      this.#running = false;
    }
  }

  async #runOnce(): Promise<
    | { kind: "idle" }
    | { kind: "verification_failed"; title: string }
    | { kind: "submitted"; title: string }
  > {
    const pending = await this.#journal.load();
    if (pending) {
      assertVerificationJournalIntegrity(pending, this.#journalIntegrityKey);
      this.#assertJournalScope(pending);
      return this.#resume(pending);
    }

    const targets = await this.#controlPlane.listPending();
    if (targets.length === 0) return { kind: "idle" };
    const target = VerificationRunnerTargetSchema.parse(targets[0]);
    this.#assertTargetScope(target);
    const verification = VerificationResultSchema.parse(
      await this.#verifier.verify(target),
    );
    this.#assertChecks(target, verification.checks);
    if (verification.checks.some((check) => check.status !== "passed")) {
      return { kind: "verification_failed", title: target.title };
    }
    this.#assertArtifact(verification.artifact);
    const artifactHash = createHash("sha256")
      .update(verification.artifact)
      .digest("hex");
    const verificationCompletedAt = this.#now().toISOString();
    const artifactEntry = verificationArtifactEntry({
      scope: this.#scope,
      target,
      evidenceKey: this.#createEvidenceKey(),
      artifact: verification.artifact,
      artifactHash,
      checks: verification.checks,
      verificationCompletedAt,
      integrityKey: this.#journalIntegrityKey,
    });
    await this.#journal.saveArtifact(artifactEntry);
    return this.#resumeArtifact(artifactEntry, target);
  }

  async #resume(entry: VerificationJournalEntry) {
    this.#assertTargetScope(entry.target);
    if (entry.stage === "evidence_signed") {
      this.#assertSignedEntry(entry);
      await this.#controlPlane.submitEvidence(entry.signedEvidence);
      await this.#journal.clear(entry.integrityTag);
      return { kind: "submitted" as const, title: entry.target.title };
    }
    const targets = await this.#controlPlane.listPending();
    const current = targets.find(
      (target) =>
        target.requirementKey === entry.target.requirementKey &&
        target.requirementRevision === entry.target.requirementRevision,
    );
    if (!current) {
      throw new Error("Runner 恢复日志对应的权威验证任务已不存在");
    }
    const parsedCurrent = VerificationRunnerTargetSchema.parse(current);
    this.#assertRecoveredTarget(entry, parsedCurrent);
    return this.#resumeArtifact(entry, parsedCurrent);
  }

  async #resumeArtifact(
    entryInput: VerificationArtifactJournalEntry,
    authoritativeTarget: VerificationRunnerTarget,
  ) {
    const entry = VerificationArtifactJournalEntrySchema.parse(entryInput);
    this.#assertRecoveredTarget(entry, authoritativeTarget);
    const recoveryNow = this.#now().getTime();
    const completedAt = Date.parse(entry.verificationCompletedAt);
    if (
      completedAt > recoveryNow ||
      recoveryNow - completedAt > this.#maxArtifactRecoveryAgeMs
    ) {
      throw new Error("Runner Preview 恢复窗口已经过期，必须重新执行独立验证");
    }
    const artifact = Uint8Array.from(
      Buffer.from(entry.artifactContentBase64, "base64"),
    );
    this.#assertArtifact(artifact);
    if (
      createHash("sha256").update(artifact).digest("hex") !== entry.artifactHash
    ) {
      throw new Error("Runner 持久日志中的 Preview 制品摘要不一致");
    }
    await this.#controlPlane.publishPreview(
      entry.target,
      artifact,
      entry.artifactHash,
    );
    const producedAt = this.#now();
    const payload = EvidencePayloadSchema.parse({
      schemaVersion: 1,
      evidenceKey: entry.evidenceKey,
      tenantKey: this.#scope.tenantKey,
      projectKey: this.#scope.projectKey,
      repositoryKey: this.#scope.repositoryKey,
      requirementKey: entry.target.requirementKey,
      requirementRevision: entry.target.requirementRevision,
      gitHashAlgorithm: entry.target.gitHashAlgorithm,
      commitSha: entry.target.commitSha,
      runnerKey: this.#scope.runnerKey,
      keyId: this.#scope.keyId,
      producedAt: new Date(producedAt.getTime()).toISOString(),
      artifactHashAlgorithm: "sha256",
      artifactHash: entry.artifactHash,
      checks: entry.checks,
    });
    const signedEvidence = await this.#signer.sign(payload);
    const signedEntry = verificationSignedEntry({
      artifactEntry: entry,
      signedEvidence,
      integrityKey: this.#journalIntegrityKey,
    });
    await this.#journal.saveSigned(signedEntry, entry.integrityTag);
    await this.#controlPlane.submitEvidence(signedEntry.signedEvidence);
    await this.#journal.clear(signedEntry.integrityTag);
    return { kind: "submitted" as const, title: entry.target.title };
  }

  #assertTargetScope(target: VerificationRunnerTarget): void {
    if (target.repositoryKey !== this.#scope.repositoryKey) {
      throw new Error("Runner 任务不属于当前受信代码仓库");
    }
  }

  #assertJournalScope(entry: VerificationJournalEntry): void {
    if (JSON.stringify(entry.scope) !== JSON.stringify(this.#scope)) {
      throw new Error("Runner 恢复日志不属于当前授权范围");
    }
  }

  #assertRecoveredTarget(
    entry: VerificationArtifactJournalEntry,
    current: VerificationRunnerTarget,
  ): void {
    this.#assertTargetScope(current);
    const { previewArtifact: _savedPreview, ...savedAuthority } = entry.target;
    const { previewArtifact: currentPreview, ...currentAuthority } = current;
    if (
      JSON.stringify(savedAuthority) !== JSON.stringify(currentAuthority) ||
      (currentPreview !== null &&
        (currentPreview.artifactHashAlgorithm !== "sha256" ||
          currentPreview.artifactHash !== entry.artifactHash))
    ) {
      throw new Error("Runner 恢复日志与当前权威验证任务不一致");
    }
  }

  #assertSignedEntry(
    entry: Extract<VerificationJournalEntry, { stage: "evidence_signed" }>,
  ): void {
    const payload = entry.signedEvidence.payload;
    if (
      payload.evidenceKey !== entry.evidenceKey ||
      payload.tenantKey !== this.#scope.tenantKey ||
      payload.projectKey !== this.#scope.projectKey ||
      payload.repositoryKey !== this.#scope.repositoryKey ||
      payload.requirementKey !== entry.target.requirementKey ||
      payload.requirementRevision !== entry.target.requirementRevision ||
      payload.gitHashAlgorithm !== entry.target.gitHashAlgorithm ||
      payload.commitSha !== entry.target.commitSha ||
      payload.runnerKey !== this.#scope.runnerKey ||
      payload.keyId !== this.#scope.keyId ||
      payload.artifactHashAlgorithm !== "sha256" ||
      payload.artifactHash !== entry.artifactHash ||
      JSON.stringify(payload.checks) !== JSON.stringify(entry.checks)
    ) {
      throw new Error("Runner 已签名恢复日志与权威任务或 Preview 制品不一致");
    }
  }

  #assertChecks(
    target: VerificationRunnerTarget,
    checks: EvidenceCheck[],
  ): void {
    const expected = new Set(
      target.acceptanceCriteria.map((criterion) => criterion.criterionKey),
    );
    const actual = new Set(checks.map((check) => check.criterionKey));
    if (
      expected.size !== checks.length ||
      actual.size !== checks.length ||
      [...expected].some((criterionKey) => !actual.has(criterionKey))
    ) {
      throw new Error("Runner 验证结果没有逐项覆盖当前验收条件");
    }
  }

  #assertArtifact(artifact: Uint8Array): void {
    if (artifact.byteLength < 1 || artifact.byteLength > MAX_PREVIEW_BYTES) {
      throw new Error("Runner 生成的 Preview 制品超过大小上限");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(artifact);
    } catch {
      throw new Error("Runner 生成的 Preview 制品不是有效 UTF-8 内容");
    }
  }

  #now(): Date {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("Runner 本地时钟无效");
    return new Date(now.getTime());
  }
}
