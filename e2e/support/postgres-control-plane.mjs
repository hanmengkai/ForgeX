import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  loadPostgresMigrations,
  PostgresAccountRepository,
  runPostgresMigrations,
} from "@forgex/postgres";
import { Pool } from "pg";

import { createProductionControlPlane } from "../../apps/control-plane-api/dist/production.js";
import { ControlPlaneRuntimeConfigSchema } from "../../apps/control-plane-api/dist/runtime-config.js";

const databaseUrl = process.env.FORGEX_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error(
    "PostgreSQL E2E 只允许使用名称以 _test 结尾的 FORGEX_TEST_DATABASE_URL",
  );
}

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const repositoryKey = "33333333-3333-4333-8333-333333333333";
const runnerKey = "55555555-5555-4555-8555-555555555555";
const keyId = "66666666-6666-4666-8666-666666666666";
const customerKey = "77777777-7777-4777-8777-777777777777";
const username = "e2e.admin";
const password = "E2E-Password-2026!";
const runnerToken = "postgres-e2e-runner-session-with-enough-entropy";
const schema = `forgex_playwright_${randomUUID().replaceAll("-", "")}`;
const fixturePath = resolve("test-results/postgres-e2e-fixture.json");
const digest = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
await adminPool.query(`CREATE SCHEMA ${schema}`);
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 12,
});
const migrations = await loadPostgresMigrations(
  resolve("packages/postgres/migrations"),
);
await runPostgresMigrations(pool, migrations);
await new PostgresAccountRepository(pool).ensureBootstrapAdministrator({
  tenantKey,
  username,
  actorName: "端到端超级管理员",
  password,
});
await pool.query(
  "UPDATE forgex_platform_accounts SET roles = ARRAY['product_owner', 'requirement_analyst', 'developer', 'administrator']::text[] WHERE tenant_key = $1 AND username = $2",
  [tenantKey, username],
);
await pool.query(
  "INSERT INTO forgex_platform_customers (customer_key, tenant_key, name, summary) VALUES ($1, $2, $3, $4)",
  [customerKey, tenantKey, "验收客户", "ForgeX PostgreSQL 浏览器验收客户"],
);
await pool.query(
  "INSERT INTO forgex_platform_projects (project_key, tenant_key, customer_key, name, summary) VALUES ($1, $2, $3, $4, $5)",
  [
    projectKey,
    tenantKey,
    customerKey,
    "验收项目",
    "ForgeX 首版交付闭环验收项目",
  ],
);
await pool.query(
  "INSERT INTO forgex_platform_repositories (repository_key, tenant_key, project_key, name, git_url, local_path, default_branch) VALUES ($1, $2, $3, $4, $5, $6, $7)",
  [
    repositoryKey,
    tenantKey,
    projectKey,
    "验收仓库",
    "https://gitee.com/example/acceptance.git",
    "/srv/forgex/acceptance",
    "master",
  ],
);

const keyPair = generateKeyPairSync("ed25519");
const config = ControlPlaneRuntimeConfigSchema.parse({
  schemaVersion: 1,
  host: "127.0.0.1",
  port: 3000,
  publicOrigin: "http://127.0.0.1:4174",
  sessionCookieSecure: false,
  sessionCookieMaxAgeSeconds: 3_600,
  projectKey,
  repositoryKey,
  sessions: [
    {
      tokenSha256: digest("postgres-e2e-people-session-with-enough-entropy"),
      principal: {
        actorKey: "44444444-4444-4444-8444-444444444444",
        actorName: "端到端产品负责人",
        username,
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
  runnerSessions: [
    {
      tokenSha256: digest(runnerToken),
      runner: { tenantKey, runnerKey, keyId },
    },
  ],
  trustedRunners: [
    {
      runnerKey,
      keyId,
      runnerName: "PostgreSQL 浏览器验收 Runner",
      publicKeyBase64: keyPair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
      scopes: [{ tenantKey, projectKey, repositoryKey }],
      acceptNewEvidence: true,
    },
  ],
  skillEvaluators: [],
  mcpVerifiers: [],
});

await mkdir(resolve("test-results"), { recursive: true });
await writeFile(
  fixturePath,
  `${JSON.stringify({
    username,
    password,
    tenantKey,
    projectKey,
    repositoryKey,
    runnerKey,
    keyId,
    runnerToken,
    runnerPrivateKeyPem: keyPair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  })}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const app = createProductionControlPlane({
  config,
  authRealmRevision: digest(`postgres-e2e:${schema}`),
  migrations,
  pool,
  serviceVersion: "0.1.0-postgres-e2e",
});
await app.listen({ host: "127.0.0.1", port: 3000 });

let stopping;
const shutdown = () => {
  stopping ??= (async () => {
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await adminPool
      .query(`DROP SCHEMA ${schema} CASCADE`)
      .catch(() => undefined);
    await adminPool.end().catch(() => undefined);
    await rm(fixturePath, { force: true }).catch(() => undefined);
  })();
  return stopping;
};
const stopAndExit = () => {
  void shutdown().finally(() => process.exit(0));
};
process.once("SIGINT", stopAndExit);
process.once("SIGTERM", stopAndExit);
