import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FixedSuiteVerificationEngine,
  VerificationSuitePlanSchema,
  verificationSuitePlanHash,
  type VerificationRunnerTarget,
  type VerificationSuitePlan,
} from "../src/index.js";

const target: VerificationRunnerTarget = {
  requirementKey: "60000000-0000-4000-8000-000000000006",
  requirementRevision: 2,
  repositoryKey: "30000000-0000-4000-8000-000000000003",
  gitHashAlgorithm: "sha1",
  commitSha: "a".repeat(40),
  title: "访客 <script>alert(1)</script> 预约",
  goal: "让访客可以提前预约并看到确认结果",
  acceptanceCriteria: [
    {
      criterionKey: "70000000-0000-4000-8000-000000000007",
      title: "预约成功",
      description: "提交后可以看到预约结果",
      priority: "must",
    },
    {
      criterionKey: "71000000-0000-4000-8000-000000000007",
      title: "失败可理解",
      description: "失败时显示用户可以理解的说明",
      priority: "should",
    },
  ],
  previewArtifact: null,
};

const plan = (
  suites: VerificationSuitePlan["suites"],
): VerificationSuitePlan => ({
  schemaVersion: 1,
  planKey: "project-node-v1",
  planVersion: 1,
  repositoryKey: target.repositoryKey,
  requirementKey: target.requirementKey,
  requirementRevision: target.requirementRevision,
  gitHashAlgorithm: target.gitHashAlgorithm,
  commitSha: target.commitSha,
  suites,
});

const anchorFor = (trustedPlan: VerificationSuitePlan) => ({
  repositoryKey: trustedPlan.repositoryKey,
  planKey: trustedPlan.planKey,
  planVersion: trustedPlan.planVersion,
  planHash: verificationSuitePlanHash(trustedPlan),
});

