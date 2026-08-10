import { describe, expect, it } from "vitest";

import { RequirementWorkflow } from "../src/index.js";

const createRequirement = () =>
  RequirementWorkflow.create({
    title: "访客预约",
    summary: "访客提交预约后，由业主确认到访时间",
    acceptanceCriteria: ["访客可以提交预约", "业主可以确认预约"]
  });

describe("RequirementWorkflow", () => {
  it("普通视图只提供业务信息和下一步提示", () => {
    const requirement = createRequirement();

    const view = requirement.toPeopleView();

    expect(view).toEqual({
      title: "访客预约",
      summary: "访客提交预约后，由业主确认到访时间",
      version: "第 1 版",
      status: "正在整理",
      nextStep: "完善内容后提交确认",
      acceptanceProgress: "尚未开始验证"
    });
    expect(view).not.toHaveProperty("id");
    expect(view).not.toHaveProperty("key");
    expect(view).not.toHaveProperty("code");
  });

  it("需求未经确认时不能开始交付", () => {
    const requirement = createRequirement();

    expect(() => requirement.startDelivery()).toThrow(
      "需求需要先由负责人确认，才能开始交付"
    );
  });

  it("确认当前版本后可以进入交付", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    requirement.confirm({
      confirmedBy: "产品负责人",
      confirmedAt: new Date("2026-08-10T01:00:00Z")
    });

    requirement.startDelivery();

    expect(requirement.toPeopleView().status).toBe("AI 正在实现");
  });

  it("已确认需求发生修改后必须重新确认", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    requirement.confirm({
      confirmedBy: "产品负责人",
      confirmedAt: new Date("2026-08-10T01:00:00Z")
    });

    requirement.revise({
      summary: "访客提交预约后，由业主确认到访时间和通行范围",
      changedBy: "需求分析师"
    });

    expect(requirement.toPeopleView()).toMatchObject({
      version: "第 2 版",
      status: "内容已更新，等待重新确认",
      nextStep: "请负责人确认最新版本"
    });
    expect(() => requirement.startDelivery()).toThrow(
      "需求需要先由负责人确认，才能开始交付"
    );
  });

  it("只有独立验证证据才能进入产品验收", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    requirement.confirm({
      confirmedBy: "产品负责人",
      confirmedAt: new Date("2026-08-10T01:00:00Z")
    });
    requirement.startDelivery();

    expect(() =>
      requirement.submitForAcceptance({
        passed: 2,
        total: 2,
        producedBy: "开发 Agent",
        independentlyVerified: false
      })
    ).toThrow("验证证据必须由独立执行者产生");

    requirement.submitForAcceptance({
      passed: 2,
      total: 2,
      producedBy: "独立测试 Runner",
      independentlyVerified: true
    });

    expect(requirement.toPeopleView()).toMatchObject({
      status: "等待产品验收",
      nextStep: "请体验 Preview 并确认结果",
      acceptanceProgress: "2 / 2 项已通过"
    });
  });

  it("验收完成后给出清晰结果", () => {
    const requirement = createRequirement();
    requirement.submitForConfirmation();
    requirement.confirm({
      confirmedBy: "产品负责人",
      confirmedAt: new Date("2026-08-10T01:00:00Z")
    });
    requirement.startDelivery();
    requirement.submitForAcceptance({
      passed: 2,
      total: 2,
      producedBy: "独立测试 Runner",
      independentlyVerified: true
    });

    requirement.accept({
      acceptedBy: "产品负责人",
      acceptedAt: new Date("2026-08-10T02:00:00Z")
    });

    expect(requirement.toPeopleView()).toMatchObject({
      status: "已完成",
      nextStep: "无需处理"
    });
  });
});

