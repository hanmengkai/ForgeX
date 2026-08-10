import { createHash, randomUUID } from "node:crypto";

import {
  EvidenceCheckSchema,
  SignedEvidenceSchema,
  type EvidenceCheck,
  type SignedEvidence,
} from "@forgex/contracts";
import {
  EvidenceAuthority,
  type AuthorizedRunnerIdentity,
  type RequirementEvidenceSnapshot,
} from "@forgex/domain";
import { z } from "zod";

import { ApplicationError } from "./errors.js";
import type {
  DeliveryRunResult,
  RequirementRecord,
  RequirementRepository,
  RequirementTransaction,
} from "./requirement-repository.js";
import type { RequirementCommandResult } from "./requirement-service.js";
import type { PreviewArtifactStore } from "./preview-artifact-store.js";

const internalKey = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const AuthenticatedRunnerSchema = z
  .object({
    tenantKey: internalKey,
    runnerKey: internalKey,
    keyId: internalKey,
  })
  .strict();

export type AuthenticatedRunner = z.infer<typeof AuthenticatedRunnerSchema>;

export interface RunnerSessionAuthenticator {
  authenticate(
    authorization: string | undefined,
  ): Promise<AuthenticatedRunner | null>;
}

export const RunnerPreviewArtifactCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementKey: internalKey,
    requirementRevision: z.number().int().positive().max(10_000),
    artifactHashAlgorithm: z.literal("sha256"),
    artifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
    content: z.instanceof(Uint8Array),
  })
  .strict();

export type RunnerPreviewArtifactCommand = z.infer<
  typeof RunnerPreviewArtifactCommandSchema
>;

export const RunnerVerificationFailureCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementKey: internalKey,
    requirementRevision: z.number().int().positive().max(10_000),
    verificationCompletedAt: z.iso.datetime(),
    checks: z.array(EvidenceCheckSchema).min(1).max(80),
  })
  .strict();

export type RunnerVerificationFailureCommand = z.infer<
  typeof RunnerVerificationFailureCommandSchema
>;

export interface VerificationTargetForRunner {
  requirementKey: string;
  requirementRevision: number;
  repositoryKey: string;
  gitHashAlgorithm: "sha1" | "sha256";
  commitSha: string;
  title: string;
  goal: string;
  acceptanceCriteria: Array<{
    criterionKey: string;
    title: string;
    description: string;
    priority: "must" | "should" | "could";
  }>;
  previewArtifact: {
    artifactHashAlgorithm: "sha256";
    artifactHash: string;
  } | null;
}

export interface VerificationCoordinatorServiceOptions {
  requirementRepository: RequirementRepository;
  previewArtifactStore: PreviewArtifactStore;
  evidenceAuthority: EvidenceAuthority;
  projectKey: string;
  repositoryKey: string;
  clock?: () => Date;
  maxVerificationFailureAgeMs?: number;
}

const sameCandidate = (
  existing: ReturnType<
    RequirementRecord["workflow"]["toSnapshot"]
  >["deliveryCandidate"],
  candidate: {
    tenantKey: string;
    projectKey: string;
    repositoryKey: string;
    gitHashAlgorithm: "sha1" | "sha256";
    commitSha: string;
    artifactHashAlgorithm: "sha256";
    artifactHash: string;
  },
): boolean =>
  existing !== null &&
  existing.tenantKey === candidate.tenantKey &&
  existing.projectKey === candidate.projectKey &&
  existing.repositoryKey === candidate.repositoryKey &&
  existing.gitHashAlgorithm === candidate.gitHashAlgorithm &&
  existing.commitSha === candidate.commitSha &&
  existing.artifactHashAlgorithm === candidate.artifactHashAlgorithm &&
  existing.artifactHash === candidate.artifactHash;

const sameSignedEvidence = (
  existing: RequirementEvidenceSnapshot | null,
  signed: SignedEvidence,
): boolean => {
  if (
    existing === null ||
    existing.evidenceKey !== signed.payload.evidenceKey ||
    existing.signature !== signed.signature
  ) {
    return false;
  }
  return (
    EvidenceAuthority.canonicalPayload({
      schemaVersion: 1,
      evidenceKey: existing.evidenceKey,
      tenantKey: existing.tenantKey,
      projectKey: existing.projectKey,
      repositoryKey: existing.repositoryKey,
      requirementKey: existing.requirementKey,
      requirementRevision: existing.requirementRevision,
      gitHashAlgorithm: existing.gitHashAlgorithm,
      commitSha: existing.commitSha,
      runnerKey: existing.runnerKey,
      keyId: existing.keyId,
      producedAt: existing.producedAt,
      artifactHashAlgorithm: existing.artifactHashAlgorithm,
      artifactHash: existing.artifactHash,
      checks: existing.checks,
    }) === EvidenceAuthority.canonicalPayload(signed.payload)
  );
};

