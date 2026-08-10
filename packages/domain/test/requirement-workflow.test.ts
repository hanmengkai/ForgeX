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
} from "./evidence-fixture.js";

const actor = {
  actorKey: "user-product-owner",
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
});
