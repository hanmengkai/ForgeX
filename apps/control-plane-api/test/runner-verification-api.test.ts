import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  InMemoryExtensionCatalogRepository,
  InMemoryKnowledgeBaseRepository,
  InMemoryMcpInputSchemaStore,
  InMemoryMcpInvocationRepository,
  InMemoryMcpRegistryRepository,
  InMemoryPreviewArtifactStore,
  InMemoryRequirementRepository,
  InMemorySkillArtifactStore,
  InMemorySkillRegistryRepository,
  InMemoryWorkerFleetRepository,
  type AuthenticatedPrincipal,
  type DeliveryRunResult,
  type RunnerSessionAuthenticator,
  type SessionAuthenticator,
} from "@forgex/application";
import { RequirementSpecSchema, type EvidencePayload } from "@forgex/contracts";
import { EvidenceAuthority, RequirementWorkflow } from "@forgex/domain";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";

import { buildControlPlaneApi } from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const repositoryKey = "33333333-3333-4333-8333-333333333333";
const runnerKey = "44444444-4444-4444-8444-444444444444";
const keyId = "55555555-5555-4555-8555-555555555555";
const owner: AuthenticatedPrincipal = {
  actorKey: "66666666-6666-4666-8666-666666666666",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner"],
};
const spec = RequirementSpecSchema.parse({
  schemaVersion: 1,
  title: "访客预约",
  goal: "让访客可以在线预约到访",
  userStories: [],
  acceptanceCriteria: [
    {
      title: "访客可以提交预约",
      description: "填写姓名和到访时间后能够成功提交",
      priority: "must",
    },
  ],
  openQuestions: [],
});
const keyPair = generateKeyPairSync("ed25519");

const arrange = async () => {
  let now = new Date("2026-08-11T03:00:00.000Z");
  const clock = () => new Date(now.getTime());
  const requirementRepository = new InMemoryRequirementRepository();
  const previewArtifactStore = new InMemoryPreviewArtifactStore();
  const workflow = RequirementWorkflow.createFromSpec(spec, {
    tenantKey,
    projectKey,
    clock,
  });
  workflow.submitForConfirmation();
  workflow.confirm({
    actor: { actorKey: owner.actorKey, actorName: owner.actorName },
  });
  workflow.startDelivery();
  const requirementKey = workflow.internalKey;
  const run: DeliveryRunResult = {
    tenantKey,
    projectKey,
    repositoryKey,
    requirementKey,
    requirementRevision: 1,
    assignmentKey: "77777777-7777-4777-8777-777777777777",
    fencingToken: 4,
    gitHashAlgorithm: "sha1",
    baseCommit: "a".repeat(40),
    commitSha: "b".repeat(40),
    branchName: `forgex/${projectKey.slice(0, 8)}/77777777-7777-4777-8777-777777777777`,
    summary: "已生成本地提交，等待独立验证",
    status: "completed",
    submittedAt: "2026-08-11T02:50:00.000Z",
    completedAt: "2026-08-11T02:55:00.000Z",
  };
  await requirementRepository.transaction(
    tenantKey,
    projectKey,
    (transaction) => {
      transaction.save({
        tenantKey,
        projectKey,
        requirementKey,
        createdAt: "2026-08-11T02:00:00.000Z",
        spec,
        workflow,
      });
      transaction.saveDeliveryRunResult(run);
    },
  );
  const evidenceAuthority = new EvidenceAuthority({
    runners: [
      {
        runnerKey,
        keyId,
        runnerName: "独立验证 Runner",
        publicKeyBase64: keyPair.publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
        scopes: [{ tenantKey, projectKey, repositoryKey }],
      },
    ],
    clock,
    maxEvidenceAgeMs: 60 * 60 * 1_000,
    maxFutureSkewMs: 60_000,
  });
  const runnerAuthenticator: RunnerSessionAuthenticator = {
    authenticate: async (authorization) =>
      authorization === "Runner runner-session"
        ? { tenantKey, runnerKey, keyId }
        : null,
  };
  const authenticator: SessionAuthenticator = {
    authenticate: async (authorization) =>
      authorization === "Bearer owner-session" ? owner : null,
  };
  const app = buildControlPlaneApi({
    authenticator,
    runnerAuthenticator,
    evidenceAuthority,
    extensionCatalogRepository: new InMemoryExtensionCatalogRepository(),
    knowledgeBaseRepository: new InMemoryKnowledgeBaseRepository(),
    mcpHealthAuthority: new McpHealthAuthority({ verifiers: [] }),
    mcpInputSchemaStore: new InMemoryMcpInputSchemaStore(),
    mcpInvocationRepository: new InMemoryMcpInvocationRepository(),
    mcpRegistryRepository: new InMemoryMcpRegistryRepository(),
    skillArtifactStore: new InMemorySkillArtifactStore(),
    skillEvaluationAuthority: new SkillEvaluationAuthority({ evaluators: [] }),
    skillRegistryRepository: new InMemorySkillRegistryRepository(),
    requirementRepository,
    previewArtifactStore,
    workerFleetRepository: new InMemoryWorkerFleetRepository(),
    projectKey,
    repositoryKey,
    clock,
  });
  return {
    app,
    workflow,
    run,
    advanceTo: (value: string) => {
      now = new Date(value);
    },
  };
};

