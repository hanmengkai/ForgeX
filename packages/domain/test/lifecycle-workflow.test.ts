import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
  LifecycleRole,
  LifecycleCapability,
} from "@forgex/contracts/lifecycle";

import { LifecycleWorkflow } from "../src/lifecycle-workflow.js";

const devExecutor = randomUUID();
const testExecutor = randomUUID();
const stagingExecutor = randomUUID();
const productionExecutor = randomUUID();
const digest = "a".repeat(64);
const commit = "b".repeat(40);
const actor = (role: LifecycleRole, key = randomUUID()) => ({
  actorKey: key,
  actorName: role,
  roles: [role],
});
const requester = actor("requester");
const product = actor("product_owner");
const developer = actor("developer");
const tester = actor("tester");
const ops = actor("production_ops");
const scope = {
  tenantKey: randomUUID(),
  projectKey: randomUUID(),
  repositoryKey: randomUUID(),
};
const create = () =>
  LifecycleWorkflow.create({
    ...scope,
    requesterKey: requester.actorKey,
    title: "访客预约",
    brief: "访客能够提交预约并获得预约编号",
    createdBy: requester.actorKey,
  });
const output = (stage: string) => {
  if (stage === "requirements_ai")
    return {
      kind: "requirements" as const,
      summary: "已整理需求",
      spec: {
        schemaVersion: 1 as const,
        title: "访客预约",
        goal: "提交预约并获得编号",
        userStories: [{ role: "访客", need: "提交预约", value: "安排到访" }],
        acceptanceCriteria: [
          {
            title: "提交预约返回编号",
            description: "有效数据返回预约编号",
            priority: "must" as const,
          },
        ],
        openQuestions: [],
      },
    };
  if (stage === "design_ai")
    return {
      kind: "design" as const,
      summary: "已完成设计",
      architecture: "预约 API 与持久化存储",
      interfaces: ["POST /appointments"],
      migrations: [],
      testStrategy: ["真实提交后检查数据库记录"],
      rolloutPlan: "使用同一制品部署两个隔离环境",
    };
  if (stage === "development")
    return {
      kind: "code" as const,
      summary: "代码及自测通过",
      commitSha: commit,
      artifactDigest: digest,
      selfTests: [{ name: "预约自测", passed: true }],
    };
  if (stage === "testing")
    return {
      kind: "tests" as const,
      summary: "独立测试通过",
      commitSha: commit,
      artifactDigest: digest,
      checks: [{ criterionIndex: 0, name: "预约编号", passed: true }],
      planDigest: digest,
    };
  if (stage === "production_rollback")
    return {
      kind: "rollback" as const,
      summary: "已恢复上一版本",
      productionJobKey: "00000000-0000-4000-8000-000000000001",
      healthy: true,
    };
  return {
    kind: "deployment" as const,
    summary: "部署成功并通过健康检查",
    environment:
      stage === "staging_deploy"
        ? ("staging" as const)
        : ("production" as const),
    commitSha: commit,
    artifactDigest: digest,
    url: "http://127.0.0.1:19001",
    healthy: true,
    deploymentKey: randomUUID(),
  };
};
const finish = (flow: LifecycleWorkflow, executorKey = devExecutor) => {
  const job = flow.claim({
    executorKey,
    capabilities: [flow.toSnapshot().stage as LifecycleCapability],
    leaseMs: 60_000,
  });
  if (!job) throw new Error("没有待执行任务");
  flow.complete({
    jobKey: job.jobKey,
    fencingToken: job.fencingToken!,
    executorKey,
    inputDigest: job.inputDigest,
    result: { status: "succeeded", output: output(job.stage) },
  });
};
const approve = (
  flow: LifecycleWorkflow,
  person: ReturnType<typeof actor>,
  role: LifecycleRole = person.roles[0]!,
) =>
  flow.decide({
    actor: person,
    role,
    decision: "approve",
    reason: "已按本轮内容核对",
  });
