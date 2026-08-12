import {
  createHash,
  createPrivateKey,
  randomUUID,
  sign as signPayload,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { WORKER_REQUIREMENT_COMPLETION_SUMMARY } from "@forgex/contracts";
import { EvidenceAuthority } from "@forgex/domain";

interface PostgresE2eFixture {
  username: string;
  password: string;
  tenantKey: string;
  projectKey: string;
  repositoryKey: string;
  runnerKey: string;
  keyId: string;
  runnerToken: string;
  runnerPrivateKeyPem: string;
}

const fixturePath = resolve("test-results/postgres-e2e-fixture.json");
const workerHeaders = (connection: {
  tenantKey: string;
  workerKey: string;
  sessionKey: string;
  generation: number;
}) => ({
  authorization: `Worker ${connection.sessionKey}`,
  "x-forgex-tenant-key": connection.tenantKey,
  "x-forgex-worker-key": connection.workerKey,
  "x-forgex-worker-generation": String(connection.generation),
});

test("真实 PostgreSQL 中从需求创建推进到独立验证和产品验收", async ({
  page,
}) => {
  const requirementName = `访客在线预约-${randomUUID().slice(0, 8)}`;
  const fixture = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as PostgresE2eFixture;
  await page.goto("/");
  await page.getByLabel("账号").fill(fixture.username);
  await page.getByLabel("密码").fill(fixture.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(
    page.getByRole("heading", { name: "ForgeX 运行总览" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "需求管理" }).click();
  await expect(page.getByLabel("当前客户")).toHaveValue("验收客户");
  await expect(page.getByLabel("当前项目")).toHaveValue("验收项目");
  await page.getByRole("button", { name: "新建需求" }).first().click();
  await page.getByLabel("需求名称").fill(requirementName);
  await page
    .getByLabel("希望解决什么问题？")
    .fill("让访客可以提前填写信息并提交到访预约");
  await page
    .getByLabel("谁会使用？")
    .fill("访客｜填写姓名和到访时间｜提前完成到访登记");
  await page.getByLabel("怎么才算完成？").fill("访客可以提交预约");
  await page.getByRole("button", { name: "保存并开始整理" }).click();
  await expect(page.getByText(requirementName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "提交确认" }).click();
  await page.getByRole("button", { name: "确认需求" }).click();
  await page.getByRole("button", { name: "安排 AI 开始实现" }).click();
  await expect(
    page.getByRole("heading", { name: "选择团队能力" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认并开始交付" }).click();
  await expect(page.getByText("AI 正在实现", { exact: true })).toBeVisible();

  const enrollment = await page.request.post("/api/v1/worker-enrollments", {
    headers: { "x-forgex-csrf": "1" },
    data: {
      schemaVersion: 1,
      deviceName: "浏览器验收设备",
      accountName: "浏览器验收 Codex",
    },
  });
  expect(enrollment.status()).toBe(201);
  const enrollmentBody = await enrollment.json();
  const exchanged = await page.request.post(
    "/api/v1/worker-enrollments/exchange",
    {
      data: {
        schemaVersion: 1,
        enrollmentToken: enrollmentBody.data.enrollmentToken,
        accountFingerprint: "f".repeat(64),
        capabilities: ["typescript"],
      },
    },
  );
  expect(exchanged.status()).toBe(201);
  const connection = (await exchanged.json()).data.connection;
  const poll = await page.request.post("/api/v1/worker-connection/poll", {
    headers: workerHeaders(connection),
    data: {},
  });
  expect(poll.status()).toBe(200);
  const assignment = (await poll.json()).data.assignment;
  expect(assignment.execution.taskType).toBe("requirement_delivery");
  const completed = await page.request.post(
    "/api/v1/worker-connection/complete",
    {
      headers: workerHeaders(connection),
      data: {
        schemaVersion: 1,
        assignmentKey: assignment.assignmentKey,
        fencingToken: assignment.fencingToken,
        projectKey: assignment.projectKey,
        repositoryKey: assignment.execution.repositoryKey,
        requirementKey: assignment.requirementKey,
        requirementRevision: assignment.requirementRevision,
        gitHashAlgorithm: "sha1",
        baseCommit: "a".repeat(40),
        commitSha: "b".repeat(40),
        branchName: `forgex/${assignment.projectKey.slice(0, 8)}/${assignment.assignmentKey}`,
        summary: WORKER_REQUIREMENT_COMPLETION_SUMMARY,
      },
    },
  );
  expect(completed.status()).toBe(200);

  const runnerHeaders = {
    authorization: `Runner ${fixture.runnerToken}`,
  };
  const targets = await page.request.get(
    "/api/v1/runner/verification-targets?limit=20",
    { headers: runnerHeaders },
  );
  expect(targets.status()).toBe(200);
  const target = (await targets.json()).data[0];
  const html = Buffer.from(
    "<!doctype html><html><body><button>提交预约</button></body></html>",
    "utf8",
  );
  const artifactHash = createHash("sha256").update(html).digest("hex");
  const preview = await page.request.put(
    `/api/v1/runner/verification-targets/${target.requirementKey}/preview`,
    {
      headers: runnerHeaders,
      data: {
        schemaVersion: 1,
        requirementRevision: target.requirementRevision,
        artifactHashAlgorithm: "sha256",
        artifactHash,
        contentBase64: html.toString("base64"),
      },
    },
  );
  expect(preview.status()).toBe(200);
  const payload = {
    schemaVersion: 1 as const,
    evidenceKey: randomUUID(),
    tenantKey: fixture.tenantKey,
    projectKey: fixture.projectKey,
    repositoryKey: fixture.repositoryKey,
    requirementKey: target.requirementKey,
    requirementRevision: target.requirementRevision,
    gitHashAlgorithm: target.gitHashAlgorithm,
    commitSha: target.commitSha,
    runnerKey: fixture.runnerKey,
    keyId: fixture.keyId,
    producedAt: new Date().toISOString(),
    artifactHashAlgorithm: "sha256" as const,
    artifactHash,
    checks: target.acceptanceCriteria.map(
      (criterion: { criterionKey: string }) => ({
        criterionKey: criterion.criterionKey,
        status: "passed" as const,
        testRunKey: "playwright-postgres-e2e",
      }),
    ),
  };
  const evidence = await page.request.post("/api/v1/runner/evidence", {
    headers: runnerHeaders,
    data: {
      payload,
      signature: signPayload(
        null,
        Buffer.from(EvidenceAuthority.canonicalPayload(payload), "utf8"),
        createPrivateKey(fixture.runnerPrivateKeyPem),
      ).toString("base64"),
    },
  });
  expect(evidence.status()).toBe(200);

  await page.reload();
  await page
    .getByRole("button", { name: `查看${requirementName}详情` })
    .click();
  await expect(page.getByText("独立验证已通过")).toBeVisible();
  const previewPagePromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "打开效果预览" }).click();
  const previewPage = await previewPagePromise;
  await previewPage.waitForURL(/\/preview$/u);
  await expect(
    previewPage
      .frameLocator('iframe[title="与已验证提交绑定的产品效果"]')
      .getByRole("button", { name: "提交预约" }),
  ).toBeVisible();
  await previewPage.close();
  await page.getByRole("button", { name: "确认验收通过" }).click();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(requirementName, { exact: true })).toBeVisible();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByLabel("账号")).toBeVisible();
});
