import {
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EvidenceAuthority,
  RequirementWorkflow,
  VerifiedEvidenceReceipt,
  type DeliveryCandidate,
  type EvidencePayload,
  type TrustedRunner,
} from "../src/index.js";
import {
  createEvidenceAuthority,
  deliveryCandidate,
  fixedNow,
  projectKey,
  repositoryKey,
  runnerKey,
  runnerKeyId,
  signEvidence,
  tenantKey,
  trustedRunner,
} from "./evidence-fixture.js";

const actor = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "产品负责人",
};

const createRequirement = (
  clock: () => Date = () => new Date(fixedNow.getTime()),
) =>
  RequirementWorkflow.create(
    {
      title: "访客预约",
      summary: "访客提交预约后，由业主确认到访时间",
      acceptanceCriteria: ["访客可以提交预约", "业主可以确认预约"],
    },
    {
      tenantKey,
      projectKey,
      clock,
    },
  );

const enterDelivery = () => {
  let nowMs = Date.parse("2026-08-10T01:00:00.000Z");
  const requirement = createRequirement(() => new Date(nowMs));
  requirement.submitForConfirmation();
  requirement.confirm({ actor });
  requirement.startDelivery();
  nowMs = Date.parse("2026-08-10T01:15:00.000Z");
  requirement.recordDeliveryCandidate(deliveryCandidate);
  nowMs = fixedNow.getTime();
  return requirement;
};

const evidencePayloadFor = (
  requirement: RequirementWorkflow,
  overrides: Partial<EvidencePayload> = {},
): EvidencePayload => {
  const target = requirement.getVerificationTarget();
  return {
    schemaVersion: 1,
    evidenceKey: randomUUID(),
    tenantKey: target.tenantKey,
    projectKey: target.projectKey,
    repositoryKey: target.repositoryKey,
    requirementKey: target.requirementKey,
    requirementRevision: target.revision,
    gitHashAlgorithm: target.gitHashAlgorithm,
    commitSha: target.commitSha,
    runnerKey,
    keyId: runnerKeyId,
    producedAt: "2026-08-10T01:30:00.000Z",
    artifactHashAlgorithm: target.artifactHashAlgorithm,
    artifactHash: target.artifactHash,
    checks: target.acceptanceCriteria.map((criterion, index) => ({
      criterionKey: criterion.criterionKey,
      status: "passed" as const,
      testRunKey: `test-run-${index + 1}`,
    })),
    ...overrides,
  };
};

describe("审批审计", () => {
  it("保存谁在何时确认了哪个需求版本", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();

    requirement.confirm({ actor });

    expect(requirement.listApprovalRecords()).toEqual([
      {
        action: "确认需求",
        actorKey: actor.actorKey,
        actorName: "产品负责人",
        requirementKey: requirement.internalKey,
        revision: 1,
        recordedAt: "2026-08-10T02:00:00.000Z",
      },
    ]);
  });

  it("修改需求后保留旧审批记录但要求重新确认", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    requirement.confirm({ actor });

    requirement.revise({
      summary: "访客提交预约后，由业主确认到访时间和通行范围",
      changedBy: "需求分析师",
    });

    const records = requirement.listApprovalRecords();
    records[0]!.actorName = "外部篡改";
    expect(requirement.listApprovalRecords()[0]!.actorName).toBe("产品负责人");
    expect(requirement.toPeopleView().status).toBe("内容已更新，等待重新确认");
  });

  it("验收审批固化所批准的证据、代码提交和产物摘要", () => {
    const requirement = enterDelivery();
    const payload = evidencePayloadFor(requirement);
    const receipt = createEvidenceAuthority().verify({
      payload,
      signature: signEvidence(payload),
    });
    requirement.submitForAcceptance(receipt);

    requirement.accept({ actor });

    const acceptance = requirement.listApprovalRecords()[1];
    expect(acceptance).toMatchObject({
      action: "验收结果",
      evidence: {
        evidenceKey: payload.evidenceKey,
        repositoryKey,
        commitSha: deliveryCandidate.commitSha,
        artifactHash: deliveryCandidate.artifactHash,
        runnerKey,
        keyId: runnerKeyId,
      },
    });
    if (acceptance?.action === "验收结果") {
      acceptance.evidence.commitSha = "f".repeat(40);
    }
    expect(requirement.listApprovalRecords()[1]).toMatchObject({
      evidence: { commitSha: deliveryCandidate.commitSha },
    });
  });
});

