import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EvidenceAuthority,
  RequirementWorkflow,
  type EvidencePayload
} from "../src/index.js";

const secret = "independent-runner-secret-for-tests";

const createRequirement = () =>
  RequirementWorkflow.create({
    title: "访客预约",
    summary: "访客提交预约后，由业主确认到访时间",
    acceptanceCriteria: ["访客可以提交预约", "业主可以确认预约"]
  });

const actor = {
  actorKey: "user-product-owner",
  actorName: "产品负责人"
};

const sign = (payload: EvidencePayload, signingSecret = secret) =>
  createHmac("sha256", signingSecret)
    .update(EvidenceAuthority.canonicalPayload(payload))
    .digest("hex");

const enterDelivery = () => {
  const requirement = createRequirement();
  requirement.submitForConfirmation();
  requirement.confirm({
    actor,
    confirmedAt: new Date("2026-08-10T01:00:00Z")
  });
  requirement.startDelivery();
  return requirement;
};

describe("审批审计", () => {
  it("保存谁在何时确认了哪个需求版本", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();

    requirement.confirm({
      actor,
      confirmedAt: new Date("2026-08-10T01:00:00Z")
    });

    expect(requirement.listApprovalRecords()).toEqual([
      {
        action: "确认需求",
        actorKey: "user-product-owner",
        actorName: "产品负责人",
        requirementKey: requirement.internalKey,
        revision: 1,
        recordedAt: "2026-08-10T01:00:00.000Z"
      }
    ]);
  });

  it("修改需求后保留旧审批记录但要求重新确认", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    requirement.confirm({
      actor,
      confirmedAt: new Date("2026-08-10T01:00:00Z")
    });

    requirement.revise({
      summary: "访客提交预约后，由业主确认到访时间和通行范围",
      changedBy: "需求分析师"
    });

    expect(requirement.listApprovalRecords()).toHaveLength(1);
    expect(requirement.toPeopleView().status).toBe(
      "内容已更新，等待重新确认"
    );
  });
});

describe("独立验证证据", () => {
  it("证据绑定需求版本、提交、可信 Runner 和每条验收条件", () => {
    const requirement = enterDelivery();
    const target = requirement.getVerificationTarget();
    const payload: EvidencePayload = {
      schemaVersion: 1,
      evidenceKey: "evidence-visit-booking",
      requirementKey: target.requirementKey,
      requirementRevision: target.revision,
      commitSha: "a".repeat(40),
      runnerKey: "trusted-qa-runner",
      producedAt: "2026-08-10T01:30:00.000Z",
      artifactHash: "b".repeat(64),
      checks: target.acceptanceCriteria.map((criterion, index) => ({
        criterionKey: criterion.criterionKey,
        status: "passed" as const,
        testRunKey: `test-run-${index + 1}`
      }))
    };
    const authority = new EvidenceAuthority([
      {
        runnerKey: "trusted-qa-runner",
        runnerName: "独立测试 Runner",
        signingSecret: secret
      }
    ]);

    const receipt = authority.verify({ payload, signature: sign(payload) });
    requirement.submitForAcceptance(receipt);

    expect(requirement.toPeopleView()).toMatchObject({
      status: "等待产品验收",
      acceptanceProgress: "2 / 2 项已通过"
    });
  });

  it("拒绝开发 Agent 冒充独立 Runner", () => {
    const requirement = enterDelivery();
    const target = requirement.getVerificationTarget();
    const payload: EvidencePayload = {
      schemaVersion: 1,
      evidenceKey: "evidence-from-developer",
      requirementKey: target.requirementKey,
      requirementRevision: target.revision,
      commitSha: "a".repeat(40),
      runnerKey: "developer-agent",
      producedAt: "2026-08-10T01:30:00.000Z",
      artifactHash: "b".repeat(64),
      checks: target.acceptanceCriteria.map((criterion, index) => ({
        criterionKey: criterion.criterionKey,
        status: "passed" as const,
        testRunKey: `test-run-${index + 1}`
      }))
    };
    const authority = new EvidenceAuthority([
      {
        runnerKey: "trusted-qa-runner",
        runnerName: "独立测试 Runner",
        signingSecret: secret
      }
    ]);

    expect(() =>
      authority.verify({ payload, signature: sign(payload) })
    ).toThrow("证据执行者不是受信任的独立 Runner");
  });

  it("拒绝签名错误或验收条件不完整的证据", () => {
    const requirement = enterDelivery();
    const target = requirement.getVerificationTarget();
    const payload: EvidencePayload = {
      schemaVersion: 1,
      evidenceKey: "evidence-incomplete",
      requirementKey: target.requirementKey,
      requirementRevision: target.revision,
      commitSha: "a".repeat(40),
      runnerKey: "trusted-qa-runner",
      producedAt: "2026-08-10T01:30:00.000Z",
      artifactHash: "b".repeat(64),
      checks: [
        {
          criterionKey: target.acceptanceCriteria[0]!.criterionKey,
          status: "passed",
          testRunKey: "test-run-1"
        }
      ]
    };
    const authority = new EvidenceAuthority([
      {
        runnerKey: "trusted-qa-runner",
        runnerName: "独立测试 Runner",
        signingSecret: secret
      }
    ]);

    expect(() =>
      authority.verify({ payload, signature: "0".repeat(64) })
    ).toThrow("证据签名无效");

    const receipt = authority.verify({ payload, signature: sign(payload) });
    expect(() => requirement.submitForAcceptance(receipt)).toThrow(
      "验证证据没有覆盖全部验收条件"
    );
  });
});

