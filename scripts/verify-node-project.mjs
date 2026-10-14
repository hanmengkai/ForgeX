import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Pool } from "pg";
import { auditNodeCapacity } from "./audit-node-project-capacity.mjs";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
  PostgresLifecycleArtifactStore,
} from "../packages/postgres/dist/index.js";
import { savePrivateJson } from "../services/device-worker/dist/lifecycle-transfer.js";
import { NodeProjectLifecyclePipeline } from "../services/device-worker/dist/lifecycle-node-project.js";
import { LocalGitCommandRunner } from "../services/device-worker/dist/workspace.js";
import {
  catalog,
  runSuite,
} from "../examples/node-task-board/trusted-suites.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(150);
  }
  throw new Error("Node 项目验收等待超时");
}
async function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    timer.unref();
  });
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function verifyNodeProject({ databaseUrl, root, mode = "codex" }) {
  const url = new URL(databaseUrl);
  if (
    !url.pathname.endsWith("_test") ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Node 项目验收仅允许本机名称以 _test 结尾的数据库");
  root = path.resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const schema = `forgex_node_${randomUUID().replaceAll("-", "")}`,
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 4,
  });
  const migrations = await loadPostgresMigrations(
    path.resolve("packages/postgres/migrations"),
  );
  await runPostgresMigrations(pool, migrations);
  const tenantKey = randomUUID(),
    projectKey = randomUUID(),
    repositoryKey = randomUUID();
  const people = [
    "requester",
    "product_owner",
    "developer",
    "tester",
    "test_ops",
  ].map((role) => ({
    actorKey: randomUUID(),
    tenantKey,
    actorName:
      "隔离验收" +
      {
        requester: "需求方",
        product_owner: "产品负责人",
        developer: "研发负责人",
        tester: "测试负责人",
        test_ops: "测试运维",
      }[role],
    roles: [role],
    token: randomUUID(),
  }));
  const projectRoot = path.join(root, "repository"),
    git = new LocalGitCommandRunner();
  await git.run(["init", "-q", "-b", "main", projectRoot]);
  await mkdir(path.join(projectRoot, "src"), { mode: 0o700 });
  await writeFile(
    path.join(projectRoot, "src/tasks.ts"),
    'export default function handle(_input: unknown): never { throw new Error("业务尚未实现"); }\n',
  );
  const contract = await readFile(
    "examples/node-task-board/project-contract.md",
    "utf8",
  );
  await writeFile(path.join(projectRoot, "README.md"), contract);
  await git.run(["-C", projectRoot, "add", "."]);
  await git.run([
    "-C",
    projectRoot,
    "-c",
    "user.name=ForgeX 测试验收",
    "-c",
    "user.email=node-project@forgex.local",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "初始化：任务管理项目契约与空实现",
  ]);
  const runtimePath = path.resolve(
      "services/device-worker/runtime/node-project-runtime.mjs",
    ),
    suitesPath = path.resolve("examples/node-task-board/trusted-suites.mjs");
  const definitions = [
    ["agent", ["requirements_ai", "design_ai", "development"]],
    ["test", ["testing"]],
    ["staging", ["staging_deploy"]],
  ];
  const executors = [],
    configs = new Map();
  for (const [name, capabilities] of definitions) {
    const pair = generateKeyPairSync("ed25519"),
      token = randomUUID(),
      workerRoot = path.join(root, "workers", name);
    const privateKeyPath = path.join(workerRoot, "private.pem");
    await mkdir(workerRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      privateKeyPath,
      pair.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    const executor = {
      executorKey: randomUUID(),
      tenantKey,
      projectKey,
      repositoryKey,
      capabilities,
      publicKeyBase64: pair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    };
    executors.push({ name, tokenSha256: sha(token), executor });
    const config = {
      schemaVersion: 2,
      displayName: {
        agent: "需求设计与开发执行器",
        test: "独立测试执行器",
        staging: "测试环境执行器",
      }[name],
      controlPlaneOrigin: "http://127.0.0.1:1",
      token,
      privateKeyPath,
      journalRoot: path.join(workerRoot, "journal"),
      pollIntervalMs: 1000,
      nodeProject: {
        schemaVersion: 1,
        root: path.join(workerRoot, "pipeline"),
        entrypoint: "src/tasks.ts",
        sourceFiles: ["src/tasks.ts"],
        runtimePath,
        runtimeSha256: sha(await readFile(runtimePath)),
        suitesPath,
        suitesSha256: sha(await readFile(suitesPath)),
      },
      ...(["agent", "test"].includes(name)
        ? {
            execution: {
              schemaVersion: 1,
              provider: "codex",
              mode: "current_user",
              project: {
                projectKey,
                repositoryKey,
                repositoryRoot: projectRoot,
                worktreeRoot: path.join(workerRoot, "worktrees"),
                baseRef: "main",
                reasoningEffort: "low",
              },
              codexHomePath:
                process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
              protectedPaths: [projectRoot],
              testingAgent: true,
              allowedDevelopmentFiles: ["src/tasks.ts"],
              instructions: contract,
            },
          }
        : {}),
    };
    configs.set(name, config);
  }
  await savePrivateJson(path.join(root, "controller.json"), {
    schema,
    authRealmRevision: sha(randomUUID()),
    config: {
      schemaVersion: 1,
      host: "127.0.0.1",
      port: 3000,
      projectKey,
      repositoryKey,
      sessions: people.map(({ token, ...principal }) => ({
        tokenSha256: sha(token),
        principal,
      })),
      lifecycleExecutors: executors.map(({ name, ...item }) => item),
      runnerSessions: [],
      trustedRunners: [],
      skillEvaluators: [],
      mcpVerifiers: [],
    },
  });
  await savePrivateJson(path.join(root, "private-manifest.json"), {
    schemaVersion: 1,
    schema,
    mode,
    projectKey,
    repositoryKey,
    people,
  });
  const children = new Map(),
    diagnostics = new Map();
  let controller,
    origin,
    proxy,
    offline = false,
    dropUpload = true,
    dropDeployment = true,
    artifactDownloads = 0,
    uploadDrops = 0,
    deploymentJobKey;
  const completions = [];
  async function start(name, args, env = {}) {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => {
      output += String(c);
    });
    child.stderr.on("data", (c) => {
      output += String(c);
    });
    child.on("error", () => {});
    diagnostics.set(name, () => output);
    children.set(name, child);
    const logFile = path.join(root, name + ".log");
    child.stdout.on(
      "data",
      (c) =>
        void import("node:fs/promises").then((fs) =>
          fs.appendFile(logFile, c, { mode: 0o600 }),
        ),
    );
    child.stderr.on(
      "data",
      (c) =>
        void import("node:fs/promises").then((fs) =>
          fs.appendFile(logFile, c, { mode: 0o600 }),
        ),
    );
    await until(() => {
      if (child.exitCode !== null)
        throw new Error(`组件 ${name} 启动失败：${output.slice(-500)}`);
      return output.includes("已就绪");
    });
    return { child, output: () => output };
  }
  async function startController(port = 0) {
    const c = await start(
      "controller",
      ["examples/node-task-board/control-plane.mjs", root],
      { FORGEX_TEST_DATABASE_URL: databaseUrl, FORGEX_NODE_PORT: String(port) },
    );
    controller = c.child;
    origin = /http:\/\/127\.0\.0\.1:\d+/u.exec(c.output())?.[0];
    assert.ok(origin);
  }
  async function startWorker(name) {
    return (
      await start(name, [
        mode === "fixture"
          ? "examples/node-task-board/fixture-worker.mjs"
          : "services/device-worker/dist/lifecycle-main.js",
        path.join(root, "workers", name, "config.json"),
      ])
    ).child;
  }
  async function request(role, method, route, body) {
    const person = people.find((p) => p.roles.includes(role));
    const r = await fetch(origin + route, {
      method,
      headers: {
        authorization: `Bearer ${person.token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await r.json();
    assert.ok(r.ok, JSON.stringify(payload));
    return payload.data;
  }
  const get = (key) => request("developer", "GET", `/api/v2/lifecycle/${key}`);
  const waitStage = (key, stage) =>
    until(
      async () => {
        const f = await get(key);
        if (
          [...children.entries()].some(
            ([n, c]) => n !== "controller" && c.exitCode !== null,
          )
        )
          throw new Error(
            [...diagnostics.entries()]
              .map(([n, v]) => n + ": " + v().slice(-1500))
              .join("\n"),
          );
        if (f.blockedReason)
          throw new Error(
            `阶段阻塞：${f.blockedReason}\n${[...diagnostics.values()].map((v) => v().slice(-500)).join("\n")}`,
          );
        return f.stage === stage && f;
      },
      mode === "codex" ? 20 * 60 * 1000 : 60000,
    );
  const approve = async (key, role) => {
    const f = await get(key);
    return request(role, "POST", `/api/v2/lifecycle/${key}/decisions`, {
      schemaVersion: 2,
      requestKey: randomUUID(),
      expectedVersion: f.version,
      role,
      decision: "approve",
      reason: "隔离验收角色输入：已核对本轮方案、实际结果及项目契约",
    });
  };
  let report;
  try {
    await startController();
    assert.equal((await fetch(origin + "/health/ready")).status, 200);
    proxy = createServer(async (req, res) => {
      try {
        if (offline) {
          res.writeHead(503);
          res.end();
          return;
        }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const r = await fetch(origin + req.url, {
          method: req.method,
          headers: {
            authorization: req.headers.authorization,
            "content-type": "application/json",
          },
          ...(body.length ? { body } : {}),
        });
        const bytes = Buffer.from(await r.arrayBuffer());
        if (req.url.endsWith("/artifacts/read") && r.ok) artifactDownloads++;
        if (req.url.endsWith("/artifacts") && r.ok && dropUpload) {
          dropUpload = false;
          uploadDrops++;
          res.destroy();
          return;
        }
        if (req.url === "/api/v2/executor/complete") {
          const value = JSON.parse(body);
          if (value.payload.result.output?.kind === "deployment") {
            completions.push(body.toString("utf8"));
            if (r.ok && dropDeployment) {
              deploymentJobKey = value.payload.jobKey;
              dropDeployment = false;
              offline = true;
              res.destroy();
              return;
            }
          }
        }
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(bytes);
      } catch {
        res.destroy();
      }
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    for (const [name, config] of configs) {
      config.controlPlaneOrigin = `http://127.0.0.1:${proxy.address().port}`;
      await savePrivateJson(
        path.join(root, "workers", name, "config.json"),
        config,
      );
      await startWorker(name);
    }
    const f = await request("requester", "POST", "/api/v2/lifecycle", {
      schemaVersion: 2,
      requestKey: randomUUID(),
      projectKey,
      repositoryKey,
      requesterKey: people[0].actorKey,
      title: "团队任务管理：创建、查询与状态流转",
      brief:
        "按登记项目契约实现五条验收条件，保持重复提交保护、中文错误与严格状态流转；仅交付测试环境",
    });
    const key = f.workflowKey;
    console.log("任务管理需求已提交，等待真实需求方案");
    await waitStage(key, "requirements_review");
    await approve(key, "product_owner");
    await approve(key, "requester");
    const before = await waitStage(key, "design_review"),
      controllerPid = controller.pid,
      controllerPort = Number(new URL(origin).port);
    await stop(controller, "SIGKILL");
    await startController(controllerPort);
    assert.notEqual(controller.pid, controllerPid);
    assert.deepEqual(await get(key), before);
    assert.ok(!before.artifacts.some((a) => a.kind === "code"));
    const unauthorized = await fetch(
      origin + `/api/v2/lifecycle/${key}/decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${people[0].token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 2,
          requestKey: randomUUID(),
          expectedVersion: before.version,
          role: "developer",
          decision: "approve",
          reason: "失败验收：需求方不能代替研发独立设计审核",
        }),
      },
    );
    assert.equal(unauthorized.status, 409);
    await approve(key, "developer");
    console.log("独立设计审核完成，等待实际 TypeScript 编译和自测");
    const codeReview = await waitStage(key, "code_review");
    assert.equal(uploadDrops, 1);
    const code = codeReview.artifacts.find((a) => a.kind === "code").technical;
    await savePrivateJson(path.join(root, "delivery", "reference.json"), {
      schemaVersion: 1,
      commitSha: code.commitSha,
      artifactDigest: code.artifactDigest,
    });
    const deliveredSource = (
      await git.run([
        "-C",
        projectRoot,
        "show",
        `${code.commitSha}:src/tasks.ts`,
      ])
    ).stdout;
    await writeFile(path.join(root, "delivery", "tasks.ts"), deliveredSource, {
      mode: 0o600,
    });
    const scope = { tenantKey, projectKey, repositoryKey },
      stored = await new PostgresLifecycleArtifactStore(pool).get(
        scope,
        code.artifactDigest,
        code.commitSha,
      );
    assert.ok(stored);
    assert.equal(
      sha(Buffer.from(stored.bytesBase64, "base64")),
      code.artifactDigest,
    );
    await Promise.all([
      new PostgresLifecycleArtifactStore(pool).put(scope, stored),
      new PostgresLifecycleArtifactStore(pool).put(scope, stored),
    ]);
    assert.equal(
      await new PostgresLifecycleArtifactStore(pool).get(
        { ...scope, repositoryKey: randomUUID() },
        code.artifactDigest,
        code.commitSha,
      ),
      null,
    );
    await approve(key, "developer");
    await waitStage(key, "test_review");
    await approve(key, "tester");
    const pendingFile = path.join(
      root,
      "workers",
      "staging",
      "journal",
      "pending.json",
    );
    await until(async () => {
      try {
        return (
          offline &&
          JSON.parse(await readFile(pendingFile, "utf8")).phase === "completed"
        );
      } catch {
        return false;
      }
    });
    const originalPid = children.get("staging").pid;
    await stop(children.get("staging"), "SIGKILL");
    const restarted = await startWorker("staging");
    assert.notEqual(restarted.pid, originalPid);
    await pause(1200);
    assert.equal(
      JSON.parse(await readFile(pendingFile, "utf8")).phase,
      "completed",
    );
    offline = false;
    await until(async () => {
      try {
        await readFile(pendingFile);
        return false;
      } catch (error) {
        return error.code === "ENOENT";
      }
    });
    const staging = await waitStage(key, "staging_acceptance");
    assert.equal(completions.length, 2);
    assert.equal(completions[0], completions[1]);
    const deployment = staging.artifacts.find((a) => a.kind === "deployment");
    const businessChecks = [];
    for (const suite of catalog)
      businessChecks.push(...(await runSuite(suite.suiteKey, deployment.url)));
    assert.ok(businessChecks.every((c) => c.passed));
    await approve(key, "requester");
    const accepted = await waitStage(key, "release_approval");
    assert.ok(!accepted.artifacts.some((a) => a.environment === "production"));
    assert.ok(!accepted.approvals.some((a) => a.stage === "release_approval"));
    const persisted = (
      await pool.query(
        "SELECT state FROM forgex_lifecycle_states WHERE tenant_key=$1",
        [tenantKey],
      )
    ).rows[0].state.workflows.find((w) => w.workflowKey === key);
    assert.equal(persisted.current.production, undefined);
    assert.equal(
      persisted.jobs.filter((j) => j.stage === "production_deploy").length,
      0,
    );
    assert.ok(
      persisted.approvals.some((a) => a.stage === "staging_acceptance"),
    );
    const db = await pool.query(
      "SELECT count(*)::integer AS count FROM forgex_lifecycle_artifacts",
    );
    assert.equal(db.rows[0].count, 1);
    const modelSessions = [];
    if (mode === "codex")
      for (const name of ["agent", "test"]) {
        const dir = path.join(
          root,
          "workers",
          name,
          "journal",
          "model-results",
        );
        for (const file of await readdir(dir)) {
          const value = JSON.parse(
            await readFile(path.join(dir, file), "utf8"),
          );
          modelSessions.push({ stage: value.stage, threadId: value.threadId });
        }
      }
    if (mode === "codex") {
      assert.equal(modelSessions.length, 4);
      assert.equal(new Set(modelSessions.map((s) => s.threadId)).size, 4);
    }
    report = {
      schemaVersion: 1,
      project: "团队任务管理",
      modelMode: mode,
      stage: accepted.stage,
      controllerRestarted: true,
      independentDesignReview: true,
      artifactUploadRecovered: true,
      postgresArtifactCount: db.rows[0].count,
      artifactDownloads,
      workerRestarted: true,
      sameSignedCompletion: true,
      uniqueDeploymentCount: 1,
      productionConfigured: false,
      productionApprovalCount: 0,
      modelSessions,
      businessChecks,
      commitSha: code.commitSha,
      artifactDigest: code.artifactDigest,
      workflow: accepted,
      approvalHistory: persisted.approvals,
      jobHistory: persisted.jobs.map(({ stage, status }) => ({
        stage,
        status,
      })),
    };
    await savePrivateJson(path.join(root, "verification.json"), report);
    report.capacityAudit = await auditNodeCapacity(root, databaseUrl);
    report.completed = true;
    await savePrivateJson(path.join(root, "verification.json"), report);
    console.log(
      `任务管理测试交付验收通过：${businessChecks.length} 项 HTTP 检查，测试验收已保存，等待发布审批`,
    );
    return { report, root };
  } finally {
    for (const name of ["agent", "test", "staging"])
      await stop(children.get(name));
    if (deploymentJobKey)
      await new NodeProjectLifecyclePipeline(
        configs.get("staging").nodeProject,
      ).stopDeployment(deploymentJobKey);
    await stop(controller);
    if (proxy) await new Promise((r) => proxy.close(r));
    await pool.end();
    await admin.end();
    // 数据库 schema 与证据保留供复核，停止组件不删除交付记录。
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve("scripts/verify-node-project.mjs")
) {
  const databaseUrl =
    process.env.FORGEX_TEST_DATABASE_URL ??
    JSON.parse(
      await readFile(".forgex-local/node-p0-tools/connection.json", "utf8"),
    ).connectionString;
  const mode = process.argv.includes("--fixture") ? "fixture" : "codex";
  await verifyNodeProject({
    databaseUrl,
    root: path.resolve(
      ".forgex-local/node-project",
      new Date().toISOString().replaceAll(":", "-"),
    ),
    mode,
  });
}