const verificationFailureDigest = (input: {
  tenantKey: string;
  projectKey: string;
  repositoryKey: string;
  requirementKey: string;
  requirementRevision: number;
  gitHashAlgorithm: "sha1" | "sha256";
  commitSha: string;
  runnerKey: string;
  keyId: string;
  verificationCompletedAt: string;
  checks: EvidenceCheck[];
}): string =>
  createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, ...input }), "utf8")
    .digest("hex");

export class VerificationCoordinatorService {
  readonly #requirementRepository: RequirementRepository;
  readonly #previewArtifactStore: PreviewArtifactStore;
  readonly #evidenceAuthority: EvidenceAuthority;
  readonly #projectKey: string;
  readonly #repositoryKey: string;
  readonly #clock: () => Date;
  readonly #maxVerificationFailureAgeMs: number;

  constructor(options: VerificationCoordinatorServiceOptions) {
    this.#requirementRepository = options.requirementRepository;
    this.#previewArtifactStore = options.previewArtifactStore;
    this.#evidenceAuthority = options.evidenceAuthority;
    this.#projectKey = internalKey.parse(options.projectKey);
    this.#repositoryKey = internalKey.parse(options.repositoryKey);
    this.#clock = options.clock ?? (() => new Date());
    this.#maxVerificationFailureAgeMs = z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60_000)
      .parse(options.maxVerificationFailureAgeMs ?? 10 * 60_000);
  }

