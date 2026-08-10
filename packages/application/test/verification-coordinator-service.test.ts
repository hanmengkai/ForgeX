import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import { RequirementSpecSchema, type EvidencePayload } from "@forgex/contracts";
import { EvidenceAuthority, RequirementWorkflow } from "@forgex/domain";

import {
  InMemoryPreviewArtifactStore,
  InMemoryRequirementRepository,
  VerificationCoordinatorService,
  type AuthenticatedRunner,
  type DeliveryRunResult,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const repositoryKey = "33333333-3333-4333-8333-333333333333";
const runnerKey = "44444444-4444-4444-8444-444444444444";
const keyId = "55555555-5555-4555-8555-555555555555";
const actor = {
  actorKey: "66666666-6666-4666-8666-666666666666",
  actorName: "产品负责人",
};
const spec = RequirementSpecSchema.parse({
  schemaVersion: 1,
  title: "访客预约",
  goal: "让访客可以在线预约到访",
  userStories: [],
  acceptanceCriteria: [
    {
      title: "访客可以提交预约",
      description: "填写姓名和到访时间后能够成功提交",
      priority: "must",
    },
  ],
  openQuestions: [],
});

const keys = generateKeyPairSync("ed25519");
const evidenceAuthority = (
  clock: () => Date,
  acceptNewEvidence: boolean = true,
) =>
  new EvidenceAuthority({
    runners: [
      {
        runnerKey,
        keyId,
        runnerName: "独立验证 Runner",
        publicKeyBase64: keys.publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
        scopes: [{ tenantKey, projectKey, repositoryKey }],
        acceptNewEvidence,
      },
    ],
    clock,
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    maxFutureSkewMs: 60_000,
  });

const runner: AuthenticatedRunner = { tenantKey, runnerKey, keyId };

const signEvidence = (payload: EvidencePayload) => ({
  payload,
  signature: signPayload(
    null,
    Buffer.from(EvidenceAuthority.canonicalPayload(payload), "utf8"),
    keys.privateKey,
  ).toString("base64"),
});

const arrangeCompletedDelivery = async (
  repository: InMemoryRequirementRepository,
  clock: () => Date,
  completed = true,
) => {
  const workflow = RequirementWorkflow.createFromSpec(spec, {
    tenantKey,
    projectKey,
    clock,
  });
  workflow.submitForConfirmation();
  workflow.confirm({ actor });
  workflow.startDelivery();
  const requirementKey = workflow.internalKey;
  const run: DeliveryRunResult = {
    tenantKey,
    projectKey,
    repositoryKey,
    requirementKey,
    requirementRevision: 1,
    assignmentKey: "77777777-7777-4777-8777-777777777777",
    fencingToken: 3,
    gitHashAlgorithm: "sha1",
    baseCommit: "a".repeat(40),
    commitSha: "b".repeat(40),
    branchName: `forgex/${projectKey.slice(0, 8)}/77777777-7777-4777-8777-777777777777`,
    summary: "已生成本地提交，等待独立验证",
    status: completed ? "completed" : "completion_pending",
    submittedAt: "2026-08-11T02:50:00.000Z",
    completedAt: completed ? "2026-08-11T02:55:00.000Z" : null,
  };
  await repository.transaction(tenantKey, projectKey, (transaction) => {
    transaction.save({
      tenantKey,
      projectKey,
      requirementKey,
      createdAt: "2026-08-11T02:00:00.000Z",
      spec,
      workflow,
    });
    transaction.saveDeliveryRunResult(run);
  });
  return { workflow, run };
};

describe("VerificationCoordinatorService", () => {
  it("把已完成提交、不可变 Preview 和 Runner 签名证据推进到产品验收", async () => {
    let now = new Date("2026-08-11T03:00:00.000Z");
    const clock = () => new Date(now.getTime());
    const repository = new InMemoryRequirementRepository();
    const previewArtifactStore = new InMemoryPreviewArtifactStore();
    const { workflow, run } = await arrangeCompletedDelivery(repository, clock);
    const service = new VerificationCoordinatorService({
      requirementRepository: repository,
      previewArtifactStore,
      evidenceAuthority: evidenceAuthority(clock),
      projectKey,
      repositoryKey,
      clock,
    });

    await expect(service.listPending(runner, { limit: 20 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          requirementKey: run.requirementKey,
          requirementRevision: 1,
          repositoryKey,
          commitSha: run.commitSha,
          title: spec.title,
          acceptanceCriteria: [
            expect.objectContaining({ title: "访客可以提交预约" }),
          ],
        }),
      ],
    });

    const content = new TextEncoder().encode(
      "<!doctype html><html><body>访客预约已可使用</body></html>",
    );
    const artifactHash = createHash("sha256").update(content).digest("hex");
    await expect(
      service.publishPreviewArtifact(runner, {
        schemaVersion: 1,
        requirementKey: run.requirementKey,
        requirementRevision: 1,
        artifactHashAlgorithm: "sha256",
        artifactHash,
        content,
      }),
    ).resolves.toMatchObject({ status: "preview_recorded" });
    const conflictingContent = new TextEncoder().encode(
      "<!doctype html><html><body>另一份效果</body></html>",
    );
    await expect(
      service.publishPreviewArtifact(runner, {
        schemaVersion: 1,
        requirementKey: run.requirementKey,
        requirementRevision: 1,
        artifactHashAlgorithm: "sha256",
        artifactHash: createHash("sha256")
          .update(conflictingContent)
          .digest("hex"),
        content: conflictingContent,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "preview_candidate_conflict",
    });

    now = new Date("2026-08-11T03:01:00.000Z");
    const verifiedAt = now.toISOString();
    const criterionKey =
      workflow.toSnapshot().revisions[0]!.acceptanceCriteria[0]!.criterionKey;
    const payload: EvidencePayload = {
      schemaVersion: 1,
      evidenceKey: randomUUID(),
      tenantKey,
      projectKey,
      repositoryKey,
      requirementKey: run.requirementKey,
      requirementRevision: 1,
      gitHashAlgorithm: "sha1",
      commitSha: run.commitSha,
      runnerKey,
      keyId,
      producedAt: verifiedAt,
      artifactHashAlgorithm: "sha256",
      artifactHash,
      checks: [
        { criterionKey, status: "passed", testRunKey: "runner-20260811-1" },
      ],
    };
    const signed = signEvidence(payload);

    await expect(service.submitEvidence(runner, signed)).resolves.toMatchObject(
      {
        view: {
          status: "等待产品验收",
          acceptanceProgress: "1 / 1 项已通过",
        },
      },
    );
    await expect(service.submitEvidence(runner, signed)).resolves.toMatchObject(
      {
        view: { status: "等待产品验收" },
      },
    );

    now = new Date("2026-08-11T05:30:00.000Z");
    const historicalService = new VerificationCoordinatorService({
      requirementRepository: repository,
      previewArtifactStore,
      evidenceAuthority: evidenceAuthority(clock, false),
      projectKey,
      repositoryKey,
      clock,
    });
    await expect(
      historicalService.submitEvidence(runner, signed),
    ).resolves.toMatchObject({ view: { status: "等待产品验收" } });
    await expect(
      historicalService.submitEvidence(runner, {
        ...signed,
        payload: { ...signed.payload, producedAt: now.toISOString() },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "runner_scope_denied",
    });

    const stored = await repository.transaction(
      tenantKey,
      projectKey,
      (transaction) => transaction.find(run.requirementKey),
    );
    expect(stored?.workflow.toAcceptanceView()).toEqual({
      verifiedBy: "独立验证 Runner",
      verifiedAt,
      checks: [{ title: "访客可以提交预约", status: "已通过" }],
    });
    await expect(
      previewArtifactStore.get({
        tenantKey,
        projectKey,
        requirementKey: run.requirementKey,
        requirementRevision: 1,
        artifactHashAlgorithm: "sha256",
        artifactHash,
      }),
    ).resolves.toMatchObject({ content });
    expect(await repository.listAuditEvents(tenantKey, projectKey)).toEqual([
      expect.objectContaining({
        action: "verification.preview_recorded",
        actorKey: runnerKey,
        actorName: "独立验证 Runner",
      }),
      expect.objectContaining({
        action: "verification.completed",
        actorKey: runnerKey,
        actorName: "独立验证 Runner",
      }),
    ]);
  });

  it("拒绝尚未完成的交付和不受信任的 Runner 会话", async () => {
    const clock = () => new Date("2026-08-11T03:00:00.000Z");
    const repository = new InMemoryRequirementRepository();
    const { run } = await arrangeCompletedDelivery(repository, clock, false);
    const service = new VerificationCoordinatorService({
      requirementRepository: repository,
      previewArtifactStore: new InMemoryPreviewArtifactStore(),
      evidenceAuthority: evidenceAuthority(clock),
      projectKey,
      repositoryKey,
      clock,
    });
    const content = new TextEncoder().encode("<p>preview</p>");

    await expect(
      service.publishPreviewArtifact(runner, {
        schemaVersion: 1,
        requirementKey: run.requirementKey,
        requirementRevision: 1,
        artifactHashAlgorithm: "sha256",
        artifactHash: createHash("sha256").update(content).digest("hex"),
        content,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "delivery_not_ready_for_verification",
    });

    const payload: EvidencePayload = {
      schemaVersion: 1,
      evidenceKey: randomUUID(),
      tenantKey,
      projectKey,
      repositoryKey,
      requirementKey: run.requirementKey,
      requirementRevision: 1,
      gitHashAlgorithm: "sha1",
      commitSha: run.commitSha,
      runnerKey,
      keyId,
      producedAt: clock().toISOString(),
      artifactHashAlgorithm: "sha256",
      artifactHash: "c".repeat(64),
      checks: [
        {
          criterionKey: randomUUID(),
          status: "passed",
          testRunKey: "runner-20260811-2",
        },
      ],
    };
    await expect(
      service.submitEvidence(
        { ...runner, runnerKey: "99999999-9999-4999-8999-999999999999" },
        signEvidence(payload),
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "runner_identity_mismatch",
    });
  });

  it("同一租户跨项目并发复用 evidenceKey 时只提交一项事务", async () => {
    const otherProjectKey = "99999999-9999-4999-8999-999999999999";
    const clock = () => new Date("2026-08-11T03:00:00.000Z");
    const repository = new InMemoryRequirementRepository();
    const first = await arrangeCompletedDelivery(repository, clock);
    const otherWorkflow = RequirementWorkflow.createFromSpec(spec, {
      tenantKey,
      projectKey: otherProjectKey,
      clock,
    });
    otherWorkflow.submitForConfirmation();
    otherWorkflow.confirm({ actor });
    otherWorkflow.startDelivery();
    const otherRequirementKey = otherWorkflow.internalKey;
    await repository.transaction(tenantKey, otherProjectKey, (transaction) => {
      transaction.save({
        tenantKey,
        projectKey: otherProjectKey,
        requirementKey: otherRequirementKey,
        createdAt: "2026-08-11T02:00:00.000Z",
        spec,
        workflow: otherWorkflow,
      });
      transaction.saveDeliveryRunResult({
        ...first.run,
        projectKey: otherProjectKey,
        requirementKey: otherRequirementKey,
        assignmentKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        branchName: `forgex/${otherProjectKey.slice(0, 8)}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      });
    });
    const evidenceKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstIsHolding = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondEntered = false;
    const firstTransaction = repository.transaction(
      tenantKey,
      projectKey,
      async (transaction) => {
        transaction.appendVerificationEvidence({
          tenantKey,
          projectKey,
          requirementKey: first.run.requirementKey,
          requirementRevision: 1,
          evidenceKey,
          evidenceDigest: "c".repeat(64),
          runnerKey,
          keyId,
          recordedAt: clock().toISOString(),
        });
        firstEntered();
        await holdFirst;
      },
    );
    await firstIsHolding;
    const secondTransaction = repository.transaction(
      tenantKey,
      otherProjectKey,
      async (transaction) => {
        secondEntered = true;
        const record = await transaction.find(otherRequirementKey);
        record!.workflow.recordDeliveryCandidate({
          repositoryKey,
          gitHashAlgorithm: "sha1",
          commitSha: first.run.commitSha,
          artifactHashAlgorithm: "sha256",
          artifactHash: "d".repeat(64),
        });
        transaction.save(record!);
        transaction.appendAudit({
          eventKey: randomUUID(),
          tenantKey,
          projectKey: otherProjectKey,
          requirementKey: otherRequirementKey,
          action: "verification.preview_recorded",
          actorKey: runnerKey,
          actorName: "独立验证 Runner",
          recordedAt: clock().toISOString(),
        });
        transaction.appendVerificationEvidence({
          tenantKey,
          projectKey: otherProjectKey,
          requirementKey: otherRequirementKey,
          requirementRevision: 1,
          evidenceKey,
          evidenceDigest: "e".repeat(64),
          runnerKey,
          keyId,
          recordedAt: clock().toISOString(),
        });
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(secondEntered).toBe(false);

    releaseFirst();
    await firstTransaction;
    await expect(secondTransaction).rejects.toThrow(
      "同一验证证据标识不能绑定不同的需求或内容",
    );
    const other = await repository.transaction(
      tenantKey,
      otherProjectKey,
      (transaction) => transaction.find(otherRequirementKey),
    );
    expect(other?.workflow.toSnapshot().deliveryCandidate).toBeNull();
    expect(
      await repository.listAuditEvents(tenantKey, otherProjectKey),
    ).toEqual([]);
  });
});