const untilRelease = () => {
  const flow = create();
  finish(flow);
  approve(flow, product);
  approve(flow, requester);
  finish(flow);
  approve(flow, developer);
  finish(flow);
  approve(flow, developer);
  finish(flow, testExecutor);
  approve(flow, tester);
  finish(flow, stagingExecutor);
  approve(flow, requester);
  return flow;
};

describe("2.0 全生命周期", () => {
  it("开发自测失败、有效格式但覆盖不全的测试和错误环境健康结果都不能推进", () => {
    const flow = create();
    const requirementJob = flow.claim({
      executorKey: devExecutor,
      capabilities: ["requirements_ai"],
      leaseMs: 60_000,
    })!;
    const requirement = output("requirements_ai");
    if (requirement.kind !== "requirements") throw new Error("错误的测试资料");
    requirement.spec.acceptanceCriteria.push({
      title: "重复请求保持同一编号",
      description: "重复提交不会产生第二条预约",
      priority: "must",
    });
    flow.complete({
      jobKey: requirementJob.jobKey,
      executorKey: devExecutor,
      fencingToken: requirementJob.fencingToken!,
      inputDigest: requirementJob.inputDigest,
      result: { status: "succeeded", output: requirement },
    });
    approve(flow, product);
    approve(flow, requester);
    finish(flow);
    approve(flow, developer);
    const developmentJob = flow.claim({
      executorKey: devExecutor,
      capabilities: ["development"],
      leaseMs: 60_000,
    })!;
    const code = output("development");
    if (code.kind !== "code") throw new Error("错误的测试资料");
    expect(() =>
      flow.complete({
        jobKey: developmentJob.jobKey,
        executorKey: devExecutor,
        fencingToken: developmentJob.fencingToken!,
        inputDigest: developmentJob.inputDigest,
        result: {
          status: "succeeded",
          output: {
            ...code,
            selfTests: [{ name: "实际自测失败", passed: false }],
          },
        },
      }),
    ).toThrow("自测");
    flow.complete({
      jobKey: developmentJob.jobKey,
      executorKey: devExecutor,
      fencingToken: developmentJob.fencingToken!,
      inputDigest: developmentJob.inputDigest,
      result: { status: "succeeded", output: code },
    });
    approve(flow, developer);
    const testJob = flow.claim({
      executorKey: testExecutor,
      capabilities: ["testing"],
      leaseMs: 60_000,
    })!;
    const tests = output("testing");
    if (tests.kind !== "tests") throw new Error("错误的测试资料");
    const completeTests = (checks: typeof tests.checks) =>
      flow.complete({
        jobKey: testJob.jobKey,
        executorKey: testExecutor,
        fencingToken: testJob.fencingToken!,
        inputDigest: testJob.inputDigest,
        result: { status: "succeeded", output: { ...tests, checks } },
      });
    expect(() => completeTests(tests.checks)).toThrow("缺少验收条件覆盖");
    const covered = [
      ...tests.checks,
      { criterionIndex: 1, name: "重复请求", passed: true },
    ];
    expect(() =>
      completeTests([
        ...covered,
        { criterionIndex: 2, name: "不存在的条件", passed: true },
      ]),
    ).toThrow("不存在的验收条件");
    completeTests(covered);
    approve(flow, tester);
    const deploymentJob = flow.claim({
      executorKey: stagingExecutor,
      capabilities: ["staging_deploy"],
      leaseMs: 60_000,
    })!;
    const deployment = output("staging_deploy");
    if (deployment.kind !== "deployment") throw new Error("错误的测试资料");
    const completeDeployment = (
      healthy: boolean,
      environment: "production" | "staging",
    ) =>
      flow.complete({
        jobKey: deploymentJob.jobKey,
        executorKey: stagingExecutor,
        fencingToken: deploymentJob.fencingToken!,
        inputDigest: deploymentJob.inputDigest,
        result: {
          status: "succeeded",
          output: { ...deployment, healthy, environment },
        },
      });
    expect(() => completeDeployment(false, "staging")).toThrow("健康检查");
    expect(() => completeDeployment(true, "production")).toThrow("部署环境");
    expect(flow.toSnapshot().stage).toBe("staging_deploy");
  });
  it("包含独立设计审核，未审核不能直接领取开发任务", () => {
    const flow = create();
    finish(flow);
    approve(flow, product);
    approve(flow, requester);
    finish(flow);
    expect(flow.toSnapshot().stage).toBe("design_review");
    expect(
      flow.claim({
        executorKey: devExecutor,
        capabilities: ["development"],
        leaseMs: 60_000,
      }),
    ).toBeNull();
    flow.decide({
      actor: developer,
      role: "developer",
      decision: "reject",
      reason: "缺少幂等设计",
    });
    expect(flow.toSnapshot().stage).toBe("design_ai");
    expect(
      flow.toSnapshot().events.some((e) => e.detail.includes("缺少幂等设计")),
    ).toBe(true);
  });
  it("测试环境验收后仍需联合放行和三方线上验收才能关闭", () => {
    const flow = untilRelease();
    expect(flow.toSnapshot().stage).toBe("release_approval");
    approve(flow, developer);
    approve(flow, ops);
    expect(flow.toSnapshot().stage).toBe("release_approval");
    approve(flow, requester);
    finish(flow, productionExecutor);
    expect(flow.toSnapshot().stage).toBe("online_acceptance");
    approve(flow, ops);
    approve(flow, requester);
    expect(flow.toSnapshot().stage).toBe("online_acceptance");
    approve(flow, developer);
    expect(flow.toSnapshot().stage).toBe("closed");
    expect(LifecycleWorkflow.restore(flow.toSnapshot()).toSnapshot()).toEqual(
      flow.toSnapshot(),
    );
  });
  it("同一自然人不能代替三方批准", () => {
    const flow = untilRelease();
    approve(flow, developer);
    expect(() =>
      approve(
        flow,
        { ...developer, roles: ["developer", "production_ops"] },
        "production_ops",
      ),
    ).toThrow("不同");
  });
  it("开发执行器不能承担独立测试", () => {
    const flow = create();
    finish(flow);
    approve(flow, product);
    approve(flow, requester);
    finish(flow);
    approve(flow, developer);
    finish(flow);
    approve(flow, developer);
    expect(
      flow.claim({
        executorKey: devExecutor,
        capabilities: ["testing"],
        leaseMs: 60_000,
      }),
    ).toBeNull();
  });
  it("拒绝错误制品和缺少覆盖的测试结果", () => {
    const flow = create();
    finish(flow);
    approve(flow, product);
    approve(flow, requester);
    finish(flow);
    approve(flow, developer);
    finish(flow);
    approve(flow, developer);
    const job = flow.claim({
      executorKey: testExecutor,
      capabilities: ["testing"],
      leaseMs: 60_000,
    })!;
    const complete = (
      checks: Array<{ criterionIndex: number; name: string; passed: boolean }>,
      artifactDigest: string,
    ) =>
      flow.complete({
        jobKey: job.jobKey,
        fencingToken: job.fencingToken!,
        executorKey: testExecutor,
        inputDigest: job.inputDigest,
        result: {
          status: "succeeded",
          output: {
            kind: "tests",
            summary: "测试结果",
            commitSha: commit,
            artifactDigest,
            checks,
            planDigest: digest,
          },
        },
      });
    expect(() => complete([], digest)).toThrow();
    expect(() =>
      complete(
        [{ criterionIndex: 0, name: "预约", passed: true }],
        "c".repeat(64),
      ),
    ).toThrow("制品");
  });
  it("相同完成回调幂等，变化的完成回调冲突", () => {
    const flow = create();
    const job = flow.claim({
      executorKey: devExecutor,
      capabilities: ["requirements_ai"],
      leaseMs: 60_000,
    })!;
    const command = {
      jobKey: job.jobKey,
      fencingToken: job.fencingToken!,
      executorKey: devExecutor,
      inputDigest: job.inputDigest,
      result: { status: "succeeded" as const, output: output(job.stage) },
    };
    flow.complete(command);
    const version = flow.toSnapshot().version;
    flow.complete(command);
    expect(flow.toSnapshot().version).toBe(version);
    expect(() =>
      flow.complete({
        ...command,
        result: { status: "blocked", reason: "不同结果" },
      }),
    ).toThrow("冲突");
  });
  it("租约过期不能提交，故障需要显式恢复", () => {
    let now = Date.now();
    const flow = LifecycleWorkflow.create(
      {
        ...scope,
        requesterKey: requester.actorKey,
        title: "租约恢复",
        brief: "验证中断恢复行为",
        createdBy: requester.actorKey,
      },
      { clock: () => new Date(now) },
    );
    const job = flow.claim({
      executorKey: devExecutor,
      capabilities: ["requirements_ai"],
      leaseMs: 60_000,
    })!;
    now += 61_000;
    expect(() =>
      flow.complete({
        jobKey: job.jobKey,
        fencingToken: job.fencingToken!,
        executorKey: devExecutor,
        inputDigest: job.inputDigest,
        result: { status: "succeeded", output: output(job.stage) },
      }),
    ).toThrow("租约");
    flow.expireLease();
    expect(flow.toSnapshot().blockedReason).toBeTruthy();
  });
  it("测试验收驳回实施缺陷保留需求版本并使下游批准失效", () => {
    const flow = untilRelease();
    const initial = flow.toSnapshot();
    flow.decide({
      actor: requester,
      role: "requester",
      decision: "reject",
      reason: "重复点击产生两条记录",
      rework: "implementation",
    });
    const revised = flow.toSnapshot();
    expect(revised.stage).toBe("development");
    expect(revised.requirementVersion).toBe(initial.requirementVersion);
    expect(revised.current.tests).toBeUndefined();
    expect(revised.current.staging).toBeUndefined();
  });
  it("联合审批中的异议使已有批准失效，处理异议后仍需重新取得三方批准", () => {
    const flow = untilRelease();
    approve(flow, developer);
    flow.decide({
      actor: ops,
      role: "production_ops",
      decision: "object",
      reason: "恢复步骤尚未确认",
    });
    expect(flow.activeApprovals()).toHaveLength(0);
    expect(() => approve(flow, requester)).toThrow("未处理异议");
    const objection = flow.toSnapshot().objections.at(-1)!;
    flow.resolveObjection({
      actor: developer,
      objectionKey: objection.objectionKey,
      reason: "恢复步骤已经补充并共同确认",
    });
    approve(flow, requester);
    approve(flow, ops);
    expect(flow.toSnapshot().stage).toBe("release_approval");
    approve(flow, developer);
    expect(flow.toSnapshot().stage).toBe("production_deploy");
  });
  it("生产失败的重试重新取得三方审批，旧批准不能直接重复发布", () => {
    const flow = untilRelease();
    approve(flow, developer);
    approve(flow, ops);
    approve(flow, requester);
    const job = flow.claim({
      executorKey: productionExecutor,
      capabilities: ["production_deploy"],
      leaseMs: 60_000,
    })!;
    flow.complete({
      jobKey: job.jobKey,
      executorKey: productionExecutor,
      fencingToken: job.fencingToken!,
      inputDigest: job.inputDigest,
      result: { status: "failed", reason: "实际健康检查没有通过" },
    });
    expect(() => flow.retry({ actor: requester, reason: "尝试恢复" })).toThrow(
      "无权",
    );
    flow.retry({ actor: ops, reason: "已核对外部发布日志，准备重新批准" });
    expect(flow.toSnapshot().stage).toBe("release_approval");
    expect(flow.activeApprovals()).toHaveLength(0);
    expect(
      flow.claim({
        executorKey: productionExecutor,
        capabilities: ["production_deploy"],
        leaseMs: 60_000,
      }),
    ).toBeNull();
  });
  it("生产发布执行中不能取消租约并并行开始恢复", () => {
    const flow = untilRelease();
    approve(flow, developer);
    approve(flow, ops);
    approve(flow, requester);
    flow.claim({
      executorKey: productionExecutor,
      capabilities: ["production_deploy"],
      leaseMs: 60_000,
    });
    expect(() =>
      flow.requestRecovery({ actor: ops, reason: "生产发布执行中请求恢复" }),
    ).toThrow("执行中");
    expect(flow.toSnapshot().stage).toBe("production_deploy");
  });
});
