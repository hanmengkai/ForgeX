import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapVerificationRunner,
  finalizeVerificationRunnerPlan,
  VerificationRunnerBootstrapInputSchema,
  VerificationSuitePlanSchema,
  verificationSuitePlanHash,
  type VerificationRunnerTarget,
  type VerificationSuitePlan,
} from "../src/index.js";

const roots: string[] = [];
const tenantKey = "10000000-0000-4000-8000-000000000001";
const projectKey = "20000000-0000-4000-8000-000000000002";
const repositoryKey = "30000000-0000-4000-8000-000000000003";

const fixture = async () => {
  const root = path.join(
    os.homedir(),
    `.forgex-runner-admin-${crypto.randomUUID()}`,
  );
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(root, 0o700);
  const repositoryRoot = path.join(root, "repository.git");
  const workspaceRoot = path.join(root, "workspaces");
  const outputDirectory = path.join(root, "runner");
  await Promise.all([
    mkdir(repositoryRoot, { mode: 0o700 }),
    mkdir(workspaceRoot, { mode: 0o700 }),
    mkdir(outputDirectory, { mode: 0o700 }),
  ]);
  const gitCommandPath = path.join(root, "git");
  const dockerCommandPath = path.join(root, "docker");
  await Promise.all([
    writeFile(gitCommandPath, "trusted-git", { mode: 0o700 }),
    writeFile(dockerCommandPath, "trusted-docker", { mode: 0o700 }),
  ]);
  return {
    root,
    outputDirectory,
    input: {
      schemaVersion: 1 as const,
      runnerName: "独立验证一号",
      controlPlaneUrl: "https://forgex.example.test",
      scope: { tenantKey, projectKey, repositoryKey },
      repositoryRoot,
      workspaceRoot,
      gitCommandPath,
      dockerCommandPath,
      containerUser: "65532:65532",
      idlePollIntervalMs: 3_000,
      requestTimeoutMs: 5_000,
    },
  };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("verification runner admin", () => {
  it("仓库内 bootstrap 与计划示例都符合管理协议", async () => {
    const [bootstrap, plan] = await Promise.all([
      readFile(
        path.resolve(
          "services/verification-runner/runner.bootstrap.example.json",
        ),
        "utf8",
      ),
      readFile(
        path.resolve("services/verification-runner/runner.plan.example.json"),
        "utf8",
      ),
    ]);

    expect(() =>
      VerificationRunnerBootstrapInputSchema.parse(JSON.parse(bootstrap)),
    ).not.toThrow();
    expect(() =>
      VerificationSuitePlanSchema.parse(JSON.parse(plan)),
    ).not.toThrow();
    expect(plan).toContain("/forgex-verifier/node-quality");
    expect(plan).toContain("sha256:");
  });

  it("在私有目录生成 Runner 密钥、会话和不含明文会话的控制面授权片段", async () => {
    const setup = await fixture();
    const generated = await bootstrapVerificationRunner(setup.input, {
      outputDirectory: setup.outputDirectory,
      assertPrivatePath: async () => undefined,
    });

    const [bootstrap, authority, session, privateKey] = await Promise.all([
      readFile(generated.bootstrapConfigPath, "utf8"),
      readFile(generated.controlPlaneFragmentPath, "utf8"),
      readFile(path.join(setup.outputDirectory, "session.key"), "utf8"),
      readFile(
        path.join(setup.outputDirectory, "evidence-ed25519.pem"),
        "utf8",
      ),
    ]);
    const authorityData = JSON.parse(authority) as {
      runnerSessions: Array<{ tokenSha256: string }>;
      trustedRunners: Array<{ publicKeyBase64: string }>;
    };

    expect(JSON.parse(bootstrap)).toMatchObject({
      plans: [],
      trustedPlanAnchors: [],
    });
    expect(authority).not.toContain(session.trim());
    expect(authorityData.runnerSessions[0]!.tokenSha256).toBe(
      createHash("sha256").update(session.trim(), "utf8").digest("hex"),
    );
    expect(
      authorityData.trustedRunners[0]!.publicKeyBase64.length,
    ).toBeGreaterThan(40);
    expect(privateKey).toContain("PRIVATE KEY");
    if (process.platform !== "win32") {
      expect((await stat(generated.bootstrapConfigPath)).mode & 0o077).toBe(0);
    }
  }, 20_000);

  it("重复 bootstrap 拒绝覆盖且不会删除既有私有材料", async () => {
    const setup = await fixture();
    const sessionPath = path.join(setup.outputDirectory, "session.key");
    await writeFile(sessionPath, "existing-session\n", { mode: 0o600 });

    await expect(
      bootstrapVerificationRunner(setup.input, {
        outputDirectory: setup.outputDirectory,
        assertPrivatePath: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(sessionPath, "utf8")).resolves.toBe(
      "existing-session\n",
    );
  }, 20_000);

  it("只为控制面当前待验证的精确目标生成完整计划摘要", async () => {
    const setup = await fixture();
    const generated = await bootstrapVerificationRunner(setup.input, {
      outputDirectory: setup.outputDirectory,
      assertPrivatePath: async () => undefined,
    });
    const target: VerificationRunnerTarget = {
      requirementKey: "60000000-0000-4000-8000-000000000006",
      requirementRevision: 2,
      repositoryKey,
      gitHashAlgorithm: "sha1",
      commitSha: "a".repeat(40),
      title: "访客预约",
      goal: "让访客可以提前预约",
      acceptanceCriteria: [
        {
          criterionKey: "70000000-0000-4000-8000-000000000007",
          title: "预约成功",
          description: "提交后可以看到预约结果",
          priority: "must",
        },
      ],
      previewArtifact: null,
    };
    const plan: VerificationSuitePlan = {
      schemaVersion: 1,
      planKey: "repository-integrity",
      planVersion: 1,
      repositoryKey,
      requirementKey: target.requirementKey,
      requirementRevision: target.requirementRevision,
      gitHashAlgorithm: target.gitHashAlgorithm,
      commitSha: target.commitSha,
      preview: { entryPath: ".forgex/preview.html" },
      suites: [
        {
          suiteKey: "integrity",
          name: "仓库完整性",
          criterionKeys: [target.acceptanceCriteria[0]!.criterionKey],
          execution: {
            image: `sha256:${"f".repeat(64)}`,
            command: ["/forgex-verifier/node-quality"],
            timeoutMs: 120_000,
          },
        },
      ],
    };
    const planPath = path.join(setup.outputDirectory, "plan.json");
    const outputPath = path.join(setup.outputDirectory, "runner.config.json");
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });

    await finalizeVerificationRunnerPlan(
      {
        bootstrapConfigPath: generated.bootstrapConfigPath,
        planPath,
        outputPath,
      },
      {
        listPending: async () => [target],
        assertPrivatePath: async () => undefined,
      },
    );

    const completed = JSON.parse(await readFile(outputPath, "utf8")) as {
      plans: VerificationSuitePlan[];
      trustedPlanAnchors: Array<{ planHash: string }>;
    };
    expect(completed.plans).toEqual([plan]);
    expect(completed.trustedPlanAnchors).toEqual([
      expect.objectContaining({ planHash: verificationSuitePlanHash(plan) }),
    ]);
  }, 20_000);

  it("目标已变化时拒绝写出可启动配置", async () => {
    const setup = await fixture();
    const generated = await bootstrapVerificationRunner(setup.input, {
      outputDirectory: setup.outputDirectory,
      assertPrivatePath: async () => undefined,
    });
    const planPath = path.join(setup.outputDirectory, "plan.json");
    const outputPath = path.join(setup.outputDirectory, "runner.config.json");
    await writeFile(
      planPath,
      JSON.stringify({
        schemaVersion: 1,
        planKey: "repository-integrity",
        planVersion: 1,
        repositoryKey,
        requirementKey: "60000000-0000-4000-8000-000000000006",
        requirementRevision: 1,
        gitHashAlgorithm: "sha1",
        commitSha: "a".repeat(40),
        preview: { entryPath: ".forgex/preview.html" },
        suites: [],
      }),
      { mode: 0o600 },
    );

    await expect(
      finalizeVerificationRunnerPlan(
        {
          bootstrapConfigPath: generated.bootstrapConfigPath,
          planPath,
          outputPath,
        },
        {
          listPending: async () => [],
          assertPrivatePath: async () => undefined,
        },
      ),
    ).rejects.toThrow();
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 20_000);
});
