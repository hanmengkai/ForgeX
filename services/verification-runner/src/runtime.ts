import { createHash, randomUUID } from "node:crypto";

import {
  EvidencePayloadSchema,
  type EvidenceCheck,
  type SignedEvidence,
} from "@forgex/contracts";

import {
  VerificationArtifactJournalEntrySchema,
  VerificationSignedJournalEntrySchema,
  verificationArtifactEntry,
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
}

export class VerificationRunnerRuntime {
  readonly #scope: VerificationRunnerScope;
  readonly #controlPlane: VerificationRunnerControlPlane;
  readonly #verifier: VerificationEngine;
  readonly #signer: RunnerEvidenceSigner;
  readonly #journal: VerificationJournal;
  readonly #clock: () => Date;
  readonly #createEvidenceKey: () => string;

  constructor(options: VerificationRunnerRuntimeOptions) {
    this.#scope = VerificationRunnerScopeSchema.parse(options.scope);
    this.#controlPlane = options.controlPlane;
    this.#verifier = options.verifier;
    this.#signer = options.signer;
    this.#journal = options.journal;
    this.#clock = options.clock ?? (() => new Date());
    this.#createEvidenceKey = options.createEvidenceKey ?? randomUUID;
  }

  async runOnce(): Promise<
    | { kind: "idle" }
    | { kind: "verification_failed"; title: string }
    | { kind: "submitted"; title: string }
  > {
    const pending = await this.#journal.load();
    if (pending) return this.#resume(pending);

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
    const artifactEntry = verificationArtifactEntry({
      target,
      evidenceKey: this.#createEvidenceKey(),
      artifact: verification.artifact,
      artifactHash,
      checks: verification.checks,
    });
    await this.#journal.saveArtifact(artifactEntry);
    return this.#resumeArtifact(artifactEntry);
  }

  async #resume(entry: VerificationJournalEntry) {
    this.#assertTargetScope(entry.target);
    if (entry.stage === "evidence_signed") {
      await this.#controlPlane.submitEvidence(entry.signedEvidence);
      await this.#journal.clear();
      return { kind: "submitted" as const, title: entry.target.title };
    }
    return this.#resumeArtifact(entry);
  }

  async #resumeArtifact(entryInput: VerificationArtifactJournalEntry) {
    const entry = VerificationArtifactJournalEntrySchema.parse(entryInput);
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
    const producedAt = this.#clock();
    if (!Number.isFinite(producedAt.getTime())) {
      throw new Error("Runner 本地时钟无效");
    }
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
    const signedEntry = VerificationSignedJournalEntrySchema.parse({
      ...entry,
      stage: "evidence_signed",
      signedEvidence,
    });
    await this.#journal.saveSigned(signedEntry);
    await this.#controlPlane.submitEvidence(signedEntry.signedEvidence);
    await this.#journal.clear();
    return { kind: "submitted" as const, title: entry.target.title };
  }

  #assertTargetScope(target: VerificationRunnerTarget): void {
    if (target.repositoryKey !== this.#scope.repositoryKey) {
      throw new Error("Runner 任务不属于当前受信代码仓库");
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
}
