import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { EvidenceAuthority } from "@forgex/domain";

import {
  Ed25519RunnerEvidenceSigner,
  InMemoryVerificationJournal,
  RunnerControlPlaneClientError,
  VerificationPreparationBlockedError,
  VerificationRunnerRuntime,
  verificationArtifactEntry,
  type VerificationRunnerTarget,
} from "../src/index.js";

const tenantKey = "10000000-0000-4000-8000-000000000001";
const projectKey = "20000000-0000-4000-8000-000000000002";
const repositoryKey = "30000000-0000-4000-8000-000000000003";
const runnerKey = "40000000-0000-4000-8000-000000000004";
const keyId = "50000000-0000-4000-8000-000000000005";
const requirementKey = "60000000-0000-4000-8000-000000000006";
const criterionKey = "70000000-0000-4000-8000-000000000007";
const runnerScope = { tenantKey, projectKey, repositoryKey, runnerKey, keyId };

const target: VerificationRunnerTarget = {
  requirementKey,
  requirementRevision: 2,
  repositoryKey,
  gitHashAlgorithm: "sha1",
  commitSha: "a".repeat(40),
  title: "访客预约",
  goal: "让访客可以提前预约",
  acceptanceCriteria: [
    {
      criterionKey,
      title: "预约成功",
      description: "提交后可以看到预约结果",
      priority: "must",
    },
  ],
  previewArtifact: null,
};

const preview = new TextEncoder().encode(
  "<!doctype html><html><body>验证通过</body></html>",
);
const artifactHash = createHash("sha256").update(preview).digest("hex");
const journalIntegrityKey = new Uint8Array(32).fill(0x5a);

const signerFixture = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = new Ed25519RunnerEvidenceSigner({
    runnerKey,
    keyId,
    privateKey,
  });
  const authority = new EvidenceAuthority({
    clock: () => new Date("2026-08-11T03:01:00.000Z"),
    runners: [
      {
        runnerKey,
        keyId,
        runnerName: "独立验证一号",
        publicKeyBase64: publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        scopes: [{ tenantKey, projectKey, repositoryKey }],
      },
    ],
  });
  return { signer, authority };
};

const passedVerification = {
  artifact: preview,
  checks: [
    {
      criterionKey,
      status: "passed" as const,
      testRunKey: "suite-a1",
    },
  ],
};

