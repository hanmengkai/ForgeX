import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { EvidenceAuthority } from "@forgex/domain";

import {
  Ed25519RunnerEvidenceSigner,
  InMemoryVerificationJournal,
  VerificationRunnerRuntime,
  type VerificationRunnerTarget,
} from "../src/index.js";

const tenantKey = "10000000-0000-4000-8000-000000000001";
const projectKey = "20000000-0000-4000-8000-000000000002";
const repositoryKey = "30000000-0000-4000-8000-000000000003";
const runnerKey = "40000000-0000-4000-8000-000000000004";
const keyId = "50000000-0000-4000-8000-000000000005";
const requirementKey = "60000000-0000-4000-8000-000000000006";
const criterionKey = "70000000-0000-4000-8000-000000000007";

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
      submitEvidence: vi
        .fn(async (evidence) => {
          submitted.push(evidence);
          if (submitted.length === 1) throw new Error("response_lost");
        }),
    };
    const verifier = { verify: vi.fn(async () => passedVerification) };
    const options = {
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier,
      signer,
      journal,
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
    };
    const verifier = { verify: vi.fn(async () => passedVerification) };
    const options = {
      scope: { tenantKey, projectKey, repositoryKey, runnerKey, keyId },
      controlPlane,
      verifier,
      signer,
      journal,
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
    expect(controlPlane.listPending).toHaveBeenCalledOnce();
    expect(controlPlane.publishPreview).toHaveBeenCalledTimes(2);
  });

  it("任一验收条件失败时不上传 Preview，也不提交通过证据", async () => {
    const { signer } = signerFixture();
    const journal = new InMemoryVerificationJournal();
    const controlPlane = {
      listPending: vi.fn(async () => [target]),
      publishPreview: vi.fn(async () => Promise.resolve()),
      submitEvidence: vi.fn(async () => Promise.resolve()),
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
    });

    await expect(runtime.runOnce()).resolves.toEqual({
      kind: "verification_failed",
      title: target.title,
    });
    expect(controlPlane.publishPreview).not.toHaveBeenCalled();
    expect(controlPlane.submitEvidence).not.toHaveBeenCalled();
    await expect(journal.load()).resolves.toBeNull();
  });
});
