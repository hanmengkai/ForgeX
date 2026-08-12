import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signPayload,
} from "node:crypto";
import { resolve } from "node:path";

import { WORKER_REQUIREMENT_COMPLETION_SUMMARY } from "@forgex/contracts";
import { EvidenceAuthority } from "@forgex/domain";
import {
  loadPostgresMigrations,
  PostgresAccountRepository,
  runPostgresMigrations,
} from "@forgex/postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createProductionControlPlane } from "../src/production.js";
import {
  ControlPlaneRuntimeConfigSchema,
  type ControlPlaneRuntimeConfig,
} from "../src/runtime-config.js";

const databaseUrl = process.env.FORGEX_TEST_DATABASE_URL;
const integrationIt = databaseUrl ? it : it.skip;

const tenantKey = "11111111-1111-4111-8111-111111111111";
const bootstrapProjectKey = "22222222-2222-4222-8222-222222222222";
const bootstrapRepositoryKey = "33333333-3333-4333-8333-333333333333";
const actorKey = "44444444-4444-4444-8444-444444444444";
const runnerKey = "55555555-5555-4555-8555-555555555555";
const runnerKeyId = "66666666-6666-4666-8666-666666666666";
const peopleToken = "production-workflow-people-session";
const runnerToken = "production-workflow-runner-session";
const bootstrapPassword = "Acceptance-Password-2026!";
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const cookieValue = (setCookie: string | string[] | undefined): string => {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("登录响应没有返回 Cookie");
  return value.split(";", 1)[0]!;
};

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

const baseConfig = (
  projectKey: string,
  repositoryKey: string,
  runnerPublicKeyBase64?: string,
): ControlPlaneRuntimeConfig =>
  ControlPlaneRuntimeConfigSchema.parse({
    schemaVersion: 1,
    host: "127.0.0.1",
    port: 3000,
    sessionCookieSecure: false,
    projectKey,
    repositoryKey,
    sessions: [
      {
        tokenSha256: digest(peopleToken),
        principal: {
          actorKey,
          actorName: "端到端产品负责人",
          username: "acceptance.owner",
          tenantKey,
          roles: [
            "product_owner",
            "requirement_analyst",
            "developer",
            "administrator",
          ],
        },
      },
    ],
    runnerSessions: runnerPublicKeyBase64
      ? [
          {
            tokenSha256: digest(runnerToken),
            runner: { tenantKey, runnerKey, keyId: runnerKeyId },
          },
        ]
      : [],
    trustedRunners: runnerPublicKeyBase64
      ? [
          {
            runnerKey,
            keyId: runnerKeyId,
            runnerName: "真实 PostgreSQL 验收 Runner",
            publicKeyBase64: runnerPublicKeyBase64,
            scopes: [{ tenantKey, projectKey, repositoryKey }],
            acceptNewEvidence: true,
          },
        ]
      : [],
    skillEvaluators: [],
    mcpVerifiers: [],
  });

