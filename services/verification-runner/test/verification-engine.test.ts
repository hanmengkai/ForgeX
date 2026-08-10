import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FixedSuiteVerificationEngine,
  type VerificationRunnerTarget,
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

describe("FixedSuiteVerificationEngine", () => {
  it("只验证权威提交，以固定套件结果覆盖全部验收条件并生成确定性 Preview", async () => {
    const workspace = {
      prepare: vi.fn(async () => ({
        path: path.resolve("verification-workspaces", "run-a"),
        dispose: vi.fn(async () => Promise.resolve()),
      })),
    };
    const sandbox = {
      run: vi.fn(async () => ({
        suites: [
          { name: "单元测试", status: "passed" as const },
          { name: "生产构建", status: "passed" as const },
        ],
      })),
    };
    const engine = new FixedSuiteVerificationEngine({ workspace, sandbox });

    const first = await engine.verify(target);
    const second = await engine.verify(target);

    expect(workspace.prepare).toHaveBeenCalledWith({
      repositoryKey: target.repositoryKey,
      gitHashAlgorithm: target.gitHashAlgorithm,
      commitSha: target.commitSha,
    });
    expect(first.checks).toEqual([
      {
        criterionKey: target.acceptanceCriteria[0]!.criterionKey,
        status: "passed",
        testRunKey: expect.stringMatching(/^suite-[a-f0-9]{32}$/u),
      },
      {
        criterionKey: target.acceptanceCriteria[1]!.criterionKey,
        status: "passed",
        testRunKey: expect.stringMatching(/^suite-[a-f0-9]{32}$/u),
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
            { name: "单元测试", status: "failed" as const },
            { name: "生产构建", status: "passed" as const },
          ],
        })),
      },
    });

    await expect(engine.verify(target)).resolves.toMatchObject({
      checks: [
        { status: "failed" },
        { status: "failed" },
      ],
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