describe("独立验证证据", () => {
  it("拒绝通过伪造原型构造的未签名证据", () => {
    const requirement = enterDelivery();
    const payload = evidencePayloadFor(requirement);
    const forgedReceipt = Object.assign(
      Object.create(VerifiedEvidenceReceipt.prototype) as object,
      { ...payload, runnerName: "伪造 Runner" },
    ) as unknown as VerifiedEvidenceReceipt;

    expect(() => requirement.submitForAcceptance(forgedReceipt)).toThrow(
      "验证证据必须经过受信任的独立 Runner 验签",
    );

    const genuineReceipt = createEvidenceAuthority().verify({
      payload,
      signature: signEvidence(payload),
    });
    expect(() =>
      requirement.submitForAcceptance(new Proxy(genuineReceipt, {})),
    ).toThrow("验证证据必须经过受信任的独立 Runner 验签");
  });

  it("证据绑定租户、项目、仓库、需求版本、完整提交和交付产物", () => {
    const requirement = enterDelivery();
    const payload = evidencePayloadFor(requirement);
    const receipt = createEvidenceAuthority().verify({
      payload,
      signature: signEvidence(payload),
    });

    requirement.submitForAcceptance(receipt);

    expect(requirement.toPeopleView()).toMatchObject({
      status: "等待产品验收",
      acceptanceProgress: "2 / 2 项已通过",
    });
    expect(requirement.listAllowedActions()).toEqual(["accept"]);
    expect(requirement.toAcceptanceView()).toEqual({
      verifiedBy: "独立测试 Runner",
      verifiedAt: "2026-08-10T01:30:00.000Z",
      checks: [
        { title: "访客可以提交预约", status: "已通过" },
        { title: "业主可以确认预约", status: "已通过" },
      ],
    });
  });

  it("拒绝未授权范围的 Runner 和已经切换掉的候选提交", () => {
    const requirement = enterDelivery();
    const payload = evidencePayloadFor(requirement);
    const unauthorizedRunner: TrustedRunner = {
      ...trustedRunner,
      scopes: [
        {
          tenantKey,
          projectKey,
          repositoryKey: "99999999-9999-4999-8999-999999999999",
        },
      ],
    };
    expect(() =>
      createEvidenceAuthority([unauthorizedRunner]).verify({
        payload,
        signature: signEvidence(payload),
      }),
    ).toThrow("独立 Runner 无权验证这个租户、项目或代码仓库");

    const receipt = createEvidenceAuthority().verify({
      payload,
      signature: signEvidence(payload),
    });
    requirement.recordDeliveryCandidate({
      ...deliveryCandidate,
      commitSha: "c".repeat(40),
    });
    expect(() => requirement.submitForAcceptance(receipt)).toThrow(
      "验证证据与当前交付候选不匹配",
    );
  });

  it("拒绝通过交付候选夹带字段覆盖可信租户和项目范围", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    requirement.confirm({ actor });
    requirement.startDelivery();
    requirement.recordDeliveryCandidate({
      ...deliveryCandidate,
      tenantKey: "99999999-9999-4999-8999-999999999999",
      projectKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    } as unknown as DeliveryCandidate);

    expect(requirement.getVerificationTarget()).toMatchObject({
      tenantKey,
      projectKey,
    });
  });

  it("拒绝签名篡改、验收条件失败或覆盖不完整的证据", () => {
    const requirement = enterDelivery();
    const complete = evidencePayloadFor(requirement);
    expect(() =>
      createEvidenceAuthority().verify({
        payload: complete,
        signature: Buffer.alloc(64).toString("base64"),
      }),
    ).toThrow("证据签名无效");

    const failed = evidencePayloadFor(requirement, {
      checks: complete.checks.map((check, index) => ({
        ...check,
        status: index === 0 ? "failed" : "passed",
      })),
    });
    const failedReceipt = createEvidenceAuthority().verify({
      payload: failed,
      signature: signEvidence(failed),
    });
    expect(() => requirement.submitForAcceptance(failedReceipt)).toThrow(
      "所有验收条件通过后才能提交产品验收",
    );

    const incomplete = evidencePayloadFor(requirement, {
      checks: complete.checks.slice(0, 1),
    });
    const incompleteReceipt = createEvidenceAuthority().verify({
      payload: incomplete,
      signature: signEvidence(incomplete),
    });
    expect(() => requirement.submitForAcceptance(incompleteReceipt)).toThrow(
      "验证证据没有覆盖全部验收条件",
    );
  });

  it("拒绝过期和超出未来偏差的证据", () => {
    const requirement = enterDelivery();
    const expired = evidencePayloadFor(requirement, {
      producedAt: "2026-08-09T20:00:00.000Z",
    });
    expect(() =>
      createEvidenceAuthority().verify({
        payload: expired,
        signature: signEvidence(expired),
      }),
    ).toThrow("验证证据已经过期，请重新执行独立验证");

    const future = evidencePayloadFor(requirement, {
      producedAt: "2026-08-10T02:02:00.000Z",
    });
    expect(() =>
      createEvidenceAuthority().verify({
        payload: future,
        signature: signEvidence(future),
      }),
    ).toThrow("证据产生时间超出允许的未来偏差");
  });

  it("拒绝早于交付候选或验签后持有过久的证据", () => {
    const requirement = enterDelivery();
    const beforeCandidate = evidencePayloadFor(requirement, {
      producedAt: "2026-08-10T01:10:00.000Z",
    });
    const beforeCandidateReceipt = createEvidenceAuthority().verify({
      payload: beforeCandidate,
      signature: signEvidence(beforeCandidate),
    });
    expect(() =>
      requirement.submitForAcceptance(beforeCandidateReceipt),
    ).toThrow("验证证据早于当前交付候选，不能用于验收");

    let nowMs = Date.parse("2026-08-10T01:00:00.000Z");
    const delayedRequirement = createRequirement(() => new Date(nowMs));
    delayedRequirement.submitForConfirmation();
    delayedRequirement.confirm({ actor });
    delayedRequirement.startDelivery();
    nowMs = Date.parse("2026-08-10T01:15:00.000Z");
    delayedRequirement.recordDeliveryCandidate(deliveryCandidate);
    const payload = evidencePayloadFor(delayedRequirement);
    const receipt = createEvidenceAuthority().verify({
      payload,
      signature: signEvidence(payload),
    });
    nowMs = Date.parse("2026-08-10T04:00:00.000Z");

    expect(() => delayedRequirement.submitForAcceptance(receipt)).toThrow(
      "验证证据已经过期，请重新执行独立验证",
    );
  });

  it("拒绝 NaN 或 Infinity 关闭证据时效校验", () => {
    expect(
      () =>
        new EvidenceAuthority({
          runners: [trustedRunner],
          maxEvidenceAgeMs: Number.NaN,
        }),
    ).toThrow("证据有效期配置无效");
    expect(
      () =>
        new EvidenceAuthority({
          runners: [trustedRunner],
          maxFutureSkewMs: Number.POSITIVE_INFINITY,
        }),
    ).toThrow("证据有效期配置无效");
  });

  it("拒绝重复 Runner 密钥并允许显式 keyId 轮换", () => {
    expect(() =>
      createEvidenceAuthority([
        trustedRunner,
        {
          ...trustedRunner,
          runnerKey: trustedRunner.runnerKey.toUpperCase(),
          keyId: trustedRunner.keyId.toUpperCase(),
        },
      ]),
    ).toThrow("受信任 Runner 的 runnerKey 与 keyId 不能重复");

    const rotatedKeyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rotated = generateKeyPairSync("ed25519");
    const rotatedRunner: TrustedRunner = {
      ...trustedRunner,
      keyId: rotatedKeyId,
      publicKeyBase64: rotated.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    };
    const requirement = enterDelivery();
    const payload = evidencePayloadFor(requirement, { keyId: rotatedKeyId });
    const signature = signPayload(
      null,
      Buffer.from(EvidenceAuthority.canonicalPayload(payload), "utf8"),
      rotated.privateKey,
    ).toString("base64");

    expect(
      createEvidenceAuthority([trustedRunner, rotatedRunner]).verify({
        payload,
        signature,
      }).keyId,
    ).toBe(rotatedKeyId);
  });

  it("已退役公钥只核验历史快照，不能签发新的验证结果", () => {
    const requirement = enterDelivery();
    const payload = evidencePayloadFor(requirement);
    const signed = { payload, signature: signEvidence(payload) };
    const authority = createEvidenceAuthority([
      { ...trustedRunner, acceptNewEvidence: false },
    ]);

    expect(() => authority.verify(signed)).toThrow("只用于核验历史证据");
    expect(authority.verifyPersisted(signed)).toMatchObject({
      runnerKey,
      keyId: runnerKeyId,
    });
  });

  it("规范化 UUID 并拒绝非规范 Base64 公钥", () => {
    const requirement = enterDelivery();
    const payload = evidencePayloadFor(requirement, {
      tenantKey: tenantKey.toUpperCase(),
      projectKey: projectKey.toUpperCase(),
      repositoryKey: repositoryKey.toUpperCase(),
      runnerKey: runnerKey.toUpperCase(),
      keyId: runnerKeyId.toUpperCase(),
    });
    const receipt = createEvidenceAuthority().verify({
      payload,
      signature: signEvidence(payload),
    });
    expect(receipt).toMatchObject({
      tenantKey,
      projectKey,
      repositoryKey,
      runnerKey,
      keyId: runnerKeyId,
    });

    expect(() =>
      createEvidenceAuthority([
        {
          ...trustedRunner,
          publicKeyBase64: `${trustedRunner.publicKeyBase64}\n`,
        },
      ]),
    ).toThrow("受信任 Runner 的 Ed25519 公钥无效");
  });

  it("使用与语言环境无关的固定规范化顺序", () => {
    const payload: EvidencePayload = {
      schemaVersion: 1,
      evidenceKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tenantKey,
      projectKey,
      repositoryKey,
      requirementKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      requirementRevision: 3,
      gitHashAlgorithm: "sha1",
      commitSha: "c".repeat(40),
      runnerKey,
      keyId: runnerKeyId,
      producedAt: "2026-08-10T01:30:00.000Z",
      artifactHashAlgorithm: "sha256",
      artifactHash: "d".repeat(64),
      checks: [
        {
          criterionKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          status: "passed",
          testRunKey: "run-z",
        },
        {
          criterionKey: "00000000-0000-4000-8000-000000000001",
          status: "passed",
          testRunKey: "run-a",
        },
      ],
    };

    expect(EvidenceAuthority.canonicalPayload(payload)).toBe(
      `{"schemaVersion":1,"evidenceKey":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","tenantKey":"${tenantKey}","projectKey":"${projectKey}","repositoryKey":"${repositoryKey}","requirementKey":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","requirementRevision":3,"gitHashAlgorithm":"sha1","commitSha":"${"c".repeat(40)}","runnerKey":"${runnerKey}","keyId":"${runnerKeyId}","producedAt":"2026-08-10T01:30:00.000Z","artifactHashAlgorithm":"sha256","artifactHash":"${"d".repeat(64)}","checks":[{"criterionKey":"00000000-0000-4000-8000-000000000001","status":"passed","testRunKey":"run-a"},{"criterionKey":"ffffffff-ffff-4fff-8fff-ffffffffffff","status":"passed","testRunKey":"run-z"}]}`,
    );
  });
});