describe("真实 PostgreSQL 首版业务闭环", () => {
  integrationIt(
    "从平台配置、需求交付和独立验证推进到验收，重启后仍可恢复证据与状态",
    async () => {
      const parsedUrl = new URL(databaseUrl!);
      if (!parsedUrl.pathname.endsWith("_test")) {
        throw new Error(
          "FORGEX_TEST_DATABASE_URL 必须指向名称以 _test 结尾的隔离数据库",
        );
      }
      const schema = `forgex_workflow_it_${randomUUID().replaceAll("-", "")}`;
      const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema}`,
        max: 8,
      });
      const migrations = await loadPostgresMigrations(
        resolve("packages/postgres/migrations"),
      );
      const authRealmRevision = digest("production-workflow-auth-realm");
      const keyPair = generateKeyPairSync("ed25519");
      let app: ReturnType<typeof createProductionControlPlane> | undefined;
      try {
        await runPostgresMigrations(pool, migrations);
        await new PostgresAccountRepository(
          pool,
        ).ensureBootstrapAdministrator({
          tenantKey,
          username: "acceptance.admin",
          actorName: "验收超级管理员",
          password: bootstrapPassword,
        });

        app = createProductionControlPlane({
          config: baseConfig(bootstrapProjectKey, bootstrapRepositoryKey),
          authRealmRevision,
          migrations,
          pool,
          serviceVersion: "0.1.0-acceptance",
        });
        const passwordLogin = await app.inject({
          method: "POST",
          url: "/api/v1/session",
          headers: { "x-forgex-csrf": "1" },
          payload: {
            schemaVersion: 1,
            username: "acceptance.admin",
            password: bootstrapPassword,
          },
        });
        expect(passwordLogin.statusCode).toBe(200);
        expect(passwordLogin.headers["set-cookie"]).toContain("HttpOnly");

        const administratorHeaders = {
          authorization: `Bearer ${peopleToken}`,
          "x-forgex-csrf": "1",
        };
        const customer = await app.inject({
          method: "POST",
          url: "/api/v1/platform/customers",
          headers: administratorHeaders,
          payload: {
            schemaVersion: 1,
            name: "验收客户",
            summary: "用于验证 ForgeX 首版真实交付闭环",
          },
        });
        expect(customer.statusCode).toBe(201);
        const project = await app.inject({
          method: "POST",
          url: customer.json().data.links.actions.createProject,
          headers: administratorHeaders,
          payload: {
            schemaVersion: 1,
            name: "验收项目",
            summary: "在真实 PostgreSQL 上完成端到端交付",
          },
        });
        expect(project.statusCode).toBe(201);
        const repository = await app.inject({
          method: "POST",
          url: project.json().data.links.actions.createRepository,
          headers: administratorHeaders,
          payload: {
            schemaVersion: 1,
            name: "验收仓库",
            gitUrl: "https://gitee.com/example/acceptance.git",
            localPath: "/srv/forgex/acceptance",
            defaultBranch: "master",
          },
        });
        expect(repository.statusCode).toBe(201);
        const projectKey = project
          .json()
          .data.links.self.split("/")
          .at(-1) as string;
        const repositoryKey = repository
          .json()
          .data.links.self.split("/")
          .at(-1) as string;
        await app.close();

        const publicKeyBase64 = keyPair.publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64");
        const productionConfig = baseConfig(
          projectKey,
          repositoryKey,
          publicKeyBase64,
        );
        app = createProductionControlPlane({
          config: productionConfig,
          authRealmRevision,
          migrations,
          pool,
          serviceVersion: "0.1.0-acceptance",
        });
        const session = await app.inject({
          method: "POST",
          url: "/api/v1/session",
          headers: { authorization: `Bearer ${peopleToken}` },
        });
        expect(session.statusCode).toBe(200);
        const cookie = cookieValue(session.headers["set-cookie"]);
        const readHeaders = { cookie };
        const writeHeaders = { cookie, "x-forgex-csrf": "1" };

        const contexts = await app.inject({
          method: "GET",
          url: "/api/v1/requirement-contexts",
          headers: readHeaders,
        });
        const selectedRepository = contexts.json().data[0].projects[0]
          .repositories[0];
        const created = await app.inject({
          method: "POST",
          url: selectedRepository.links.actions.createRequirement,
          headers: writeHeaders,
          payload: {
            schemaVersion: 1,
            title: "访客在线预约",
            goal: "让访客能够填写必要信息并提交到访预约",
            userStories: [
              {
                role: "访客",
                need: "填写姓名和到访时间",
                value: "提前完成到访登记",
              },
            ],
            acceptanceCriteria: [
              {
                title: "访客可以提交预约",
                description: "填写姓名和到访时间后能够成功提交",
                priority: "must",
              },
            ],
            openQuestions: [],
          },
        });
        expect(created.statusCode).toBe(201);
        const requirementLocation = created.headers.location!;
        for (const action of ["submit-confirmation", "confirm"]) {
          const response = await app.inject({
            method: "POST",
            url: `${requirementLocation}/${action}`,
            headers: writeHeaders,
            payload: {},
          });
          expect(response.statusCode, action).toBe(200);
        }
        const delivery = await app.inject({
          method: "POST",
          url: `${requirementLocation}/start-delivery`,
          headers: writeHeaders,
          payload: { schemaVersion: 1, requiredCapabilities: ["typescript"] },
        });
        expect(delivery.statusCode).toBe(202);

        const enrollment = await app.inject({
          method: "POST",
          url: "/api/v1/worker-enrollments",
          headers: writeHeaders,
          payload: {
            schemaVersion: 1,
            deviceName: "验收设备",
            accountName: "验收 Codex 账户",
          },
        });
        expect(enrollment.statusCode).toBe(201);
        const exchanged = await app.inject({
          method: "POST",
          url: "/api/v1/worker-enrollments/exchange",
          payload: {
            schemaVersion: 1,
            enrollmentToken: enrollment.json().data.enrollmentToken,
            accountFingerprint: "f".repeat(64),
            capabilities: ["typescript"],
          },
        });
        expect(exchanged.statusCode).toBe(201);
        const connection = exchanged.json().data.connection;
        const poll = await app.inject({
          method: "POST",
          url: "/api/v1/worker-connection/poll",
          headers: workerHeaders(connection),
          payload: {},
        });
        expect(poll.statusCode).toBe(200);
        const assignment = poll.json().data.assignment;
        expect(assignment.execution.taskType).toBe("requirement_delivery");
        const completion = await app.inject({
          method: "POST",
          url: "/api/v1/worker-connection/complete",
          headers: workerHeaders(connection),
          payload: {
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
        });
        expect(completion.statusCode).toBe(200);

        const runnerHeaders = { authorization: `Runner ${runnerToken}` };
        const targets = await app.inject({
          method: "GET",
          url: "/api/v1/runner/verification-targets?limit=20",
          headers: runnerHeaders,
        });
        expect(targets.statusCode).toBe(200);
        expect(targets.json().data).toHaveLength(1);
        const target = targets.json().data[0];
        const html = Buffer.from(
          "<!doctype html><html><body><button>提交预约</button></body></html>",
          "utf8",
        );
        const artifactHash = createHash("sha256").update(html).digest("hex");
        const preview = await app.inject({
          method: "PUT",
          url: `/api/v1/runner/verification-targets/${target.requirementKey}/preview`,
          headers: runnerHeaders,
          payload: {
            schemaVersion: 1,
            requirementRevision: target.requirementRevision,
            artifactHashAlgorithm: "sha256",
            artifactHash,
            contentBase64: html.toString("base64"),
          },
        });
        expect(preview.statusCode).toBe(200);
        const evidencePayload = {
          schemaVersion: 1 as const,
          evidenceKey: randomUUID(),
          tenantKey,
          projectKey,
          repositoryKey,
          requirementKey: target.requirementKey,
          requirementRevision: target.requirementRevision,
          gitHashAlgorithm: target.gitHashAlgorithm,
          commitSha: target.commitSha,
          runnerKey,
          keyId: runnerKeyId,
          producedAt: new Date().toISOString(),
          artifactHashAlgorithm: "sha256" as const,
          artifactHash,
          checks: target.acceptanceCriteria.map(
            (criterion: { criterionKey: string }) => ({
              criterionKey: criterion.criterionKey,
              status: "passed" as const,
              testRunKey: "postgres-production-workflow-e2e",
            }),
          ),
        };
        const evidence = await app.inject({
          method: "POST",
          url: "/api/v1/runner/evidence",
          headers: runnerHeaders,
          payload: {
            payload: evidencePayload,
            signature: signPayload(
              null,
              Buffer.from(
                EvidenceAuthority.canonicalPayload(evidencePayload),
                "utf8",
              ),
              keyPair.privateKey,
            ).toString("base64"),
          },
        });
        expect(evidence.statusCode).toBe(200);
        expect(evidence.json().data.status).toBe("等待产品验收");
        const accepted = await app.inject({
          method: "POST",
          url: `${requirementLocation}/accept`,
          headers: writeHeaders,
          payload: {},
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json().data.status).toBe("已完成");
        await app.close();

        app = createProductionControlPlane({
          config: productionConfig,
          authRealmRevision,
          migrations,
          pool,
          serviceVersion: "0.1.0-acceptance",
        });
        const restored = await app.inject({
          method: "GET",
          url: requirementLocation,
          headers: readHeaders,
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json().data).toMatchObject({
          status: "已完成",
          acceptance: {
            verifiedBy: "真实 PostgreSQL 验收 Runner",
            checks: [{ title: "访客可以提交预约", status: "已通过" }],
          },
        });
        const logout = await app.inject({
          method: "DELETE",
          url: "/api/v1/session",
          headers: writeHeaders,
        });
        expect(logout.statusCode).toBe(204);
        const revoked = await app.inject({
          method: "GET",
          url: "/api/v1/session",
          headers: readHeaders,
        });
        expect(revoked.statusCode).toBe(401);
      } finally {
        await app?.close().catch(() => undefined);
        await pool.end();
        await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
        await adminPool.end();
      }
    },
    120_000,
  );
});