describe("独立验证 Runner API", () => {
  it("在解析请求体前拒绝无效 Runner 会话", async () => {
    const { app } = await arrange();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runner/evidence",
      headers: {
        authorization: "Runner invalid-session",
        "content-type": "application/json",
      },
      payload: "{broken-json",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_runner_session",
        message: "Runner 连接已经失效，请重新连接",
      },
    });
    await app.close();
  });

  it("完成验证任务读取、Preview 上传、签名证据提交和页面验收展示", async () => {
    const { app, workflow, run, advanceTo } = await arrange();
    const headers = { authorization: "Runner runner-session" };

    const targets = await app.inject({
      method: "GET",
      url: "/api/v1/runner/verification-targets?limit=20",
      headers,
    });
    expect(targets.statusCode).toBe(200);
    expect(targets.json()).toEqual({
      data: [
        expect.objectContaining({
          requirementKey: run.requirementKey,
          repositoryKey,
          commitSha: run.commitSha,
          title: spec.title,
        }),
      ],
      meta: { count: 1 },
    });

    const html = Buffer.from(
      "<!doctype html><html><body>访客预约已可使用</body></html>",
      "utf8",
    );
    const artifactHash = createHash("sha256").update(html).digest("hex");
    const artifact = await app.inject({
      method: "PUT",
      url: `/api/v1/runner/verification-targets/${run.requirementKey}/preview`,
      headers,
      payload: {
        schemaVersion: 1,
        requirementRevision: 1,
        artifactHashAlgorithm: "sha256",
        artifactHash,
        contentBase64: html.toString("base64"),
      },
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.json()).toEqual({
      data: { status: "preview_recorded", requirementRevision: 1 },
    });

    advanceTo("2026-08-11T03:01:00.000Z");
    const criterionKey =
      workflow.toSnapshot().revisions[0]!.acceptanceCriteria[0]!.criterionKey;
    const payload: EvidencePayload = {
      schemaVersion: 1,
      evidenceKey: randomUUID(),
      tenantKey,
      projectKey,
      repositoryKey,
      requirementKey: run.requirementKey,
      requirementRevision: 1,
      gitHashAlgorithm: "sha1",
      commitSha: run.commitSha,
      runnerKey,
      keyId,
      producedAt: "2026-08-11T03:01:00.000Z",
      artifactHashAlgorithm: "sha256",
      artifactHash,
      checks: [{ criterionKey, status: "passed", testRunKey: "runner-api-1" }],
    };
    const evidence = await app.inject({
      method: "POST",
      url: "/api/v1/runner/evidence",
      headers,
      payload: {
        payload,
        signature: signPayload(
          null,
          Buffer.from(EvidenceAuthority.canonicalPayload(payload), "utf8"),
          keyPair.privateKey,
        ).toString("base64"),
      },
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json()).toEqual({
      data: {
        status: "等待产品验收",
        acceptanceProgress: "1 / 1 项已通过",
      },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${run.requirementKey}`,
      headers: { authorization: "Bearer owner-session" },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({
      status: "等待产品验收",
      acceptance: {
        verifiedBy: "独立验证 Runner",
        checks: [{ title: "访客可以提交预约", status: "已通过" }],
      },
      links: {
        preview: `/api/v1/requirements/${run.requirementKey}/preview`,
        actions: {
          accept: `/api/v1/requirements/${run.requirementKey}/accept`,
        },
      },
    });
    await app.close();
  });

  it("接收 Runner 的缺计划报告并在需求进度中立即展示", async () => {
    const { app, run } = await arrange();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runner/verification-targets/${run.requirementKey}/blocker`,
      headers: { authorization: "Runner runner-session" },
      payload: {
        schemaVersion: 1,
        requirementKey: run.requirementKey,
        requirementRevision: run.requirementRevision,
        reason: "trusted_plan_missing",
        reportedAt: "2026-08-11T03:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        status: "verification_blocked_recorded",
        requirementRevision: 1,
      },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${run.requirementKey}`,
      headers: { authorization: "Bearer owner-session" },
    });
    expect(detail.json().data.progress).toMatchObject({
      currentStage: "等待可信验证计划",
      stages: expect.arrayContaining([
        expect.objectContaining({
          key: "verification",
          detail:
            "当前交付提交没有匹配的可信验证计划，请配置后等待 Runner 自动继续",
        }),
      ]),
    });
    await app.close();
  });

  it("通过 Runner 专用路由持久上报失败并移出待验证队列", async () => {
    const { app, workflow, run } = await arrange();
    const criterionKey =
      workflow.toSnapshot().revisions[0]!.acceptanceCriteria[0]!.criterionKey;
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runner/verification-targets/${run.requirementKey}/failure`,
      headers: { authorization: "Runner runner-session" },
      payload: {
        schemaVersion: 1,
        requirementKey: run.requirementKey,
        requirementRevision: run.requirementRevision,
        verificationCompletedAt: "2026-08-11T03:00:00.000Z",
        checks: [
          {
            criterionKey,
            status: "failed",
            testRunKey: "trusted-plan-v1-suite-failed",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        status: "verification_failed_recorded",
        requirementRevision: 1,
      },
    });
    const pending = await app.inject({
      method: "GET",
      url: "/api/v1/runner/verification-targets?limit=20",
      headers: { authorization: "Runner runner-session" },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ data: [], meta: { count: 0 } });
    await app.close();
  });
});