describe("VerificationRunnerRuntime", () => {
  it("在一百条待验证任务中跳过无计划项并验证可处理任务", async () => {
    const { signer } = signerFixture();
    const unplannedTargets: VerificationRunnerTarget[] = Array.from(
      { length: 99 },
      (_, index) => ({
        ...target,
        requirementKey: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        title: `尚未配置验证计划的需求 ${index + 1}`,
      }),
    );
    const controlPlane = {
      listPending: vi.fn(async () => [...unplannedTargets, target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
      reportBlocker: vi.fn(async () => Promise.resolve()),
    };
    const verifier = {
      canVerify: vi.fn(
        async (candidate: VerificationRunnerTarget) =>
          candidate.requirementKey === target.requirementKey,
      ),
      verify: vi.fn(async () => passedVerification),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: runnerScope,
      controlPlane,
      verifier,
      signer,
      journal: new InMemoryVerificationJournal(),
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
      createEvidenceKey: () => "80000000-0000-4000-8000-000000000008",
    });

    await expect(runtime.runOnce()).resolves.toEqual({
      kind: "submitted",
      title: target.title,
    });
    expect(controlPlane.listPending).toHaveBeenCalledWith(100);
    expect(verifier.canVerify).toHaveBeenNthCalledWith(1, unplannedTargets[0]);
    expect(verifier.canVerify).toHaveBeenNthCalledWith(100, target);
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(verifier.verify).toHaveBeenCalledWith(target);
    expect(controlPlane.reportBlocker).toHaveBeenCalledTimes(99);
  });

  it("没有匹配可信计划时向控制面报告明确阻塞，而不是静默空闲", async () => {
    const { signer } = signerFixture();
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
      reportBlocker: vi.fn(async () => Promise.resolve()),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: runnerScope,
      controlPlane,
      verifier: {
        canVerify: vi.fn(async () => false),
        verify: vi.fn(async () => passedVerification),
      },
      signer,
      journal: new InMemoryVerificationJournal(),
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
    });

    await expect(runtime.runOnce()).resolves.toEqual({
      kind: "blocked",
      title: target.title,
      reason: "trusted_plan_missing",
    });
    expect(controlPlane.reportBlocker).toHaveBeenCalledWith(
      target,
      "trusted_plan_missing",
      "2026-08-11T03:01:00.000Z",
    );
  });

  it("交付提交尚未同步时向控制面报告明确阻塞，而不是无限重试", async () => {
    const { signer } = signerFixture();
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
      reportBlocker: vi.fn(async () => Promise.resolve()),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: runnerScope,
      controlPlane,
      verifier: {
        canVerify: vi.fn(async () => true),
        verify: vi.fn(async () => {
          throw new VerificationPreparationBlockedError(
            "delivery_commit_missing",
          );
        }),
      },
      signer,
      journal: new InMemoryVerificationJournal(),
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
    });

    await expect(runtime.runOnce()).resolves.toEqual({
      kind: "blocked",
      title: target.title,
      reason: "delivery_commit_missing",
    });
    expect(controlPlane.reportBlocker).toHaveBeenCalledWith(
      target,
      "delivery_commit_missing",
      "2026-08-11T03:01:00.000Z",
    );
  });

  it("先持久化并上传不可变 Preview，再签名并提交证据", async () => {
    const order: string[] = [];
    const { signer: actualSigner, authority } = signerFixture();
    const signer = {
      sign: vi.fn(async (payload) => {
        order.push("sign");
        return actualSigner.sign(payload);
      }),
    };
    const journal = {
      load: vi.fn(async () => null),
      saveArtifact: vi.fn(async () => {
        order.push("save_artifact");
      }),
      saveFailure: vi.fn(async () => Promise.resolve()),
      saveSigned: vi.fn(async () => {
        order.push("save_signed");
      }),
      clear: vi.fn(async () => {
        order.push("clear");
      }),
    };
    const controlPlane = {
      listPending: vi.fn(async () => {
        order.push("list");
        return [target];
      }),
      publishPreview: vi.fn(async () => {
        order.push("upload");
      }),
      submitEvidence: vi.fn(async (evidence) => {
        order.push("submit");
        authority.verify(evidence);
      }),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const verifier = {
      verify: vi.fn(async () => {
        order.push("verify");
        return passedVerification;
      }),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
      createEvidenceKey: () => "80000000-0000-4000-8000-000000000008",
    });

    await expect(runtime.runOnce()).resolves.toEqual({
      kind: "submitted",
      title: target.title,
    });
    expect(order).toEqual([
      "list",
      "verify",
      "save_artifact",
      "upload",
      "sign",
      "save_signed",
      "submit",
      "clear",
    ]);
    expect(controlPlane.publishPreview).toHaveBeenCalledWith(
      target,
      preview,
      artifactHash,
    );
  });

  it("提交响应丢失后重启会原样重放已签名证据，不会重复验证", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    const submitted: unknown[] = [];
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async (evidence) => {
        submitted.push(evidence);
        if (submitted.length === 1) throw new Error("response_lost");
      }),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const verifier = { verify: vi.fn(async () => passedVerification) };
    const options = {
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
      createEvidenceKey: () => "80000000-0000-4000-8000-000000000008",
    } as const;

    await expect(
      new VerificationRunnerRuntime(options).runOnce(),
    ).rejects.toThrow("response_lost");
    await expect(
      new VerificationRunnerRuntime(options).runOnce(),
    ).resolves.toEqual({ kind: "submitted", title: target.title });

    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(controlPlane.listPending).toHaveBeenCalledOnce();
    expect(controlPlane.publishPreview).toHaveBeenCalledOnce();
    expect(controlPlane.submitEvidence).toHaveBeenCalledTimes(2);
    expect(submitted[1]).toEqual(submitted[0]);
    await expect(journal.load()).resolves.toBeNull();
  });

  it("失败终态先于已签名证据落库时会清除旧日志并继续取新任务", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    const firstControlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => {
        throw new Error("response_lost");
      }),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const verifier = { verify: vi.fn(async () => passedVerification) };
    const baseOptions = {
      scope: runnerScope,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
      createEvidenceKey: () => "80000000-0000-4000-8000-000000000008",
    } as const;
    await expect(
      new VerificationRunnerRuntime({
        ...baseOptions,
        controlPlane: firstControlPlane,
      }).runOnce(),
    ).rejects.toThrow("response_lost");

    const resumedControlPlane = {
      listPending: vi.fn(async () => []),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => {
        throw new RunnerControlPlaneClientError(
          409,
          "verification_failure_recorded",
          "同一交付版本已经记录独立验证失败",
        );
      }),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const resumed = new VerificationRunnerRuntime({
      ...baseOptions,
      controlPlane: resumedControlPlane,
    });

    await expect(resumed.runOnce()).resolves.toEqual({ kind: "idle" });
    await expect(journal.load()).resolves.toBeNull();
    await expect(resumed.runOnce()).resolves.toEqual({ kind: "idle" });
    expect(resumedControlPlane.listPending).toHaveBeenCalledOnce();
    expect(verifier.verify).toHaveBeenCalledOnce();
  });

  it("Preview 上传失败后从制品日志恢复，不会重新运行验证命令", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi
        .fn()
        .mockRejectedValueOnce(new Error("upload_lost"))
        .mockResolvedValueOnce(undefined),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const verifier = { verify: vi.fn(async () => passedVerification) };
    const options = {
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
      createEvidenceKey: () => "80000000-0000-4000-8000-000000000008",
    } as const;

    await expect(
      new VerificationRunnerRuntime(options).runOnce(),
    ).rejects.toThrow("upload_lost");
    await expect(
      new VerificationRunnerRuntime(options).runOnce(),
    ).resolves.toEqual({ kind: "submitted", title: target.title });

    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(controlPlane.listPending).toHaveBeenCalledTimes(2);
    expect(controlPlane.publishPreview).toHaveBeenCalledTimes(2);
  });

  it("失败终态先于 Preview 恢复完成时会清除旧制品日志", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    const firstControlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => {
        throw new Error("upload_lost");
      }),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const verifier = { verify: vi.fn(async () => passedVerification) };
    const baseOptions = {
      scope: runnerScope,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
      createEvidenceKey: () => "80000000-0000-4000-8000-000000000008",
    } as const;
    await expect(
      new VerificationRunnerRuntime({
        ...baseOptions,
        controlPlane: firstControlPlane,
      }).runOnce(),
    ).rejects.toThrow("upload_lost");

    const resumedControlPlane = {
      listPending: vi.fn(async () => []),
      publishPreview: vi.fn(async () => {
        throw new RunnerControlPlaneClientError(
          409,
          "delivery_not_ready_for_verification",
          "当前交付已经不再等待验证",
        );
      }),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };

    await expect(
      new VerificationRunnerRuntime({
        ...baseOptions,
        controlPlane: resumedControlPlane,
      }).runOnce(),
    ).resolves.toEqual({ kind: "idle" });
    await expect(journal.load()).resolves.toBeNull();
    expect(verifier.verify).toHaveBeenCalledOnce();
  });

  it("任一验收条件失败时不上传 Preview，也不提交通过证据", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const verifier = {
      verify: vi.fn(async () => ({
        artifact: preview,
        checks: [
          {
            criterionKey,
            status: "failed" as const,
            testRunKey: "suite-failed",
          },
        ],
      })),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
    });

    await expect(runtime.runOnce()).resolves.toEqual({
      kind: "verification_failed",
      title: target.title,
    });
    expect(controlPlane.publishPreview).not.toHaveBeenCalled();
    expect(controlPlane.submitEvidence).not.toHaveBeenCalled();
    expect(controlPlane.reportFailure).toHaveBeenCalledWith(
      target,
      expect.arrayContaining([
        expect.objectContaining({
          criterionKey,
          status: "failed",
          testRunKey: "suite-failed",
        }),
      ]),
      expect.any(String),
    );
    await expect(journal.load()).resolves.toBeNull();
  });

  it("失败上报响应丢失后重启只重放失败结果，不会再次运行验证套件", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    const failedVerification = {
      artifact: preview,
      checks: [
        {
          criterionKey,
          status: "failed" as const,
          testRunKey: "suite-failed",
        },
      ],
    };
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi
        .fn()
        .mockRejectedValueOnce(new Error("response_lost"))
        .mockResolvedValueOnce(undefined),
    };
    const verifier = { verify: vi.fn(async () => failedVerification) };
    const options = {
      scope: runnerScope,
      controlPlane,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
    } as const;

    await expect(
      new VerificationRunnerRuntime(options).runOnce(),
    ).rejects.toThrow("response_lost");
    await expect(
      new VerificationRunnerRuntime(options).runOnce(),
    ).resolves.toEqual({
      kind: "verification_failed",
      title: target.title,
    });
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(controlPlane.listPending).toHaveBeenCalledOnce();
    expect(controlPlane.reportFailure).toHaveBeenCalledTimes(2);
    await expect(journal.load()).resolves.toBeNull();
  });

  it("失败日志超过恢复窗口后会清理并在下一轮重新领取任务", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    let now = new Date("2026-08-11T03:00:00.000Z");
    const controlPlane = {
      listPending: vi
        .fn()
        .mockResolvedValueOnce([target])
        .mockResolvedValueOnce([]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const verifier = {
      verify: vi.fn(async () => ({
        artifact: preview,
        checks: [
          {
            criterionKey,
            status: "failed" as const,
            testRunKey: "suite-failed",
          },
        ],
      })),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: runnerScope,
      controlPlane,
      verifier,
      signer,
      journal,
      journalIntegrityKey,
      clock: () => new Date(now.getTime()),
    });

    await expect(runtime.runOnce()).rejects.toThrow("offline");
    now = new Date("2026-08-11T03:11:00.001Z");
    await expect(runtime.runOnce()).resolves.toEqual({ kind: "idle" });
    await expect(journal.load()).resolves.toBeNull();
    await expect(runtime.runOnce()).resolves.toEqual({ kind: "idle" });
    expect(controlPlane.listPending).toHaveBeenCalledTimes(2);
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(controlPlane.reportFailure).toHaveBeenCalledOnce();
  });

  it("拒绝为缺少本地完整性认证的 artifact_ready 日志签发新鲜证据", async () => {
    const { signer } = signerFixture();
    const forgedEntry = {
      schemaVersion: 1,
      stage: "artifact_ready",
      target,
      evidenceKey: "80000000-0000-4000-8000-000000000008",
      artifactHashAlgorithm: "sha256",
      artifactHash,
      artifactContentBase64: Buffer.from(preview).toString("base64"),
      checks: passedVerification.checks,
      scope: runnerScope,
      verificationCompletedAt: "2026-08-11T03:00:00.000Z",
      integrityTag: "0".repeat(64),
    } as const;
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier: { verify: vi.fn() },
      signer,
      journal: {
        load: vi.fn(async () => forgedEntry),
        saveArtifact: vi.fn(),
        saveFailure: vi.fn(),
        saveSigned: vi.fn(),
        clear: vi.fn(),
      },
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
    });

    await expect(runtime.runOnce()).rejects.toThrow("完整性");
    expect(controlPlane.publishPreview).not.toHaveBeenCalled();
    expect(controlPlane.submitEvidence).not.toHaveBeenCalled();
  });

  it("Preview 恢复窗过期后清理旧制品并在下一轮重新取件", async () => {
    const { signer } = signerFixture();
    const entry = verificationArtifactEntry({
      target,
      evidenceKey: "80000000-0000-4000-8000-000000000008",
      artifact: preview,
      artifactHash,
      checks: passedVerification.checks,
      scope: runnerScope,
      verificationCompletedAt: "2026-08-11T03:00:00.000Z",
      integrityKey: journalIntegrityKey,
    });
    const journal = new InMemoryVerificationJournal();
    await journal.saveArtifact(entry);
    const controlPlane = {
      listPending: vi.fn(async () => []),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier: { verify: vi.fn() },
      signer,
      journal,
      journalIntegrityKey,
      maxArtifactRecoveryAgeMs: 10 * 60_000,
      clock: () => new Date("2026-08-11T03:11:00.000Z"),
    });

    await expect(runtime.runOnce()).resolves.toEqual({ kind: "idle" });
    await expect(journal.load()).resolves.toBeNull();
    await expect(runtime.runOnce()).resolves.toEqual({ kind: "idle" });
    expect(controlPlane.listPending).toHaveBeenCalledTimes(2);
    expect(controlPlane.publishPreview).not.toHaveBeenCalled();
    expect(controlPlane.submitEvidence).not.toHaveBeenCalled();
  });

  it("恢复时权威需求或验收条件变化会拒绝旧制品", async () => {
    const { signer } = signerFixture();
    const entry = verificationArtifactEntry({
      target,
      evidenceKey: "80000000-0000-4000-8000-000000000008",
      artifact: preview,
      artifactHash,
      checks: passedVerification.checks,
      scope: runnerScope,
      verificationCompletedAt: "2026-08-11T03:00:00.000Z",
      integrityKey: journalIntegrityKey,
    });
    const changedTarget = {
      ...target,
      acceptanceCriteria: [
        {
          ...target.acceptanceCriteria[0]!,
          description: "需求已经变化，必须显示新的预约结果",
        },
      ],
    };
    const controlPlane = {
      listPending: vi.fn(async () => [changedTarget]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier: { verify: vi.fn() },
      signer,
      journal: {
        load: vi.fn(async () => entry),
        saveArtifact: vi.fn(),
        saveFailure: vi.fn(),
        saveSigned: vi.fn(),
        clear: vi.fn(),
      },
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
    });

    await expect(runtime.runOnce()).rejects.toThrow("权威验证任务不一致");
    expect(controlPlane.publishPreview).not.toHaveBeenCalled();
  });

  it("同一完整性密钥下也不能把其他租户项目的恢复日志重新签名", async () => {
    const { signer } = signerFixture();
    const entry = verificationArtifactEntry({
      target,
      evidenceKey: "80000000-0000-4000-8000-000000000008",
      artifact: preview,
      artifactHash,
      checks: passedVerification.checks,
      scope: runnerScope,
      verificationCompletedAt: "2026-08-11T03:00:00.000Z",
      integrityKey: journalIntegrityKey,
    });
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: {
        tenantKey: "11000000-0000-4000-8000-000000000001",
        projectKey: "22000000-0000-4000-8000-000000000002",
        repositoryKey,
        runnerKey,
        keyId,
      },
      controlPlane,
      verifier: { verify: vi.fn() },
      signer,
      journal: {
        load: vi.fn(async () => entry),
        saveArtifact: vi.fn(),
        saveFailure: vi.fn(),
        saveSigned: vi.fn(),
        clear: vi.fn(),
      },
      journalIntegrityKey,
      clock: () => new Date("2026-08-11T03:01:00.000Z"),
    });

    await expect(runtime.runOnce()).rejects.toThrow("授权范围");
    expect(controlPlane.publishPreview).not.toHaveBeenCalled();
    expect(controlPlane.submitEvidence).not.toHaveBeenCalled();
  });

  it("同一 Runtime 不允许两个 runOnce 并发签署同一任务", async () => {
    const { signer } = signerFixture();
    let releaseFirst!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const controlPlane = {
      listPending: vi
        .fn()
        .mockImplementationOnce(async () => {
          await firstMayContinue;
          return [target];
        })
        .mockResolvedValueOnce([]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
      reportFailure: vi.fn(async () => Promise.resolve()),
    };
    const runtime = new VerificationRunnerRuntime({
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier: {
        verify: vi.fn(async () => ({
          artifact: preview,
          checks: [
            {
              criterionKey,
              status: "failed" as const,
              testRunKey: "suite-failed",
            },
          ],
        })),
      },
      signer,
      journal: new InMemoryVerificationJournal(),
      journalIntegrityKey,
    });

    const first = runtime.runOnce();
    const second = runtime.runOnce();
    releaseFirst();

    await expect(second).rejects.toThrow("正在处理");
    await expect(first).resolves.toMatchObject({
      kind: "verification_failed",
    });
    expect(controlPlane.listPending).toHaveBeenCalledOnce();
  });
});