describe("FixedSuiteVerificationEngine", () => {
  it("验证计划摘要绑定实际容器镜像、命令和超时", () => {
    const candidate = {
      ...plan([]),
      suites: [
        {
          suiteKey: "unit",
          name: "单元测试",
          criterionKeys: target.acceptanceCriteria.map(
            (criterion) => criterion.criterionKey,
          ),
          execution: {
            image: `registry.example.test/forgex/node@sha256:${"a".repeat(64)}`,
            command: ["npm", "test", "--", "--runInBand"],
            timeoutMs: 120_000,
          },
        },
      ],
    };
    const first = VerificationSuitePlanSchema.safeParse(candidate);
    expect(first.success).toBe(true);
    if (!first.success) return;
    const changed = VerificationSuitePlanSchema.parse({
      ...candidate,
      suites: candidate.suites.map((suite) => ({
        ...suite,
        execution: {
          ...suite.execution,
          command: ["npm", "run", "fake-pass"],
        },
      })),
    });

    expect(verificationSuitePlanHash(first.data)).not.toBe(
      verificationSuitePlanHash(changed),
    );
  });

  it("只验证权威提交，以固定套件结果覆盖全部验收条件并生成确定性 Preview", async () => {
    const trustedPlan = plan([
      {
        suiteKey: "unit",
        name: "单元测试",
        criterionKeys: [target.acceptanceCriteria[0]!.criterionKey],
      },
      {
        suiteKey: "build",
        name: "生产构建",
        criterionKeys: [target.acceptanceCriteria[1]!.criterionKey],
      },
    ]);
    const workspace = {
      prepare: vi.fn(async () => ({
        path: path.resolve("verification-workspaces", "run-a"),
        dispose: vi.fn(async () => Promise.resolve()),
      })),
    };
    const sandbox = {
      run: vi.fn(async () => ({
        suites: [
          { suiteKey: "unit", status: "passed" as const },
          { suiteKey: "build", status: "passed" as const },
        ],
      })),
    };
    const planProvider = {
      planFor: vi.fn(async () => trustedPlan),
    };
    const engine = new FixedSuiteVerificationEngine({
      workspace,
      sandbox,
      planProvider,
      trustedPlanAnchors: [anchorFor(trustedPlan)],
    });

    const first = await engine.verify(target);
    const second = await engine.verify(target);

    expect(workspace.prepare).toHaveBeenCalledWith({
      repositoryKey: target.repositoryKey,
      gitHashAlgorithm: target.gitHashAlgorithm,
      commitSha: target.commitSha,
    });
    expect(planProvider.planFor).toHaveBeenCalledWith(target);
    expect(first.checks).toEqual([
      {
        criterionKey: target.acceptanceCriteria[0]!.criterionKey,
        status: "passed",
        testRunKey: expect.stringMatching(
          /^plan-[a-z0-9._-]+-v\d+-[a-f0-9]{64}-result-[a-f0-9]{64}$/u,
        ),
      },
      {
        criterionKey: target.acceptanceCriteria[1]!.criterionKey,
        status: "passed",
        testRunKey: expect.stringMatching(
          /^plan-[a-z0-9._-]+-v\d+-[a-f0-9]{64}-result-[a-f0-9]{64}$/u,
        ),
      },
    ]);
    expect(first.artifact).toEqual(second.artifact);
    const html = new TextDecoder().decode(first.artifact);
    expect(html).toContain("ForgeX 独立验证通过");
    expect(html).toContain("访客 &lt;script&gt;alert(1)&lt;/script&gt; 预约");
    expect(html).toContain("单元测试");
    expect(html).toContain("生产构建");
    expect(html).not.toContain(target.requirementKey);
    expect(html).not.toContain("<script>");
  });

  it("固定套件失败时逐项给出失败结果，且始终清理隔离工作区", async () => {
    const dispose = vi.fn(async () => Promise.resolve());
    const trustedPlan = plan([
      {
        suiteKey: "unit",
        name: "单元测试",
        criterionKeys: [target.acceptanceCriteria[0]!.criterionKey],
      },
      {
        suiteKey: "build",
        name: "生产构建",
        criterionKeys: [target.acceptanceCriteria[1]!.criterionKey],
      },
    ]);
    const engine = new FixedSuiteVerificationEngine({
      workspace: {
        prepare: vi.fn(async () => ({
          path: path.resolve("verification-workspaces", "run-b"),
          dispose,
        })),
      },
      sandbox: {
        run: vi.fn(async () => ({
          suites: [
            { suiteKey: "unit", status: "failed" as const },
            { suiteKey: "build", status: "passed" as const },
          ],
        })),
      },
      planProvider: {
        planFor: vi.fn(async () => trustedPlan),
      },
      trustedPlanAnchors: [anchorFor(trustedPlan)],
    });

    await expect(engine.verify(target)).resolves.toMatchObject({
      checks: [{ status: "failed" }, { status: "passed" }],
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("拒绝缺少验收条件绑定或返回未知套件的验证计划", async () => {
    const incompletePlan = plan([
      {
        suiteKey: "unit",
        name: "单元测试",
        criterionKeys: [target.acceptanceCriteria[0]!.criterionKey],
      },
    ]);
    const engine = new FixedSuiteVerificationEngine({
      workspace: {
        prepare: vi.fn(async () => ({
          path: path.resolve("verification-workspaces", "run-c"),
          dispose: vi.fn(async () => Promise.resolve()),
        })),
      },
      sandbox: {
        run: vi.fn(async () => ({
          suites: [{ suiteKey: "smuggled", status: "passed" as const }],
        })),
      },
      planProvider: {
        planFor: vi.fn(async () => incompletePlan),
      },
      trustedPlanAnchors: [anchorFor(incompletePlan)],
    });

    await expect(engine.verify(target)).rejects.toThrow();
  });

  it("拒绝同一计划身份在后续调用中改变套件与验收条件映射", async () => {
    let invocation = 0;
    const originalPlan = plan([
      {
        suiteKey: "unit",
        name: "单元测试",
        criterionKeys: target.acceptanceCriteria.map(
          (criterion) => criterion.criterionKey,
        ),
      },
    ]);
    const smuggledPlan = plan([
      {
        suiteKey: "trivial",
        name: "空壳检查",
        criterionKeys: target.acceptanceCriteria.map(
          (criterion) => criterion.criterionKey,
        ),
      },
    ]);
    const engine = new FixedSuiteVerificationEngine({
      workspace: {
        prepare: vi.fn(async () => ({
          path: path.resolve("verification-workspaces", "run-d"),
          dispose: vi.fn(async () => Promise.resolve()),
        })),
      },
      sandbox: {
        run: vi.fn(async ({ plan }) => ({
          suites: plan.suites.map(
            (suite: VerificationSuitePlan["suites"][number]) => ({
              suiteKey: suite.suiteKey,
              status: "passed" as const,
            }),
          ),
        })),
      },
      planProvider: {
        planFor: vi.fn(async () => {
          invocation += 1;
          return invocation === 1 ? originalPlan : smuggledPlan;
        }),
      },
      trustedPlanAnchors: [anchorFor(originalPlan)],
    });

    await expect(engine.verify(target)).resolves.toBeDefined();
    await expect(engine.verify(target)).rejects.toThrow("计划");
  });

  it("拒绝把一个仓库的可信计划用于另一个仓库", async () => {
    const trustedPlan = plan([
      {
        suiteKey: "unit",
        name: "单元测试",
        criterionKeys: target.acceptanceCriteria.map(
          (criterion) => criterion.criterionKey,
        ),
      },
    ]);
    const engine = new FixedSuiteVerificationEngine({
      workspace: {
        prepare: vi.fn(async () => ({
          path: path.resolve("verification-workspaces", "run-e"),
          dispose: vi.fn(async () => Promise.resolve()),
        })),
      },
      sandbox: {
        run: vi.fn(async () => ({
          suites: [{ suiteKey: "unit", status: "passed" as const }],
        })),
      },
      planProvider: { planFor: vi.fn(async () => trustedPlan) },
      trustedPlanAnchors: [anchorFor(trustedPlan)],
    });

    await expect(
      engine.verify({
        ...target,
        repositoryKey: "31000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toThrow("权威提交");
  });
});