  async listPending(
    runnerInput: AuthenticatedRunner,
    query: { limit?: number } = {},
  ): Promise<{ items: VerificationTargetForRunner[] }> {
    const connection = this.#parseRunner(runnerInput);
    this.#authorize(connection);
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError(
        422,
        "invalid_page_size",
        "每页验证任务数量需要在 1 到 100 之间",
      );
    }
    const runs =
      await this.#requirementRepository.listDeliveryRunsAwaitingVerification(
        connection.tenantKey,
        this.#projectKey,
        this.#repositoryKey,
        limit,
      );
    const items: VerificationTargetForRunner[] = [];
    for (const run of runs) {
      const target = await this.#requirementRepository.transaction(
        connection.tenantKey,
        this.#projectKey,
        async (transaction) => this.#loadTarget(transaction, run),
      );
      items.push(target);
    }
    return { items };
  }

  async publishPreviewArtifact(
    runnerInput: AuthenticatedRunner,
    commandInput: RunnerPreviewArtifactCommand,
  ): Promise<{ status: "preview_recorded"; requirementRevision: number }> {
    const connection = this.#parseRunner(runnerInput);
    this.#authorizeHistorical(connection);
    const command = RunnerPreviewArtifactCommandSchema.safeParse(commandInput);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "invalid_preview_artifact",
        "效果制品格式不正确",
      );
    }
    const preflight = await this.#requirementRepository.transaction(
      connection.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const run = await transaction.findDeliveryRunResult(
          command.data.requirementKey,
          command.data.requirementRevision,
        );
        return this.#loadTarget(transaction, run);
      },
    );
    if (
      preflight.previewArtifact &&
      (preflight.previewArtifact.artifactHashAlgorithm !==
        command.data.artifactHashAlgorithm ||
        preflight.previewArtifact.artifactHash !== command.data.artifactHash)
    ) {
      throw new ApplicationError(
        409,
        "preview_candidate_conflict",
        "当前交付已经绑定另一份效果制品，请重新安排交付版本",
      );
    }
    if (preflight.previewArtifact) {
      const stored = await this.#previewArtifactStore.get({
        tenantKey: connection.tenantKey,
        projectKey: this.#projectKey,
        requirementKey: command.data.requirementKey,
        requirementRevision: command.data.requirementRevision,
        artifactHashAlgorithm: command.data.artifactHashAlgorithm,
        artifactHash: command.data.artifactHash,
      });
      if (
        stored &&
        Buffer.from(stored.content).equals(Buffer.from(command.data.content))
      ) {
        this.#authorizeHistorical(connection);
        return {
          status: "preview_recorded",
          requirementRevision: command.data.requirementRevision,
        };
      }
    }
    const runner = this.#authorize(connection);
    await this.#putArtifact(connection.tenantKey, command.data);

    await this.#requirementRepository.transaction(
      connection.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(command.data.requirementKey);
        const run = await transaction.findDeliveryRunResult(
          command.data.requirementKey,
          command.data.requirementRevision,
        );
        const current = await this.#loadTarget(transaction, run, record);
        if (
          current.repositoryKey !== preflight.repositoryKey ||
          current.gitHashAlgorithm !== preflight.gitHashAlgorithm ||
          current.commitSha !== preflight.commitSha
        ) {
          throw new ApplicationError(
            409,
            "delivery_not_ready_for_verification",
            "交付提交已经变化，请重新获取验证任务",
          );
        }
        const candidate = {
          tenantKey: connection.tenantKey,
          projectKey: this.#projectKey,
          repositoryKey: this.#repositoryKey,
          gitHashAlgorithm: current.gitHashAlgorithm,
          commitSha: current.commitSha,
          artifactHashAlgorithm: command.data.artifactHashAlgorithm,
          artifactHash: command.data.artifactHash,
        } as const;
        if (
          sameCandidate(
            record!.workflow.toSnapshot().deliveryCandidate,
            candidate,
          )
        ) {
          return;
        }
        if (record!.workflow.toSnapshot().deliveryCandidate !== null) {
          throw new ApplicationError(
            409,
            "preview_candidate_conflict",
            "当前交付已经绑定另一份效果制品，请重新安排交付版本",
          );
        }
        record!.workflow.recordDeliveryCandidate(candidate);
        transaction.save(record!);
        transaction.appendAudit({
          eventKey: randomUUID(),
          tenantKey: connection.tenantKey,
          projectKey: this.#projectKey,
          requirementKey: command.data.requirementKey,
          action: "verification.preview_recorded",
          actorKey: runner.runnerKey,
          actorName: runner.runnerName,
          recordedAt: this.#nowIso(),
        });
      },
    );
    return {
      status: "preview_recorded",
      requirementRevision: command.data.requirementRevision,
    };
  }

  async submitEvidence(
    runnerInput: AuthenticatedRunner,
    signedInput: SignedEvidence,
  ): Promise<RequirementCommandResult> {
    const parsedRunner = this.#parseRunner(runnerInput);
    const signed = SignedEvidenceSchema.safeParse(signedInput);
    if (!signed.success) {
      throw new ApplicationError(
        422,
        "invalid_verification_evidence",
        "验证证据格式不正确",
      );
    }
    if (
      signed.data.payload.runnerKey !== parsedRunner.runnerKey ||
      signed.data.payload.keyId !== parsedRunner.keyId ||
      signed.data.payload.tenantKey !== parsedRunner.tenantKey ||
      signed.data.payload.projectKey !== this.#projectKey ||
      signed.data.payload.repositoryKey !== this.#repositoryKey
    ) {
      throw new ApplicationError(
        403,
        "runner_identity_mismatch",
        "验证证据与当前 Runner 身份不一致",
      );
    }

    const existing = await this.#requirementRepository.transaction(
      parsedRunner.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(
          signed.data.payload.requirementKey,
        );
        return record &&
          sameSignedEvidence(record.workflow.toSnapshot().evidence, signed.data)
          ? this.#result(record)
          : null;
      },
    );
    if (existing) {
      try {
        this.#evidenceAuthority.verifyPersisted(signed.data);
      } catch {
        throw new ApplicationError(
          422,
          "invalid_verification_evidence",
          "历史验证证据未通过可信签名或范围校验",
        );
      }
      return existing;
    }

    const runner = this.#authorize(parsedRunner);
    let receipt;
    try {
      receipt = this.#evidenceAuthority.verify(signed.data);
    } catch {
      throw new ApplicationError(
        422,
        "invalid_verification_evidence",
        "验证证据未通过可信签名或范围校验",
      );
    }

    return this.#requirementRepository.transaction(
      runnerInput.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const record = await transaction.find(receipt.requirementKey);
        if (!record) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这项待验证需求",
          );
        }
        if (
          sameSignedEvidence(record.workflow.toSnapshot().evidence, signed.data)
        ) {
          return this.#result(record);
        }
        const run = await transaction.findDeliveryRunResult(
          receipt.requirementKey,
          receipt.requirementRevision,
        );
        const failure = await transaction.findVerificationFailure(
          receipt.requirementKey,
          receipt.requirementRevision,
        );
        if (failure) {
          throw new ApplicationError(
            409,
            "verification_failure_recorded",
            "当前交付版本已经记录独立验证失败，不能再提交通过证据",
          );
        }
        await this.#loadTarget(transaction, run, record);
        if (
          run!.repositoryKey !== receipt.repositoryKey ||
          run!.gitHashAlgorithm !== receipt.gitHashAlgorithm ||
          run!.commitSha !== receipt.commitSha
        ) {
          throw new ApplicationError(
            409,
            "verification_evidence_stale",
            "验证证据没有绑定当前已完成的交付提交",
          );
        }
        const recordedAt = this.#nowIso();
        try {
          record.workflow.submitForAcceptance(receipt);
        } catch (error) {
          throw new ApplicationError(
            409,
            "verification_evidence_stale",
            error instanceof Error ? error.message : "验证证据不再对应当前交付",
          );
        }
        transaction.appendVerificationEvidence({
          tenantKey: runnerInput.tenantKey,
          projectKey: this.#projectKey,
          requirementKey: receipt.requirementKey,
          requirementRevision: receipt.requirementRevision,
          evidenceKey: receipt.evidenceKey,
          evidenceDigest: createHash("sha256")
            .update(EvidenceAuthority.canonicalPayload(signed.data.payload))
            .update(".")
            .update(signed.data.signature)
            .digest("hex"),
          runnerKey: runner.runnerKey,
          keyId: runner.keyId,
          recordedAt,
        });
        transaction.save(record);
        transaction.appendAudit({
          eventKey: randomUUID(),
          tenantKey: runnerInput.tenantKey,
          projectKey: this.#projectKey,
          requirementKey: receipt.requirementKey,
          action: "verification.completed",
          actorKey: runner.runnerKey,
          actorName: runner.runnerName,
          recordedAt,
        });
        return this.#result(record);
      },
    );
  }

  async reportFailure(
    runnerInput: AuthenticatedRunner,
    commandInput: RunnerVerificationFailureCommand,
  ): Promise<{
    status: "verification_failed_recorded";
    requirementRevision: number;
  }> {
    const connection = this.#parseRunner(runnerInput);
    this.#authorizeHistorical(connection);
    const command =
      RunnerVerificationFailureCommandSchema.safeParse(commandInput);
    if (!command.success) {
      throw new ApplicationError(
        422,
        "invalid_verification_failure",
        "验证失败结果格式不正确",
      );
    }
    return this.#requirementRepository.transaction(
      connection.tenantKey,
      this.#projectKey,
      async (transaction) => {
        const run = await transaction.findDeliveryRunResult(
          command.data.requirementKey,
          command.data.requirementRevision,
        );
        const checks = command.data.checks
          .map((check) => ({ ...check }))
          .sort((left, right) =>
            left.criterionKey < right.criterionKey ? -1 : 1,
          );
        const existing = await transaction.findVerificationFailure(
          command.data.requirementKey,
          command.data.requirementRevision,
        );
        if (existing) {
          if (
            !run ||
            run.status !== "completed" ||
            run.tenantKey !== connection.tenantKey ||
            run.projectKey !== this.#projectKey ||
            run.repositoryKey !== this.#repositoryKey
          ) {
            throw new ApplicationError(
              409,
              "verification_failure_conflict",
              "历史验证失败记录没有绑定当前权威交付",
            );
          }
          const failureDigest = verificationFailureDigest({
            tenantKey: connection.tenantKey,
            projectKey: this.#projectKey,
            repositoryKey: run.repositoryKey,
            requirementKey: run.requirementKey,
            requirementRevision: run.requirementRevision,
            gitHashAlgorithm: run.gitHashAlgorithm,
            commitSha: run.commitSha,
            runnerKey: connection.runnerKey,
            keyId: connection.keyId,
            verificationCompletedAt: command.data.verificationCompletedAt,
            checks,
          });
          if (
            existing.failureDigest !== failureDigest ||
            existing.runnerKey !== connection.runnerKey ||
            existing.keyId !== connection.keyId
          ) {
            throw new ApplicationError(
              409,
              "verification_failure_conflict",
              "当前交付版本已经记录另一份验证失败结果",
            );
          }
          this.#authorizeHistorical(connection);
          return {
            status: "verification_failed_recorded" as const,
            requirementRevision: command.data.requirementRevision,
          };
        }
        const target = await this.#loadTarget(transaction, run, undefined, {
          allowAwaitingAcceptance: true,
          allowCompleted: true,
        });
        this.#assertFailureChecks(target, checks);
        const now = this.#clock();
        const nowMs = now.getTime();
        const completedAtMs = Date.parse(command.data.verificationCompletedAt);
        if (
          !Number.isFinite(nowMs) ||
          completedAtMs > nowMs + 5 * 60_000 ||
          nowMs - completedAtMs > this.#maxVerificationFailureAgeMs
        ) {
          throw new ApplicationError(
            409,
            "verification_failure_stale",
            "验证失败结果已经超过可信恢复窗口，请重新执行独立验证",
          );
        }
        const failureDigest = verificationFailureDigest({
          tenantKey: connection.tenantKey,
          projectKey: this.#projectKey,
          repositoryKey: target.repositoryKey,
          requirementKey: target.requirementKey,
          requirementRevision: target.requirementRevision,
          gitHashAlgorithm: target.gitHashAlgorithm,
          commitSha: target.commitSha,
          runnerKey: connection.runnerKey,
          keyId: connection.keyId,
          verificationCompletedAt: command.data.verificationCompletedAt,
          checks,
        });
        const runner = this.#authorize(connection);
        const recordedAt = new Date(nowMs).toISOString();
        transaction.saveVerificationFailure({
          tenantKey: connection.tenantKey,
          projectKey: this.#projectKey,
          repositoryKey: target.repositoryKey,
          requirementKey: target.requirementKey,
          requirementRevision: target.requirementRevision,
          failureDigest,
          runnerKey: runner.runnerKey,
          keyId: runner.keyId,
          verificationCompletedAt: command.data.verificationCompletedAt,
          checks,
          recordedAt,
        });
        const record = await transaction.find(target.requirementKey);
        if (!record) {
          throw new ApplicationError(
            404,
            "requirement_not_found",
            "没有找到这项待验证需求",
          );
        }
        record.workflow.recordVerificationFailure();
        transaction.save(record);
        transaction.appendAudit({
          eventKey: randomUUID(),
          tenantKey: connection.tenantKey,
          projectKey: this.#projectKey,
          requirementKey: target.requirementKey,
          action: "verification.failed",
          actorKey: runner.runnerKey,
          actorName: runner.runnerName,
          recordedAt,
        });
        return {
          status: "verification_failed_recorded" as const,
          requirementRevision: target.requirementRevision,
        };
      },
    );
  }

  #parseRunner(runnerInput: AuthenticatedRunner): AuthenticatedRunner {
    const runner = AuthenticatedRunnerSchema.safeParse(runnerInput);
    if (!runner.success) {
      throw new ApplicationError(
        401,
        "invalid_runner_session",
        "Runner 连接已经失效，请重新连接",
      );
    }
    return runner.data;
  }

  #authorize(runnerInput: AuthenticatedRunner): AuthorizedRunnerIdentity {
    const runner = this.#parseRunner(runnerInput);
    try {
      return this.#evidenceAuthority.authorizeRunner(
        {
          runnerKey: runner.runnerKey,
          keyId: runner.keyId,
        },
        {
          tenantKey: runner.tenantKey,
          projectKey: this.#projectKey,
          repositoryKey: this.#repositoryKey,
        },
      );
    } catch {
      throw new ApplicationError(
        403,
        "runner_scope_denied",
        "当前 Runner 无权验证这个项目或代码仓库",
      );
    }
  }

  #authorizeHistorical(
    runnerInput: AuthenticatedRunner,
  ): AuthorizedRunnerIdentity {
    const runner = this.#parseRunner(runnerInput);
    try {
      return this.#evidenceAuthority.authorizeRunnerForHistoricalRecord(
        { runnerKey: runner.runnerKey, keyId: runner.keyId },
        {
          tenantKey: runner.tenantKey,
          projectKey: this.#projectKey,
          repositoryKey: this.#repositoryKey,
        },
      );
    } catch {
      throw new ApplicationError(
        403,
        "runner_scope_denied",
        "当前 Runner 无权恢复这个项目或代码仓库的历史结果",
      );
    }
  }

  async #putArtifact(
    tenantKey: string,
    command: RunnerPreviewArtifactCommand,
  ): Promise<void> {
    try {
      await this.#previewArtifactStore.put({
        tenantKey,
        projectKey: this.#projectKey,
        requirementKey: command.requirementKey,
        requirementRevision: command.requirementRevision,
        artifactHashAlgorithm: command.artifactHashAlgorithm,
        artifactHash: command.artifactHash,
        content: command.content,
      });
    } catch {
      throw new ApplicationError(
        422,
        "invalid_preview_artifact",
        "效果制品内容、大小或摘要不正确",
      );
    }
  }

  async #loadTarget(
    transaction: RequirementTransaction,
    run: DeliveryRunResult | null,
    loadedRecord?: RequirementRecord | null,
    options: {
      allowAwaitingAcceptance?: boolean;
      allowCompleted?: boolean;
    } = {},
  ): Promise<VerificationTargetForRunner> {
    const record =
      loadedRecord ?? (run ? await transaction.find(run.requirementKey) : null);
    if (
      !record ||
      !run ||
      run.status !== "completed" ||
      run.completedAt === null ||
      record.tenantKey !== run.tenantKey ||
      record.projectKey !== this.#projectKey ||
      run.projectKey !== this.#projectKey ||
      run.repositoryKey !== this.#repositoryKey ||
      record.requirementKey !== run.requirementKey ||
      record.workflow.currentRevision !== run.requirementRevision ||
      (record.workflow.toSnapshot().status !== "inDelivery" &&
        !(
          options.allowAwaitingAcceptance === true &&
          record.workflow.toSnapshot().status === "awaitingAcceptance"
        ) &&
        !(
          options.allowCompleted === true &&
          record.workflow.toSnapshot().status === "completed"
        ))
    ) {
      throw new ApplicationError(
        409,
        "delivery_not_ready_for_verification",
        "交付尚未形成可独立验证的完整提交",
      );
    }
    record.workflow.assertSpecIntegrity(record.spec);
    const revision = record.workflow
      .toSnapshot()
      .revisions.find((item) => item.version === run.requirementRevision);
    if (
      !revision ||
      revision.acceptanceCriteria.length !==
        record.spec.acceptanceCriteria.length
    ) {
      throw new Error("验证目标与需求验收条件不一致");
    }
    const candidate = record.workflow.toSnapshot().deliveryCandidate;
    if (
      candidate &&
      (candidate.repositoryKey !== run.repositoryKey ||
        candidate.gitHashAlgorithm !== run.gitHashAlgorithm ||
        candidate.commitSha !== run.commitSha)
    ) {
      throw new Error("验证目标中的交付候选与已完成提交不一致");
    }
    return {
      requirementKey: record.requirementKey,
      requirementRevision: run.requirementRevision,
      repositoryKey: run.repositoryKey,
      gitHashAlgorithm: run.gitHashAlgorithm,
      commitSha: run.commitSha,
      title: record.spec.title,
      goal: record.spec.goal,
      acceptanceCriteria: revision.acceptanceCriteria.map(
        (criterion, index) => {
          const detail = record.spec.acceptanceCriteria[index]!;
          return {
            criterionKey: criterion.criterionKey,
            title: criterion.title,
            description: detail.description,
            priority: detail.priority,
          };
        },
      ),
      previewArtifact: candidate
        ? {
            artifactHashAlgorithm: candidate.artifactHashAlgorithm,
            artifactHash: candidate.artifactHash,
          }
        : null,
    };
  }

  #result(record: RequirementRecord): RequirementCommandResult {
    return {
      requirementKey: record.requirementKey,
      view: record.workflow.toPeopleView(),
      allowedActions: record.workflow.listAllowedActions(),
    };
  }

  #assertFailureChecks(
    target: VerificationTargetForRunner,
    checks: EvidenceCheck[],
  ): void {
    const expected = new Set(
      target.acceptanceCriteria.map((criterion) => criterion.criterionKey),
    );
    const actual = new Set(checks.map((check) => check.criterionKey));
    if (
      expected.size !== checks.length ||
      actual.size !== checks.length ||
      [...expected].some((criterionKey) => !actual.has(criterionKey)) ||
      checks.every((check) => check.status === "passed")
    ) {
      throw new ApplicationError(
        422,
        "invalid_verification_failure",
        "验证失败结果必须逐项覆盖当前验收条件，并至少包含一项未通过",
      );
    }
  }

  #nowIso(): string {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("服务端时间无效");
    return new Date(now.getTime()).toISOString();
  }
}
