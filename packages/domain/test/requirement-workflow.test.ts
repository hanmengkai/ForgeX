import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RequirementWorkflow,
  type EvidencePayload,
  type VerifiedEvidenceReceipt,
} from "../src/index.js";
import {
  createEvidenceAuthority,
  deliveryCandidate,
  fixedNow,
  projectKey,
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
const evidenceAuthority = createEvidenceAuthority();

const createRequirement = (
  clock: () => Date = () => new Date(fixedNow.getTime()),
) =>
  RequirementWorkflow.create(
    {
      title: "访客预约",
      summary: "访客提交预约后，由业主确认到访时间",
      acceptanceCriteria: ["访客可以提交预约", "业主可以确认预约"],
    },
    { tenantKey, projectKey, clock },
  );

const confirmRequirement = (requirement: RequirementWorkflow) => {
  requirement.submitForConfirmation();
  requirement.confirm({ actor });
};

const createVerifiedEvidence = (
  requirement: RequirementWorkflow,
  options: { failedCriterion?: number; onlyFirstCriterion?: boolean } = {},
): VerifiedEvidenceReceipt => {
  requirement.recordDeliveryCandidate(deliveryCandidate);
  const target = requirement.getVerificationTarget();
  const allChecks = target.acceptanceCriteria.map((criterion, index) => ({
    criterionKey: criterion.criterionKey,
    status:
      index === options.failedCriterion
        ? ("failed" as const)
        : ("passed" as const),
    testRunKey: `test-run-${index + 1}`,
  }));
  const payload: EvidencePayload = {
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
    producedAt: fixedNow.toISOString(),
    artifactHashAlgorithm: target.artifactHashAlgorithm,
    artifactHash: target.artifactHash,
    checks: options.onlyFirstCriterion ? allChecks.slice(0, 1) : allChecks,
  };
  const signature = signEvidence(payload);

  return evidenceAuthority.verify({ payload, signature });
};

describe("RequirementWorkflow", () => {
  it("拒绝无法理解或无法验收的需求内容", () => {
    expect(() =>
      RequirementWorkflow.create(
        {
          title: " ",
          summary: "有功能",
          acceptanceCriteria: ["可以使用"],
        },
        { tenantKey, projectKey },
      ),
    ).toThrow("请使用可理解的业务语言填写需求标题");

    expect(() =>
      RequirementWorkflow.create(
        {
          title: "访客预约",
          summary: "短",
          acceptanceCriteria: ["可以使用"],
        },
        { tenantKey, projectKey },
      ),
    ).toThrow("请说明需求希望解决的问题");

    expect(() =>
      RequirementWorkflow.create(
        {
          title: "访客预约",
          summary: "让访客到访更顺畅",
          acceptanceCriteria: [],
        },
        { tenantKey, projectKey },
      ),
    ).toThrow("至少需要一个可验证的验收条件");
  });

  it("普通视图只提供业务信息和下一步提示", () => {
    const requirement = createRequirement();

    const view = requirement.toPeopleView();

    expect(view).toEqual({
      title: "访客预约",
      summary: "访客提交预约后，由业主确认到访时间",
      version: "第 1 版",
      status: "正在整理",
      nextStep: "完善内容后提交确认",
      acceptanceProgress: "尚未开始验证",
    });
    expect(view).not.toHaveProperty("id");
    expect(view).not.toHaveProperty("key");
    expect(view).not.toHaveProperty("code");
  });

  it("需求未经确认时不能开始交付", () => {
    const requirement = createRequirement();

    expect(() => requirement.startDelivery()).toThrow(
      "需求需要先由负责人确认，才能开始交付",
    );
  });

  it("确认当前版本后可以进入交付", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);

    requirement.startDelivery();

    expect(requirement.toPeopleView().status).toBe("AI 正在实现");
  });

  it("等待确认和已确认状态提供清晰下一步", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    expect(requirement.toPeopleView()).toMatchObject({
      status: "等待负责人确认",
      nextStep: "请负责人确认需求内容",
    });

    requirement.confirm({ actor });
    expect(requirement.toPeopleView()).toMatchObject({
      status: "已确认，等待交付",
      nextStep: "可以安排 AI 开始实现",
    });
  });

  it("已确认需求发生修改后必须重新确认", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);

    requirement.revise({
      summary: "访客提交预约后，由业主确认到访时间和通行范围",
      changedBy: "需求分析师",
    });

    expect(requirement.toPeopleView()).toMatchObject({
      version: "第 2 版",
      status: "内容已更新，等待重新确认",
      nextStep: "请负责人确认最新版本",
    });
    expect(() => requirement.startDelivery()).toThrow(
      "需求需要先由负责人确认，才能开始交付",
    );
  });

  it("只有独立验证证据才能进入产品验收", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();

    expect(() =>
      requirement.submitForAcceptance({
        checks: [],
      } as unknown as VerifiedEvidenceReceipt),
    ).toThrow("验证证据必须经过受信任的独立 Runner 验签");

    requirement.submitForAcceptance(createVerifiedEvidence(requirement));

    expect(requirement.toPeopleView()).toMatchObject({
      status: "等待产品验收",
      nextStep: "请体验 Preview 并确认结果",
      acceptanceProgress: "2 / 2 项已通过",
    });
  });

  it("验收完成后给出清晰结果", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));

    requirement.accept({ actor });

    expect(requirement.toPeopleView()).toMatchObject({
      status: "已完成",
      nextStep: "无需处理",
    });
  });

  it("拒绝无效确认和验收信息", () => {
    const requirement = createRequirement();
    expect(() => requirement.confirm({ actor })).toThrow("请先提交需求确认");

    requirement.submitForConfirmation();
    expect(() => requirement.submitForConfirmation()).toThrow(
      "当前状态不能重复提交确认",
    );
    expect(() =>
      requirement.confirm({
        actor: { actorKey: " ", actorName: " " },
      }),
    ).toThrow("请记录确认人");

    const invalidClockRequirement = createRequirement(
      () => new Date("invalid"),
    );
    invalidClockRequirement.submitForConfirmation();
    expect(() => invalidClockRequirement.confirm({ actor })).toThrow(
      "确认时间无效",
    );
  });

  it("拒绝交付中的直接改需求和不完整验证", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();

    expect(() =>
      requirement.revise({ summary: "临时修改", changedBy: "产品" }),
    ).toThrow("需求已经进入交付，请创建新的变更需求");
    expect(() =>
      requirement.submitForAcceptance(
        createVerifiedEvidence(requirement, { failedCriterion: 0 }),
      ),
    ).toThrow("所有验收条件通过后才能提交产品验收");
    expect(() =>
      requirement.submitForAcceptance(
        createVerifiedEvidence(requirement, { onlyFirstCriterion: true }),
      ),
    ).toThrow("验证证据没有覆盖全部验收条件");
  });

  it("拒绝无效修改人和提前验收", () => {
    const requirement = createRequirement();
    expect(() =>
      requirement.revise({ summary: "增加通行范围", changedBy: " " }),
    ).toThrow("请记录修改人");
    expect(() =>
      requirement.submitForAcceptance({} as VerifiedEvidenceReceipt),
    ).toThrow("需求尚未进入交付，不能提交验收");
    expect(() => requirement.accept({ actor })).toThrow(
      "请先完成独立验证并提交产品验收",
    );
  });

  it("工作流快照可恢复等待验收状态且不依赖原始验签对象", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));

    const snapshot = requirement.toSnapshot();
    expect(() => RequirementWorkflow.fromSnapshot(snapshot)).toThrow(
      "EvidenceAuthority",
    );
    const restored = RequirementWorkflow.fromSnapshot(snapshot, {
      clock: () => new Date(fixedNow.getTime()),
      evidenceAuthority,
    });
    restored.accept({ actor });

    expect(restored.toPeopleView()).toMatchObject({
      status: "已完成",
      acceptanceProgress: "2 / 2 项已通过",
    });
    expect(restored.listApprovalRecords()).toHaveLength(2);
  });

  it("重启恢复后仍不能用已经过期的独立证据完成验收", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));
    const snapshot = requirement.toSnapshot();
    const restored = RequirementWorkflow.fromSnapshot(snapshot, {
      clock: () => new Date(fixedNow.getTime() + 2 * 60 * 60 * 1_000 + 1),
      evidenceAuthority,
    });

    expect(() => restored.accept({ actor })).toThrow("验证证据已经过期");
    expect(restored.toPeopleView().status).toBe("等待产品验收");
  });

  it("工作流快照拒绝范围伪装和状态资料不一致", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    const snapshot = requirement.toSnapshot();

    expect(() =>
      RequirementWorkflow.fromSnapshot({
        ...snapshot,
        requirementKey: "99999999-9999-4999-8999-999999999999",
      }),
    ).toThrow("需求工作流快照");
    expect(() =>
      RequirementWorkflow.fromSnapshot({
        ...snapshot,
        status: "completed",
      }),
    ).toThrow("需求工作流快照");
    expect(() =>
      RequirementWorkflow.fromSnapshot({
        ...snapshot,
        approvalRecords: [],
      }),
    ).toThrow("需求工作流快照");
  });

  it("工作流快照拒绝交付候选与验证证据不一致", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));
    const snapshot = requirement.toSnapshot();
    const tamperedHash = "f".repeat(64);

    expect(() =>
      RequirementWorkflow.fromSnapshot(
        {
          ...snapshot,
          deliveryCandidate: {
            ...snapshot.deliveryCandidate!,
            artifactHash: tamperedHash,
          },
          evidence: {
            ...snapshot.evidence!,
            artifactHash: tamperedHash,
          },
        },
        { evidenceAuthority },
      ),
    ).toThrow("需求工作流快照");
  });

  it("工作流快照拒绝验收记录与证据不一致且不保留契约外字段", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));
    requirement.accept({ actor });
    const snapshot = requirement.toSnapshot();
    const acceptance = snapshot.approvalRecords.find(
      (record) => record.action === "验收结果",
    )!;

    expect(() =>
      RequirementWorkflow.fromSnapshot(
        {
          ...snapshot,
          approvalRecords: snapshot.approvalRecords.map((record) =>
            record.action === "验收结果"
              ? {
                  ...record,
                  evidence: {
                    ...acceptance.evidence,
                    artifactHash: "e".repeat(64),
                  },
                }
              : record,
          ),
        },
        { evidenceAuthority },
      ),
    ).toThrow("需求工作流快照");

    const restored = RequirementWorkflow.fromSnapshot(snapshot, {
      evidenceAuthority,
    });
    expect(restored.toSnapshot().evidence).not.toHaveProperty("schemaVersion");
  });

  it("最终验收记录必须绑定完成时的当前需求版本", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.revise({
      summary: "访客提交预约后，由业主确认到访时间和通行范围",
      changedBy: "需求分析师",
    });
    requirement.submitForConfirmation();
    requirement.confirm({ actor });
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));
    requirement.accept({ actor });
    const snapshot = requirement.toSnapshot();

    expect(() =>
      RequirementWorkflow.fromSnapshot(
        {
          ...snapshot,
          approvalRecords: snapshot.approvalRecords.map((record) =>
            record.action === "验收结果" ? { ...record, revision: 1 } : record,
          ),
        },
        { evidenceAuthority },
      ),
    ).toThrow("需求工作流快照");
  });

  it("独立验证失败后仍可验真并恢复旧版本的验收历史", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));
    requirement.accept({ actor });

    requirement.recordVerificationFailure();
    const snapshot = requirement.toSnapshot();
    const restored = RequirementWorkflow.fromSnapshot(snapshot, {
      evidenceAuthority,
    });

    expect(restored.toPeopleView()).toMatchObject({
      version: "第 2 版",
      status: "内容已更新，等待重新确认",
    });
    expect(restored.listApprovalRecords()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "验收结果",
          revision: 1,
          evidence: expect.objectContaining({
            requirementRevision: 1,
            signature: expect.any(String),
            checks: expect.arrayContaining([
              expect.objectContaining({ status: "passed" }),
            ]),
          }),
        }),
      ]),
    );
    expect(restored.listAllowedActions()).toEqual(["submitForConfirmation"]);
    restored.submitForConfirmation();
    restored.confirm({ actor });
    restored.startDelivery();
    expect(restored.toSnapshot()).toMatchObject({
      status: "inDelivery",
      confirmedVersion: 2,
    });
  });

  it("恢复失败后的需求时拒绝伪造旧版本验收证据", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));
    requirement.accept({ actor });
    requirement.recordVerificationFailure();
    const snapshot = requirement.toSnapshot();

    expect(() =>
      RequirementWorkflow.fromSnapshot(
        {
          ...snapshot,
          approvalRecords: snapshot.approvalRecords.map((record) =>
            record.action === "验收结果"
              ? {
                  ...record,
                  evidence: {
                    ...record.evidence,
                    signature: Buffer.from("伪造签名").toString("base64"),
                  },
                }
              : record,
          ),
        },
        { evidenceAuthority },
      ),
    ).toThrow("需求工作流快照");
  });

  it("退役密钥不能签发新证据但仍可恢复已完成的历史需求", () => {
    const requirement = createRequirement();
    confirmRequirement(requirement);
    requirement.startDelivery();
    requirement.submitForAcceptance(createVerifiedEvidence(requirement));
    requirement.accept({ actor });
    const snapshot = requirement.toSnapshot();
    const historicalAuthority = createEvidenceAuthority([
      { ...trustedRunner, acceptNewEvidence: false },
    ]);

    const restored = RequirementWorkflow.fromSnapshot(snapshot, {
      evidenceAuthority: historicalAuthority,
    });

    expect(restored.toPeopleView().status).toBe("已完成");
    expect(restored.listApprovalRecords()).toHaveLength(2);
  });
});
